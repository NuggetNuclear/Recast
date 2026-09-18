// Format picker popover: categories on the left, formats on the right, instant search.
import { h, $$, clamp } from './util.js';
import { icon } from './icons.js';

const SUGGEST = {
  pdf: ['docx', 'jpg', 'png', 'txt', 'md', 'html', 'pdf'],
  docx: ['pdf', 'md', 'html', 'txt', 'odt'], doc: ['pdf', 'docx'], odt: ['pdf', 'docx'], rtf: ['pdf', 'docx'],
  md: ['pdf', 'html', 'docx', 'txt'], html: ['pdf', 'png', 'md', 'docx'], txt: ['pdf', 'docx', 'html'],
  xlsx: ['csv', 'pdf', 'json', 'ods', 'xls'], xls: ['xlsx', 'csv', 'pdf'], csv: ['xlsx', 'json', 'md', 'pdf'], ods: ['xlsx', 'csv'],
  pptx: ['pdf', 'png'], ppt: ['pptx', 'pdf'], odp: ['pptx', 'pdf'],
  json: ['yaml', 'csv', 'xml', 'xlsx'], yaml: ['json', 'toml'], xml: ['json', 'csv', 'yaml'], toml: ['json', 'yaml'],
  epub: ['pdf', 'mobi', 'azw3', 'docx', 'txt'], mobi: ['epub', 'pdf', 'azw3'], azw3: ['epub', 'pdf'], fb2: ['epub', 'pdf'],
  zip: ['7z', 'tar.gz'], rar: ['zip', '7z'], '7z': ['zip', 'tar.gz'],
  ttf: ['woff2', 'woff', 'otf'], otf: ['woff2', 'ttf'], woff: ['ttf', 'woff2'], woff2: ['ttf', 'woff'],
  srt: ['vtt', 'ass'], vtt: ['srt', 'ass'], ass: ['srt', 'vtt'],
  svg: ['png', 'pdf', 'jpg', 'webp'], heic: ['jpg', 'png', 'pdf'], gif: ['mp4', 'webp', 'png'], png: ['jpg', 'webp', 'svg', 'pdf', 'ico'],
  jpg: ['png', 'webp', 'avif', 'pdf'], webp: ['jpg', 'png'], psd: ['png', 'jpg'],
};
const CAT_SUGGEST = {
  image: ['jpg', 'png', 'webp', 'avif', 'pdf', 'ico'],
  vector: ['png', 'pdf', 'jpg'],
  video: ['mp4', 'mp3', 'gif', 'webm', 'mov', 'jpg'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'],
  document: ['pdf', 'docx', 'txt', 'html'],
  ebook: ['pdf', 'epub', 'mobi', 'txt'],
  spreadsheet: ['xlsx', 'csv', 'pdf', 'json'],
  presentation: ['pdf', 'pptx', 'png'],
  data: ['json', 'yaml', 'csv', 'xml'],
  archive: ['zip', '7z', 'tar.gz'],
  font: ['woff2', 'ttf', 'woff'],
  subtitle: ['srt', 'vtt'],
};

export function suggestionsFor(from, targets, meta) {
  const cat = meta.formats[from]?.category;
  const list = [...(SUGGEST[from] || []), ...(CAT_SUGGEST[cat] || [])];
  return [...new Set(list)].filter((t) => targets.includes(t)).slice(0, 8);
}

let open = null;

export function closePicker() {
  if (!open) return;
  open.cleanup();
  open = null;
}

/**
 * anchor: element to attach to; targets: allowed formats; current: selected; from: source format (for suggestions)
 */
export function openPicker({ anchor, targets, current, from, meta, onPick, footer }) {
  if (open?.anchor === anchor) return closePicker();
  closePicker();
  const cats = meta.categories.filter((c) => targets.some((t) => meta.formats[t]?.category === c.id));
  const suggested = from ? suggestionsFor(from, targets, meta) : [];
  const currentCat = current && meta.formats[current]?.category;
  let activeCat = suggested.length ? '__suggested' : currentCat || cats[0]?.id;
  let query = '';
  let kbIndex = -1;

  const search = h('input', { type: 'text', placeholder: 'Search formats…', 'aria-label': 'Search formats', autocomplete: 'off', spellcheck: 'false' });
  const catList = h('div.picker-cats', { role: 'tablist' });
  const grid = h('div.picker-grid');
  const foot = h('div.picker-foot', footer || h('span', 'Type to search · ', h('kbd', 'Enter'), ' to pick · ', h('kbd', 'Esc'), ' to close'));
  const pop = h('div.popover', { role: 'dialog', 'aria-label': 'Choose output format' },
    h('div.picker-search', icon('search'), search),
    h('div.picker-body', catList, grid),
    foot);

  const pick = (fmt) => {
    closePicker();
    onPick(fmt);
  };

  function formatButtons(list) {
    return h('div.picker-formats', list.map((f) => h('button', {
      type: 'button',
      class: f === current ? 'cur' : '',
      title: meta.formats[f]?.name || f,
      dataset: { fmt: f },
      onclick: () => pick(f),
      onmouseenter: () => { foot.replaceChildren(h('span', h('b', f.toUpperCase()), ' — ', meta.formats[f]?.name || '')); },
    }, f)));
  }

  function renderCats() {
    const items = [];
    if (suggested.length) items.push({ id: '__suggested', label: 'Suggested', n: suggested.length });
    for (const c of cats) items.push({ id: c.id, label: c.label, n: targets.filter((t) => meta.formats[t]?.category === c.id).length });
    catList.replaceChildren(...items.map((c) => h('button', {
      type: 'button', role: 'tab', class: !query && c.id === activeCat ? 'on' : '', 'aria-selected': String(!query && c.id === activeCat),
      onclick: () => { activeCat = c.id; query = ''; search.value = ''; kbIndex = -1; render(); search.focus(); },
    }, h('span', c.label), h('span.n', c.n))));
  }

  function renderGrid() {
    grid.replaceChildren();
    if (query) {
      const q = query.toLowerCase().replace(/^\./, '');
      const hits = targets.filter((t) => t.includes(q) || (meta.formats[t]?.name || '').toLowerCase().includes(q))
        .sort((a, b) => (a.startsWith(q) ? 0 : 1) - (b.startsWith(q) ? 0 : 1) || a.length - b.length);
      if (!hits.length) { grid.append(h('div.picker-empty', `No output format matches “${query}”`)); return; }
      grid.append(formatButtons(hits));
    } else if (activeCat === '__suggested') {
      grid.append(h('div.group-label', 'Suggested'), formatButtons(suggested));
      for (const c of cats) {
        const list = targets.filter((t) => meta.formats[t]?.category === c.id);
        grid.append(h('div.group-label', c.label), formatButtons(list));
      }
    } else {
      grid.append(formatButtons(targets.filter((t) => meta.formats[t]?.category === activeCat)));
    }
    highlight();
  }

  function highlight() {
    const btns = $$('.picker-formats button', grid);
    btns.forEach((b, i) => b.classList.toggle('kb', i === kbIndex));
    if (kbIndex >= 0) btns[kbIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    renderCats();
    renderGrid();
  }

  search.addEventListener('input', () => { query = search.value.trim(); kbIndex = query ? 0 : -1; render(); });
  pop.addEventListener('keydown', (e) => {
    const btns = $$('.picker-formats button', grid);
    const cols = getComputedStyle(btns[0]?.parentElement || grid).gridTemplateColumns.split(' ').length || 4;
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); anchor.focus(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const b = btns[Math.max(0, kbIndex)];
      if (b) pick(b.dataset.fmt);
      return;
    }
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (moves[e.key] && btns.length) {
      e.preventDefault();
      kbIndex = clamp(kbIndex < 0 ? 0 : kbIndex + moves[e.key], 0, btns.length - 1);
      highlight();
    }
  });

  document.body.append(pop);
  render();

  function position() {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = r.right - w;
    if (left < 12) left = Math.min(r.left, window.innerWidth - w - 12);
    left = clamp(left, 12, Math.max(12, window.innerWidth - w - 12));
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 12 && r.top - ph - 6 > 12) top = r.top - ph - 6;
    top = clamp(top, 12, Math.max(12, window.innerHeight - ph - 12));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  position();
  search.focus({ preventScroll: true });
  anchor.setAttribute('aria-expanded', 'true');

  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePicker(); };
  const onResize = () => position();
  const onEsc = (e) => { if (e.key === 'Escape' && !pop.contains(e.target)) { closePicker(); anchor.focus(); } };
  setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
  document.addEventListener('keydown', onEsc);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onResize, true);

  open = {
    anchor,
    cleanup() {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      anchor.setAttribute('aria-expanded', 'false');
      pop.remove();
    },
  };
}
