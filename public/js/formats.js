// "Formats" page: browse every input format and what it converts to; search "pdf to docx".
import { h, debounce } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';

export function renderFormats(view, meta, { category = '', onUse } = {}) {
  const inputs = Object.keys(meta.targets).filter((f) => f !== '*' && meta.formats[f]);
  const totalTargets = new Set(inputs.flatMap((f) => meta.targets[f])).size;
  let activeCat = meta.categories.some((c) => c.id === category) ? category : '';
  let query = '';
  let openFmt = null;

  const search = h('input.input', { type: 'search', placeholder: 'Search a format, or try “heic to jpg”', 'aria-label': 'Search formats', spellcheck: 'false', autocomplete: 'off' });
  const routeResult = h('div.route-result');
  const tabs = h('div.cat-tabs');
  const sections = h('div');

  const badge = (f, big) => h(`span.fmt${big ? '.fmt-lg' : ''}`, { dataset: { cat: meta.formats[f]?.category || 'other' } }, f);

  function renderTabs() {
    const cats = meta.categories.filter((c) => inputs.some((f) => meta.formats[f].category === c.id));
    tabs.replaceChildren(
      h('button.chip', { type: 'button', class: !activeCat ? 'on' : '', onclick: () => { activeCat = ''; history.replaceState(null, '', '#/formats'); render(); } }, `All · ${inputs.length}`),
      ...cats.map((c) => h('button.chip', {
        type: 'button', class: activeCat === c.id ? 'on' : '',
        onclick: () => { activeCat = c.id; history.replaceState(null, '', `#/formats/${c.id}`); render(); },
      }, `${c.label} · ${inputs.filter((f) => meta.formats[f].category === c.id).length}`)));
  }

  function card(f) {
    const targets = meta.targets[f] || [];
    const isOpen = openFmt === f;
    const el = h('div.fmt-card', { class: isOpen ? 'open' : '', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) },
      h('div.row', badge(f, true), h('span.nm', meta.formats[f].name), h('span.tc', `${targets.length} outputs`)));
    const toggle = () => { openFmt = isOpen ? null : f; render(); };
    el.addEventListener('click', (e) => { if (!e.target.closest('.targets')) toggle(); });
    el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); toggle(); } });
    if (isOpen) {
      const groups = meta.categories.map((c) => ({ c, list: targets.filter((t) => meta.formats[t]?.category === c.id) })).filter((g) => g.list.length);
      el.append(h('div.targets', groups.map((g) => h('div.grp',
        h('span.gl', g.c.label),
        h('div.gf', g.list.map((t) => h('button.chip', { type: 'button', title: `Convert ${f.toUpperCase()} to ${t.toUpperCase()}`, onclick: () => onUse?.(f, t) }, t.toUpperCase())))))));
      el.append(h('p.field-help', { style: { margin: '12px 0 0' } }, 'Pick an output to choose files and convert straight away.'));
    }
    return el;
  }

  function render() {
    renderTabs();
    sections.replaceChildren();
    const q = query.toLowerCase().replace(/^\./, '');
    const pair = q.match(/^\.?([a-z0-9.]+)\s+(?:to|→|->|2|a|para)\s+\.?([a-z0-9.]+)$/);
    const alias = (x) => meta.aliases[x] || x;
    if (pair) {
      const from = alias(pair[1]);
      const to = alias(pair[2]);
      showRoute(from, to);
      const list = inputs.filter((f) => f === from);
      if (list.length) sections.append(h('div.fmt-cards', list.map((f) => { openFmt = f; return card(f); })));
      return;
    }
    routeResult.replaceChildren();
    const filtered = inputs.filter((f) => {
      if (activeCat && meta.formats[f].category !== activeCat) return false;
      if (!q) return true;
      return f.includes(q) || alias(q) === f || meta.formats[f].name.toLowerCase().includes(q);
    });
    if (!filtered.length) {
      sections.append(h('p.muted', { style: { marginTop: '24px' } }, `No format matches “${query}”.`));
      return;
    }
    for (const c of meta.categories) {
      const list = filtered.filter((f) => meta.formats[f].category === c.id);
      if (!list.length) continue;
      sections.append(h('section.fmt-section',
        h('h2', c.label, h('span.n', `${list.length} input formats`)),
        h('div.fmt-cards', list.map(card))));
    }
    const unsupported = Object.keys(meta.formats).filter((f) => !meta.targets[f] && (!activeCat || meta.formats[f].category === activeCat));
    if (!q && unsupported.length) {
      sections.append(h('section.fmt-section',
        h('h2', 'Needs an optional engine', h('span.n', `${unsupported.length} formats`)),
        h('p.muted', { style: { margin: '0 0 12px' } }, 'Install LibreOffice, Pandoc, Calibre or ImageMagick (see Engines) to unlock these.'),
        h('div.chips', unsupported.map((f) => h('span.fmt', { title: meta.formats[f].name, dataset: { cat: meta.formats[f].category } }, f)))));
    }
  }

  const routeReq = { n: 0 };
  async function showRoute(from, to) {
    const n = ++routeReq.n;
    routeResult.replaceChildren(h('span.dim', 'Checking…'));
    try {
      const r = await api.route({ from, to });
      if (n !== routeReq.n) return;
      routeResult.replaceChildren(
        icon('check'),
        h('span', 'Supported:'),
        badge(r.steps[0].from),
        ...r.steps.flatMap((s) => [icon('arrowRight'), badge(s.to)]),
        h('span.dim', `via ${[...new Set(r.steps.map((s) => s.label))].join(', ')}`),
        h('button.btn.btn-sm.btn-primary', { type: 'button', style: { marginLeft: '6px' }, onclick: () => onUse?.(from, to) }, 'Choose files'));
    } catch {
      if (n !== routeReq.n) return;
      routeResult.replaceChildren(icon('x'), h('span', `${from.toUpperCase()} → ${to.toUpperCase()} is not available${meta.formats[from] && !meta.targets[from] ? ' without an optional engine' : ''}.`));
    }
  }

  search.addEventListener('input', debounce(() => { query = search.value.trim(); openFmt = null; render(); }, 120));

  view.replaceChildren(h('div.formats-page',
    h('header.page-head',
      h('h1', 'Supported formats'),
      h('p', `${inputs.length} input formats and ${totalTargets} output formats. Click a format to see everything it converts to.`),
      h('div.search-lg', icon('search'), search),
      routeResult),
    tabs,
    sections));
  render();
  setTimeout(() => search.focus({ preventScroll: true }), 30);
}
