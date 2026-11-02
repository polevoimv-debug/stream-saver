import {transfer} from './media.js';

const jobs = [];
const channel = new BroadcastChannel('stream-saver-queue');
let revision = 0, notice = '';
const snapshot = () => ({revision, notice, jobs:jobs.map(job => job.view)});
function notify() {
  revision++;
  channel.postMessage(snapshot());
}
async function broker(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({target:'broker', type, ...fields});
  if (result.error) throw Error(result.error);
  return result.value;
}

// Only this document owns the staging directory. Remove leftovers from a previous browser session.
const staging = (async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('queue', {create:true});
  for await (const name of dir.keys()) await dir.removeEntry(name);
  return dir;
})();

async function run(job) {
  const {view, controller} = job;
  let dir, blobUrl;
  try {
    view.state = 'active';
    view.text = 'Начинаем сохранение…';
    notify();
    dir = await staging;
    const file = await dir.getFileHandle(view.id, {create:true});
    await transfer(job.media, file, (ratio, phase) => {
      const percent = Number.isFinite(ratio) ? Math.max(0, Math.min(99, Math.floor(100 * ratio))) : null;
      const text = percent == null ? phase + ' · размер неизвестен' : phase + ' · ' + percent + '%';
      if (controller.signal.aborted || view.text === text) return;
      view.percent = percent;
      view.text = text;
      notify();
    }, {
      signal: controller.signal,
      async check() {
        while (job.gate) await job.gate;
        controller.signal.throwIfAborted();
      },
      committing() {
        view.state = 'finishing';
        view.text = 'Записываем готовый файл в загрузки Chrome…';
        notify();
      }
    });
    const staged = await file.getFile();
    const type = job.media.ext === 'mp4' ? 'video/mp4' : 'video/mp2t';
    blobUrl = URL.createObjectURL(staged.slice(0, staged.size, type));
    const id = await broker('export', {url:blobUrl, name:view.name});
    job.downloadId = id;
    for (;;) {
      if (job.deleting) {
        await broker('cancel-export', {id}).catch(() => {});
        break;
      }
      const {state, error, filename} = await broker('status', {id});
      if (state === 'complete') {
        view.name = filename.split(/[\\/]/).pop() || view.name;
        view.percent = 100;
        view.state = 'done';
        view.text = '100% · Сохранено в загрузках Chrome';
        break;
      }
      if (state === 'interrupted') throw Error(error || 'Запись прервана.');
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  } catch (e) {
    view.state = controller.signal.aborted ? 'cancelled' : 'error';
    view.text = controller.signal.aborted ? 'Отменено' : 'Ошибка сохранения. ' + e.message;
  } finally {
    delete job.media;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (dir) await dir.removeEntry(view.id).catch(() => {});
    notify();
  }
}

// A deferred job starts only when all currently running films have released their slot.
function start(job) {
  if (job.gate) {
    job.view.state = 'active';
    job.gate = null;
    job.resume();
    notify();
  } else {
    job.finished = run(job).finally(nextDeferred);
  }
}

function nextDeferred() {
  if (jobs.some(j => ['active','finishing'].includes(j.view.state))) return;
  const next = jobs.find(j => j.view.state === 'waiting');
  if (next) start(next);
}

function hold(job) {
  job.gate ??= new Promise(resolve => { job.resume = resolve; });
}

function defer(job) {
  // Requeued films join the tail, even when they were originally added first.
  jobs.splice(jobs.indexOf(job), 1);
  jobs.push(job);
  job.view.state = 'waiting';
}

async function removeJob(job) {
  if (job.deleting) return;
  job.deleting = true;
  job.view.state = 'deleting';
  job.view.text = 'Удаляем задачу и её файл…';
  job.controller.abort();
  job.gate = null;
  job.resume?.();
  notify();
  try {
    await job.finished;
    const dir = await staging;
    await dir.removeEntry(job.view.id).catch(error => {
      if (error.name !== 'NotFoundError') throw error;
    });
    const note = job.downloadId == null ? '' : await broker('delete-export', {id:job.downloadId});
    notice = 'Удалена задача «' + job.view.name + '». ' + (note || '');
    jobs.splice(jobs.indexOf(job), 1);
  } catch (e) {
    job.view.state = 'error';
    job.view.text = 'Не удалось удалить файл. ' + e.message;
  } finally {
    job.deleting = false;
    notify();
    nextDeferred();
  }
}

function command(message) {
  if (message.type === 'add') {
    if (!jobs.some(job => job.view.id === message.id)) {
      const job = {view:{id:message.id, name:message.name, detail:message.detail, state:'waiting',
        text:'Готово к загрузке', percent:0}, media:message.media, controller:new AbortController()};
      jobs.push(job);
      if (message.deferred) nextDeferred();
      else start(job);
      notify();
    }
  } else if (message.type !== 'list') {
    const job = jobs.find(j => j.view.id === message.id);
    if (!job) throw Error('Задача не найдена.');
    if (message.type === 'delete') {
      removeJob(job);
      return snapshot();
    }
    const {view} = job;
    if (message.type === 'pause' && view.state === 'active') {
      hold(job);
      view.state = 'paused';
    } else if (message.type === 'resume' && ['paused','waiting'].includes(view.state)) {
      start(job);
    } else if (message.type === 'defer' && ['active','paused'].includes(view.state)) {
      hold(job);
      defer(job);
    } else if (message.type === 'cancel' && ['waiting','active','paused'].includes(view.state)) {
      job.controller.abort();
      job.gate = null;
      job.resume?.();
      delete job.media;
      view.state = 'cancelled';
      view.text = 'Отменено';
    }
    notify();
    nextDeferred();
  }
  return snapshot();
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'engine') return;
  try { reply({value:command(message)}); } catch (e) { reply({error:e.message}); }
});
