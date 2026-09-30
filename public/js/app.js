import { h, $, formatBytes, formatDuration, detectFormat, storage } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { openPicker, closePicker } from './picker.js';
import { renderForm, mergeValues, isCustomized, routeDefaults } from './form.js';
import { toast, modal, drawer, copyText } from './ui.js';
import { renderFormats } from './formats.js';
import { t, tCategory, tFormatName, tError, currentLang, setLang, onLangChange } from './i18n.js';

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

function announce(message) {
  const el = $('#a11yStatus');
  if (!el || !message) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

const fmtCat = (f) => state.meta.formats[f]?.category || 'other';
const targetsOf = (fmt) => state.meta.targets[fmt] || state.meta.targets['*'] || [];
const fmtBadge = (f, cls = '') => h(`span.fmt${cls}`, { dataset: { cat: fmtCat(f) } }, f || '?');
const aliasesFor = (fmt) => ['.' + fmt, ...Object.entries(state.meta.aliases).filter(([, v]) => v === fmt).map(([k]) => '.' + k)];

function describe(row) {
  const i = row.upload?.info || {};
  const parts = [formatBytes(row.size)];
  if (i.encrypted) parts.push(t('describe.passwordProtected'));
  if (i.video?.width) parts.push(`${i.video.width}×${i.video.height}`);
  else if (i.width && i.height && fmtCat(row.format) !== 'document') parts.push(i.orientation >= 5 ? `${i.height}×${i.width}` : `${i.width}×${i.height}`);
  if (i.duration) parts.push(formatDuration(i.duration));
  if (i.video?.codec) parts.push(i.video.codec.toUpperCase());
  else if (i.audio?.[0]?.codec) parts.push(`${i.audio[0].codec.toUpperCase()}${i.audio[0].sampleRate ? ` · ${(i.audio[0].sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : ''}`);
  if (i.pages > 1 && fmtCat(row.format) === 'image') parts.push(t('describe.frames', { count: i.pages }));
  else if (i.pages && fmtCat(row.format) !== 'image') parts.push(t(i.pages > 1 ? 'describe.pages' : 'describe.page', { count: i.pages }));
  if (i.sheets?.length) parts.push(t(i.sheets.length > 1 ? 'describe.sheets' : 'describe.sheet', { count: i.sheets.length }));
  if (i.files) parts.push(t('describe.files', { count: i.files }));
  if (i.subtitles?.length) parts.push(t(i.subtitles.length > 1 ? 'describe.subtitleTracks' : 'describe.subtitleTrack', { count: i.subtitles.length }));
  return parts;
}

// ---------------------------------------------------------------- theme & language

const THEMES = ['system', 'light', 'dark'];
function initTheme() {
  const btn = $('#themeBtn');
  const apply = () => {
    const th = storage.get('theme', 'system');
    if (th === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = th;
    btn.replaceChildren(icon(th === 'light' ? 'sun' : th === 'dark' ? 'moon' : 'monitor'));
    const tMap = { system: t('topbar.themeSystem'), light: t('topbar.themeLight'), dark: t('topbar.themeDark') };
    btn.title = tMap[th] || `${t('topbar.theme')}: ${th}`;
    btn.setAttribute('aria-label', t('topbar.theme'));
  };
  btn.addEventListener('click', () => {
    const th = storage.get('theme', 'system');
    storage.set('theme', THEMES[(THEMES.indexOf(th) + 1) % THEMES.length]);
    apply();
  });
  apply();
}

function initLang() {
  const btn = $('#langBtn');
  if (!btn) return;
  const updateBtn = () => {
    const lang = currentLang();
    btn.textContent = lang.toUpperCase();
    btn.title = lang === 'es' ? 'Idioma: Español (clic para cambiar a Inglés)' : 'Language: English (click to switch to Spanish)';
    btn.setAttribute('aria-label', t('topbar.lang'));
  };
  btn.addEventListener('click', () => {
    const next = currentLang() === 'es' ? 'en' : 'es';
    setLang(next);
  });
  onLangChange(() => {
    updateBtn();
    updateNav();
    applyMeta();
    route();
  });
  updateBtn();
}

function updateNav() {
  const c = $('#navConvert');
  if (c) c.textContent = t('nav.convert');
  const f = $('#navFormats');
  if (f) f.textContent = t('nav.formats');
  const e = $('#enginesBtn');
  if (e) e.textContent = t('nav.engines');
  const hist = $('#historyBtn');
  if (hist) {
    const badge = $('#historyBadge');
    hist.replaceChildren(document.createTextNode(t('nav.history') + ' '), badge);
    updateHistoryBadge();
  }
  const foot = $('#footerText');
  if (foot) {
    foot.replaceChildren(document.createTextNode(t('footer.privacy')), h('span#retention', retentionText()));
  }
  const skip = $('#skipLink');
  if (skip) skip.textContent = t('a11y.skipLink');
  const mainNav = $('#mainNav');
  if (mainNav) mainNav.setAttribute('aria-label', t('a11y.navMain'));
  const fi = $('#fileInput');
  if (fi) fi.setAttribute('aria-label', t('a11y.chooseFilesInput'));
}

function retentionText() {
  const m = state.meta;
  if (!m) return '';
  const hrs = m.limits.retentionMinutes / 60;
  return hrs >= 1 ? t('units.hours', { count: Math.round(hrs * 10) / 10, s: (Math.round(hrs * 10) / 10) === 1 ? '' : 's' }) : t('units.minutes', { count: m.limits.retentionMinutes });
}

// ---------------------------------------------------------------- rows

function newRow(fields) {
  return { id: ++seq, status: 'waiting', progress: 0, options: null, steps: null, routeReq: 0, ...fields };
}

function addFiles(files) {
  if (!files.length) return;
  const max = state.meta.limits.maxUploadBytes;
  let added = 0;
  for (const file of files) {
    if (file.size > max) { toast(t('toast.fileTooLarge', { name: file.name, max: formatBytes(max) }), { type: 'error' }); continue; }
    const format = detectFormat(file.name, state.meta.aliases);
    const row = newRow({ file, name: file.name, size: file.size, format });
    if (THUMBABLE.has(format) && file.size < 40 * 1024 * 1024) row.thumb = URL.createObjectURL(file);
    const preset = state.preset && targetsOf(format).includes(state.preset) ? state.preset : null;
    if (preset) row.target = preset;
    state.rows.push(row);
    if (row.target) loadRoute(row);
    added++;
  }
  state.preset = null;
  renderShell();
  pumpUploads();
  if (added > 0) announce(t('a11y.filesAdded', { count: added }));
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
    row.error = tError(e.message);
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
    toast(tError(e.message), { type: 'error' });
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
  row.status = 'removed';
  if (row.fetchId) api.cancelFetch(row.fetchId);
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
  announce(t('a11y.filesCleared'));
}

// ---------------------------------------------------------------- jobs

async function startJob(row) {
  if (!row.upload) { row.autoConvert = true; renderRow(row); return; }
  if (!row.steps || !row.routeFromUpload) await loadRoute(row);
  if (!row.steps) return;
  resetResult(row);
  row.status = 'queued';
  row.progress = 0;
  row.stage = t('status.waiting');
  renderRow(row);
  try {
    const job = await api.createJob(row.upload.id, row.target, row.options);
    applyJob(row, job);
    ensurePolling();
  } catch (e) {
    row.status = 'error';
    row.error = tError(e.message);
    renderRow(row);
  }
  renderChrome();
}

function convertAll() {
  closePicker();
  const pending = state.rows.filter((r) => r.kind !== 'merge' && !['done', 'queued', 'processing', 'upload-error'].includes(r.status));
  const missing = pending.filter((r) => !r.target);
  if (missing.length) {
    const targetDesc = missing.length === 1 ? missing[0].name : t('describe.files', { count: missing.length });
    toast(t('toast.chooseTarget', { target: targetDesc }), { type: 'error' });
    missing.forEach((r) => r.el?.querySelector('.target-btn')?.animate([{ boxShadow: 'var(--ring)' }, { boxShadow: 'none' }], { duration: 900 }));
  }
  const ready = pending.filter((r) => r.target);
  if (!ready.length && !missing.length) toast(t('toast.alreadyConverted'));
  for (const r of ready) startJob(r);
}

function ensurePolling() {
  if (!state.polling) state.polling = setInterval(poll, 500);
}

async function poll() {
  const active = state.rows.filter((r) => r.job && ACTIVE.includes(r.job.status));
  const fetching = state.rows.filter((r) => r.status === 'fetching' && r.fetchId);
  if (!active.length && !fetching.length) {
    clearInterval(state.polling);
    state.polling = null;
    return;
  }
  if (active.length) {
    let jobs;
    try { jobs = await api.jobs(active.map((r) => r.job.id)); } catch { jobs = null; }
    if (jobs) {
      const byId = new Map(jobs.map((j) => [j.id, j]));
      for (const r of active) {
        const j = byId.get(r.job.id);
        if (j) applyJob(r, j);
        else { r.status = 'error'; r.error = t('toast.serverLostJob'); r.job = null; renderRow(r); }
      }
    }
  }
  await Promise.all(fetching.map(async (r) => {
    try {
      applyFetch(r, await api.fetchStatus(r.fetchId));
    } catch (e) {
      if (r.status !== 'fetching') return;
      r.status = 'upload-error';
      r.error = e.status === 404 ? t('toast.serverLostDownload') : tError(e.message);
      r.fetchId = null;
      renderRow(r);
    }
  }));
  renderChrome();
}

function applyJob(row, job) {
  const prevStatus = row.status;
  row.job = job;
  row.progress = job.progress;
  row.stage = job.stage;
  row.status = job.status;
  if (job.status === 'error') { row.error = tError(job.error); row.details = job.details; }
  if (job.status === 'done' && prevStatus !== 'done') {
    flashTitle();
    announce(t('a11y.conversionDone', { name: row.name }));
    addToHistory(row);
  }
  patch(row);
}

let titleTimer;
function flashTitle() {
  if (!document.hidden) return;
  document.title = t('toast.titleConverted');
  clearTimeout(titleTimer);
  const restore = () => { document.title = t('toast.titleDefault'); document.removeEventListener('visibilitychange', restore); };
  document.addEventListener('visibilitychange', restore);
}

// ---------------------------------------------------------------- rendering: row

function rowSignature(r) {
  return JSON.stringify([r.status, r.target, r.error, r.showLog, r.name, !!r.upload, r.job?.outputs?.length, r.steps ? 1 : 0, isCustomized(r.steps, r.options), r.autoConvert, currentLang()]);
}

function patch(row) {
  if (!row.el || row.sig !== rowSignature(row)) return renderRow(row);
  const progEl = row.el.querySelector('.progress');
  const bar = progEl?.querySelector('i');
  const text = statusText(row);
  if (progEl && bar) {
    const known = row.status === 'uploading' || row.progress > 0.005;
    const pct = Math.round((row.progress || 0) * 100);
    progEl.classList.toggle('indeterminate', !known);
    bar.style.width = known ? `${pct}%` : '';
    progEl.setAttribute('aria-label', `${row.name}: ${text}`);
    progEl.setAttribute('aria-valuetext', text);
    if (known) {
      progEl.setAttribute('aria-valuenow', String(pct));
    } else {
      progEl.removeAttribute('aria-valuenow');
    }
  }
  const st = row.el.querySelector('.status-text');
  if (st) st.textContent = text;
}

function statusText(row) {
  const pct = `${Math.round((row.progress || 0) * 100)}%`;
  switch (row.status) {
    case 'waiting': return t('status.waiting');
    case 'uploading': return t('status.uploading', { pct });
    case 'fetching': return row.progress > 0.005 ? `${row.stage || t('status.downloading')} · ${pct}` : (row.stage || t('status.downloading'));
    case 'queued': return row.job?.queuePosition > 1 ? t('status.queued', { pos: row.job.queuePosition }) : t('status.starting');
    case 'processing': return row.progress > 0.005 ? `${row.stage || t('status.converting')} · ${pct}` : (row.stage || t('status.converting'));
    default: return '';
  }
}

function renderRow(row) {
  const cat = row.kind === 'merge' ? 'document' : fmtCat(row.format);
  const thumb = h('div.thumb', { dataset: { cat }, 'aria-hidden': 'true' }, row.status === 'fetching'
    ? icon('link')
    : row.thumb ? h('img', { src: row.thumb, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(document.createTextNode(row.format || '?')) }) : (row.kind === 'merge' ? icon('layers') : (row.format || '?').slice(0, 5)));

  const meta = row.status === 'fetching'
    ? [row.sourceUrl || t('status.downloading')]
    : row.kind === 'merge'
      ? [t('row.mergedFrom', { count: row.sources.length })]
      : describe(row);
  const main = h('div.file-main',
    h('div.file-name', { title: row.name }, row.name),
    h('div.file-meta', meta.flatMap((m, i) => (i ? [h('span.sep', { 'aria-hidden': 'true' }, '·'), m] : [m]))),
    row.error ? h('div.file-error', tError(row.error), row.details ? h('button', {
      type: 'button',
      'aria-label': t('a11y.detailsFor', { name: row.name }),
      onclick: () => { row.showLog = !row.showLog; renderRow(row); }
    }, row.showLog ? t('status.hideDetails') : t('status.details')) : null) : null,
    row.showLog && row.details ? h('pre.file-log', { 'aria-label': `${row.name} error log` }, row.details) : null);

  let convert;
  if (row.kind === 'merge') convert = h('div.file-convert', h('span.to', t('row.to')), h('span.target-btn', { style: { cursor: 'default' } }, 'pdf'));
  else {
    const targets = targetsOf(row.format);
    const targetName = row.target ? tFormatName(row.target, state.meta.formats[row.target]?.name || row.target) : '';
    const targetAria = row.target
      ? t('a11y.chooseFormatFor', { name: row.name, target: row.target.toUpperCase() })
      : `${t('row.chooseFormat')}: ${row.name}`;
    const tbtn = h('button.target-btn', {
      type: 'button', class: row.target ? '' : 'empty', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-label': targetAria,
      disabled: row.status === 'upload-error' || row.status === 'fetching' || !targets.length,
      title: row.target ? targetName : t('row.chooseFormat'),
    }, row.target ? row.target : t('row.convertTo'), icon('chevronDown'));
    tbtn.addEventListener('click', () => openPicker({ anchor: tbtn, targets, current: row.target, from: row.format, meta: state.meta, onPick: (to) => setTarget(row, to) }));
    const customized = isCustomized(row.steps, row.options);
    const gear = h('button.icon-btn', {
      type: 'button', class: customized ? 'has-dot' : '',
      'aria-label': t('a11y.settingsFor', { name: row.name }),
      title: row.target ? t('row.settings') : t('row.chooseFormatFirst'),
      disabled: !row.target || !row.steps, onclick: () => openSettings(row),
    }, icon('sliders'));
    convert = h('div.file-convert', h('span.to', t('row.to')), tbtn, gear);
  }

  const status = h('div.file-status');
  const removeBtn = h('button.icon-btn.file-remove', {
    type: 'button',
    'aria-label': t('status.removeFile', { name: row.name }),
    title: t('status.remove'),
    onclick: () => removeRow(row)
  }, icon('x'));

  let progress = null;
  const currentStatusText = statusText(row);
  switch (row.status) {
    case 'waiting': case 'uploading': case 'fetching': {
      const known = row.status === 'uploading' || row.progress > 0.005;
      const pct = Math.round((row.progress || 0) * 100);
      status.append(h('span.status-text', currentStatusText));
      if (row.status === 'fetching') status.append(h('button.icon-btn', {
        type: 'button',
        title: t('status.cancel'),
        'aria-label': t('a11y.cancelDownloadFor', { name: row.name }),
        onclick: () => cancelFetchRow(row)
      }, icon('stop')));
      progress = h('div.progress', {
        class: known ? '' : 'indeterminate',
        role: 'progressbar',
        'aria-label': `${row.name}: ${currentStatusText}`,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': known ? String(pct) : undefined,
        'aria-valuetext': currentStatusText,
      }, h('i', { style: { width: known ? `${pct}%` : undefined } }));
      break;
    }
    case 'queued': case 'processing': {
      const known = row.progress > 0.005;
      const pct = Math.round((row.progress || 0) * 100);
      status.append(h('span.spinner', { 'aria-hidden': 'true' }), h('span.status-text', currentStatusText), h('button.icon-btn', {
        type: 'button',
        title: t('status.cancel'),
        'aria-label': t('a11y.cancelConversionFor', { name: row.name }),
        onclick: () => { api.cancelJob(row.job.id); }
      }, icon('stop')));
      progress = h('div.progress', {
        class: known ? '' : 'indeterminate',
        role: 'progressbar',
        'aria-label': `${row.name}: ${currentStatusText}`,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': known ? String(pct) : undefined,
        'aria-valuetext': currentStatusText,
      }, h('i', { style: { width: known ? `${pct}%` : undefined } }));
      break;
    }
    case 'ready':
      if (row.autoConvert) status.append(h('span.status-text', t('status.starting')));
      else if (row.target && row.steps?.length > 1) status.append(h('span.status-text', { title: row.steps.map((s) => `${s.from} → ${s.to} (${s.label})`).join('\n') }, t('status.stepConversion', { count: row.steps.length })));
      if (row.fromLink && row.upload && !row.autoConvert) {
        status.append(h('a.btn.btn-sm', {
          href: api.uploadFileUrl(row.upload.id),
          download: '',
          title: t('status.downloadAsFetched'),
          'aria-label': t('a11y.downloadOriginalFor', { name: row.name })
        }, icon('download'), t('status.download')));
      }
      break;
    case 'done': {
      const outs = row.job.outputs;
      const total = outs.reduce((s, o) => s + o.size, 0);
      const inSize = row.kind === 'merge' ? row.sources.reduce((s, r) => s + r.size, 0) : row.size;
      const delta = inSize ? Math.round(((total - inSize) / inSize) * 100) : 0;
      status.append(h('div.status-done',
        h('span.size', outs.length > 1 ? `${outs.length} ${t('describe.files', { count: outs.length })} · ${formatBytes(total)}` : formatBytes(total)),
        Math.abs(delta) >= 1 ? h('span.delta', { class: delta < 0 ? 'down' : 'up' }, `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`) : null));
      if (outs.length > 0) status.append(h('a.icon-btn', {
        href: outs.length === 1 ? api.fileUrl(row.job.id, 0, true) : api.downloadUrl(row.job.id, { inline: true }),
        target: '_blank',
        rel: 'noopener',
        title: t('preview.title'),
        'aria-label': t('a11y.openFor', { name: row.name }),
        onclick: (e) => {
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            openPreviewForRow(row);
          }
        }
      }, icon('eye')));
      if (row.fromLink && row.upload) status.append(h('a.icon-btn', {
        href: api.uploadFileUrl(row.upload.id),
        download: '',
        title: t('status.downloadOriginalFmt', { fmt: row.format.toUpperCase() }),
        'aria-label': t('a11y.downloadOriginalFor', { name: row.name })
      }, icon('link')));
      status.append(h('a.btn.btn-sm.btn-primary', {
        href: api.downloadUrl(row.job.id),
        download: '',
        'aria-label': t('a11y.downloadFor', { name: row.name })
      }, icon('download'), outs.length > 1 ? 'ZIP' : t('status.download')));
      break;
    }
    case 'error': case 'cancelled':
      status.append(
        h('span.pill', { class: row.status === 'error' ? 'pill-error' : '' }, row.status === 'error' ? t('status.failed') : t('status.cancelled')),
        row.kind !== 'merge' && row.target ? h('button.icon-btn', {
          type: 'button',
          title: t('status.tryAgain'),
          'aria-label': t('a11y.retryFor', { name: row.name }),
          onclick: () => startJob(row)
        }, icon('refresh')) : null);
      break;
    case 'upload-error':
      status.append(h('span.pill.pill-error', t('status.uploadFailed')));
      break;
    default: break;
  }
  const li = h('li.file', { dataset: { id: row.id }, 'aria-label': row.name }, thumb, main, convert, status, removeBtn, progress);
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
  const panel = $('.list-panel');
  if (panel) panel.hidden = !state.rows.length;
  const title = $('#heroTitle');
  if (title) title.replaceChildren(...(state.rows.length ? [t('hero.titleFiles')] : [t('hero.titleLine1'), h('br'), h('span.soft', t('hero.titleLine2'))]));
  const conv = state.rows.filter((r) => r.kind !== 'merge');
  const done = state.rows.filter((r) => r.status === 'done');
  const pending = conv.filter((r) => !['done', 'queued', 'processing', 'upload-error', 'fetching'].includes(r.status));
  const busy = state.rows.some((r) => ACTIVE.includes(r.status));
  const cb = $('#convertBtn');
  if (cb) {
    cb.disabled = !pending.length;
    cb.replaceChildren(busy && !pending.length ? h('span.spinner', { style: { borderTopColor: 'currentColor' } }) : icon('arrowRight'), pending.length ? t('list.convertCount', { count: pending.length }) : busy ? t('list.converting') : t('list.convert'));
  }
  const dl = $('#downloadAllBtn');
  if (dl) {
    dl.hidden = done.length < 2;
    dl.href = api.downloadAllUrl(done.map((r) => r.job.id));
  }
  const sum = $('#summary');
  if (sum) {
    sum.textContent = t('list.summary', {
      files: state.rows.length,
      filesS: state.rows.length === 1 ? '' : 's',
      done: done.length ? t('list.summaryDone', { count: done.length, s: done.length === 1 ? '' : 's' }) : '',
      busy: busy ? t('list.summaryWorking') : '',
    });
  }
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
  const fileBtn = () => h('button.btn.btn-primary.btn-lg', { type: 'button', onclick: () => $('#fileInput').click() }, icon('upload'), t('dropzone.chooseFiles'));
  const urlBtn = (cls = '.btn-lg') => h(`button.btn${cls}`, { type: 'button', onclick: openUrlImport }, icon('link'), t('dropzone.fromUrl'));

  const dz = h('div.dropzone#dropzone', { role: 'region', 'aria-label': t('a11y.uploadZone') },
    h('div.dz-icon', { 'aria-hidden': 'true' }, icon('upload')),
    h('div.dz-title', t('dropzone.dropAnywhere')),
    h('div.dz-actions', fileBtn(), urlBtn()),
    h('div.dz-hint', t('dropzone.hint', { size: formatBytes(state.meta.limits.maxUploadBytes) }), h('kbd', 'Ctrl'), ' ', h('kbd', 'V'), t('dropzone.pasteHint')));

  const popular = POPULAR.filter(([a, b]) => targetsOf(a).includes(b)).slice(0, 8);
  const pop = popular.length ? h('div.popular', h('span', t('popular.title')), popular.map(([a, b]) => h('button', {
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
    h('span.eyebrow', h('span.dot'), t('hero.eyebrow')),
    h('h1#heroTitle'),
    h('p.lede', t('hero.lede', { count: Object.keys(state.meta.targets).length - 1 })),
    dz, pop);

  const panel = h('section.panel.list-panel', { hidden: !state.rows.length, 'aria-label': t('a11y.fileList') },
    h('div.list-toolbar',
      h('button.btn.btn-sm#allToBtn', { type: 'button', onclick: (e) => convertAllTo(e.currentTarget) }, t('toolbar.convertAllTo'), icon('chevronDown')),
      h('button.btn.btn-sm#mergeBtn', { type: 'button', hidden: true, onclick: openMerge }, icon('layers'), t('toolbar.mergePdf')),
      h('span.spacer'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => $('#fileInput').click() }, icon('plus'), t('toolbar.addFiles')),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: openUrlImport }, icon('link'), t('toolbar.url')),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: clearAll, title: t('toolbar.clearTitle') }, icon('trash'), t('toolbar.clear'))),
    h('ul.files#files', { role: 'list', 'aria-label': t('a11y.fileList') }),
    h('button.add-more#addMore', { type: 'button', onclick: () => $('#fileInput').click() }, icon('plus'), t('list.addMore')),
    h('div.list-footer',
      h('span.summary#summary'),
      h('span.spacer'),
      h('a.btn#downloadAllBtn', { hidden: true, download: '' }, icon('download'), t('list.downloadAll')),
      h('button.btn.btn-primary#convertBtn', { type: 'button', onclick: convertAll }, icon('arrowRight'), t('list.convert'))));

  const app = h('div.app', hero, panel, landing());
  view.replaceChildren(app);
  for (const r of state.rows) { r.el = null; renderRow(r); }
  renderChrome();
}

function landing() {
  const m = state.meta;
  const engines = m.engines.filter((e) => e.available).length;
  const retentionHours = Math.round(m.limits.retentionMinutes / 60 * 10) / 10;
  const features = [
    ['grid', t('feat.formatsTitle'), t('feat.formatsDesc')],
    ['sliders', t('feat.settingsTitle'), t('feat.settingsDesc')],
    ['route', t('feat.chainTitle'), t('feat.chainDesc')],
    ['shield', t('feat.privacyTitle'), t('feat.privacyDesc', { hours: retentionHours })],
    ['layers', t('feat.batchTitle'), t('feat.batchDesc')],
    ['cpu', t('feat.enginesTitle', { count: engines }), t('feat.enginesDesc')],
  ];
  const catCards = m.categories.map((c) => {
    const inputs = Object.keys(m.targets).filter((f) => f !== '*' && m.formats[f]?.category === c.id);
    return { c, inputs };
  }).filter((x) => x.inputs.length);
  return h('div.landing',
    h('div.features', features.map(([ic, ti, d]) => h('div.feature', h('div.fi', icon(ic)), h('h3', ti), h('p', d)))),
    h('div.cat-grid', catCards.map(({ c, inputs }) => h('a.cat-card', { href: `#/formats/${c.id}`, dataset: { cat: c.id } },
      h('div.bar'),
      h('div.top', h('span.name', tCategory(c.id)), h('span.count', t('cat.formatsCount', { count: inputs.length }))),
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
    footer: common.length ? h('span', t('picker.commonFormats')) : h('span', t('picker.noCommonFormats')),
    onPick: (to) => {
      let skipped = 0;
      for (const r of rows) {
        if (targetsOf(r.format).includes(to)) setTarget(r, to);
        else skipped++;
      }
      if (skipped) toast(t('toast.cannotConvert', { count: skipped, s: skipped > 1 ? 's' : '', n: skipped > 1 ? 'n' : '', fmt: to.toUpperCase() }), { type: 'error' });
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
    title: t('settings.title'),
    subtitle: row.name,
    head: chain,
    body: form,
    actions: [
      h('button.btn.btn-ghost', { type: 'button', onclick: () => {
        const fresh = routeDefaults(row.steps);
        values.splice(0, values.length, ...fresh);
        const nf = renderForm(row.steps, values);
        d.body.replaceChildren(nf);
      } }, t('settings.reset')),
      h('span.spacer'),
      sims.length ? h('button.btn', { type: 'button', title: t('settings.applyToAllTitle', { count: sims.length, from: row.format.toUpperCase(), to: row.target.toUpperCase() }), onclick: () => { apply([row, ...similar()]); d.close(); toast(t('settings.appliedToast', { count: sims.length + 1 })); } }, t('settings.applyToAll', { count: sims.length + 1 })) : null,
      h('button.btn.btn-primary', { type: 'button', onclick: () => { apply([row]); d.close(); } }, t('settings.done')),
    ],
  });
}

const URL_PREFS = [
  ['auto', 'url.prefs.auto'],
  ['best', 'url.prefs.best'],
  ['1080', 'url.prefs.1080'],
  ['720', 'url.prefs.720'],
  ['480', 'url.prefs.480'],
  ['audio', 'url.prefs.audio'],
];

function savedUrlPrefs() {
  const saved = storage.get('url-import', {});
  return {
    preference: URL_PREFS.some(([id]) => id === saved.preference) ? saved.preference : 'auto',
    playlist: !!saved.playlist,
    subtitles: !!saved.subtitles,
  };
}

function linkLabel(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return (last || u.hostname).slice(0, 140);
  } catch {
    return String(url || 'Link').slice(0, 140);
  }
}

function ytdlpEngine() {
  return state.meta.engines.find((e) => e.id === 'ytdlp');
}

function startUrlImport(opts) {
  const row = newRow({
    name: linkLabel(opts.url),
    sourceUrl: opts.url,
    size: 0,
    format: '',
    status: 'fetching',
    progress: 0,
    stage: t('status.starting'),
  });
  state.rows.push(row);
  if (location.hash.startsWith('#/formats')) location.hash = '#/';
  if ($('#files')) renderRow(row);
  else renderShell();
  renderChrome();
  api.importUrl(opts).then((job) => {
    if (row.status !== 'fetching') { api.cancelFetch(job.id); return; }
    row.fetchId = job.id;
    applyFetch(row, job);
    ensurePolling();
  }).catch((e) => {
    if (row.status !== 'fetching') return;
    row.status = 'upload-error';
    row.error = tError(e.message);
    renderRow(row);
    renderChrome();
  });
}

function cancelFetchRow(row) {
  const id = row.fetchId;
  row.fetchId = null;
  if (id) api.cancelFetch(id);
  row.status = 'upload-error';
  row.error = t('toast.downloadCancelled');
  renderRow(row);
  renderChrome();
}

function adoptUploads(row, uploads) {
  const [first, ...rest] = uploads;
  if (!first) {
    row.status = 'upload-error';
    row.error = t('toast.downloadNoFile');
    renderRow(row);
    return;
  }
  const fill = (target, up) => {
    target.name = up.name;
    target.size = up.size;
    target.format = up.format;
    target.upload = up;
    target.status = 'ready';
    target.progress = 1;
    target.stage = '';
    target.fetchId = null;
    target.sourceUrl = null;
    target.error = null;
    target.fromLink = true;
    if (state.preset && targetsOf(up.format).includes(state.preset)) target.target = state.preset;
  };
  fill(row, first);
  const extras = rest.map((up) => {
    const extra = newRow({ status: 'ready' });
    fill(extra, up);
    return extra;
  });
  const idx = state.rows.indexOf(row);
  if (idx >= 0 && extras.length) state.rows.splice(idx + 1, 0, ...extras);
  state.preset = null;
  renderShell();
  for (const r of [row, ...extras]) if (r.target) loadRoute(r);
  if (uploads.length > 1) toast(t('toast.addedFiles', { count: uploads.length }));
}

function applyFetch(row, job) {
  if (row.status !== 'fetching') return;
  row.progress = job.progress || 0;
  row.stage = job.stage || t('status.downloading');
  if (job.status === 'done') {
    adoptUploads(row, job.uploads || []);
    return;
  }
  if (job.status === 'error' || job.status === 'cancelled') {
    row.fetchId = null;
    row.status = 'upload-error';
    row.error = job.status === 'cancelled' ? t('toast.downloadCancelled') : tError(job.error || t('toast.downloadCancelled'));
    row.details = job.details || null;
    renderRow(row);
    renderChrome();
    return;
  }
  patch(row);
}

function openUrlImport() {
  const prefs = savedUrlPrefs();
  const urlId = 'url-import-input';
  const prefId = 'url-import-pref';
  const playlistId = 'url-import-playlist';
  const subsId = 'url-import-subs';

  const input = h('input.input', { id: urlId, type: 'url', placeholder: t('url.placeholder'), spellcheck: 'false', 'aria-required': 'true' });
  const preference = h('select.select', { id: prefId }, URL_PREFS.map(([id, key]) => h('option', { value: id, selected: id === prefs.preference }, t(key))));
  const playlistBox = h('input', { id: playlistId, type: 'checkbox' });
  playlistBox.checked = prefs.playlist;
  const subsBox = h('input', { id: subsId, type: 'checkbox' });
  subsBox.checked = prefs.subtitles;
  const toggle = (box, id, label, help) => h('div.field.field-toggle.full',
    h('div.txt', h('label.field-label', { for: id }, label), h('div.field-help', help)),
    h('label.switch', box, h('span', { 'aria-hidden': 'true' })));
  const ytdlp = ytdlpEngine();
  const note = ytdlp && !ytdlp.available
    ? h('div.field-note', icon('info'), h('span', t('url.ytdlpNote')))
    : null;
  const go = h('button.btn.btn-primary', { type: 'button' }, t('url.import'));
  const m = modal({
    title: t('url.title'),
    subtitle: t('url.subtitle'),
    body: h('form.url-form', { onsubmit: (e) => { e.preventDefault(); go.click(); } },
      h('div.field', h('label.field-label', { for: urlId }, h('span', t('url.inputLabel'))), input),
      h('div.field', h('label.field-label', { for: prefId }, h('span', t('url.saveAs'))), preference, h('div.field-help', t('url.saveAsHelp'))),
      toggle(playlistBox, playlistId, t('url.playlist'), t('url.playlistHelp')),
      toggle(subsBox, subsId, t('url.subtitles'), t('url.subtitlesHelp')),
      note),
    actions: [h('button.btn', { type: 'button', onclick: () => m.close() }, t('url.cancel')), go],
  });
  go.addEventListener('click', () => {
    const url = input.value.trim();
    if (!url) return input.focus();
    const opts = { url, preference: preference.value, playlist: playlistBox.checked, subtitles: subsBox.checked };
    storage.set('url-import', { preference: opts.preference, playlist: opts.playlist, subtitles: opts.subtitles });
    startUrlImport(opts);
    m.close();
  });
}

async function openMerge() {
  const items = mergeCandidates().slice();
  let schema;
  try { schema = await api.mergeSchema(); } catch (e) { toast(tError(e.message), { type: 'error' }); return; }
  const steps = [{ label: 'PDF', from: 'pdf', to: 'pdf', groups: schema.groups }];
  const values = routeDefaults(steps);
  const list = h('ol.merge-list');
  let dragIdx = -1;
  const renderList = () => {
    list.replaceChildren(...items.map((r, i) => {
      const li = h('li', { draggable: 'true' },
        h('span.grip', { 'aria-hidden': 'true' }, icon('grip')),
        h('span.idx', { 'aria-hidden': 'true' }, i + 1),
        fmtBadge(r.format),
        h('span.nm', { title: r.name }, r.name),
        h('button.icon-btn', {
          type: 'button',
          'aria-label': `${t('merge.moveUp')}: ${r.name}`,
          disabled: i === 0,
          onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; renderList(); }
        }, h('span', { style: { transform: 'rotate(180deg)', display: 'grid' }, 'aria-hidden': 'true' }, icon('chevronDown'))),
        h('button.icon-btn', {
          type: 'button',
          'aria-label': `${t('merge.moveDown')}: ${r.name}`,
          disabled: i === items.length - 1,
          onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; renderList(); }
        }, icon('chevronDown')),
        h('button.icon-btn', {
          type: 'button',
          'aria-label': `${t('merge.leaveOut')}: ${r.name}`,
          disabled: items.length <= 2,
          onclick: () => { items.splice(i, 1); renderList(); }
        }, icon('x')));
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
  const nameId = 'merge-filename-input';
  const name = h('input.input', { id: nameId, type: 'text', value: 'merged', spellcheck: 'false' });
  const go = h('button.btn.btn-primary', { type: 'button' }, icon('layers'), t('merge.merge'));
  const m = modal({
    title: t('merge.title'),
    subtitle: t('merge.subtitle'),
    size: 'modal-lg',
    body: [
      list,
      h('div.field', { style: { marginBottom: '8px' } },
        h('label.field-label', { for: nameId }, t('merge.fileName')),
        h('div.input-wrap', name, h('span.unit', '.pdf'))
      ),
      renderForm(steps, values)
    ],
    actions: [h('button.btn', { type: 'button', onclick: () => m.close() }, t('merge.cancel')), go],
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
      toast(tError(e.message), { type: 'error' });
      go.disabled = false;
    }
  });
}

function openEngines() {
  const body = h('div');
  const render = () => {
    const engines = state.meta.engines;
    const dockerBanner = state.meta.isDocker
      ? h('div.docker-banner', icon('shield'), h('span', t('engines.docker')))
      : null;
    const list = engines.map((e) => h('div.engine',
      h('span.led', { class: e.available ? 'on' : '', 'aria-hidden': 'true' }),
      h('div',
        h('div', h('span.name', e.label), ' ', h('span.ver', e.available ? e.version || '' : e.optional ? t('engines.notInstalled') : e.note || t('engines.unavailable'))),
        e.available && e.detail ? h('div.adds', e.detail) : null,
        !e.available && e.optional ? [h('div.adds', t('engines.adds', { adds: e.optional.adds })), h('div.cmd', h('code', e.optional.install), h('button.icon-btn', { type: 'button', title: t('engines.copy'), 'aria-label': `${t('engines.copyCommand')}: ${e.label}`, onclick: () => copyText(e.optional.install) }, icon('copy')))] : null),
      h('span.dim', { style: { fontSize: '12px' } }, e.available ? t('engines.active') : '')));
    body.replaceChildren(...(dockerBanner ? [dockerBanner, ...list] : list));
  };
  render();
  const rescan = h('button.btn', { type: 'button' }, icon('refresh'), t('engines.rescan'));
  const m = modal({
    title: t('engines.title'),
    subtitle: t('engines.subtitle'),
    body,
    actions: [rescan, h('button.btn.btn-primary', { type: 'button', onclick: () => m.close() }, t('engines.close'))],
  });
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    try {
      state.meta = await api.rescan();
      applyMeta();
      render();
      toast(t('engines.rescanned'));
      if (!location.hash.startsWith('#/formats')) renderShell();
    } catch (e) {
      toast(tError(e.message), { type: 'error' });
    }
    rescan.disabled = false;
  });
}

// ---------------------------------------------------------------- history

function getHistory() {
  return storage.get('history', []);
}

function saveHistory(list) {
  storage.set('history', list.slice(0, 80));
  updateHistoryBadge();
}

function updateHistoryBadge() {
  const badge = $('#historyBadge');
  if (!badge) return;
  const count = getHistory().length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function addToHistory(row) {
  if (!row.job || row.job.status !== 'done') return;
  const history = getHistory();
  if (history.some((h) => h.jobId === row.job.id)) return;
  const outs = row.job.outputs || [];
  const totalSize = outs.reduce((sum, o) => sum + (o.size || 0), 0) || row.size || 0;
  const item = {
    id: row.job.id,
    jobId: row.job.id,
    name: row.name,
    originalFormat: row.format,
    targetFormat: row.target || row.job.to,
    size: totalSize,
    timestamp: Date.now(),
    outputs: outs.map((o) => ({ name: o.name, size: o.size, index: o.index })),
    kind: row.kind || 'convert',
  };
  history.unshift(item);
  saveHistory(history);
}

function formatTimeAgo(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return currentLang() === 'es' ? 'hace un momento' : 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return currentLang() === 'es' ? `hace ${diffMin} min` : `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return currentLang() === 'es' ? `hace ${diffHrs} h` : `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return currentLang() === 'es' ? `hace ${diffDays} d` : `${diffDays}d ago`;
}

function openHistory() {
  const items = getHistory();
  const body = h('div');

  const render = () => {
    const list = getHistory();
    if (!list.length) {
      body.replaceChildren(
        h('div.history-empty',
          icon('clock'),
          h('h3', t('history.empty')),
          h('p', t('history.emptyHint'))
        )
      );
      return;
    }

    const ul = h('ul.history-list', list.map((item) => {
      const outFmt = (item.targetFormat || '').toLowerCase();

      return h('li.history-item',
        fmtBadge(outFmt),
        h('div.history-info',
          h('div.history-name', { title: item.name }, item.name),
          h('div.history-meta',
            h('span', outFmt.toUpperCase()),
            h('span.dot'),
            h('span', formatBytes(item.size)),
            h('span.dot'),
            h('span', formatTimeAgo(item.timestamp))
          )
        ),
        h('div.history-actions',
          h('button.icon-btn', {
            type: 'button',
            title: t('history.preview'),
            onclick: () => {
              m.close();
              openPreviewForHistoryItem(item);
            }
          }, icon('eye')),
          h('a.icon-btn', {
            href: api.downloadUrl(item.jobId),
            download: '',
            title: t('history.download'),
          }, icon('download')),
          h('button.icon-btn', {
            type: 'button',
            title: t('status.remove'),
            onclick: () => {
              const updated = getHistory().filter((x) => x.id !== item.id);
              saveHistory(updated);
              render();
            }
          }, icon('trash'))
        )
      );
    }));

    body.replaceChildren(ul);
  };

  render();

  const clearBtn = h('button.btn.btn-ghost', {
    type: 'button',
    onclick: () => {
      if (getHistory().length && confirm(t('history.clearConfirm'))) {
        saveHistory([]);
        render();
      }
    }
  }, icon('trash'), t('history.clear'));

  const m = modal({
    title: t('history.title'),
    subtitle: t('history.badge', { count: items.length }),
    size: 'modal-lg',
    body,
    actions: [clearBtn, h('button.btn.btn-primary', { type: 'button', onclick: () => m.close() }, t('engines.close'))],
  });
}

// ---------------------------------------------------------------- preview

function openPreviewForRow(row) {
  if (!row.job?.outputs?.length) return;
  const outs = row.job.outputs;
  const first = outs[0];
  const outFmt = detectFormat(first.name, state.meta?.aliases) || row.target || '';
  openPreview({
    jobId: row.job.id,
    name: first.name || row.name,
    format: outFmt,
    size: first.size || row.size,
    outputs: outs,
  });
}

function openPreviewForHistoryItem(item) {
  const outs = item.outputs?.length ? item.outputs : [{ name: item.name, size: item.size, index: 0 }];
  const first = outs[0];
  const outFmt = (item.targetFormat || detectFormat(first.name, state.meta?.aliases) || '').toLowerCase();
  openPreview({
    jobId: item.jobId,
    name: first.name || item.name,
    format: outFmt,
    size: first.size || item.size,
    outputs: outs,
  });
}

function openPreview({ jobId, name, format, size, outputs = [] }) {
  let currentIndex = 0;
  const container = h('div.preview-container');
  const toolbar = h('div.preview-toolbar');

  const renderContent = (index) => {
    currentIndex = index;
    const file = outputs[index] || { name, size, index: 0 };
    const curName = file.name || name;
    const curFmt = (detectFormat(curName, state.meta?.aliases) || format || '').toLowerCase();
    const curSize = file.size || size || 0;
    const curUrl = api.fileUrl(jobId, index, true);
    const curDownload = api.fileUrl(jobId, index, false);

    const metaSpan = h('div.preview-meta',
      fmtBadge(curFmt),
      h('strong', curName),
      h('span.dot'),
      h('span', formatBytes(curSize))
    );

    const actions = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
      h('a.icon-btn', {
        href: curUrl,
        target: '_blank',
        rel: 'noopener',
        title: t('preview.openNewTab')
      }, icon('external')),
      h('a.btn.btn-sm.btn-primary', {
        href: curDownload,
        download: curName,
        title: t('preview.download')
      }, icon('download'), t('preview.download'))
    );

    let switcher = null;
    if (outputs.length > 1) {
      switcher = h('select.select', {
        style: { width: 'auto', minWidth: '150px', height: '32px', fontSize: '12px' },
        onchange: (e) => renderContent(Number(e.target.value))
      }, outputs.map((o, i) => h('option', { value: i, selected: i === index }, `${i + 1}. ${o.name} (${formatBytes(o.size)})`)));
    }

    toolbar.replaceChildren(
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, metaSpan, switcher),
      actions
    );

    const imgFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'apng'];
    const videoFormats = ['mp4', 'webm', 'mov', 'mkv'];
    const audioFormats = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac'];
    const codeFormats = ['txt', 'md', 'json', 'html', 'xml', 'yaml', 'yml', 'csv', 'tsv', 'srt', 'vtt', 'log', 'css', 'js', 'sh', 'sql', 'toml', 'ini'];

    if (imgFormats.includes(curFmt)) {
      container.replaceChildren(h('img.preview-img', { src: curUrl, alt: curName }));
    } else if (videoFormats.includes(curFmt)) {
      container.replaceChildren(h('video.preview-video', { src: curUrl, controls: true, playsinline: true, autoplay: true }));
    } else if (audioFormats.includes(curFmt)) {
      container.replaceChildren(
        h('div.preview-audio-wrap',
          h('div.preview-audio-icon', icon('sparkle')),
          h('strong', { style: { fontSize: '14px', wordBreak: 'break-all', textAlign: 'center' } }, curName),
          h('audio', { src: curUrl, controls: true, autoplay: true })
        )
      );
    } else if (curFmt === 'pdf') {
      container.replaceChildren(h('iframe.preview-iframe', { src: curUrl, title: curName }));
    } else if (codeFormats.includes(curFmt)) {
      const codeWrap = h('pre.preview-code-wrap', t('preview.loading'));
      container.replaceChildren(codeWrap);
      fetch(curUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => {
          const codeEl = h('code', text.slice(0, 500000) + (text.length > 500000 ? '\n\n... (truncated)' : ''));
          codeWrap.replaceChildren(codeEl);
          const copyBtn = h('button.btn.btn-sm', {
            type: 'button',
            style: { marginLeft: '8px' },
            onclick: () => {
              copyText(text);
              toast(t('preview.copiedCode'));
            }
          }, icon('copy'), t('preview.copyCode'));
          actions.prepend(copyBtn);
        })
        .catch((err) => {
          codeWrap.textContent = `Error reading file: ${err.message}`;
        });
    } else {
      container.replaceChildren(
        h('div.preview-unsupported',
          h('div.preview-unsupported-icon', icon('fileText')),
          h('h3', t('preview.unsupported')),
          h('p', t('preview.unsupportedHint')),
          h('a.btn.btn-primary', { href: curDownload, download: curName }, icon('download'), t('preview.download'))
        )
      );
    }
  };

  const m = modal({
    title: t('preview.title'),
    size: 'modal-lg modal-preview',
    body: [toolbar, container],
    actions: [h('button.btn.btn-primary', { type: 'button', onclick: () => m.close() }, t('preview.close'))],
  });

  renderContent(0);
}

// ---------------------------------------------------------------- SSE

let sseSource = null;

function initSSE() {
  if (typeof EventSource === 'undefined' || sseSource) return;

  try {
    sseSource = new EventSource('/api/jobs/events');

    sseSource.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return;
      try {
        const job = JSON.parse(e.data);
        const row = state.rows.find((r) => r.job?.id === job.id || (r.upload?.id && r.upload.id === job.uploadId));
        if (row) {
          applyJob(row, job);
          renderChrome();
        }
      } catch {}
    };

    sseSource.onerror = () => {
      ensurePolling();
    };
  } catch {
    ensurePolling();
  }
}

// ---------------------------------------------------------------- drag & drop, paste

function setupGlobalDrop() {
  const veil = h('div.dropveil', h('div', t('drop.veil')));
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

function pastedLinks(text) {
  const parts = String(text || '').trim().split(/[\s\n]+/).filter(Boolean);
  if (!parts.length || parts.length > 10) return null;
  if (!parts.every((p) => /^https?:\/\/\S+$/i.test(p))) return null;
  return parts;
}

function setupPaste() {
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      if (location.hash.startsWith('#/formats')) location.hash = '#/';
      addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, { type: f.type }))));
      return;
    }
    const links = pastedLinks(e.clipboardData?.getData('text/plain'));
    if (!links) return;
    e.preventDefault();
    const prefs = savedUrlPrefs();
    for (const url of links) startUrlImport({ url, ...prefs });
  });
}

// ---------------------------------------------------------------- routing & boot

function applyMeta() {
  const m = state.meta;
  if (!m) return;
  document.title = t('toast.titleDefault');
  $('#retention').textContent = retentionText();
  const on = m.engines.filter((e) => e.available).length;
  $('#engineSummary').textContent = t('footer.enginesActive', { on, total: m.engines.length });
  updateNav();
}

function route() {
  closePicker();
  const hash = location.hash || '#/';
  const isFormats = hash.startsWith('#/formats');
  for (const a of document.querySelectorAll('[data-nav]')) {
    const active = isFormats ? a.dataset.nav === 'formats' : a.dataset.nav === 'convert';
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (isFormats) {
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
  initLang();
  window.addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  try {
    state.meta = await api.meta();
  } catch (e) {
    $('#view').replaceChildren(h('div.page-head', h('h1', t('toast.serverUnreachable')), h('p', t('toast.startWithNpm', { message: e.message }))));
    return;
  }
  applyMeta();
  $('#enginesBtn').addEventListener('click', openEngines);
  $('#historyBtn')?.addEventListener('click', openHistory);
  updateHistoryBadge();
  initSSE();
  $('#fileInput').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  setupGlobalDrop();
  setupPaste();
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => {
    if (state.rows.some((r) => ['uploading', 'fetching', 'queued', 'processing'].includes(r.status))) e.preventDefault();
  });
  route();
}

boot();

// Exposed for debugging in the console.
window.recast = { state };
