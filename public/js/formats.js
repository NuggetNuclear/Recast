// "Formats" page: browse every input format and what it converts to; search "pdf to docx".
import { h, debounce } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { t, tCategory, tFormatName } from './i18n.js';

export function renderFormats(view, meta, { category = '', onUse } = {}) {
  const inputs = Object.keys(meta.targets).filter((f) => f !== '*' && meta.formats[f]);
  const totalTargets = new Set(inputs.flatMap((f) => meta.targets[f])).size;
  let activeCat = meta.categories.some((c) => c.id === category) ? category : '';
  let query = '';
  let openFmt = null;

  const search = h('input.input', {
    type: 'search',
    role: 'searchbox',
    placeholder: t('formats.searchPlaceholder'),
    'aria-label': t('formats.searchPlaceholder'),
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const routeResult = h('div.route-result', { role: 'status', 'aria-live': 'polite' });
  const tabs = h('div.cat-tabs', { role: 'tablist', 'aria-label': t('a11y.formatsTablist') });
  const sections = h('div');

  const badge = (f, big) => h(`span.fmt${big ? '.fmt-lg' : ''}`, { dataset: { cat: meta.formats[f]?.category || 'other' } }, f);

  function renderTabs() {
    const cats = meta.categories.filter((c) => inputs.some((f) => meta.formats[f].category === c.id));
    const isAll = !activeCat;
    tabs.replaceChildren(
      h('button.chip', {
        type: 'button',
        role: 'tab',
        class: isAll ? 'on' : '',
        'aria-selected': String(isAll),
        tabindex: isAll ? '0' : '-1',
        onclick: () => { activeCat = ''; history.replaceState(null, '', '#/formats'); render(); },
      }, t('formats.all', { count: inputs.length })),
      ...cats.map((c) => {
        const isSel = activeCat === c.id;
        const count = inputs.filter((f) => meta.formats[f].category === c.id).length;
        return h('button.chip', {
          type: 'button',
          role: 'tab',
          class: isSel ? 'on' : '',
          'aria-selected': String(isSel),
          tabindex: isSel ? '0' : '-1',
          onclick: () => { activeCat = c.id; history.replaceState(null, '', `#/formats/${c.id}`); render(); },
        }, `${tCategory(c.id)} · ${count}`);
      }));
  }

  function card(f) {
    const targets = meta.targets[f] || [];
    const isOpen = openFmt === f;
    const formatName = tFormatName(f, meta.formats[f].name);
    const label = `${formatName} (${f.toUpperCase()}) — ${targets.length} ${t('formats.outputs', { count: targets.length })}`;
    const el = h('div.fmt-card', {
      class: isOpen ? 'open' : '',
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(isOpen),
      'aria-label': label,
    },
      h('div.row', badge(f, true), h('span.nm', formatName), h('span.tc', t('formats.outputs', { count: targets.length }))));
    const toggle = () => { openFmt = isOpen ? null : f; render(); };
    el.addEventListener('click', (e) => { if (!e.target.closest('.targets')) toggle(); });
    el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); toggle(); } });
    if (isOpen) {
      const groups = meta.categories.map((c) => ({ c, list: targets.filter((t) => meta.formats[t]?.category === c.id) })).filter((g) => g.list.length);
      el.append(h('div.targets', groups.map((g) => h('div.grp',
        h('span.gl', tCategory(g.c.id)),
        h('div.gf', g.list.map((t) => h('button.chip', { type: 'button', title: `${tFormatName(f, f.toUpperCase())} → ${tFormatName(t, t.toUpperCase())}`, 'aria-label': `${tFormatName(f, f.toUpperCase())} → ${tFormatName(t, t.toUpperCase())}`, onclick: () => onUse?.(f, t) }, t.toUpperCase())))))));
      el.append(h('p.field-help', { style: { margin: '12px 0 0' } }, t('formats.pickHint')));
    }
    return el;
  }

  function render() {
    renderTabs();
    sections.replaceChildren();
    const q = query.toLowerCase().replace(/^\./, '');
    const pair = q.match(/^(?:de\s+)?\.?([a-z0-9.]+)\s+(?:to|→|->|2|a|para)\s+\.?([a-z0-9.]+)$/);
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
      return f.includes(q) ||
        alias(q) === f ||
        meta.formats[f].name.toLowerCase().includes(q) ||
        tFormatName(f).toLowerCase().includes(q) ||
        tCategory(meta.formats[f].category).toLowerCase().includes(q);
    });
    if (!filtered.length) {
      sections.append(h('p.muted', { role: 'status', style: { marginTop: '24px' } }, t('formats.noMatch', { query })));
      return;
    }
    for (const c of meta.categories) {
      const list = filtered.filter((f) => meta.formats[f].category === c.id);
      if (!list.length) continue;
      sections.append(h('section.fmt-section',
        h('h2', tCategory(c.id), h('span.n', t('formats.inputFormats', { count: list.length }))),
        h('div.fmt-cards', list.map(card))));
    }
    const unsupported = Object.keys(meta.formats).filter((f) => !meta.targets[f] && (!activeCat || meta.formats[f].category === activeCat));
    if (!q && unsupported.length) {
      sections.append(h('section.fmt-section',
        h('h2', t('formats.needsOptional'), h('span.n', t('formats.formatsCount', { count: unsupported.length }))),
        h('p.muted', { style: { margin: '0 0 12px' } }, t('formats.unlockHint')),
        h('div.chips', unsupported.map((f) => h('span.fmt', { title: tFormatName(f, meta.formats[f].name), dataset: { cat: meta.formats[f].category } }, f)))));
    }
  }

  const routeReq = { n: 0 };
  async function showRoute(from, to) {
    const n = ++routeReq.n;
    routeResult.replaceChildren(h('span.dim', t('formats.checking')));
    try {
      const r = await api.route({ from, to });
      if (n !== routeReq.n) return;
      routeResult.replaceChildren(
        icon('check'),
        h('span', t('formats.supported')),
        badge(r.steps[0].from),
        ...r.steps.flatMap((s) => [icon('arrowRight'), badge(s.to)]),
        h('span.dim', `via ${[...new Set(r.steps.map((s) => s.label))].join(', ')}`),
        h('button.btn.btn-sm.btn-primary', { type: 'button', style: { marginLeft: '6px' }, onclick: () => onUse?.(from, to) }, t('formats.chooseFiles')));
    } catch {
      if (n !== routeReq.n) return;
      const suffix = meta.formats[from] && !meta.targets[from] ? t('formats.withoutOptional') : '';
      routeResult.replaceChildren(icon('x'), h('span', t('formats.notAvailable', { from: from.toUpperCase(), to: to.toUpperCase(), suffix })));
    }
  }

  search.addEventListener('input', debounce(() => { query = search.value.trim(); openFmt = null; render(); }, 120));

  view.replaceChildren(h('div.formats-page',
    h('header.page-head',
      h('h1', t('formats.title')),
      h('p', t('formats.subtitle', { inputs: inputs.length, targets: totalTargets })),
      h('div.search-lg', icon('search'), search),
      routeResult),
    tabs,
    sections));
  render();
  setTimeout(() => search.focus({ preventScroll: true }), 30);
}
