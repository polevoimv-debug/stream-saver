import {transfer} from './media.js';

const jobs = [];
let running = false;
const channel = new BroadcastChannel('stream-saver-queue');
let revision = 0;
const snapshot = () => ({revision, jobs:jobs.map(job => job.view)});
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
    for (;;) {
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

async function drain() {
  if (running) return;
  running = true;
  try {
    let job;
    while ((job = jobs.find(item => item.view.state === 'waiting'))) await run(job);
  } finally { running = false; }
}

function command(message) {
  if (message.type === 'add') {
    if (!jobs.some(job => job.view.id === message.id)) {
      jobs.push({view:{id:message.id, name:message.name, detail:message.detail, state:'waiting',
        text:'В очереди', percent:0}, media:message.media, controller:new AbortController()});
      notify();
      drain();
    }
  } else if (message.type !== 'list') {
    const job = jobs.find(j => j.view.id === message.id);
    if (!job) throw Error('Задача не найдена.');
    const {view} = job;
    if (message.type === 'pause' && view.state === 'active') {
      job.gate = new Promise(resolve => {job.resume = resolve;});
      view.state = 'paused';
    } else if (message.type === 'resume' && view.state === 'paused') {
      job.gate = null;
      job.resume();
      view.state = 'active';
    } else if (message.type === 'cancel' && ['waiting','active','paused'].includes(view.state)) {
      job.controller.abort();
      job.gate = null;
      job.resume?.();
      delete job.media;
      view.state = 'cancelled';
      view.text = 'Отменено';
    }
    notify();
  }
  return snapshot();
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'engine') return;
  try { reply({value:command(message)}); } catch (e) { reply({error:e.message}); }
});
