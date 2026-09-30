// Import a URL: a direct file is saved as-is, and anything else goes through yt-dlp
// (YouTube and the other sites yt-dlp supports) so it can be converted like an upload.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config, dirs } from './config.js';
import * as store from './jobs.js';
import { tools } from './tools.js';
import { run, UserError, ensureDir, rmrf, fileSize, safeName, stripExt } from './util.js';
import { assertSafeUrl, safeAgent } from './security.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PREFERENCES = new Set(['auto', 'best', '1080', '720', '480', 'audio']);
const PLAYLIST_LIMIT = 25;
const MAX_PARALLEL = 2;

const MIME_EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'text/html': 'html', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/webm': 'weba',
  'application/zip': 'zip', 'application/epub+zip': 'epub',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const MEDIA_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', 'm4v', '3gp', '3g2', 'ogv', 'ts', 'mts', 'm2ts', 'vob', 'asf', 'f4v', 'mxf', 'rm', 'rmvb', 'divx', 'm4a', 'm4b', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'ac3', 'eac3', 'dts', 'amr', 'mka', 'weba', 'caf', 'au', 'mp2', 'wv', 'ape']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'ogg', 'opus', 'wma', 'aiff', 'ac3', 'eac3', 'dts', 'amr', 'mka', 'weba', 'caf', 'au', 'mp2', 'wv', 'ape']);
const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa', 'lrc', 'ttml', 'sub']);
const THUMB_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const AUDIO_CONTAINER = {
  aac: 'm4a', mp4a: 'm4a', alac: 'm4a', mp3: 'mp3', opus: 'opus', vorbis: 'ogg', flac: 'flac',
  wmav1: 'wma', wmav2: 'wma', pcm_s16le: 'wav', pcm_s24le: 'wav', pcm_f32le: 'wav', ac3: 'ac3', eac3: 'eac3',
};

const fetches = new Map();
let active = 0;
const waiters = [];
let helpCache = { bin: '', text: null };

const extOf = (file) => path.extname(file).slice(1).toLowerCase();
const isSubtitle = (file) => SUB_EXT.has(extOf(file));

function parseHttpUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new UserError('That does not look like a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('Only http and https links are supported');
  return url;
}

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        waiters.shift()?.();
      });
    };
    if (active >= MAX_PARALLEL) waiters.push(start);
    else start();
  });
}

function ytdlpHelp() {
  const bin = tools.ytDlp;
  if (!bin) return Promise.resolve('');
  if (helpCache.bin === bin && helpCache.text !== null) return Promise.resolve(helpCache.text);
  helpCache = { bin, text: '' };
  return run(bin, ['--help'], { timeoutMs: 30_000, okCodes: [0, 1, 2] })
    .then((r) => { helpCache = { bin, text: `${r.stdout}\n${r.stderr}` }; return helpCache.text; })
    .catch(() => '');
}

function hasFlag(help, flag) {
  if (!help) return false;
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![\\w-])`).test(help);
}

function maxSizeArg() {
  const bytes = config.maxUploadBytes;
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}M`;
  if (bytes % 1024 === 0) return `${bytes / 1024}K`;
  return String(bytes);
}

function canExtractAudio() {
  if (!tools.ffmpeg || !tools.ffprobe) return false;
  if (path.dirname(tools.ffmpeg) === path.dirname(tools.ffprobe)) return true;
  const base = path.basename(tools.ffprobe);
  return (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, base)));
}

function formatArgs(preference, help) {
  if (preference === 'audio') {
    const args = ['-f', 'ba/b'];
    if (canExtractAudio() && hasFlag(help, '--extract-audio')) args.push('-x', '--audio-format', 'best');
    return args;
  }
  const height = { 1080: 1080, 720: 720, 480: 480 }[preference];
  const format = height
    ? `bv*[height<=${height}]+ba/b[height<=${height}]/b[height<=${height}]`
    : 'bv*+ba/b';
  const args = ['-f', format];
  if (hasFlag(help, '--merge-output-format')) args.push('--merge-output-format', 'mkv');
  return args;
}

function cookiesFile() {
  const cookies = process.env.YTDLP_COOKIES;
  if (!cookies) return '';
  try { if (fs.statSync(cookies).isFile()) return cookies; } catch {}
  return '';
}

function friendlyYtError(text) {
  const s = String(text || '');
  const rules = [
    [/Unsupported URL/i, 'yt-dlp does not support this link'],
    [/confirm (?:you.?re|you are) not a bot|Sign in to confirm your age|Use --cookies/i, 'This site asked for a sign-in. Export cookies.txt from your browser and point YTDLP_COOKIES at it.'],
    [/Private video|This video is private/i, 'This video is private'],
    [/Video unavailable|has been removed|account associated with this video/i, 'This video is unavailable'],
    [/HTTP Error 429|Too Many Requests/i, 'The site is rate-limiting downloads. Wait a little and try again.'],
    [/HTTP Error 404|unable to download webpage: HTTP Error 404/i, 'Nothing was found at that link (404)'],
    [/HTTP Error 403/i, 'The site refused the download (403)'],
    [/does not pass filter|live event will begin/i, 'Live streams are skipped'],
    [/larger than max-filesize|File is larger than/i, 'The file is larger than the upload limit'],
    [/ffmpeg not found|ffprobe and ffmpeg not found|ffmpeg or avconv/i, 'ffmpeg is required to finish this download and was not found'],
  ];
  for (const [re, msg] of rules) if (re.test(s)) return msg;
  const line = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^ERROR:/i.test(l)).pop();
  if (line) return line.replace(/^ERROR:\s*/i, '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 280);
  return 'Could not download this link';
}

function trackProgress(job) {
  let buf = '';
  let item = 1;
  let total = 1;
  let lastError = '';
  const push = (line) => {
    const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!text) return;
    if (/^ERROR:/i.test(text)) lastError = text;
    const itemMatch = text.match(/Downloading item (\d+) of (\d+)/i);
    if (itemMatch) {
      item = Number(itemMatch[1]);
      total = Number(itemMatch[2]);
      job.stage = `Item ${item} of ${total}`;
    }
    const pct = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (pct && total) {
      const frac = (Math.max(0, item - 1) + Number(pct[1]) / 100) / total;
      job.progress = Math.max(job.progress || 0, Math.min(0.99, frac));
      if (!/Merging|Extracting|Subtitles/.test(job.stage || '')) {
        job.stage = total > 1 ? `Item ${item} of ${total}` : 'Downloading';
      }
    } else if (/\[Merger\]|\[VideoRemuxer\]|Merging formats/i.test(text)) job.stage = 'Merging';
    else if (/\[ExtractAudio\]/i.test(text)) job.stage = 'Extracting audio';
    else if (/\[EmbedSubtitle\]|\[SubtitlesConvertor\]/i.test(text)) job.stage = 'Subtitles';
  };
  return {
    onChunk(chunk) {
      buf += chunk;
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop() ?? '';
      for (const line of parts) push(line);
    },
    errorText: () => lastError,
  };
}

function isJunk(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) return true;
  if (/\.(part|ytdl|temp|tmp|aria2)$/.test(lower)) return true;
  if (/\.(info\.json|description|annotations\.xml)$/.test(lower)) return true;
  return false;
}

async function collectFiles(dir) {
  let root;
  try { root = await fsp.realpath(dir); } catch { return []; }
  const out = [];
  const walk = async (current) => {
    let entries = [];
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (isJunk(ent.name)) continue;
      const full = path.join(current, ent.name);
      let real;
      try { real = await fsp.realpath(full); } catch { continue; }
      if (real !== root && !real.startsWith(root + path.sep)) continue;
      if (ent.isDirectory()) { await walk(full); continue; }
      if (!ent.isFile()) continue;
      if (await fileSize(full) > 0) out.push(full);
    }
  };
  await walk(dir);
  out.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
  return out;
}

function keepUseful(files, playlist) {
  const media = files.filter((f) => MEDIA_EXT.has(extOf(f)) || AUDIO_EXT.has(extOf(f)));
  const subs = files.filter((f) => isSubtitle(f));
  const rest = files.filter((f) => !media.includes(f) && !subs.includes(f));
  const thumbs = new Set(rest.filter((f) => {
    if (!THUMB_EXT.has(extOf(f))) return false;
    try { return fs.statSync(f).size < 2 * 1024 * 1024; } catch { return false; }
  }));
  const other = rest.filter((f) => !thumbs.has(f) || !media.length);
  const limitedMedia = media.slice(0, playlist ? PLAYLIST_LIMIT : 3);
  const limitedSubs = subs.slice(0, playlist ? PLAYLIST_LIMIT : 6);
  const limitedOther = other.slice(0, playlist ? 10 : 3);
  return [...limitedMedia, ...limitedSubs, ...limitedOther];
}

async function publish(filePath) {
  const size = await fileSize(filePath);
  if (!size) return null;
  if (size > config.maxUploadBytes) throw new UserError('The file is larger than the upload limit');
  const id = randomUUID();
  const name = safeName(path.basename(filePath), 'download');
  const dir = await ensureDir(path.join(dirs.uploads, id));
  const dest = path.join(dir, name);
  try {
    await fsp.rename(filePath, dest);
  } catch {
    await fsp.copyFile(filePath, dest);
    await fsp.rm(filePath, { force: true });
  }
  const up = await store.registerUpload({ id, filePath: dest, name, size });
  return store.uploadJson(up);
}

async function ensureAudio(file, signal) {
  if (!tools.ffmpeg) return file;
  if (AUDIO_EXT.has(extOf(file))) return file;
  let info = '';
  try {
    const probed = await run(tools.ffmpeg, ['-hide_banner', '-i', file], { signal, okCodes: [0, 1], timeoutMs: 60_000 });
    info = `${probed.stderr}\n${probed.stdout}`;
  } catch (e) {
    if (signal?.aborted) throw e;
    return file;
  }
  const lines = [...info.matchAll(/Stream #\d+:\d+[^\n]*/g)].map((m) => m[0]);
  const hasVideo = lines.some((l) => /: Video:/.test(l) && !/attached pic/i.test(l));
  const codec = (lines.find((l) => /: Audio:/.test(l)) || '').match(/: Audio: ([A-Za-z0-9_]+)/)?.[1]?.toLowerCase() || '';
  if (!codec) return file;
  if (!hasVideo && AUDIO_EXT.has(extOf(file))) return file;
  const ext = AUDIO_CONTAINER[codec] || 'm4a';
  const base = stripExt(path.basename(file));
  let dest = path.join(path.dirname(file), `${base}.${ext}`);
  if (dest === file) return file;
  const copy = ['-y', '-i', file, '-vn', '-map', '0:a:0', '-c:a', 'copy', dest];
  try {
    await run(tools.ffmpeg, copy, { signal, timeoutMs: 30 * 60 * 1000, errorMessage: 'Could not extract the audio' });
  } catch (e) {
    if (signal?.aborted) throw e;
    await fsp.rm(dest, { force: true }).catch(() => {});
    dest = path.join(path.dirname(file), `${base}.m4a`);
    await run(tools.ffmpeg, ['-y', '-i', file, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', dest], { signal, timeoutMs: 30 * 60 * 1000, errorMessage: 'Could not extract the audio' });
  }
  if (dest !== file) await fsp.rm(file, { force: true }).catch(() => {});
  return dest;
}

function filenameFrom(url, headers, type) {
  const cd = headers.get('content-disposition') || '';
  let name = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
  if (name) { try { name = decodeURIComponent(name); } catch { /* keep the raw token */ } }
  else name = (cd.match(/filename="?([^";]+)"?/i) || [])[1];
  if (!name) {
    try { name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; }
  }
  if (!name) name = url.hostname || 'download';
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const ext = MIME_EXT[type];
    if (ext && ext !== 'html') name += `.${ext}`;
  }
  return safeName(path.basename(name), 'download');
}

async function downloadDirect(url, job, { rejectHtml }) {
  job.stage = 'Downloading';
  const signal = job.controller.signal;
  let r;
  try {
    let current = await assertSafeUrl(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      r = await fetch(current, { signal, redirect: 'manual', headers: { 'user-agent': UA, accept: '*/*' }, dispatcher: safeAgent });
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      const location = r.headers.get('location');
      if (!location) break;
      await r.body?.cancel().catch(() => {});
      current = await assertSafeUrl(new URL(location, current));
    }
  } catch (e) {
    if (signal.aborted) throw new UserError(job.timedOut ? 'The download timed out' : 'Cancelled');
    throw new UserError(`Could not download the file: ${e.cause?.code || e.message}`);
  }
  if (!r.ok || !r.body) throw new UserError(`The server answered ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`);
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (rejectHtml && (type === 'text/html' || type === 'application/xhtml+xml')) {
    await r.body.cancel().catch(() => {});
    throw new UserError('This looks like a web page, not a file. Install yt-dlp (Engines → Rescan) to download YouTube and most other sites.');
  }
  const len = Number(r.headers.get('content-length') || 0);
  if (len > config.maxUploadBytes) {
    await r.body.cancel().catch(() => {});
    throw new UserError('The file is larger than the upload limit');
  }
  const filePath = path.join(job.dir, filenameFrom(url, r.headers, type));
  let size = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > config.maxUploadBytes) controller.error(new UserError('The file is larger than the upload limit'));
      else {
        if (len) job.progress = Math.max(job.progress || 0, Math.min(0.99, size / len));
        controller.enqueue(chunk);
      }
    },
  });
  try {
    await pipeline(Readable.fromWeb(r.body.pipeThrough(limiter)), fs.createWriteStream(filePath));
  } catch (e) {
    if (signal.aborted) throw new UserError(job.timedOut ? 'The download timed out' : 'Cancelled');
    throw e.userFacing ? e : new UserError(`Download failed: ${e.message}`);
  }
  if (!size) throw new UserError('The link returned an empty file');
  return [filePath];
}

async function probeKind(url, signal) {
  let r;
  try {
    r = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      headers: { 'user-agent': UA, accept: '*/*', range: 'bytes=0-0' },
      dispatcher: safeAgent,
    });
  } catch (e) {
    if (signal.aborted) throw new UserError('Cancelled');
    return 'unknown';
  }
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  await r.body?.cancel().catch(() => {});
  if (!r.ok && r.status !== 206) return 'unknown';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'page';
  const ext = path.extname(url.pathname).slice(1).toLowerCase();
  if ((!type || type.includes('json')) && !ext) return 'unknown';
  return 'file';
}

async function downloadMedia(job, opts) {
  if (!tools.ytDlp) {
    throw new UserError('yt-dlp is not installed. Install it, then choose Engines → Rescan.');
  }
  job.stage = 'Starting';
  const help = await ytdlpHelp();
  const tpl = opts.playlist
    ? '%(playlist_index)02d - %(title).140B [%(id)s].%(ext)s'
    : '%(title).180B [%(id)s].%(ext)s';
  const args = [];
  if (hasFlag(help, '--ignore-config')) args.push('--ignore-config');
  if (hasFlag(help, '--newline')) args.push('--newline');
  if (hasFlag(help, '--progress')) args.push('--progress');
  if (hasFlag(help, '--no-overwrites')) args.push('--no-overwrites');
  if (help && help.includes('--windows-filenames')) args.push('--windows-filenames');
  else if (hasFlag(help, '--restrict-filenames')) args.push('--restrict-filenames');
  if (help && /\s--color(\s|$)/.test(help)) args.push('--color', 'never');
  args.push('--retries', '10', '--fragment-retries', '10', '--socket-timeout', '30');
  if (hasFlag(help, '--concurrent-fragments')) args.push('--concurrent-fragments', '4');
  if (hasFlag(help, '--no-mtime')) args.push('--no-mtime');
  if (hasFlag(help, '--no-write-thumbnail')) args.push('--no-write-thumbnail');
  if (hasFlag(help, '--embed-metadata')) args.push('--embed-metadata');
  if (opts.preference !== 'audio' && hasFlag(help, '--embed-chapters')) args.push('--embed-chapters');
  if (hasFlag(help, '--match-filters')) args.push('--match-filters', '!is_live');
  else if (hasFlag(help, '--match-filter')) args.push('--match-filter', '!is_live');
  args.push('--max-filesize', maxSizeArg());
  if (tools.ffmpeg && hasFlag(help, '--ffmpeg-location')) args.push('--ffmpeg-location', path.dirname(tools.ffmpeg));
  if (help && help.includes('--js-runtimes')) args.push('--js-runtimes', `node:${process.execPath}`);
  if (help && help.includes('--remote-components')) args.push('--remote-components', 'ejs:github');
  const cookies = cookiesFile();
  if (cookies && hasFlag(help, '--cookies')) args.push('--cookies', cookies);
  args.push(...formatArgs(opts.preference === 'auto' ? 'best' : opts.preference, help));
  if (opts.playlist) {
    if (hasFlag(help, '--yes-playlist')) args.push('--yes-playlist');
    if (hasFlag(help, '--playlist-items')) args.push('--playlist-items', `1:${PLAYLIST_LIMIT}`);
    else if (hasFlag(help, '--playlist-end')) args.push('--playlist-end', String(PLAYLIST_LIMIT));
    if (hasFlag(help, '--ignore-errors')) args.push('--ignore-errors');
  } else if (hasFlag(help, '--no-playlist')) args.push('--no-playlist');
  if (opts.subtitles && opts.preference !== 'audio') {
    if (hasFlag(help, '--write-subs')) args.push('--write-subs');
    if (hasFlag(help, '--write-auto-subs')) args.push('--write-auto-subs');
    if (hasFlag(help, '--sub-langs')) args.push('--sub-langs', 'en,-live_chat');
    if (tools.ffmpeg && hasFlag(help, '--convert-subs')) args.push('--convert-subs', 'srt');
    // A failed subtitle request must not cancel the video that comes after it.
    if (hasFlag(help, '--ignore-errors')) args.push('--ignore-errors');
  }
  args.push('-o', path.join(job.dir, tpl), opts.url.href);

  const tracker = trackProgress(job);
  try {
    await run(tools.ytDlp, args, {
      cwd: job.dir,
      signal: job.controller.signal,
      timeoutMs: config.jobTimeoutMs + 30_000,
      killGroup: true,
      onStdout: tracker.onChunk,
      onStderr: tracker.onChunk,
      errorMessage: 'Could not download this link',
      timeoutMessage: 'The download timed out',
    });
  } catch (e) {
    if (job.controller.signal.aborted) throw new UserError(job.timedOut ? 'The download timed out' : 'Cancelled');
    const files = keepUseful(await collectFiles(job.dir), opts.playlist);
    const gotMedia = files.some((f) => MEDIA_EXT.has(extOf(f)) || AUDIO_EXT.has(extOf(f)));
    if (gotMedia) return files;
    const raw = `${tracker.errorText()}\n${e.details || ''}\n${e.message || ''}`;
    throw new UserError(friendlyYtError(raw), e.details || tracker.errorText() || null);
  }
  const files = keepUseful(await collectFiles(job.dir), opts.playlist);
  if (!files.length) throw new UserError('The download produced no file. It may be larger than the upload limit, or the link has no media.');
  return files;
}

async function downloadAuto(job, opts) {
  job.stage = 'Looking at the link';
  const kind = await probeKind(opts.url, job.controller.signal);
  if (kind === 'file') return downloadDirect(opts.url, job, { rejectHtml: false });
  if (!tools.ytDlp) return downloadDirect(opts.url, job, { rejectHtml: kind === 'page' });
  try {
    return await downloadMedia(job, opts);
  } catch (e) {
    if (job.controller.signal.aborted || kind === 'page') throw e;
    const blob = `${e.message}\n${e.details || ''}`;
    if (!/Unsupported URL|does not support this link/i.test(blob)) throw e;
    job.progress = 0;
    return downloadDirect(opts.url, job, { rejectHtml: false });
  }
}

async function execute(job, opts) {
  let published = [];
  try {
    opts.url = await assertSafeUrl(opts.url);
    if (active >= MAX_PARALLEL) job.stage = 'Waiting';
    await withSlot(async () => {
      if (job.controller.signal.aborted) throw new UserError(job.timedOut ? 'The download timed out' : 'Cancelled');
      job.dir = await ensureDir(path.join(dirs.fetches, job.id));
      let files = opts.preference === 'auto' ? await downloadAuto(job, opts) : await downloadMedia(job, opts);
      if (opts.preference === 'audio') {
        const next = [];
        for (const file of files) {
          if (job.controller.signal.aborted) throw new UserError(job.timedOut ? 'The download timed out' : 'Cancelled');
          next.push(isSubtitle(file) ? file : await ensureAudio(file, job.controller.signal));
        }
        files = next;
      }
      const uploads = [];
      for (let i = 0; i < files.length; i++) {
        if (job.controller.signal.aborted) throw new UserError(job.timedOut ? 'The download timed out' : 'Cancelled');
        job.stage = files.length > 1 ? `Checking file ${i + 1} of ${files.length}` : 'Checking the file';
        const up = await publish(files[i]);
        if (up) uploads.push(up);
      }
      if (!uploads.length) throw new UserError('The download produced no file');
      published = uploads;
    });
    job.uploads = published;
    job.status = 'done';
    job.progress = 1;
    job.stage = published.length > 1 ? `Added ${published.length} files` : 'Done';
  } catch (err) {
    await Promise.all(published.map((u) => store.deleteUpload(u.id).catch(() => {})));
    job.uploads = [];
    if (job.timedOut) {
      job.status = 'error';
      job.stage = 'Failed';
      job.error = 'The download timed out';
    } else if (job.controller.signal.aborted || err?.message === 'Cancelled') {
      job.status = 'cancelled';
      job.stage = 'Cancelled';
      job.error = 'Cancelled';
    } else {
      job.status = 'error';
      job.stage = 'Failed';
      job.error = err?.userFacing ? err.message : 'Could not download this link';
      job.details = err?.userFacing ? (err.details || null) : null;
      if (!err?.userFacing) console.error(`[fetch ${job.id}]`, err);
    }
  } finally {
    clearTimeout(job.timer);
    if (job.dir) await rmrf(job.dir);
  }
}

export function startFetch(body = {}) {
  const url = parseHttpUrl(body?.url);
  const preference = PREFERENCES.has(body?.preference) ? body.preference : 'auto';
  const playlist = body?.playlist === true;
  const subtitles = body?.subtitles === true;
  if (preference !== 'auto' && !tools.ytDlp) {
    throw new UserError('yt-dlp is not installed. Install it, then choose Engines → Rescan.');
  }
  const job = {
    id: randomUUID(),
    status: 'working',
    progress: 0,
    stage: 'Starting',
    error: null,
    details: null,
    uploads: [],
    controller: new AbortController(),
    createdAt: Date.now(),
    timedOut: false,
  };
  job.timer = setTimeout(() => {
    job.timedOut = true;
    job.controller.abort();
  }, config.jobTimeoutMs);
  fetches.set(job.id, job);
  execute(job, { url, preference, playlist, subtitles });
  return job;
}

export const getFetch = (id) => fetches.get(id);

export function publicFetch(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round((job.progress || 0) * 1000) / 1000,
    stage: job.stage,
    error: job.error,
    details: job.details,
    uploads: job.status === 'done' ? job.uploads : [],
  };
}

export function cancelFetch(id) {
  const job = fetches.get(id);
  if (!job || job.status !== 'working') return false;
  job.controller.abort();
  return true;
}

export function sweepFetches() {
  const cutoff = Date.now() - config.retentionMinutes * 60 * 1000;
  for (const [id, job] of fetches) {
    if (job.status !== 'working' && job.createdAt < cutoff) fetches.delete(id);
  }
}

export async function resetFetches() {
  for (const job of fetches.values()) job.controller.abort();
  fetches.clear();
  await rmrf(dirs.fetches);
  await ensureDir(dirs.fetches);
}
