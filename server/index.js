import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import { config, dirs, ROOT } from './config.js';
import { CATEGORIES, FORMATS, ALIASES } from './formats.js';
import { initEngines, rescan, allTargets, engineStatus, findRoute, routeSchema, shutdownEngines } from './registry.js';
import { pdfPageSchema } from './engines/imagepdf.js';
import * as store from './jobs.js';
import { UserError, ensureDir, safeName } from './util.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- static assets
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: 0 }));
app.use('/vendor/inter', express.static(path.join(ROOT, 'node_modules', '@fontsource-variable', 'inter'), { maxAge: '7d' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- metadata
function meta() {
  return {
    appName: config.appName,
    categories: CATEGORIES,
    formats: FORMATS,
    aliases: ALIASES,
    targets: allTargets(),
    engines: engineStatus(),
    limits: { maxUploadBytes: config.maxUploadBytes, retentionMinutes: config.retentionMinutes },
  };
}

app.get('/api/meta', (req, res) => res.json(meta()));

app.post('/api/engines/rescan', wrap(async (req, res) => {
  await rescan();
  res.json(meta());
}));

// ---------- uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      req.uploadId = randomUUID();
      const dir = path.join(dirs.uploads, req.uploadId);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (req, file, cb) => cb(null, safeName(originalName(req, file))),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

function originalName(req, file) {
  const header = req.get('x-file-name');
  if (header) {
    try { return decodeURIComponent(header); } catch {}
  }
  // Busboy decodes multipart filenames as latin1; recover UTF-8 names.
  const n = file.originalname || 'file';
  const recoded = Buffer.from(n, 'latin1').toString('utf8');
  return /\uFFFD/.test(recoded) ? n : recoded;
}

app.post('/api/uploads', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new UserError('No file received');
  const name = originalName(req, req.file);
  const up = await store.registerUpload({ id: req.uploadId, filePath: req.file.path, name, size: req.file.size });
  res.json(store.uploadJson(up));
}));

const MIME_EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'text/html': 'html', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

app.post('/api/uploads/url', wrap(async (req, res) => {
  let url;
  try { url = new URL(String(req.body?.url || '').trim()); } catch { throw new UserError('That does not look like a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('Only http and https links are supported');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  let r;
  try {
    r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': `Mozilla/5.0 ${config.appName}/1.0` } });
  } catch (e) {
    clearTimeout(timer);
    throw new UserError(`Could not download the file: ${e.cause?.code || e.message}`);
  }
  if (!r.ok || !r.body) { clearTimeout(timer); throw new UserError(`The server answered ${r.status} ${r.statusText}`); }
  const len = Number(r.headers.get('content-length') || 0);
  if (len > config.maxUploadBytes) { clearTimeout(timer); throw new UserError('The file is larger than the upload limit'); }
  const cd = r.headers.get('content-disposition') || '';
  let name = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
  if (name) name = decodeURIComponent(name);
  else name = (cd.match(/filename="?([^";]+)"?/i) || [])[1];
  if (!name) name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '') || url.hostname;
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const ext = MIME_EXT[(r.headers.get('content-type') || '').split(';')[0].trim()];
    if (ext) name += `.${ext}`;
  }
  name = safeName(name, 'download');
  const id = randomUUID();
  const dir = await ensureDir(path.join(dirs.uploads, id));
  const filePath = path.join(dir, name);
  let size = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > config.maxUploadBytes) controller.error(new UserError('The file is larger than the upload limit'));
      else controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(r.body.pipeThrough(limiter)), fs.createWriteStream(filePath));
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw e.userFacing ? e : new UserError(`Download failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const up = await store.registerUpload({ id, filePath, name, size });
  res.json(store.uploadJson(up));
}));

app.get('/api/uploads/:id', (req, res) => {
  const up = store.getUpload(req.params.id);
  if (!up) return res.status(404).json({ error: 'Upload not found' });
  res.json(store.uploadJson(up));
});

app.delete('/api/uploads/:id', wrap(async (req, res) => {
  await store.deleteUpload(req.params.id);
  res.json({ ok: true });
}));

// ---------- routes & options
app.get('/api/route', (req, res) => {
  const up = req.query.upload ? store.getUpload(String(req.query.upload)) : null;
  const from = up ? up.format : String(req.query.from || '');
  const to = String(req.query.to || '');
  const route = findRoute(from, to);
  if (!route) return res.status(404).json({ error: `No conversion from ${from || 'this file'} to ${to}` });
  res.json({ from, to, steps: routeSchema(route, up?.info || {}) });
});

app.get('/api/merge/schema', (req, res) => res.json({ groups: pdfPageSchema({ multi: true }) }));

// ---------- jobs
app.post('/api/jobs', (req, res) => {
  const { uploadId, to, options } = req.body || {};
  const job = store.createJob({ uploadId, to: String(to || ''), options });
  res.json(store.jobJson(job));
});

app.post('/api/merge', (req, res) => {
  const { uploadIds, options, name } = req.body || {};
  if (!Array.isArray(uploadIds)) throw new UserError('uploadIds must be an array');
  const job = store.createMergeJob({ uploadIds, options, name });
  res.json(store.jobJson(job));
});

app.get('/api/jobs', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 500);
  res.json(ids.map((id) => store.getJob(id)).filter(Boolean).map(store.jobJson));
});

app.get('/api/jobs/:id', (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json(store.jobJson(j));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  store.cancelJob(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/jobs/:id', wrap(async (req, res) => {
  await store.deleteJob(req.params.id);
  res.json({ ok: true });
}));

function contentDisposition(name, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendFile(res, file, inline) {
  res.setHeader('Content-Disposition', contentDisposition(file.name, inline));
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file.path, { dotfiles: 'allow' });
}

function uniqueNames(files) {
  const used = new Map();
  return files.map((f) => {
    let name = f.name;
    const count = used.get(name.toLowerCase()) || 0;
    used.set(name.toLowerCase(), count + 1);
    if (count) name = name.replace(/(\.[^.]+)?$/, ` (${count + 1})$1`);
    return { ...f, name };
  });
}

async function sendZip(res, files, zipName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(zipName));
  res.setHeader('Cache-Control', 'no-store');
  const zip = new ZipArchive({ zlib: { level: 1 } });
  zip.on('warning', () => {});
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  for (const f of uniqueNames(files)) zip.file(f.path, { name: f.name });
  await zip.finalize();
}

app.get('/api/jobs/:id/download', wrap(async (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j || j.status !== 'done') return res.status(404).json({ error: 'Nothing to download' });
  if (j.outputs.length === 1) return sendFile(res, j.outputs[0], req.query.inline === '1');
  const up = store.getUpload(j.uploadId);
  const base = up ? up.name.replace(/\.[^.]+$/, '') : 'converted';
  await sendZip(res, j.outputs, `${base}-${j.to}.zip`);
}));

app.get('/api/jobs/:id/files/:index', (req, res) => {
  const j = store.getJob(req.params.id);
  const f = j?.outputs?.[Number(req.params.index)];
  if (!f) return res.status(404).json({ error: 'File not found' });
  sendFile(res, f, req.query.inline === '1');
});

app.get('/api/download', wrap(async (req, res) => {
  const ids = String(req.query.jobs || '').split(',').filter(Boolean);
  const files = ids.map((id) => store.getJob(id)).filter((j) => j?.status === 'done').flatMap((j) => j.outputs);
  if (!files.length) return res.status(404).json({ error: 'Nothing to download' });
  await sendZip(res, files, `${config.appName.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.zip`);
}));

app.get('/api/health', (req, res) => res.json({ ok: true, ...store.stats() }));

// ---------- errors
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB` : err.message;
    return res.status(413).json({ error: msg });
  }
  if (err.userFacing) return res.status(400).json({ error: err.message, details: err.details });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
});

// ---------- start
async function main() {
  await store.resetStorage();
  await ensureDir(dirs.profiles);
  const status = await initEngines();
  const sweep = setInterval(() => store.sweep().catch(() => {}), 5 * 60 * 1000);
  sweep.unref();
  const server = app.listen(config.port, config.host, () => {
    const on = Object.entries(status).filter(([, s]) => s.available).map(([id]) => id);
    const off = Object.entries(status).filter(([, s]) => !s.available).map(([id]) => id);
    console.log(`\n  ${config.appName} is running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}\n`);
    console.log(`  Engines ready:   ${on.join(', ')}`);
    if (off.length) console.log(`  Not installed:   ${off.join(', ')} (optional)`);
    console.log('');
  });
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  const stop = async () => {
    server.close();
    await shutdownEngines();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
