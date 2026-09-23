// Imports from links: plain file downloads, or video/audio pages (YouTube, Vimeo, SoundCloud…) through yt-dlp.
// Imports run in the background; the UI polls their progress.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config, dirs } from './config.js';
import { FORMATS, detectFormat } from './formats.js';
import { tools, versionOf } from './tools.js';
import * as store from './jobs.js';
import { UserError, ensureDir, rmrf, run, safeName } from './util.js';

const imports = new Map();

const MIME_EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'text/html': 'html', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'application/zip': 'zip',
  'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/opus': 'opus',
  'application/epub+zip': 'epub', 'application/x-mobipocket-ebook': 'mobi', 'application/x-7z-compressed': '7z', 'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar', 'application/gzip': 'gz', 'application/x-tar': 'tar', 'application/msword': 'doc', 'application/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/vnd.oasis.opendocument.text': 'odt',
};

export const QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360'];

export function importJson(i) {
  return { id: i.id, status: i.status, stage: i.stage, progress: i.progress, error: i.error, details: i.details, upload: i.upload ? store.uploadJson(i.upload) : undefined };
}

export const getImport = (id) => imports.get(id);

export function cancelImport(id) {
  const i = imports.get(id);
  if (i?.status === 'running') i.ctrl.abort();
  return !!i;
}

export function startImport({ url: raw, mode = 'auto', quality = 'best' }) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new UserError('That does not look like a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('Only http and https links are supported');
  if (!['auto', 'video', 'audio', 'file'].includes(mode)) mode = 'auto';
  if (!QUALITIES.includes(String(quality))) quality = 'best';
  if ((mode === 'video' || mode === 'audio') && !tools.ytdlp) throw new UserError('yt-dlp is not installed, so video pages cannot be downloaded');

  const imp = { id: randomUUID(), status: 'running', stage: 'Connecting…', progress: null, ctrl: new AbortController(), createdAt: Date.now() };
  imports.set(imp.id, imp);
  (async () => {
    const dir = await ensureDir(path.join(dirs.uploads, imp.id));
    try {
      const timer = setTimeout(() => imp.ctrl.abort(new UserError('The download timed out')), config.jobTimeoutMs);
      let file;
      try {
        file = mode === 'file' || mode === 'auto' ? await direct(url, dir, imp, mode === 'auto' && !!tools.ytdlp) : null;
        if (!file) {
          try {
            file = await ytdlp(url, dir, imp, mode === 'audio', quality);
          } catch (e) {
            // A plain web page in automatic mode: keep it as an HTML file.
            if (mode !== 'auto' || !e.unsupported) throw e;
            file = await direct(url, dir, imp, false);
          }
        }
      } finally {
        clearTimeout(timer);
      }
      imp.stage = 'Reading file…';
      imp.upload = await store.registerUpload({ id: imp.id, filePath: file.path, name: file.name, size: file.size });
      imp.status = 'done';
    } catch (e) {
      await rmrf(dir);
      imp.status = 'error';
      const reason = imp.ctrl.signal.reason;
      imp.error = imp.ctrl.signal.aborted ? (reason?.userFacing ? reason.message : 'Cancelled') : e.userFacing ? e.message : `Download failed: ${e.message}`;
      imp.details = e.details;
    } finally {
      imp.finishedAt = Date.now();
    }
  })();
  return imp;
}

// Plain HTTP download. With `fallback`, returns null when the link is a web page (or fails)
// so the caller can hand it to yt-dlp instead.
async function direct(url, dir, imp, fallback) {
  let r;
  try {
    r = await fetch(url, { signal: imp.ctrl.signal, redirect: 'follow', headers: { 'user-agent': `Mozilla/5.0 ${config.appName}/1.0` } });
  } catch (e) {
    if (imp.ctrl.signal.aborted) throw e;
    if (fallback) return null;
    throw new UserError(`Could not download the file: ${e.cause?.code || e.message}`);
  }
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (fallback && (!r.ok || !r.body || type === 'text/html' || type === 'application/xhtml+xml')) {
    await r.body?.cancel().catch(() => {});
    return null;
  }
  if (!r.ok || !r.body) throw new UserError(`The server answered ${r.status} ${r.statusText}`);
  const total = Number(r.headers.get('content-length') || 0);
  if (total > config.maxUploadBytes) { await r.body.cancel().catch(() => {}); throw new UserError('The file is larger than the upload limit'); }

  const cd = r.headers.get('content-disposition') || '';
  let name = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
  if (name) name = decodeURIComponent(name);
  else name = (cd.match(/filename="?([^";]+)"?/i) || [])[1];
  const fromPath = !name && decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  if (!name) name = fromPath || url.hostname;
  const ext = MIME_EXT[type];
  // Add the extension when the name has none, or only a fake one (example.com, 11.epub3.images).
  if (ext && detectFormat(name) !== ext && (fromPath === '' || !FORMATS[detectFormat(name)])) name += `.${ext}`;
  name = safeName(name, 'download');

  const filePath = path.join(dir, name);
  let size = 0;
  imp.stage = 'Downloading…';
  const counter = new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > config.maxUploadBytes) return controller.error(new UserError('The file is larger than the upload limit'));
      if (total) imp.progress = size / total;
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(r.body.pipeThrough(counter)), fs.createWriteStream(filePath));
  return { path: filePath, name, size };
}

async function ytdlp(url, dir, imp, audioOnly, quality) {
  if (!tools.ytdlp) throw new UserError('This link is a web page, not a file. Install yt-dlp to download videos from sites like YouTube.');
  imp.stage = 'Looking up the video…';
  imp.progress = null;
  // Highest resolution first; at equal resolution prefer H.264/AAC in MP4, which plays everywhere.
  const sort = `${quality === 'best' ? 'res' : `res:${quality}`},vcodec:h264,ext:mp4:m4a`;
  const args = [
    '--no-playlist', '--newline', '--no-colors', '--no-mtime', '--progress',
    '-N', '4',
    '-P', dir,
    '-o', '%(title).150B [%(id)s].%(ext)s',
    '--max-filesize', String(config.maxUploadBytes),
    '--js-runtimes', `node:${process.execPath}`,
    '--progress-template', 'download:[recast] %(info.vcodec)s|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
    ...(tools.ffmpeg ? ['--ffmpeg-location', tools.ffmpeg] : []),
    ...(process.env.YTDLP_COOKIES && fs.existsSync(process.env.YTDLP_COOKIES) ? ['--cookies', process.env.YTDLP_COOKIES] : []),
    ...(audioOnly ? ['-f', 'ba/b', '-x'] : ['-S', sort, '--merge-output-format', 'mp4']),
    '--', url.href,
  ];
  let buf = '';
  const onStdout = (s) => {
    buf += s;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('[recast] ')) {
        const [vcodec, status, done, total, estimate] = line.slice(9).split('|');
        const t = Number(total) || Number(estimate) || 0;
        imp.stage = audioOnly ? 'Downloading audio…' : vcodec === 'none' ? 'Downloading audio track…' : 'Downloading video…';
        imp.progress = status === 'finished' ? 1 : t ? Math.min(1, Number(done) / t) : null;
      } else if (/^\[(Merger|VideoConvertor|VideoRemuxer)\]/.test(line)) {
        imp.stage = 'Merging video and audio…';
        imp.progress = null;
      } else if (/^\[ExtractAudio\]/.test(line)) {
        imp.stage = 'Extracting audio…';
        imp.progress = null;
      }
    }
  };
  try {
    await run(tools.ytdlp, args, { signal: imp.ctrl.signal, onStdout, errorMessage: 'yt-dlp could not download this link' });
  } catch (e) {
    if (imp.ctrl.signal.aborted) throw e;
    const err = (e.details || '').split(/\r?\n/).filter((l) => l.startsWith('ERROR:')).pop();
    if (err) {
      const ue = new UserError(explain(err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '')), e.details);
      ue.unsupported = /Unsupported URL/i.test(err);
      throw ue;
    }
    throw e;
  }
  const files = (await fsp.readdir(dir)).filter((n) => !/\.(part|ytdl|temp)$|\.part-Frag|\.f\d+\./i.test(n));
  if (!files.length) throw new UserError('yt-dlp finished but produced no file (it may exceed the upload limit)');
  const stats = await Promise.all(files.map(async (n) => ({ n, size: (await fsp.stat(path.join(dir, n))).size })));
  const best = stats.sort((a, b) => b.size - a.size)[0];
  const name = safeName(best.n, 'video');
  const filePath = path.join(dir, name);
  if (name !== best.n) await fsp.rename(path.join(dir, best.n), filePath);
  return { path: filePath, name, size: best.size };
}

function explain(msg) {
  if (/Unsupported URL/i.test(msg)) return 'This link is neither a file nor a page yt-dlp knows how to download';
  if (/confirm you.?re not a bot|Sign in to confirm/i.test(msg)) return 'YouTube is asking to sign in. Export your browser cookies to a cookies.txt file and set YTDLP_COOKIES (see README).';
  if (/larger than max-filesize|File is larger/i.test(msg)) return 'The video is larger than the upload limit (MAX_UPLOAD_MB)';
  return msg;
}

export function sweepImports() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, i] of imports) if (i.finishedAt && i.finishedAt < cutoff) imports.delete(id);
}

// Shown in the Engines panel.
export default {
  id: 'ytdlp',
  label: 'yt-dlp',
  optional: { install: 'pip install -U "yt-dlp[default]"', url: 'https://github.com/yt-dlp/yt-dlp', adds: 'downloading videos and audio from YouTube, Vimeo, SoundCloud and 1,800+ other sites via Add from URL' },
  async detect() {
    if (!tools.ytdlp) return { available: false };
    const v = await versionOf(tools.ytdlp, ['--version'], /(\d{4}\.\d+\.\d+)/);
    return { available: true, version: `yt-dlp ${v || ''}`.trim(), detail: 'Add from URL → video and audio pages' };
  },
  routes: () => [],
};
