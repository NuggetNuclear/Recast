// Engine registry and conversion router.
// Every engine declares direct routes; the router chains them through a few "pivot"
// formats (png, pdf, html, json) to reach targets no single engine supports.
import { FORMATS, categoryOf } from './formats.js';
import { rescanTools } from './tools.js';
import image from './engines/image.js';
import media from './engines/media.js';
import subtitle from './engines/subtitle.js';
import pdf from './engines/pdf.js';
import imagepdf from './engines/imagepdf.js';
import browser from './engines/browser.js';
import markup from './engines/markup.js';
import data from './engines/data.js';
import sheet from './engines/sheet.js';
import archive from './engines/archive.js';
import font from './engines/font.js';
import trace from './engines/trace.js';
import office from './engines/office.js';
import pandoc from './engines/pandoc.js';
import ebook from './engines/ebook.js';
import ytdlp from './engines/ytdlp.js';

export const ENGINES = [image, media, subtitle, pdf, imagepdf, browser, markup, data, sheet, archive, font, trace, office, pandoc, ebook, ytdlp];
const byId = Object.fromEntries(ENGINES.map((e) => [e.id, e]));

const HOP_PENALTY = 0.5;
const MAX_HOPS = 4;

// Which chains are sensible: source categories allowed through a pivot, and the
// categories the next step may produce.
const COMMON_IMAGES = ['jpg', 'webp', 'avif', 'tiff', 'gif', 'bmp'];
const PIVOTS = {
  png: {
    from: ['image', 'vector', 'video', 'document', 'ebook', 'presentation', 'spreadsheet'],
    to: ['image', 'vector'],
    extra: { pdf: ['image'] },
    // Rendered pages and video frames only continue to everyday image formats.
    only: { video: COMMON_IMAGES, document: COMMON_IMAGES, ebook: COMMON_IMAGES, spreadsheet: COMMON_IMAGES, presentation: COMMON_IMAGES },
  },
  pdf: { from: ['document', 'ebook', 'spreadsheet', 'presentation'], to: ['image', 'document', 'vector'] },
  html: { from: ['document', 'ebook', 'spreadsheet', 'presentation', 'data'], to: ['document', 'image'] },
  json: { from: ['data', 'spreadsheet'], to: ['data', 'spreadsheet'] },
};

let status = {};
let graph = new Map();
let wildcard = [];
let routeCache = new Map();

export async function initEngines() {
  const results = await Promise.all(ENGINES.map(async (e) => {
    try {
      return [e.id, { available: false, ...(await e.detect()) }];
    } catch (err) {
      return [e.id, { available: false, note: err.message }];
    }
  }));
  status = Object.fromEntries(results);
  buildGraph();
  return status;
}

export async function rescan() {
  rescanTools();
  return initEngines();
}

function buildGraph() {
  graph = new Map();
  wildcard = [];
  routeCache = new Map();
  for (const e of ENGINES) {
    if (!status[e.id]?.available) continue;
    for (const r of e.routes()) {
      for (const from of r.from) {
        for (const to of r.to) {
          if (from === '*') { wildcard.push({ engine: e.id, to, cost: r.cost }); continue; }
          if (from === to && !r.same) continue;
          if (!graph.has(from)) graph.set(from, new Map());
          const cur = graph.get(from).get(to);
          if (!cur || r.cost < cur.cost) graph.get(from).set(to, { engine: e.id, cost: r.cost, sourceOnly: !!r.sourceOnly });
        }
      }
    }
  }
}

function edges(fmt, isSource) {
  const out = [];
  for (const [to, e] of graph.get(fmt) || []) if (isSource || !e.sourceOnly) out.push({ from: fmt, to, ...e });
  if (isSource) for (const w of wildcard) if (!graph.get(fmt)?.has(w.to) && w.to !== fmt) out.push({ from: fmt, ...w, wildcard: true });
  return out;
}

function pivotAllows(pivot, srcCat, nextTo) {
  const rule = PIVOTS[pivot];
  if (!rule || !rule.from.includes(srcCat)) return false;
  if (rule.only?.[srcCat]) return rule.only[srcCat].includes(nextTo);
  const cat = categoryOf(nextTo);
  return rule.to.includes(cat) || (rule.extra?.[nextTo] || []).includes(srcCat);
}

/** All reachable targets from a source format → Map(to → { steps, cost }). */
function routesFrom(src) {
  if (routeCache.has(src)) return routeCache.get(src);
  const best = new Map();
  const srcCat = categoryOf(src) || 'other';
  const consider = (path) => {
    const to = path[path.length - 1].to;
    if (to === src && path.length > 1) return;
    const cost = path.reduce((s, e) => s + e.cost, 0) + HOP_PENALTY * (path.length - 1);
    const cur = best.get(to);
    if (!cur || cost < cur.cost - 1e-9) best.set(to, { cost, steps: path.map((e) => ({ engine: e.engine, from: e.from, to: e.to, ...(e.wildcard ? { wildcard: true } : {}) })) });
  };
  const walk = (path) => {
    consider(path);
    if (path.length >= MAX_HOPS) return;
    const last = path[path.length - 1];
    if (!PIVOTS[last.to] || last.to === src) return;
    const seen = new Set([src, ...path.map((e) => e.to)]);
    for (const e of edges(last.to, false)) {
      if (seen.has(e.to)) continue;
      if (!pivotAllows(last.to, srcCat, e.to)) continue;
      walk([...path, e]);
    }
  };
  for (const e of edges(src, true)) walk([e]);
  routeCache.set(src, best);
  return best;
}

export function findRoute(from, to) {
  return routesFrom(from).get(to) || null;
}

export function targetsFor(from) {
  return [...routesFrom(from).keys()].filter((t) => FORMATS[t]);
}

export function allTargets() {
  const out = {};
  for (const fmt of Object.keys(FORMATS)) {
    // Formats that can only be zipped up are not really "supported" inputs.
    const real = [...routesFrom(fmt).values()].some((r) => !r.steps.every((s) => s.wildcard));
    if (real) out[fmt] = targetsFor(fmt);
  }
  out['*'] = [...new Set(wildcard.map((w) => w.to))];
  return out;
}

export function engineStatus() {
  return ENGINES.map((e) => ({
    id: e.id,
    label: e.label,
    optional: e.optional || null,
    ...status[e.id],
  }));
}

export const getEngine = (id) => byId[id];

/** Option schema for every step of a route. `info` is the probe of the source file. */
export function routeSchema(route, info) {
  return route.steps.map((s, i) => {
    const e = byId[s.engine];
    const last = i === route.steps.length - 1;
    let groups = e.schema ? e.schema({ from: s.from, to: s.to, info: i === 0 ? info : null, intermediate: !last }) || [] : [];
    if (!last) groups = groups.map((g) => ({ ...g, fields: g.fields.filter((fl) => !fl.finalOnly) })).filter((g) => g.fields.length);
    return { engine: e.id, label: e.label, from: s.from, to: s.to, groups };
  });
}

/** Probe a file with the first engine that knows its format. */
export async function probeFile(path, format) {
  for (const e of ENGINES) {
    if (!status[e.id]?.available || !e.probe) continue;
    const formats = typeof e.probeFormats === 'function' ? e.probeFormats() : [];
    if (!formats.includes(format)) continue;
    try {
      const info = await e.probe(path, format);
      if (info && Object.keys(info).length) return info;
    } catch {}
  }
  return {};
}

export async function shutdownEngines() {
  await Promise.all(ENGINES.map((e) => e.shutdown?.().catch(() => {})));
}
