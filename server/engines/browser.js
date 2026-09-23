// HTML/SVG → PDF and screenshots through a headless Chromium browser (Edge, Chrome or Brave).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { f, group, PAPER_SIZES, paperMm } from '../schema.js';
import { tools } from '../tools.js';
import { dirs } from '../config.js';
import { UserError, opt, clamp, sleep, ensureDir, rmrf } from '../util.js';

let browserPromise = null;
let idleTimer = null;
let active = 0;

async function connectFromPortFile(profile, timeoutMs) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (port && wsPath) return await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${wsPath}`, defaultViewport: null, protocolTimeout: 180000 });
    } catch {}
    await sleep(100);
  }
  return null;
}

async function launch() {
  if (!tools.browser) throw new UserError('No Chromium-based browser (Edge/Chrome) was found');
  const profile = path.join(dirs.profiles, 'browser');
  await ensureDir(profile);
  // Reuse a browser left running by a previous server process, if any.
  const existing = fs.existsSync(path.join(profile, 'DevToolsActivePort')) ? await connectFromPortFile(profile, 1500) : null;
  if (existing) return existing;
  await rmrf(path.join(profile, 'DevToolsActivePort'));
  // Launch detached and connect through DevToolsActivePort: some Edge installs re-spawn
  // themselves, which breaks puppeteer.launch()'s process tracking.
  const child = spawn(tools.browser, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars', '--no-pings', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    // Containers usually lack the namespaces Chromium's sandbox needs, and have a tiny /dev/shm.
    ...(process.env.BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  const browser = await connectFromPortFile(profile, 20000);
  if (!browser) throw new UserError('The headless browser did not start');
  return browser;
}

async function getBrowser() {
  if (!browserPromise) browserPromise = launch().catch((e) => { browserPromise = null; throw e; });
  const b = await browserPromise;
  if (!b.connected) {
    browserPromise = null;
    return getBrowser();
  }
  return b;
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (active === 0) shutdownBrowser(); }, 90_000);
  idleTimer.unref?.();
}

export async function shutdownBrowser() {
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  const b = await p.catch(() => null);
  await b?.close().catch(() => {});
}

const MARGINS = { none: 0, small: 10, normal: 20, large: 30 };

function schema({ from, to }) {
  if (to === 'pdf') {
    return [
      group('page', 'Page', [
        f.select('paper', 'Paper size', [{ value: 'fit', label: 'Fit to content (one page)' }, ...PAPER_SIZES], from === 'svg' ? 'fit' : 'A4'),
        f.number('paperW', 'Width', { unit: 'mm', min: 20, max: 5000, default: 210, showIf: { paper: ['custom'] } }),
        f.number('paperH', 'Height', { unit: 'mm', min: 20, max: 5000, default: 297, showIf: { paper: ['custom'] } }),
        f.select('orientation', 'Orientation', [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }], 'portrait', { showIf: { paper: { not: ['fit'] } } }),
        f.select('margins', 'Margins', [{ value: 'none', label: 'None' }, { value: 'small', label: 'Small · 10 mm' }, { value: 'normal', label: 'Normal · 20 mm' }, { value: 'large', label: 'Large · 30 mm' }, { value: 'custom', label: 'Custom…' }], from === 'svg' ? 'none' : 'normal', { showIf: { paper: { not: ['fit'] } } }),
        f.number('mTop', 'Top', { unit: 'mm', min: 0, max: 100, default: 20, showIf: { margins: ['custom'] } }),
        f.number('mRight', 'Right', { unit: 'mm', min: 0, max: 100, default: 20, showIf: { margins: ['custom'] } }),
        f.number('mBottom', 'Bottom', { unit: 'mm', min: 0, max: 100, default: 20, showIf: { margins: ['custom'] } }),
        f.number('mLeft', 'Left', { unit: 'mm', min: 0, max: 100, default: 20, showIf: { margins: ['custom'] } }),
        f.range('scale', 'Scale', 10, 200, 1, 100, { unit: '%', showIf: { paper: { not: ['fit'] } } }),
        f.text('pageRanges', 'Pages', { placeholder: 'all', help: 'e.g. 1-3, 5', showIf: { paper: { not: ['fit'] } } }),
      ]),
      group('print', 'Print options', [
        f.toggle('printBackground', 'Print backgrounds', true),
        f.select('headerFooter', 'Header & footer', [{ value: 'none', label: 'None' }, { value: 'numbers', label: 'Page numbers' }, { value: 'full', label: 'Title, date & page numbers' }], 'none', { showIf: { paper: { not: ['fit'] } } }),
        f.toggle('outline', 'Bookmarks from headings', true),
        f.toggle('preferCSSPageSize', 'Use page size defined by the document', false, { showIf: { paper: { not: ['fit'] } } }),
        f.select('media', 'CSS media', [{ value: 'print', label: 'Print' }, { value: 'screen', label: 'Screen' }], 'print'),
      ]),
      group('render', 'Rendering', [
        f.toggle('javascript', 'Run JavaScript', true),
        f.number('waitMs', 'Extra wait', { unit: 'ms', min: 0, max: 30000, placeholder: '0', help: 'Time for scripts and web fonts to finish.' }),
      ], { collapsed: true }),
    ];
  }
  return [
    group('shot', 'Screenshot', [
      f.number('vw', 'Viewport width', { unit: 'px', min: 200, max: 7680, default: 1280 }),
      f.number('vh', 'Viewport height', { unit: 'px', min: 200, max: 4320, default: 800 }),
      f.toggle('fullPage', 'Capture full page', true),
      f.select('dsf', 'Pixel density', [{ value: '1', label: '1× (standard)' }, { value: '2', label: '2× (retina)' }, { value: '3', label: '3×' }], '1'),
      to !== 'jpg' ? f.toggle('transparent', 'Transparent background') : null,
      to !== 'png' ? f.range('quality', 'Quality', 1, 100, 1, 85) : null,
      f.toggle('darkMode', 'Emulate dark mode'),
    ]),
    group('render', 'Rendering', [
      f.toggle('javascript', 'Run JavaScript', true),
      f.number('waitMs', 'Extra wait', { unit: 'ms', min: 0, max: 30000, placeholder: '0' }),
    ], { collapsed: true }),
  ];
}

async function convert({ input, from, to, o, outDir, baseName, signal, progress }) {
  active++;
  clearTimeout(idleTimer);
  let page;
  try {
    const browser = await getBrowser();
    progress(0.15);
    page = await browser.newPage();
    const onAbort = () => page?.close().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    await page.setJavaScriptEnabled(opt.bool(o.javascript, true));
    const isPdf = to === 'pdf';
    await page.setViewport({
      width: Math.round(clamp(opt.num(o.vw, 1280), 200, 7680)),
      height: Math.round(clamp(opt.num(o.vh, 800), 200, 4320)),
      deviceScaleFactor: isPdf ? 1 : clamp(opt.num(o.dsf, 1), 1, 3),
    });
    await page.emulateMediaType(isPdf ? o.media || 'print' : 'screen');
    if (opt.bool(o.darkMode)) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.goto(pathToFileURL(input).href, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    const wait = clamp(opt.num(o.waitMs, 0), 0, 30000);
    if (wait) await sleep(wait);
    progress(0.5);
    const out = path.join(outDir, `${baseName}.${to}`);

    if (isPdf) {
      const pdfOpts = { printBackground: opt.bool(o.printBackground, true), timeout: 180_000, outline: opt.bool(o.outline, true), tagged: true };
      if (o.paper === 'fit') {
        const dims = await page.evaluate(() => {
          const el = document.documentElement;
          const svg = document.querySelector('svg');
          if (document.body == null && svg) {
            const r = svg.getBoundingClientRect();
            return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
          }
          return { w: Math.max(el.scrollWidth, document.body?.scrollWidth || 0), h: Math.max(el.scrollHeight, document.body?.scrollHeight || 0) };
        });
        Object.assign(pdfOpts, { width: `${dims.w + 1}px`, height: `${dims.h + 1}px`, margin: { top: 0, right: 0, bottom: 0, left: 0 }, pageRanges: '1' });
      } else {
        const p = o.paper === 'custom' ? { w: opt.num(o.paperW, 210), h: opt.num(o.paperH, 297) } : paperMm(o.paper || 'A4');
        const m = o.margins === 'custom'
          ? { top: opt.num(o.mTop, 20), right: opt.num(o.mRight, 20), bottom: opt.num(o.mBottom, 20), left: opt.num(o.mLeft, 20) }
          : Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k) => [k, MARGINS[o.margins || 'normal'] ?? 20]));
        const hf = o.headerFooter || 'none';
        if (hf !== 'none') {
          m.top = Math.max(m.top, 14);
          m.bottom = Math.max(m.bottom, 14);
        }
        Object.assign(pdfOpts, {
          width: `${p.w}mm`,
          height: `${p.h}mm`,
          landscape: o.orientation === 'landscape',
          margin: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, `${v}mm`])),
          scale: clamp(opt.num(o.scale, 100), 10, 200) / 100,
          preferCSSPageSize: opt.bool(o.preferCSSPageSize),
          pageRanges: opt.str(o.pageRanges).replace(/\s+/g, ''),
          displayHeaderFooter: hf !== 'none',
          headerTemplate: hf === 'full' ? '<div style="font:8px sans-serif;color:#777;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span class="title"></span><span class="date"></span></div>' : '<div></div>',
          footerTemplate: hf !== 'none' ? '<div style="font:8px sans-serif;color:#777;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' : '<div></div>',
        });
      }
      try {
        await page.pdf({ ...pdfOpts, path: out });
      } catch (e) {
        if (/page range/i.test(e.message)) throw new UserError('The page range is invalid for this document');
        throw e;
      }
      return [out];
    }

    const type = to === 'jpg' ? 'jpeg' : to;
    await page.screenshot({
      path: out,
      type,
      fullPage: opt.bool(o.fullPage, true),
      omitBackground: to !== 'jpg' && opt.bool(o.transparent),
      ...(type !== 'png' ? { quality: Math.round(clamp(opt.num(o.quality, 85), 1, 100)) } : {}),
      captureBeyondViewport: true,
    });
    return [out];
  } catch (e) {
    if (signal?.aborted) throw new UserError('Cancelled');
    if (e.userFacing) throw e;
    throw new UserError('The browser could not render this page', e.message);
  } finally {
    await page?.close().catch(() => {});
    active--;
    scheduleIdleClose();
  }
}

export default {
  id: 'browser',
  label: 'Headless browser',
  detect: async () => {
    if (!tools.browser) return { available: false, note: 'Install Microsoft Edge, Google Chrome or Chromium' };
    const name = /msedge/i.test(tools.browser) ? 'Microsoft Edge' : /brave/i.test(tools.browser) ? 'Brave' : 'Chrome';
    return { available: true, version: name, detail: 'HTML rendering for PDF & screenshots' };
  },
  routes: () => [
    { from: ['html', 'xhtml', 'mhtml'], to: ['pdf'], cost: 1 },
    { from: ['html', 'xhtml', 'mhtml'], to: ['png', 'jpg', 'webp'], cost: 1, sourceOnly: true },
    { from: ['svg'], to: ['pdf'], cost: 1 },
  ],
  schema,
  convert,
  shutdown: shutdownBrowser,
};

