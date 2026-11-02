chrome.action.onClicked.addListener(async tab => {
  let urls = [];
  let error = '', title = tab.title, pageUrl = tab.url;
  try {
    const frames = await chrome.scripting.executeScript({
      target: {tabId: tab.id, allFrames: true},
      func: () => ({
        title: document.querySelector('meta[property="og:title"]')?.content ||
          document.querySelector('meta[name="twitter:title"]')?.content ||
          document.querySelector('h1')?.textContent.trim() || document.title,
        pageUrl: location.href,
        urls: [...new Set([
          ...performance.getEntriesByType('resource').map(entry => entry.name),
          ...Array.from(document.querySelectorAll('video, video source'), el => el.currentSrc || el.src)
        ].filter(url => /^https?:/i.test(url) && /\.(m3u8|mp4)(?:[?#]|$)/i.test(url)))]
      })
    });
    const page = frames.find(frame => frame.frameId === 0)?.result;
    title = page?.title || title;
    pageUrl = page?.pageUrl || pageUrl;
    urls = [...new Set(frames.flatMap(frame => frame.result?.urls || []))];
  } catch {
    error = 'Chrome не дал прочитать страницу. Откройте вкладку сайта с видео.';
  }
  const id = crypto.randomUUID();
  await chrome.storage.session.set({[id]: {urls, error, title, pageUrl}});
  const manager = await chrome.runtime.sendMessage({type: 'open-selection', id}).catch(() => null);
  if (manager?.tabId != null) {
    await chrome.tabs.update(manager.tabId, {active: true});
    await chrome.windows.update(manager.windowId, {focused: true});
    return;
  }
  await chrome.tabs.create({url: chrome.runtime.getURL('save.html#' + id)});
});
