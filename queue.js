import {transfer} from './media.js';

const pending = [];
let running = false;

export function enqueue(media, file, detail) {
  document.querySelector('#empty').hidden = true;
  const row = document.createElement('li');
  const name = document.createElement('strong');
  name.textContent = file.name + ' · ' + detail;
  const status = document.createElement('p');
  const bar = document.createElement('progress');
  bar.max = 100;
  bar.value = 0;
  const pause = document.createElement('button');
  const cancel = document.createElement('button');
  pause.textContent = 'Пауза';
  cancel.textContent = 'Отменить';
  row.append(name, status, bar, document.createElement('br'), pause, cancel);
  document.querySelector('#jobs').append(row);
  status.textContent = 'В очереди';
  pause.disabled = true;
  const controller = new AbortController();
  let resume, gate, last = 'Начинаем сохранение…';
  const control = {
    signal: controller.signal,
    async check() {
      while (gate) await gate;
      controller.signal.throwIfAborted();
    },
    committing() {
      pause.disabled = cancel.disabled = true;
      status.textContent = 'Завершаем запись на диск…';
    }
  };
  function release() { gate = null; resume?.(); }
  pause.onclick = () => {
    if (gate) { release(); pause.textContent = 'Пауза'; status.textContent = last; }
    else {
      gate = new Promise(resolve => { resume = resolve; });
      pause.textContent = 'Продолжить';
      status.textContent = 'Приостановлено · ' + last;
    }
  };
  cancel.onclick = () => {
    controller.abort();
    release();
    pause.disabled = cancel.disabled = true;
    status.textContent = 'Отменено';
  };
  pending.push(async () => {
    if (controller.signal.aborted) return;
    pause.disabled = false;
    status.textContent = last;
    try {
      await transfer(media, file, (ratio, phase) => {
        if (controller.signal.aborted) return;
        if (Number.isFinite(ratio)) {
          const percent = Math.max(0, Math.min(99, Math.floor(100 * ratio)));
          bar.value = percent;
          last = phase + ' · ' + percent + '%';
        } else { bar.removeAttribute('value'); last = phase + ' · размер неизвестен'; }
        if (!gate && status.textContent !== last) status.textContent = last;
      }, control);
      bar.value = 100;
      status.textContent = '100% · Сохранено';
    } catch (e) {
      status.textContent = controller.signal.aborted ? 'Отменено' : 'Ошибка сохранения. ' + e.message;
    } finally { pause.disabled = cancel.disabled = true; }
  });
  if (!running) drain();
}

async function drain() {
  running = true;
  try { while (pending.length) await pending.shift()(); }
  finally { running = false; }
}
