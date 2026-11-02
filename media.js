function httpUrl(path, base) {
  const url = new URL(path, base);
  if (!['https:', 'http:'].includes(url.protocol)) throw Error('Недопустимый адрес потока.');
  return url.href;
}

async function request(url) {
  const response = await fetch(url, {credentials: 'include'});
  if (!response.ok) throw Error('Сервер вернул HTTP ' + response.status);
  return response;
}

export async function plan(url, depth = 0) {
  if (depth > 4) throw Error('Слишком много вложенных плейлистов.');
  if (!depth && /\.mp4(?:[?#]|$)/i.test(url)) return {ext: 'mp4', parts: [url]};
  const response = await request(url);
  const lines = (await response.text()).trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw Error('Сервер не вернул HLS-плейлист.');
  const base = response.url;
  const variants = [];
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    if (/\bAUDIO=/.test(line) && lines.some(s => s.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(s) && /\bURI=/.test(s))) continue;
    if (lines[index + 1] && !lines[index + 1].startsWith('#')) variants.push({
      bandwidth: Number(line.match(/(?:[:,])BANDWIDTH=(\d+)/)?.[1] || 0),
      url: httpUrl(lines[index + 1], base)
    });
  }
  if (variants.length) return plan(variants.sort((a,b) => b.bandwidth - a.bandwidth)[0].url, depth + 1);
  if (lines.some(s => s.startsWith('#EXT-X-STREAM-INF:'))) throw Error('Поток с отдельной аудиодорожкой пока не поддерживается.');
  if (!lines.includes('#EXT-X-ENDLIST')) throw Error('Поддерживаются только завершённые записи.');
  if (lines.some(s => /^#EXT-X-(KEY:(?!METHOD=NONE$)|BYTERANGE:|GAP$|DISCONTINUITY$)/.test(s))) throw Error('Этот тип сегментации или шифрования не поддерживается.');
  const parts = [];
  let ext = 'ts';
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = line.match(/\bURI="([^"]+)"/)?.[1];
      if (!uri || parts.length || line.includes('BYTERANGE=')) throw Error('Неподдерживаемая карта сегментов.');
      ext = 'mp4';
      parts.push(httpUrl(uri, base));
    } else if (!line.startsWith('#')) parts.push(httpUrl(line, base));
  }
  if (!lines.some(s => s.startsWith('#EXTINF:')) || !parts.length) throw Error('Нет видеосегментов.');
  return {ext, parts};
}

export async function transfer(parts, file, progress) {
  const output = await file.createWritable();
  try {
    for (const [index, url] of parts.entries()) {
      progress(index + 1, parts.length);
      const response = await request(url);
      if (!response.body || /(?:text\/html|application\/json)/i.test(response.headers.get('content-type') || '')) throw Error('Вместо видео сервер вернул другой ответ.');
      await response.body.pipeTo(output, {preventClose: true, preventAbort: true});
    }
    await output.close();
  } catch (error) {
    await output.abort().catch(() => {});
    throw error;
  }
}
