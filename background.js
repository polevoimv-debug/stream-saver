chrome.action.onClicked.addListener(async tab => {
  let urls = [];
  let error = '';
  try {
    const frames = await chrome.scripting.executeScript({
      target: {tabId: tab.id, allFrames: true},
      func: () => [...new Set([
        ...performance.getEntriesByType('resource').map(entry => entry.name),
        ...Array.from(document.querySelectorAll('video, video source'), el => el.currentSrc || el.src)
      ].filter(url => /^https?:/i.test(url) && /\.(m3u8|mp4)(?:[?#]|$)/i.test(url)))]
    });
    urls = [...new Set(frames.flatMap(frame => frame.result || []))];
  } catch {
    error = 'Chrome не дал прочитать страницу. Откройте вкладку сайта с видео.';
  }
  const id = crypto.randomUUID();
  await chrome.storage.session.set({[id]: {urls, error}});
  await chrome.tabs.create({url: chrome.runtime.getURL('save.html#' + id)});
});
