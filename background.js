function filmTitle(candidates) {
  return candidates.map(s => s?.trim()).find(s => s && !/^(?:видео|video|плеер|player|смотреть онлайн|watch online)$/i.test(s));
}

async function openVideo(tab) {
  let urls = [];
  let error = '', title = tab.title, pageUrl = tab.url;
  const current = await chrome.tabs.get(tab.id).catch(() => tab);
  title = filmTitle([current.title, tab.title]);
  pageUrl = current.url || tab.url;
  try {
    const frames = await chrome.scripting.executeScript({
      target: {tabId: tab.id, allFrames: true},
      func: () => ({
        titles: [document.title, document.querySelector('meta[property="og:title"]')?.content,
          document.querySelector('h1')?.textContent, document.querySelector('meta[name="twitter:title"]')?.content],
        pageUrl: location.href,
        urls: [...new Set([
          ...performance.getEntriesByType('resource').map(entry => entry.name),
          ...Array.from(document.querySelectorAll('video, video source'), el => el.currentSrc || el.src)
        ].filter(url => /^https?:/i.test(url) && /\.(m3u8|mp4)(?:[?#]|$)/i.test(url)))]
      })
    });
    const page = frames.find(frame => frame.frameId === 0)?.result;
    title = filmTitle([title, ...(page?.titles || [])]);
    pageUrl = page?.pageUrl || pageUrl;
    urls = [...new Set(frames.flatMap(frame => frame.result?.urls || []))];
  } catch {
    error = 'Chrome не дал прочитать страницу. Откройте вкладку сайта с видео.';
  }
  const id = crypto.randomUUID();
  await chrome.storage.session.set({[id]: {urls, error, title: title || '', pageUrl: pageUrl || ''}});
  const manager = await chrome.runtime.sendMessage({type: 'open-selection', id}).catch(() => null);
  if (manager?.tabId != null) {
    await chrome.tabs.update(manager.tabId, {active: true});
    await chrome.windows.update(manager.windowId, {focused: true});
    return;
  }
  await chrome.tabs.create({url: chrome.runtime.getURL('save.html#' + id)});
}
chrome.action.onClicked.addListener(openVideo);

let creating;
async function ensureQueue() {
  const url = chrome.runtime.getURL('engine.html');
  const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]});
  if (!contexts.length) {
    creating ??= chrome.offscreen.createDocument({
      url, reasons: ['BLOBS'],
      justification: 'Assemble media in a temporary file and keep its Blob URL alive until Chrome saves the download.'
    }).finally(() => { creating = undefined; });
    await creating;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'broker') return;
  async function handle() {
    if (message.type === 'ensure') { await ensureQueue(); return true; }
    if (sender.url !== chrome.runtime.getURL('engine.html')) throw Error('Недоступная команда.');
    if (message.type === 'export') {
      return chrome.downloads.download({url: message.url, filename: message.name, conflictAction: 'uniquify'});
    }
    if (message.type === 'status') {
      const [item] = await chrome.downloads.search({id: message.id});
      if (!item) throw Error('Chrome не нашёл загрузку.');
      return {state: item.state, error: item.error, filename: item.filename};
    }
    throw Error('Неизвестная команда.');
  }
  handle().then(value => reply({value}), e => reply({error: e.message}));
  return true;
});
