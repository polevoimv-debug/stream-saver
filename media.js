import {
  Input, Output, ALL_FORMATS, BufferSource, CustomPathedSource, UrlSource,
  Mp4OutputFormat, StreamTarget, Conversion
} from './vendor/mediabunny.min.mjs';

function http(path, base) {
  const url = new URL(path, base);
  if (!['https:', 'http:'].includes(url.protocol)) throw Error('Недопустимый адрес файла.');
  return url.href;
}

async function request(url, signal) {
  const response = await fetch(url, {credentials: 'include', signal});
  if (!response.ok) throw Error('Видеосервер вернул HTTP ' + response.status + '. Обновите страницу плеера.');
  return response;
}

function attributes(line) {
  return Object.fromEntries(Array.from(line.slice(line.indexOf(':') + 1)
    .matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g), m => [m[1], m[2].replace(/^"|"$/g, '')]));
}

async function playlist(url) {
  const response = await request(url);
  const lines = (await response.text()).trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw Error('Сервер не вернул список воспроизведения.');
  if (lines.some(s => /^#EXT-X-(SESSION-KEY:|KEY:(?!METHOD=NONE$))/.test(s))) {
    throw Error('Запись защищена шифрованием.');
  }
  return {lines, base: response.url};
}

export async function inspect(url) {
  if (/\.mp4(?:[?#]|$)/i.test(url)) return {url, direct: true, variants: [{}], children: []};
  const {lines, base} = await playlist(url);
  const tracks = lines.filter(s => s.startsWith('#EXT-X-MEDIA:')).map(attributes)
    .filter(a => a.TYPE === 'AUDIO').map(a => ({group: a['GROUP-ID'], name: a.NAME || a.LANGUAGE,
      language: a.LANGUAGE, preferred: a.DEFAULT === 'YES', url: a.URI && http(a.URI, base)}));
  const variants = [];
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attributes(line);
    if (!lines[i + 1] || lines[i + 1].startsWith('#')) continue;
    variants.push({url: http(lines[i + 1], base), height: Number(a.RESOLUTION?.split('x')[1]) || 0,
      rate: Number(a.BANDWIDTH) || 0, audio: tracks.filter(t => t.group === a.AUDIO)
        .sort((a,b) => Number(b.preferred) - Number(a.preferred))});
  }
  const children = [...variants, ...tracks].map(v => v.url).filter(Boolean);
  variants.sort((a,b) => b.height - a.height || b.rate - a.rate);
  return {url, variants: variants.length ? variants : [{url}], children, master: !!children.length};
}

async function recording(url) {
  const {lines, base} = await playlist(url);
  if (!lines.includes('#EXT-X-ENDLIST')) throw Error('Можно сохранить только завершённую запись.');
  if (lines.some(s => /^#EXT-X-(BYTERANGE:|GAP$|DISCONTINUITY$)/.test(s))) throw Error('Этот способ разбиения записи пока не поддерживается.');
  const parts = [];
  let ext = 'ts';
  const absolute = lines.map(line => {
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line);
      if (!a.URI || parts.length || a.BYTERANGE) throw Error('Неподдерживаемая карта фрагментов.');
      const path = http(a.URI, base);
      ext = 'mp4';
      parts.push(path);
      return '#EXT-X-MAP:URI="' + path + '"';
    }
    if (line.startsWith('#')) return line;
    const path = http(line, base);
    parts.push(path);
    return path;
  });
  if (!lines.some(s => s.startsWith('#EXTINF:')) || !parts.length) throw Error('В записи нет видеофрагментов.');
  return {ext, parts, text: absolute.join('\n')};
}

export async function plan(source, variant, audio, depth = 0) {
  if (source.direct) return {ext: 'mp4', parts: [source.url]};
  // Follow nested masters before loading a media playlist.
  if (source.master) {
    const child = await inspect(variant.url);
    if (child.master) {
      if (depth >= 4) throw Error('Слишком много вложенных списков воспроизведения.');
      return plan(child, child.variants[0], audio || child.variants[0].audio?.[0], depth + 1);
    }
  }
  const video = await recording(variant.url);
  if (!audio?.url) return video;
  return {ext: 'mp4', video, audio: await recording(audio.url)};
}

async function mux(media, outputFile, progress, control) {
  const root = 'https://stream-saver.invalid/master.m3u8';
  const texts = new Map([
    [root, '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="a"\nvideo.m3u8'],
    [http('video.m3u8',root), media.video.text], [http('audio.m3u8',root), media.audio.text]
  ]);
  const source = new CustomPathedSource(root, ({path}) => {
    const text = texts.get(String(path));
    return text ? new BufferSource(new TextEncoder().encode(text)) : new UrlSource(http(path), {
      requestInit: {credentials: 'include'},
      fetchFn: async (url, init) => {
        await control.check();
        return fetch(url, {...init, signal: AbortSignal.any([init.signal, control.signal].filter(Boolean))});
      }, getRetryDelay: n => n < 2 ? 1 : null
    });
  });
  const input = new Input({formats: ALL_FORMATS, source});
  const stop = () => input.dispose();
  control.signal.addEventListener('abort', stop, {once:true});
  try {
    if (!await input.getPrimaryVideoTrack() || !await input.getPrimaryAudioTrack()) {
      throw Error('Не удалось прочитать обе дорожки записи.');
    }
    // The caller commits the file only after conversion and finalization succeed.
    const stream = new WritableStream({async write(chunk) { await control.check(); await outputFile.write(chunk); }});
    const output = new Output({format: new Mp4OutputFormat({fastStart: false}),
      target: new StreamTarget(stream, {chunked: true})});
    const conversion = await Conversion.init({input, output, tracks: 'primary',
      copy: {mode: 'forced', shiftTolerance: Infinity}, showWarnings: false});
    if (!conversion.isValid || conversion.discardedTracks.length) throw Error('Кодеки этих дорожек несовместимы с MP4.');
    conversion.onProgress = ratio => progress(ratio, 'Собираем видео со звуком · по длительности');
    await conversion.execute();
  } finally { control.signal.removeEventListener('abort', stop); input.dispose(); }
}

export async function transfer(media, file, progress, control) {
  const output = await file.createWritable();
  try {
    if (media.audio) await mux(media, output, progress, control);
    else {
      for (const [i,url] of media.parts.entries()) {
        await control.check();
        const response = await request(url, control.signal);
        if (!response.body || /(?:text\/html|application\/json)/i.test(response.headers.get('content-type') || '')) {
          throw Error('Сервер вернул страницу вместо видео.');
        }
        let bytes = 0;
        const size = Number(response.headers.get('content-length'));
        progress(media.parts.length > 1 ? i/media.parts.length : null, media.parts.length > 1 ? 'Загрузка по фрагментам' : 'Скачиваем видео');
        for await (const chunk of response.body) {
          await control.check();
          await output.write(chunk);
          bytes += chunk.byteLength;
          if (size) progress((i + Math.min(bytes/size,1))/media.parts.length, media.parts.length > 1 ? 'Загрузка по фрагментам' : 'Загрузка по размеру файла');
        }
      }
    }
    await control.check();
    control.committing();
    await output.close();
  } catch (error) { await output.abort().catch(() => {}); throw error; }
}
