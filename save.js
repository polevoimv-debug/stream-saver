import {plan, transfer} from './media.js';
const select = document.querySelector('select');
const button = document.querySelector('button');
const status = document.querySelector('#status');
const id = location.hash.slice(1);
const {urls = [], error} = (await chrome.storage.session.get(id))[id] || {};
await chrome.storage.session.remove(id);
let media;
let generation = 0;
for (const url of urls) {
  const parsed = new URL(url);
  select.add(new Option(parsed.host + parsed.pathname, url));
}
async function prepare() {
  const current = ++generation;
  button.disabled = true;
  status.textContent = 'Читаем сведения о потоке…';
  try {
    const result = await plan(select.value);
    if (current !== generation) return;
    media = result;
    button.disabled = false;
    status.textContent = 'Формат ' + media.ext.toUpperCase() + '. Частей в файле — ' + media.parts.length + '.';
  } catch (e) { if (current === generation) status.textContent = e.message; }
}
select.onchange = prepare;
if (urls.length) prepare();
else status.textContent = error || 'Поток не найден. Запустите видео во вкладке сайта и снова нажмите значок расширения.';
button.onclick = async () => {
  select.disabled = button.disabled = true;
  try {
    const file = await showSaveFilePicker({suggestedName: 'video.' + media.ext});
    await transfer(media.parts, file, (i,n) => { status.textContent = 'Скачивается часть ' + i + ' из ' + n + '…'; });
    status.textContent = 'Файл сохранён.';
  } catch (e) { status.textContent = e.name === 'AbortError' ? 'Сохранение отменено.' : 'Ошибка. ' + e.message; }
  finally { select.disabled = button.disabled = false; }
};
