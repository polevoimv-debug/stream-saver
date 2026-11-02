import {inspect, plan} from './media.js';
import {connect, enqueue} from './queue.js';
const $ = id => document.getElementById(id);
const source = $('source'), quality = $('quality'), audio = $('audio'), save = $('save');
const status = $('status');
let sources = [], title = '', selection = 0, batch = 0;
let prepared;
function safeName(value) {
  let name = value.normalize('NFC').replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g,' ').trim().slice(0,110)
    .replace(/[. ]+$/, '') || 'Видео';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

function label(v) {
  return [v.height && v.height + 'p', v.rate && (v.rate/1e6).toLocaleString('ru', {maximumFractionDigits:2}) + ' Мбит/с']
    .filter(Boolean).join(' · ') || 'Исходное качество';
}

async function loadSelection(id) {
  const previous = location.hash.slice(1);
  if (previous !== id) {
    history.replaceState(null, '', '#' + id);
    if (previous) chrome.storage.session.remove(previous);
  }
  const version = ++batch;
  ++selection;
  save.disabled = $('defer').disabled = true;
  const payload = (await chrome.storage.session.get(id))[id] || {};
  const {urls = [], error} = payload;
  status.textContent = 'Ищем качество и аудиодорожки…';
  const found = await Promise.allSettled(urls.map(inspect));
  if (version !== batch) return;
  let fallback = 'Видео';
  if (payload.pageUrl) {
    try {
      const page = new URL(payload.pageUrl);
      fallback = decodeURIComponent(page.pathname.split('/').filter(Boolean).pop() || page.hostname)
        .replace(/\.html?$/i, '').replace(/[-_]+/g, ' ');
    } catch { /* Use the generic name for an invalid URL. */ }
  }
  title = payload.title?.trim() || fallback;
  $('filename').value = safeName(title);
  $('title').textContent = title;
  source.replaceChildren();
  quality.replaceChildren();
  audio.replaceChildren();
  const items = found.filter(r => r.status === 'fulfilled').map(r => r.value);
  const children = new Set(items.flatMap(s => s.children));
  sources = items.filter(s => !children.has(s.url)).sort((a,b) => Number(!!b.master) - Number(!!a.master));
  const shortName = s => new URL(s.url).hostname;
  sources.forEach((s,i) => source.add(new Option('Видео ' + (i+1) + ' · ' + shortName(s) +
    (s.direct ? ' · MP4' : ' · HLS'), i)));
  $('sourceRow').hidden = sources.length < 2;
  if (sources.length) { changeSource(); await prepare(); }
  else status.textContent = error || found.find(r => r.status === 'rejected')?.reason?.message ||
    'Видео не найдено. Запустите его на сайте и снова нажмите значок расширения.';
}
const selectedSource = () => sources[source.selectedIndex];
const selectedVariant = () => selectedSource().variants[quality.selectedIndex];
function changeAudio() {
  const tracks = selectedVariant().audio || [];
  audio.replaceChildren();
  for (const t of tracks) audio.add(new Option([t.name, t.language && t.language !== t.name && t.language].filter(Boolean).join(' · ') || 'Основная'));
  if (!tracks.length) audio.add(new Option('Звук из исходного видео'));
  audio.disabled = tracks.length < 2;
  status.textContent = 'Выберите параметры и нажмите «Скачать сейчас» или «В очередь». После добавления в очередь вкладку можно закрыть.';
}
function changeSource() {
  quality.replaceChildren(...selectedSource().variants.map(v => new Option(label(v))));
  quality.disabled = quality.length < 2;
  changeAudio();
}
source.onchange = changeSource;
quality.onchange = changeAudio;
audio.onchange = changeAudioStatus;
function changeAudioStatus() { status.textContent = 'Выбран звук «' + audio.selectedOptions[0].text + '».'; }
async function prepare() {
  const token = ++selection;
  save.disabled = $('defer').disabled = true;
  if (!sources.length) return;
  const v = selectedVariant();
  try {
    const media = await plan(selectedSource(), v, v.audio?.[audio.selectedIndex]);
    if (token !== selection) return;
    prepared = media;
    save.disabled = $('defer').disabled = false;
  } catch (e) { if (token === selection) status.textContent = e.message; }
}
for (const control of [source, quality, audio]) control.addEventListener('change', prepare);
const here = await chrome.tabs.getCurrent();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== 'open-selection') return;
  reply({tabId: here.id, windowId: here.windowId});
  loadSelection(message.id);
});
await connect();
await loadSelection(location.hash.slice(1));
async function addFilm(deferred) {
  const media = prepared;
  const variant = selectedVariant();
  const detail = label(variant) + ' · ' + audio.selectedOptions[0].text;
  const name = safeName($('filename').value);
  try {
    const filename = name + (variant.height ? '-' + variant.height + 'p' : '') + '.' + media.ext;
    await enqueue(media, filename, detail, deferred);
    status.textContent = 'Добавлено в общую очередь. Можно закрыть эту вкладку и плеер. Чтобы вернуться к очереди, нажмите значок расширения.';
  } catch (e) { status.textContent = e.name === 'AbortError' ? 'Выбор файла отменён.' : e.message; }
}
save.onclick = () => addFilm(false);
$('defer').onclick = () => addFilm(true);
