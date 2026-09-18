// Uploads, conversion jobs, the work queue and periodic clean-up.
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, dirs } from './config.js';
import { detectFormat } from './formats.js';
import { findRoute, getEngine, probeFile } from './registry.js';
import { mergeToPdf } from './engines/imagepdf.js';
import { UserError, ensureDir, rmrf, fileSize, safeName, stripExt } from './util.js';

const uploads = new Map();
const jobs = new Map();
const queue = [];
let running = 0;

// ---------- uploads

export async function registerUpload({ id, filePath, name, size }) {
  const format = detectFormat(name);
  const up = { id, name, format, size, path: filePath, createdAt: Date.now(), info: {} };
  uploads.set(id, up);
  up.info = await Promise.race([probeFile(filePath, format), new Promise((r) => setTimeout(() => r({}), 15000))]).catch(() => ({}));
  return up;
}

export const getUpload = (id) => uploads.get(id);

export async function deleteUpload(id) {
  const up = uploads.get(id);
  if (!up) return false;
  uploads.delete(id);
  await rmrf(path.dirname(up.path));
  return true;
}

export const uploadJson = (u) => ({ id: u.id, name: u.name, format: u.format, size: u.size, info: publicInfo(u.info) });

function publicInfo(info = {}) {
  const out = { ...info };
  delete out.streams;
  if (out.video) out.video = { width: out.video.width, height: out.video.height, fps: out.video.fps, codec: out.video.codec };
  if (out.audio) out.audio = out.audio.map((a) => ({ codec: a.codec, lang: a.lang, channels: a.channels, sampleRate: a.sampleRate, layout: a.layout }));
  if (out.subtitles) out.subtitles = out.subtitles.map((s) => ({ codec: s.codec, lang: s.lang, bitmap: s.bitmap }));
  return out;
}

// ---------- jobs

export function jobJson(j) {
  return {
    id: j.id,
    kind: j.kind,
    uploadId: j.uploadId,
    to: j.to,
    status: j.status,
    progress: Math.round(j.progress * 1000) / 1000,
    stage: j.stage,
    error: j.error,
    details: j.details,
    outputs: j.outputs.map((o, i) => ({ index: i, name: o.name, size: o.size })),
    steps: j.steps?.map((s) => ({ engine: s.engine, from: s.from, to: s.to })),
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    queuePosition: j.status === 'queued' ? queue.indexOf(j.id) + 1 : undefined,
  };
}

export function createJob({ uploadId, to, options }) {
  const up = uploads.get(uploadId);
  if (!up) throw new UserError('The uploaded file has expired — please add it again');
  const route = findRoute(up.format, to);
  if (!route) throw new UserError(`Converting ${up.format ? up.format.toUpperCase() : 'this file'} to ${to.toUpperCase()} is not supported`);
  const job = newJob({ kind: 'convert', uploadId, to, steps: route.steps, options: Array.isArray(options) ? options : [options || {}] });
  enqueue(job);
  return job;
}

export function createMergeJob({ uploadIds, options, name }) {
  const items = uploadIds.map((id) => uploads.get(id));
  if (items.some((x) => !x)) throw new UserError('Some files have expired — please add them again');
  if (items.length < 2) throw new UserError('Choose at least two files to merge');
  const job = newJob({ kind: 'merge', uploadIds, to: 'pdf', options: [options || {}], mergeName: safeName(name || 'merged') });
  enqueue(job);
  return job;
}

function newJob(fields) {
  const job = { id: randomUUID(), status: 'queued', progress: 0, stage: 'Waiting', error: null, details: null, outputs: [], createdAt: Date.now(), ...fields };
  jobs.set(job.id, job);
  return job;
}

export const getJob = (id) => jobs.get(id);

export async function deleteJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.status === 'queued') queue.splice(queue.indexOf(id), 1);
  j.controller?.abort();
  jobs.delete(id);
  await rmrf(path.join(dirs.jobs, id));
  return true;
}

export function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.status === 'queued') {
    queue.splice(queue.indexOf(id), 1);
    j.status = 'cancelled';
    j.stage = 'Cancelled';
  } else if (j.status === 'processing') j.controller?.abort();
  return true;
}

function enqueue(job) {
  queue.push(job.id);
  pump();
}

function pump() {
  while (running < config.concurrency && queue.length) {
    const job = jobs.get(queue.shift());
    if (!job) continue;
    running++;
    run(job).finally(() => {
      running--;
      pump();
    });
  }
}

const STAGE = { image: 'Processing image', media: 'Encoding', subtitle: 'Converting subtitles', pdf: 'Processing document', imagepdf: 'Building PDF', browser: 'Rendering', markup: 'Converting', data: 'Converting data', sheet: 'Converting spreadsheet', archive: 'Repacking', font: 'Converting font', trace: 'Tracing', office: 'LibreOffice', pandoc: 'Pandoc', ebook: 'Calibre' };

async function run(job) {
  job.status = 'processing';
  job.startedAt = Date.now();
  job.controller = new AbortController();
  const timer = setTimeout(() => job.controller.abort(), config.jobTimeoutMs);
  const signal = job.controller.signal;
  const jobDir = path.join(dirs.jobs, job.id);
  try {
    await ensureDir(jobDir);
    if (job.kind === 'merge') await runMerge(job, jobDir, signal);
    else await runConvert(job, jobDir, signal);
    if (signal.aborted) throw new UserError('Cancelled');
    job.status = 'done';
    job.progress = 1;
    job.stage = 'Done';
  } catch (err) {
    const cancelled = signal.aborted && Date.now() - job.startedAt < config.jobTimeoutMs;
    job.status = cancelled ? 'cancelled' : 'error';
    job.stage = cancelled ? 'Cancelled' : 'Failed';
    job.error = cancelled ? 'Cancelled' : err.userFacing ? err.message : 'Unexpected error during conversion';
    job.details = err.userFacing ? err.details || null : String(err.stack || err.message || err).split('\n').slice(0, 6).join('\n');
    if (!err.userFacing) console.error(`[job ${job.id}]`, err);
  } finally {
    clearTimeout(timer);
    job.finishedAt = Date.now();
    delete job.controller;
  }
}

async function runConvert(job, jobDir, signal) {
  const up = uploads.get(job.uploadId);
  if (!up) throw new UserError('The uploaded file has expired');
  let files = [{ path: up.path, name: up.name }];
  const n = job.steps.length;
  for (let i = 0; i < n; i++) {
    const step = job.steps[i];
    const engine = getEngine(step.engine);
    const outDir = await ensureDir(path.join(jobDir, i === n - 1 ? 'out' : `step${i}`));
    const produced = [];
    job.stage = n > 1 ? `${STAGE[engine.id] || 'Converting'} · step ${i + 1}/${n}` : STAGE[engine.id] || 'Converting';
    for (let k = 0; k < files.length; k++) {
      if (signal.aborted) throw new UserError('Cancelled');
      const file = files[k];
      const baseName = safeName(stripExt(file.name), 'file');
      const outs = await engine.convert({
        input: file.path,
        from: step.from,
        to: step.to,
        o: job.options[i] || {},
        outDir,
        baseName,
        tmpDir: path.join(jobDir, `tmp${i}-${k}`),
        signal,
        info: i === 0 ? up.info : null,
        originalName: file.name,
        progress: (p) => {
          const frac = (i + (k + Math.max(0, Math.min(1, p))) / files.length) / n;
          job.progress = Math.max(job.progress, Math.min(0.99, frac));
        },
      });
      for (const o of outs) produced.push({ path: o, name: path.basename(o) });
    }
    if (!produced.length) throw new UserError('The conversion produced no output');
    files = produced;
    job.progress = Math.max(job.progress, (i + 1) / n * 0.99);
  }
  job.outputs = await Promise.all(files.map(async (f) => ({ name: f.name, path: f.path, size: await fileSize(f.path) })));
}

async function runMerge(job, jobDir, signal) {
  job.stage = 'Merging';
  const outDir = await ensureDir(path.join(jobDir, 'out'));
  const items = job.uploadIds.map((id) => uploads.get(id)).map((u) => ({ path: u.path, format: u.format, name: u.name }));
  const out = path.join(outDir, `${job.mergeName}.pdf`);
  await mergeToPdf(items, job.options[0] || {}, out, { tmpDir: path.join(jobDir, 'tmp'), progress: (p) => { job.progress = Math.min(0.99, p); } });
  if (signal.aborted) throw new UserError('Cancelled');
  job.outputs = [{ name: path.basename(out), path: out, size: await fileSize(out) }];
}

// ---------- clean-up

export async function sweep() {
  const cutoff = Date.now() - config.retentionMinutes * 60 * 1000;
  for (const [id, u] of uploads) if (u.createdAt < cutoff && ![...jobs.values()].some((j) => j.status === 'processing' && (j.uploadId === id || j.uploadIds?.includes(id)))) await deleteUpload(id);
  for (const [id, j] of jobs) if ((j.finishedAt || j.createdAt) < cutoff && j.status !== 'processing') await deleteJob(id);
}

export async function resetStorage() {
  await rmrf(dirs.uploads);
  await rmrf(dirs.jobs);
  await ensureDir(dirs.uploads);
  await ensureDir(dirs.jobs);
}

export function stats() {
  return { uploads: uploads.size, jobs: jobs.size, running, queued: queue.length };
}

