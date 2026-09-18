import { h, $, formatBytes, formatDuration, detectFormat, storage } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { openPicker, closePicker } from './picker.js';
import { renderForm, mergeValues, isCustomized, routeDefaults } from './form.js';
import { toast, modal, drawer, copyText } from './ui.js';
import { renderFormats } from './formats.js';

const state = {
  meta: null,
  rows: [],
  preset: null,
  polling: null,
};
let seq = 0;
const MAX_PARALLEL_UPLOADS = 3;
const THUMBABLE = new Set(['jpg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);
const VIEWABLE = new Set(['jpg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'apng', 'pdf', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'txt', 'md', 'json', 'html', 'csv', 'xml', 'yaml', 'srt', 'vtt']);
const ACTIVE = ['queued', 'processing'];
const POPULAR = [['heic', 'jpg'], ['pdf', 'docx'], ['mp4', 'mp3'], ['png', 'svg'], ['md', 'pdf'], ['docx', 'pdf'], ['mov', 'mp4'], ['xlsx', 'csv'], ['jpg', 'webp'], ['mp4', 'gif']];

// ---------------------------------------------------------------- helpers

const fmtCat = (f) => state.meta.formats[f]?.category || 'other';
const targetsOf = (fmt) => state.meta.targets[fmt] || state.meta.targets['*'] || [];
const fmtBadge = (f, cls = '') => h(`span.fmt${cls}`, { dataset: { cat: fmtCat(f) } }, f || '?');
const aliasesFor = (fmt) => ['.' + fmt, ...Object.entries(state.meta.aliases).filter(([, v]) => v === fmt).map(([k]) => '.' + k)];

function describe(row) {
  const i = row.upload?.info || {};
  const parts = [formatBytes(row.size)];
  if (i.encrypted) parts.push('password-protected');
  if (i.video?.width) parts.push(`${i.video.width}×${i.video.height}`);
  else if (i.width && i.height && fmtCat(row.format) !== 'document') parts.push(i.orientation >= 5 ? `${i.height}×${i.width}` : `${i.width}×${i.height}`);
  if (i.duration) parts.push(formatDuration(i.duration));
  if (i.video?.codec) parts.push(i.video.codec.toUpperCase());
  else if (i.audio?.[0]?.codec) parts.push(`${i.audio[0].codec.toUpperCase()}${i.audio[0].sampleRate ? ` · ${(i.audio[0].sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : ''}`);
  if (i.pages > 1 && fmtCat(row.format) === 'image') parts.push(`${i.pages} frames`);
  else if (i.pages && fmtCat(row.format) !== 'image') parts.push(`${i.pages} page${i.pages > 1 ? 's' : ''}`);
  if (i.sheets?.length) parts.push(`${i.sheets.length} sheet${i.sheets.length > 1 ? 's' : ''}`);
  if (i.files) parts.push(`${i.files} files`);
  if (i.subtitles?.length) parts.push(`${i.subtitles.length} subtitle track${i.subtitles.length > 1 ? 's' : ''}`);
  return parts;
}

// ---------------------------------------------------------------- theme

const THEMES = ['system', 'light', 'dark'];
function initTheme() {
  const btn = $('#themeBtn');
  const apply = () => {
    const t = storage.get('theme', 'system');
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    btn.replaceChildren(icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor'));
    btn.title = `Theme: ${t}`;
  };
  btn.addEventListener('click', () => {
    const t = storage.get('theme', 'system');
    storage.set('theme', THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
    apply();
  });
  apply();
}

// ---------------------------------------------------------------- rows

function newRow(fields) {
  return { id: ++seq, status: 'waiting', progress: 0, options: null, steps: null, routeReq: 0, ...fields };
}

function addFiles(files) {
  if (!files.length) return;
  const max = state.meta.limits.maxUploadBytes;
  for (const file of files) {
    if (file.size > max) { toast(`${file.name} is larger than ${formatBytes(max)}`, { type: 'error' }); continue; }
    const format = detectFormat(file.name, state.meta.aliases);
    const row = newRow({ file, name: file.name, size: file.size, format });
    if (THUMBABLE.has(format) && file.size < 40 * 1024 * 1024) row.thumb = URL.createObjectURL(file);
    const preset = state.preset && targetsOf(format).includes(state.preset) ? state.preset : null;
    if (preset) row.target = preset;
    state.rows.push(row);
    if (row.target) loadRoute(row);
  }
  state.preset = null;
  renderShell();
  pumpUploads();
}

function pumpUploads() {
  const active = state.rows.filter((r) => r.status === 'uploading').length;
  const waiting = state.rows.filter((r) => r.status === 'waiting');
  for (const row of waiting.slice(0, Math.max(0, MAX_PARALLEL_UPLOADS - active))) startUpload(row);
}

function startUpload(row) {
  row.status = 'uploading';
  row.progress = 0;
  const { promise, abort } = api.upload(row.file, (p) => { row.progress = p; patch(row); });
  row.abortUpload = abort;
  renderRow(row);
  promise.then(async (up) => {
    row.upload = up;
    row.format = up.format;
    row.status = 'ready';
    row.abortUpload = null;
    if (row.target && !targetsOf(row.format).includes(row.target)) row.target = null;
    if (row.target) await loadRoute(row);
    renderRow(row);
    renderChrome();
    if (row.autoConvert) { row.autoConvert = false; startJob(row); }
  }).catch((e) => {
    if (e.aborted) return;
    row.status = 'upload-error';
    row.error = e.message;
    renderRow(row);
    renderChrome();
  }).finally(pumpUploads);
}

async function loadRoute(row) {
  if (!row.target) return;
  const req = ++row.routeReq;
  try {
    const r = await api.route(row.upload ? { upload: row.upload.id, to: row.target } : { from: row.format, to: row.target });
    if (req !== row.routeReq) return;
    row.steps = r.steps;
    row.options = mergeValues(r.steps, row.options || []);
    row.routeFromUpload = !!row.upload;
  } catch (e) {
    if (req !== row.routeReq) return;
    row.steps = null;
    toast(e.message, { type: 'error' });
  }
  renderRow(row);
}

function resetResult(row) {
  if (row.job) {
    if (ACTIVE.includes(row.job.status)) api.cancelJob(row.job.id);
    api.deleteJob(row.job.id);
  }
  row.job = null;
  row.error = null;
  row.details = null;
  row.showLog = false;
  if (['done', 'error', 'cancelled'].includes(row.status)) row.status = row.upload ? 'ready' : row.status;
}

async function setTarget(row, to) {
  if (row.target === to && row.steps) return;
  resetResult(row);
  row.target = to;
  row.steps = null;
  renderRow(row);
  await loadRoute(row);
  renderChrome();
}

function removeRow(row) {
  row.abortUpload?.();
  if (row.job && ACTIVE.includes(row.job.status)) api.cancelJob(row.job.id);
  if (row.job) api.deleteJob(row.job.id);
  if (row.upload && !state.rows.some((r) => r !== row && r.upload?.id === row.upload.id)) api.deleteUpload(row.upload.id);
  if (row.thumb) URL.revokeObjectURL(row.thumb);
  state.rows = state.rows.filter((r) => r !== row);
  row.el?.remove();
  if (!state.rows.length) renderShell();
  else renderChrome();
  pumpUploads();
}

function clearAll() {
  for (const r of [...state.rows]) removeRow(r);
}

// ---------------------------------------------------------------- jobs

async function startJob(row) {
  if (!row.upload) { row.autoConvert = true; renderRow(row); return; }
  if (!row.steps || !row.routeFromUpload) await loadRoute(row);
  if (!row.steps) return;
  resetResult(row);
  row.status = 'queued';
  row.progress = 0;
  row.stage = 'Waiting';
  renderRow(row);
  try {
    const job = await api.createJob(row.upload.id, row.target, row.options);
    applyJob(row, job);
    ensurePolling();
  } catch (e) {
    row.status = 'error';
    row.error = e.message;
    renderRow(row);
  }
  renderChrome();
}

function convertAll() {
  closePicker();
  const pending = state.rows.filter((r) => r.kind !== 'merge' && !['done', 'queued', 'processing', 'upload-error'].includes(r.status));
  const missing = pending.filter((r) => !r.target);
  if (missing.length) {
    toast(`Choose an output format for ${missing.length === 1 ? missing[0].name : `${missing.length} files`}`, { type: 'error' });
    missing.forEach((r) => r.el?.querySelector('.target-btn')?.animate([{ boxShadow: 'var(--ring)' }, { boxShadow: 'none' }], { duration: 900 }));
  }
  const ready = pending.filter((r) => r.target);
  if (!ready.length && !missing.length) toast('Everything is already converted');
  for (const r of ready) startJob(r);
}

function ensurePolling() {
  if (!state.polling) state.polling = setInterval(poll, 500);
}

async function poll() {
  const active = state.rows.filter((r) => r.job && ACTIVE.includes(r.job.status));
  if (!active.length) {
    clearInterval(state.polling);
    state.polling = null;
    return;
  }
  let jobs;
  try { jobs = await api.jobs(active.map((r) => r.job.id)); } catch { return; }
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const r of active) {
    const j = byId.get(r.job.id);
    if (j) applyJob(r, j);
    else { r.status = 'error'; r.error = 'The server no longer knows this job (was it restarted?)'; r.job = null; renderRow(r); }
  }
  renderChrome();
}

function applyJob(row, job) {
  const prevStatus = row.status;
  row.job = job;
  row.progress = job.progress;
  row.stage = job.stage;
  row.status = job.status;
  if (job.status === 'error') { row.error = job.error; row.details = job.details; }
  if (job.status === 'done' && prevStatus !== 'done') flashTitle();
  patch(row);
}

let titleTimer;
function flashTitle() {
  if (!document.hidden) return;
  document.title = '✓ Converted — Recast';
  clearTimeout(titleTimer);
  const restore = () => { document.title = 'Recast — Convert any file'; document.removeEventListener('visibilitychange', restore); };
  document.addEventListener('visibilitychange', restore);
}

// ---------------------------------------------------------------- rendering: row

function rowSignature(r) {
  return JSON.stringify([r.status, r.target, r.error, r.showLog, r.name, !!r.upload, r.job?.outputs?.length, r.steps ? 1 : 0, isCustomized(r.steps, r.options), r.autoConvert]);
}

function patch(row) {
  if (!row.el || row.sig !== rowSignature(row)) return renderRow(row);
  const bar = row.el.querySelector('.progress i');
  if (bar) {
    const known = row.status === 'uploading' || row.progress > 0.005;
    bar.parentElement.classList.toggle('indeterminate', !known);
    bar.style.width = known ? `${Math.round((row.progress || 0) * 100)}%` : '';
  }
  const st = row.el.querySelector('.status-text');
  if (st) st.textContent = statusText(row);
}

function statusText(row) {
  const pct = `${Math.round((row.progress || 0) * 100)}%`;
  switch (row.status) {
    case 'waiting': return 'Waiting to upload';
    case 'uploading': return `Uploading ${pct}`;
    case 'queued': return row.job?.queuePosition > 1 ? `Queued · #${row.job.queuePosition}` : 'Starting…';
    case 'processing': return row.progress > 0.005 ? `${row.stage || 'Converting'} · ${pct}` : row.stage || 'Converting';
    default: return '';
  }
}

function renderRow(row) {
  const cat = row.kind === 'merge' ? 'document' : fmtCat(row.format);
  const thumb = h('div.thumb', { dataset: { cat } }, row.thumb ? h('img', { src: row.thumb, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(document.createTextNode(row.format || '?')) }) : (row.kind === 'merge' ? icon('layers') : (row.format || '?').slice(0, 5)));

  const meta = row.kind === 'merge'
    ? [`Merged from ${row.sources.length} files`]
    : describe(row);
  const main = h('div.file-main',
    h('div.file-name', { title: row.name }, row.name),
    h('div.file-meta', meta.flatMap((m, i) => (i ? [h('span.sep', '·'), m] : [m]))),
    row.error ? h('div.file-error', row.error, row.details ? h('button', { type: 'button', onclick: () => { row.showLog = !row.showLog; renderRow(row); } }, row.showLog ? 'Hide details' : 'Details') : null) : null,
    row.showLog && row.details ? h('pre.file-log', row.details) : null);

  let convert;
  if (row.kind === 'merge') convert = h('div.file-convert', h('span.to', 'to'), h('span.target-btn', { style: { cursor: 'default' } }, 'pdf'));
  else {
    const targets = targetsOf(row.format);
    const tbtn = h('button.target-btn', {
      type: 'button', class: row.target ? '' : 'empty', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      disabled: row.status === 'upload-error' || !targets.length,
      title: row.target ? `${state.meta.formats[row.target]?.name || row.target}` : 'Choose output format',
    }, row.target ? row.target : 'Convert to…', icon('chevronDown'));
    tbtn.addEventListener('click', () => openPicker({ anchor: tbtn, targets, current: row.target, from: row.format, meta: state.meta, onPick: (to) => setTarget(row, to) }));
    const customized = isCustomized(row.steps, row.options);
    const gear = h('button.icon-btn', {
      type: 'button', class: customized ? 'has-dot' : '', 'aria-label': 'Conversion settings', title: row.target ? 'Settings' : 'Choose a format first',
      disabled: !row.target || !row.steps, onclick: () => openSettings(row),
    }, icon('sliders'));
    convert = h('div.file-convert', h('span.to', 'to'), tbtn, gear);
  }

  const status = h('div.file-status');
  const removeBtn = h('button.icon-btn.file-remove', { type: 'button', 'aria-label': `Remove ${row.name}`, title: 'Remove', onclick: () => removeRow(row) }, icon('x'));
  let progress = null;
  switch (row.status) {
    case 'waiting': case 'uploading':
      status.append(h('span.status-text', statusText(row)));
      progress = h('div.progress', h('i', { style: { width: `${Math.round(row.progress * 100)}%` } }));
      break;
    case 'queued': case 'processing': {
      status.append(h('span.spinner'), h('span.status-text', statusText(row)), h('button.icon-btn', { type: 'button', title: 'Cancel', 'aria-label': 'Cancel conversion', onclick: () => { api.cancelJob(row.job.id); } }, icon('stop')));
      progress = h('div.progress', { class: row.progress > 0.005 ? '' : 'indeterminate' }, h('i', { style: { width: row.progress > 0.005 ? `${Math.round(row.progress * 100)}%` : undefined } }));
      break;
    }
    case 'ready':
      if (row.autoConvert) status.append(h('span.status-text', 'Starting…'));
      else if (row.target && row.steps?.length > 1) status.append(h('span.status-text', { title: row.steps.map((s) => `${s.from} → ${s.to} (${s.label})`).join('\n') }, `${row.steps.length}-step conversion`));
      break;
    case 'done': {
      const outs = row.job.outputs;
      const total = outs.reduce((s, o) => s + o.size, 0);
      const inSize = row.kind === 'merge' ? row.sources.reduce((s, r) => s + r.size, 0) : row.size;
      const delta = inSize ? Math.round(((total - inSize) / inSize) * 100) : 0;
      status.append(h('div.status-done',
        h('span.size', outs.length > 1 ? `${outs.length} files · ${formatBytes(total)}` : formatBytes(total)),
        Math.abs(delta) >= 1 ? h('span.delta', { class: delta < 0 ? 'down' : 'up' }, `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`) : null));
      const viewable = outs.length === 1 && VIEWABLE.has(detectFormat(outs[0].name, state.meta.aliases));
      if (viewable) status.append(h('a.icon-btn', { href: api.fileUrl(row.job.id, 0, true), target: '_blank', rel: 'noopener', title: 'Open', 'aria-label': 'Open result' }, icon('eye')));
      status.append(h('a.btn.btn-sm.btn-primary', { href: api.downloadUrl(row.job.id), download: '' }, icon('download'), outs.length > 1 ? 'ZIP' : 'Download'));
      break;
    }
    case 'error': case 'cancelled':
      status.append(
        h('span.pill', { class: row.status === 'error' ? 'pill-error' : '' }, row.status === 'error' ? 'Failed' : 'Cancelled'),
        row.kind !== 'merge' && row.target ? h('button.icon-btn', { type: 'button', title: 'Try again', 'aria-label': 'Retry', onclick: () => startJob(row) }, icon('refresh')) : null);
      break;
    case 'upload-error':
      status.append(h('span.pill.pill-error', 'Upload failed'));
      break;
    default: break;
  }
  const li = h('li.file', { dataset: { id: row.id } }, thumb, main, convert, status, removeBtn, progress);
  if (row.el?.isConnected) {
    li.style.animation = 'none';
    row.el.replaceWith(li);
  } else {
    $('#files')?.append(li);
  }
  row.el = li;
  row.sig = rowSignature(row);
  renderChrome();
}

// ---------------------------------------------------------------- rendering: shell

function renderChrome() {
  const app = $('.app');
  if (!app) return;
  app.classList.toggle('has-files', state.rows.length > 0);
  const title = $('#heroTitle');
  if (title) title.replaceChildren(...(state.rows.length ? ['Convert files'] : ['Convert any file.', h('br'), h('span.soft', 'Keep every setting.')]));
  const conv = state.rows.filter((r) => r.kind !== 'merge');
  const done = state.rows.filter((r) => r.status === 'done');
  const pending = conv.filter((r) => !['done', 'queued', 'processing', 'upload-error'].includes(r.status));
  const busy = state.rows.some((r) => ACTIVE.includes(r.status));
  const cb = $('#convertBtn');
  if (cb) {
    cb.disabled = !pending.length;
    cb.replaceChildren(busy && !pending.length ? h('span.spinner', { style: { borderTopColor: 'currentColor' } }) : icon('arrowRight'), pending.length ? `Convert ${pending.length > 1 ? pending.length + ' files' : ''}`.trim() : busy ? 'Converting…' : 'Convert');
  }
  const dl = $('#downloadAllBtn');
  if (dl) {
    dl.hidden = done.length < 2;
    dl.href = api.downloadAllUrl(done.map((r) => r.job.id));
  }
  const sum = $('#summary');
  if (sum) sum.textContent = `${state.rows.length} file${state.rows.length === 1 ? '' : 's'}${done.length ? ` · ${done.length} converted` : ''}${busy ? ' · working…' : ''}`;
  const mergeBtn = $('#mergeBtn');
  if (mergeBtn) mergeBtn.hidden = mergeCandidates().length < 2;
  const allBtn = $('#allToBtn');
  if (allBtn) allBtn.hidden = conv.length < 2;
}

function mergeCandidates() {
  return state.rows.filter((r) => r.kind !== 'merge' && r.upload && (r.format === 'pdf' || (fmtCat(r.format) === 'image' && targetsOf(r.format).includes('pdf'))));
}

function renderShell() {
  if (location.hash.startsWith('#/formats')) return;
  const view = $('#view');
  const fileBtn = () => h('button.btn.btn-primary.btn-lg', { type: 'button', onclick: () => $('#fileInput').click() }, icon('upload'), 'Choose files');
  const urlBtn = (cls = '.btn-lg') => h(`button.btn${cls}`, { type: 'button', onclick: openUrlImport }, icon('link'), 'From URL');

  const dz = h('div.dropzone#dropzone',
    h('div.dz-icon', icon('upload')),
    h('div.dz-title', 'Drop files anywhere to start'),
    h('div.dz-actions', fileBtn(), urlBtn()),
    h('div.dz-hint', `Up to ${formatBytes(state.meta.limits.maxUploadBytes)} per file · `, h('kbd', 'Ctrl'), ' ', h('kbd', 'V'), ' to paste'));

  const popular = POPULAR.filter(([a, b]) => targetsOf(a).includes(b)).slice(0, 8);
  const pop = popular.length ? h('div.popular', h('span', 'Popular'), popular.map(([a, b]) => h('button', {
    type: 'button',
    onclick: () => {
      state.preset = b;
      const input = $('#fileInput');
      input.accept = aliasesFor(a).join(',');
      input.click();
      setTimeout(() => { input.accept = ''; }, 500);
    },
  }, a.toUpperCase(), icon('arrowRight'), b.toUpperCase()))) : null;

  const hero = h('section.hero',
    h('span.eyebrow', h('span.dot'), 'Private · runs on your own machine'),
    h('h1#heroTitle'),
    h('p.lede', `${Object.keys(state.meta.targets).length - 1}+ input formats across images, video, audio, documents, ebooks, spreadsheets, data, archives, fonts and subtitles — with fine control over codecs, quality, size, pages and more.`),
    dz, pop);

  const panel = h('section.panel.list-panel', { hidden: !state.rows.length },
    h('div.list-toolbar',
      h('button.btn.btn-sm#allToBtn', { type: 'button', onclick: (e) => convertAllTo(e.currentTarget) }, 'Convert all to…', icon('chevronDown')),
      h('button.btn.btn-sm#mergeBtn', { type: 'button', hidden: true, onclick: openMerge }, icon('layers'), 'Merge into PDF'),
      h('span.spacer'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => $('#fileInput').click() }, icon('plus'), 'Add files'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: openUrlImport }, icon('link'), 'URL'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: clearAll, title: 'Remove all files' }, icon('trash'), 'Clear')),
    h('ul.files#files'),
    h('button.add-more#addMore', { type: 'button', onclick: () => $('#fileInput').click() }, icon('plus'), 'Add more files — or drop them anywhere'),
    h('div.list-footer',
      h('span.summary#summary'),
      h('span.spacer'),
      h('a.btn#downloadAllBtn', { hidden: true, download: '' }, icon('download'), 'Download all'),
      h('button.btn.btn-primary#convertBtn', { type: 'button', onclick: convertAll }, icon('arrowRight'), 'Convert')));

  const app = h('div.app', hero, panel, landing());
  view.replaceChildren(app);
  for (const r of state.rows) { r.el = null; renderRow(r); }
  renderChrome();
}

function landing() {
  const m = state.meta;
  const engines = m.engines.filter((e) => e.available).length;
  const features = [
    ['grid', 'Every format that matters', 'Photos incl. HEIC and PSD, video, audio, PDF, Word, Markdown, spreadsheets, JSON/YAML/XML, archives, fonts and subtitles.'],
    ['sliders', 'Every setting exposed', 'Codecs, CRF, bitrate, target size, resolution, frame rate, trimming, page ranges, compression, encryption, subsetting and more.'],
    ['route', 'Smart chaining', 'When no single engine can do it, Recast chains them — DOCX → HTML → PDF → PNG — and lets you tune each step.'],
    ['shield', 'Private by design', `Nothing leaves this computer. Uploads and results are deleted automatically after ${Math.round(m.limits.retentionMinutes / 60 * 10) / 10} hours.`],
    ['layers', 'Batch, merge & download', 'Convert dozens of files at once, merge PDFs and images into one document, grab everything as a single ZIP.'],
    ['cpu', `${engines} engines, one interface`, 'FFmpeg, libvips, MuPDF, SheetJS, 7-Zip, a headless browser and more — plus LibreOffice, Pandoc and Calibre when installed.'],
  ];
  const catCards = m.categories.map((c) => {
    const inputs = Object.keys(m.targets).filter((f) => f !== '*' && m.formats[f]?.category === c.id);
    return { c, inputs };
  }).filter((x) => x.inputs.length);
  return h('div.landing',
    h('div.features', features.map(([ic, t, d]) => h('div.feature', h('div.fi', icon(ic)), h('h3', t), h('p', d)))),
    h('div.cat-grid', catCards.map(({ c, inputs }) => h('a.cat-card', { href: `#/formats/${c.id}`, dataset: { cat: c.id } },
      h('div.bar'),
      h('div.top', h('span.name', c.label), h('span.count', `${inputs.length} formats`)),
      h('div.exts', inputs.slice(0, 9).join(' · ') + (inputs.length > 9 ? ' …' : ''))))));
}

// ---------------------------------------------------------------- actions

function convertAllTo(anchor) {
  const rows = state.rows.filter((r) => r.kind !== 'merge' && r.status !== 'upload-error');
  const sets = rows.map((r) => new Set(targetsOf(r.format)));
  const union = [...new Set(sets.flatMap((s) => [...s]))];
  const common = union.filter((t) => sets.every((s) => s.has(t)));
  const list = common.length ? common : union;
  const firstFormat = rows.map((r) => r.format).find(Boolean);
  openPicker({
    anchor, targets: list, from: rows.every((r) => r.format === firstFormat) ? firstFormat : null, meta: state.meta,
    footer: common.length ? h('span', 'Formats every file can be converted to') : h('span', 'No format fits every file — others will be skipped'),
    onPick: (to) => {
      let skipped = 0;
      for (const r of rows) {
        if (targetsOf(r.format).includes(to)) setTarget(r, to);
        else skipped++;
      }
      if (skipped) toast(`${skipped} file${skipped > 1 ? 's' : ''} cannot be converted to ${to.toUpperCase()}`, { type: 'error' });
    },
  });
}

function openSettings(row) {
  if (!row.steps) return;
  const values = row.options.map((o) => JSON.parse(JSON.stringify(o)));
  const similar = () => state.rows.filter((r) => r !== row && r.kind !== 'merge' && r.format === row.format && r.target === row.target && r.steps);
  const chain = h('div.chain', fmtBadge(row.steps[0].from), row.steps.map((s) => [icon('arrowRight'), fmtBadge(s.to)]), h('span.eng', row.steps.map((s) => s.label).join(' · ')));
  const form = renderForm(row.steps, values);
  const apply = (targets) => {
    for (const r of targets) {
      const before = JSON.stringify(r.options);
      r.options = values.map((o) => JSON.parse(JSON.stringify(o)));
      if (JSON.stringify(r.options) !== before) resetResult(r);
      renderRow(r);
    }
  };
  const sims = similar();
  const d = drawer({
    title: 'Settings',
    subtitle: row.name,
    head: chain,
    body: form,
    actions: [
      h('button.btn.btn-ghost', { type: 'button', onclick: () => {
        const fresh = routeDefaults(row.steps);
        values.splice(0, values.length, ...fresh);
        const nf = renderForm(row.steps, values);
        d.body.replaceChildren(nf);
      } }, 'Reset'),
      h('span.spacer'),
      sims.length ? h('button.btn', { type: 'button', title: `Also apply to the other ${sims.length} ${row.format.toUpperCase()} → ${row.target.toUpperCase()} files`, onclick: () => { apply([row, ...similar()]); d.close(); toast(`Settings applied to ${sims.length + 1} files`); } }, `Apply to all ${sims.length + 1}`) : null,
      h('button.btn.btn-primary', { type: 'button', onclick: () => { apply([row]); d.close(); } }, 'Done'),
    ],
  });
}

function openUrlImport() {
  const input = h('input.input', { type: 'url', placeholder: 'https://example.com/file.pdf', spellcheck: 'false' });
  const go = h('button.btn.btn-primary', { type: 'button' }, 'Import');
  const m = modal({
    title: 'Add from URL',
    subtitle: 'The file is downloaded by the Recast server on this computer.',
    body: h('form', { onsubmit: (e) => { e.preventDefault(); go.click(); } }, input),
    actions: [h('button.btn', { type: 'button', onclick: () => m.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) return input.focus();
    go.disabled = true;
    go.replaceChildren(h('span.spinner', { style: { borderTopColor: 'currentColor' } }), 'Downloading…');
    try {
      const up = await api.importUrl(url);
      const row = newRow({ name: up.name, size: up.size, format: up.format, upload: up, status: 'ready' });
      if (state.preset && targetsOf(up.format).includes(state.preset)) row.target = state.preset;
      state.rows.push(row);
      m.close();
      renderShell();
      if (row.target) loadRoute(row);
    } catch (e) {
      toast(e.message, { type: 'error' });
      go.disabled = false;
      go.replaceChildren('Import');
    }
  });
}

async function openMerge() {
  const items = mergeCandidates().slice();
  let schema;
  try { schema = await api.mergeSchema(); } catch (e) { toast(e.message, { type: 'error' }); return; }
  const steps = [{ label: 'PDF', from: 'pdf', to: 'pdf', groups: schema.groups }];
  const values = routeDefaults(steps);
  const list = h('ol.merge-list');
  let dragIdx = -1;
  const renderList = () => {
    list.replaceChildren(...items.map((r, i) => {
      const li = h('li', { draggable: 'true' },
        h('span.grip', icon('grip')), h('span.idx', i + 1), fmtBadge(r.format), h('span.nm', { title: r.name }, r.name),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; renderList(); } }, h('span', { style: { transform: 'rotate(180deg)', display: 'grid' } }, icon('chevronDown'))),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Move down', disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; renderList(); } }, icon('chevronDown')),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Leave out', disabled: items.length <= 2, onclick: () => { items.splice(i, 1); renderList(); } }, icon('x')));
      li.addEventListener('dragstart', () => { dragIdx = i; li.classList.add('dragging'); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragIdx < 0 || dragIdx === i) return;
        const [moved] = items.splice(dragIdx, 1);
        items.splice(i, 0, moved);
        dragIdx = -1;
        renderList();
      });
      return li;
    }));
  };
  renderList();
  const name = h('input.input', { type: 'text', value: 'merged', spellcheck: 'false' });
  const go = h('button.btn.btn-primary', { type: 'button' }, icon('layers'), 'Merge');
  const m = modal({
    title: 'Merge into one PDF',
    subtitle: 'Drag to reorder. Images become pages; PDFs keep all their pages.',
    size: 'modal-lg',
    body: [list, h('div.field', { style: { marginBottom: '8px' } }, h('div.field-label', 'File name'), h('div.input-wrap', name, h('span.unit', '.pdf'))), renderForm(steps, values)],
    actions: [h('button.btn', { type: 'button', onclick: () => m.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const job = await api.merge(items.map((r) => r.upload.id), values[0], name.value.trim() || 'merged');
      const row = newRow({ kind: 'merge', name: `${(name.value.trim() || 'merged').replace(/\.pdf$/i, '')}.pdf`, format: 'pdf', size: 0, sources: items.slice(), target: 'pdf' });
      state.rows.unshift(row);
      applyJob(row, job);
      m.close();
      renderShell();
      ensurePolling();
    } catch (e) {
      toast(e.message, { type: 'error' });
      go.disabled = false;
    }
  });
}

function openEngines() {
  const body = h('div');
  const render = () => {
    const engines = state.meta.engines;
    body.replaceChildren(...engines.map((e) => h('div.engine',
      h('span.led', { class: e.available ? 'on' : '' }),
      h('div',
        h('div', h('span.name', e.label), ' ', h('span.ver', e.available ? e.version || '' : e.optional ? 'Not installed' : e.note || 'Unavailable')),
        e.available && e.detail ? h('div.adds', e.detail) : null,
        !e.available && e.optional ? [h('div.adds', `Adds ${e.optional.adds}.`), h('div.cmd', h('code', e.optional.install), h('button.icon-btn', { type: 'button', title: 'Copy', 'aria-label': 'Copy command', onclick: () => copyText(e.optional.install) }, icon('copy')))] : null),
      h('span.dim', { style: { fontSize: '12px' } }, e.available ? 'Active' : ''))));
  };
  render();
  const rescan = h('button.btn', { type: 'button' }, icon('refresh'), 'Rescan');
  const m = modal({
    title: 'Conversion engines',
    subtitle: 'Recast detects these tools automatically. Install an optional one and rescan to unlock more formats.',
    body,
    actions: [rescan, h('button.btn.btn-primary', { type: 'button', onclick: () => m.close() }, 'Close')],
  });
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    try {
      state.meta = await api.rescan();
      applyMeta();
      render();
      toast('Engines rescanned');
      if (!location.hash.startsWith('#/formats')) renderShell();
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
    rescan.disabled = false;
  });
}

// ---------------------------------------------------------------- drag & drop, paste

function setupGlobalDrop() {
  const veil = h('div.dropveil', h('div', 'Drop to add files'));
  document.body.append(veil);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; veil.classList.add('on'); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) veil.classList.remove('on'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.classList.remove('on');
    if (location.hash.startsWith('#/formats')) location.hash = '#/';
    addFiles([...e.dataTransfer.files].filter((f) => f.size > 0 || f.type));
  });
}

function setupPaste() {
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    if (location.hash.startsWith('#/formats')) location.hash = '#/';
    addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, { type: f.type }))));
  });
}

// ---------------------------------------------------------------- routing & boot

function applyMeta() {
  const m = state.meta;
  document.title = `${m.appName} — Convert any file`;
  const hrs = m.limits.retentionMinutes / 60;
  $('#retention').textContent = hrs >= 1 ? `${Math.round(hrs * 10) / 10} hour${hrs === 1 ? '' : 's'}` : `${m.limits.retentionMinutes} minutes`;
  const on = m.engines.filter((e) => e.available).length;
  $('#engineSummary').textContent = `${on} of ${m.engines.length} engines active`;
}

function route() {
  closePicker();
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', hash.startsWith('#/formats') ? a.dataset.nav === 'formats' : a.dataset.nav === 'convert');
  if (hash.startsWith('#/formats')) {
    const cat = hash.split('/')[2] || '';
    renderFormats($('#view'), state.meta, {
      category: cat,
      onUse: (from, to) => {
        state.preset = to;
        location.hash = '#/';
        const input = $('#fileInput');
        input.accept = aliasesFor(from).join(',');
        setTimeout(() => { input.click(); setTimeout(() => { input.accept = ''; }, 500); }, 50);
      },
    });
    window.scrollTo(0, 0);
  } else {
    renderShell();
  }
}

async function boot() {
  initTheme();
  window.addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  try {
    state.meta = await api.meta();
  } catch (e) {
    $('#view').replaceChildren(h('div.page-head', h('h1', 'Cannot reach the server'), h('p', `${e.message}. Start it with “npm start”.`)));
    return;
  }
  applyMeta();
  $('#enginesBtn').addEventListener('click', openEngines);
  $('#fileInput').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  setupGlobalDrop();
  setupPaste();
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => {
    if (state.rows.some((r) => ['uploading', 'queued', 'processing'].includes(r.status))) e.preventDefault();
  });
  route();
}

boot();

// Exposed for debugging in the console.
window.recast = { state };
