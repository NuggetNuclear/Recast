import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import { config, dirs, ROOT } from './config.js';
import { CATEGORIES, FORMATS, ALIASES } from './formats.js';
import { initEngines, rescan, allTargets, engineStatus, findRoute, routeSchema, shutdownEngines } from './registry.js';
import { pdfPageSchema } from './engines/imagepdf.js';
import * as store from './jobs.js';
import { startFetch, getFetch, publicFetch, cancelFetch, sweepFetches, resetFetches } from './fetch.js';
import { UserError, ensureDir, safeName } from './util.js';
import { assertId, assertIndex, basicAuthValid, verifyHostAndAuth } from './security.js';

export { verifyHostAndAuth };

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (config.authUser && config.authPassword) {
    if (!basicAuthValid(req.get('authorization'), config.authUser, config.authPassword)) {
      res.set('WWW-Authenticate', 'Basic realm="Recast"');
      return res.status(401).json({ error: 'Authentication required' });
    }
  }
  return next();
});

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
    isDocker: fs.existsSync('/.dockerenv'),
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

app.post('/api/uploads/url', wrap(async (req, res) => {
  const job = startFetch(req.body || {});
  res.status(202).json(publicFetch(job));
}));

app.get('/api/fetches/:id', (req, res) => {
  const job = getFetch(assertId(req.params.id, 'download id'));
  if (!job) return res.status(404).json({ error: 'Download not found' });
  res.json(publicFetch(job));
});

app.post('/api/fetches/:id/cancel', (req, res) => {
  const id = assertId(req.params.id, 'download id');
  cancelFetch(id);
  const job = getFetch(id);
  res.json(job ? publicFetch(job) : { ok: true });
});

app.get('/api/uploads/:id', (req, res) => {
  const up = store.getUpload(assertId(req.params.id, 'upload id'));
  if (!up) return res.status(404).json({ error: 'Upload not found' });
  res.json(store.uploadJson(up));
});

// The imported file as-is, e.g. a video fetched from a link, without converting it.
app.get('/api/uploads/:id/file', (req, res) => {
  const up = store.getUpload(assertId(req.params.id, 'upload id'));
  if (!up) return res.status(404).json({ error: 'Upload not found' });
  sendFile(res, up, req.query.inline === '1');
});

app.delete('/api/uploads/:id', wrap(async (req, res) => {
  await store.deleteUpload(assertId(req.params.id, 'upload id'));
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

// SSE endpoint for live streaming job progress
app.get('/api/jobs/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(': connected\n\n');

  const filterIds = req.query.ids ? new Set(String(req.query.ids).split(',').filter(Boolean)) : null;

  const onUpdate = (job) => {
    if (!filterIds || filterIds.has(job.id)) {
      try {
        const payload = JSON.stringify(store.jobJson(job));
        res.write(`data: ${payload}\n\n`);
      } catch {}
    }
  };

  store.jobEvents.on('update', onUpdate);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    store.jobEvents.off('update', onUpdate);
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = store.getJob(assertId(req.params.id, 'job id'));
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json(store.jobJson(j));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  store.cancelJob(assertId(req.params.id, 'job id'));
  res.json({ ok: true });
});

app.delete('/api/jobs/:id', wrap(async (req, res) => {
  await store.deleteJob(assertId(req.params.id, 'job id'));
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
  const j = store.getJob(assertId(req.params.id, 'job id'));
  if (!j || j.status !== 'done') return res.status(404).json({ error: 'Nothing to download' });
  if (j.outputs.length === 1) return sendFile(res, j.outputs[0], req.query.inline === '1');
  const up = store.getUpload(j.uploadId);
  const base = up ? up.name.replace(/\.[^.]+$/, '') : 'converted';
  await sendZip(res, j.outputs, `${base}-${j.to}.zip`);
}));

app.get('/api/jobs/:id/files/:index', (req, res) => {
  const j = store.getJob(assertId(req.params.id, 'job id'));
  const f = j?.outputs?.[assertIndex(req.params.index)];
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
  verifyHostAndAuth(config.host, config.authUser, config.authPassword);
  await store.resetStorage();
  await resetFetches();
  await ensureDir(dirs.profiles);
  const status = await initEngines();
  const sweep = setInterval(() => { store.sweep().catch(() => {}); sweepFetches(); }, 5 * 60 * 1000);
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

function checkIsMain() {
  if (!process.argv[1]) return false;
  try {
    const a = path.resolve(process.argv[1]);
    const b = fileURLToPath(import.meta.url);
    if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
    return a === b;
  } catch {
    return false;
  }
}

const isMain = checkIsMain();
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
