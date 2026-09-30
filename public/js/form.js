// Renders option schemas (from the server) into form controls.
import { h, $$ } from './util.js';
import { icon } from './icons.js';
import { t, tSchema } from './i18n.js';

export function stepDefaults(step) {
  const out = {};
  for (const g of step.groups) for (const f of g.fields) if (f.default !== undefined) out[f.key] = Array.isArray(f.default) ? [...f.default] : f.default;
  return out;
}

export const routeDefaults = (steps) => steps.map(stepDefaults);

/** Keep values the user already set when a new schema arrives (e.g. after re-routing). */
export function mergeValues(steps, previous = []) {
  return steps.map((s, i) => {
    const d = stepDefaults(s);
    const prev = previous[i] || {};
    const fields = new Map(s.groups.flatMap((g) => g.fields.map((f) => [f.key, f])));
    for (const [k, v] of Object.entries(prev)) {
      const f = fields.get(k);
      if (!f) continue;
      // Drop choices that the new target does not offer (e.g. an H.264 codec when switching to WebM).
      if (f.type === 'select' && !f.options.some((o) => String(o.value) === String(v))) continue;
      d[k] = v;
    }
    return d;
  });
}

export function isCustomized(steps, values) {
  if (!steps || !values) return false;
  return steps.some((s, i) => {
    const d = stepDefaults(s);
    const v = values[i] || {};
    return Object.keys({ ...d, ...v }).some((k) => !same(d[k], v[k]));
  });
}

const same = (a, b) => {
  const norm = (x) => (x === undefined || x === null ? '' : Array.isArray(x) ? [...x].sort().join(',') : String(x));
  return norm(a) === norm(b);
};

function valueOf(values, fields, key) {
  if (key in values) return values[key];
  return fields.find((f) => f.key === key)?.default;
}

function visible(field, values, fields) {
  if (!field.showIf) return true;
  return Object.entries(field.showIf).every(([k, cond]) => {
    const v = valueOf(values, fields, k);
    if (Array.isArray(cond)) return cond.some((c) => (typeof c === 'boolean' ? !!v === c : String(v ?? '') === String(c)));
    if (cond && Array.isArray(cond.not)) return !cond.not.some((c) => String(v ?? '') === String(c));
    if (cond && cond.truthy) return !!v;
    return true;
  });
}

const FULL = new Set(['range', 'toggle', 'textarea', 'multi', 'note', 'select']);
const segmentable = (f) => f.options.length >= 2 && f.options.length <= 4 && f.options.every((o) => String(o.label).length <= 13);

function control(field, value, set, fieldId, helpId) {
  const id = fieldId || `f-${Math.random().toString(36).slice(2, 9)}`;
  switch (field.type) {
    case 'select': {
      if (segmentable(field)) {
        const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': tSchema(field.label) });
        const radios = field.options.map((o) => {
          const isSel = String(value ?? '') === String(o.value);
          const oLabel = tSchema(o.label);
          return h('button', {
            type: 'button',
            role: 'radio',
            tabindex: isSel ? '0' : '-1',
            class: isSel ? 'on' : '',
            'aria-checked': String(isSel),
            onclick: () => selectRadio(o.value),
            dataset: { v: String(o.value) },
            title: oLabel,
          }, oLabel);
        });
        const selectRadio = (val) => {
          radios.forEach((b) => {
            const on = b.dataset.v === String(val);
            b.classList.toggle('on', on);
            b.setAttribute('aria-checked', String(on));
            b.tabIndex = on ? 0 : -1;
            if (on) b.focus();
          });
          set(val);
        };
        seg.addEventListener('keydown', (e) => {
          if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            const currIdx = radios.findIndex((b) => b.getAttribute('aria-checked') === 'true');
            const nextIdx = (e.key === 'ArrowRight' || e.key === 'ArrowDown')
              ? (currIdx + 1) % radios.length
              : (currIdx - 1 + radios.length) % radios.length;
            selectRadio(field.options[nextIdx].value);
          }
        });
        seg.append(...radios);
        return seg;
      }
      const sel = h('select.select', { id, 'aria-describedby': helpId || undefined, onchange: (e) => set(e.target.value) }, field.options.map((o) => h('option', { value: o.value }, tSchema(o.label))));
      sel.value = value ?? '';
      if (sel.selectedIndex < 0 && field.options[0]) sel.value = field.options[0].value;
      return sel;
    }
    case 'number': {
      const input = h('input.input', { id, type: 'number', inputmode: 'decimal', step: field.step ?? 'any', min: field.min, max: field.max, placeholder: tSchema(field.placeholder) || '', value: value ?? '', 'aria-describedby': helpId || undefined });
      input.addEventListener('input', () => set(input.value === '' ? '' : Number(input.value)));
      return field.unit ? h('div.input-wrap', input, h('span.unit', field.unit)) : input;
    }
    case 'range': {
      const input = h('input.range', {
        id,
        type: 'range',
        min: field.min,
        max: field.max,
        step: field.step ?? 1,
        value: value ?? field.default ?? field.min,
        'aria-valuenow': Number(value ?? field.default ?? field.min),
        'aria-valuemin': field.min,
        'aria-valuemax': field.max,
        'aria-valuetext': fmtRange(value ?? field.default ?? field.min, field),
        'aria-describedby': helpId || undefined,
      });
      const paint = () => {
        input.style.setProperty('--p', `${((input.value - field.min) / (field.max - field.min)) * 100}%`);
        input.setAttribute('aria-valuenow', input.value);
        input.setAttribute('aria-valuetext', fmtRange(Number(input.value), field));
      };
      paint();
      input.addEventListener('input', () => { paint(); set(Number(input.value)); });
      return input;
    }
    case 'toggle': {
      const input = h('input', { id, type: 'checkbox', checked: !!value, role: 'switch', 'aria-checked': String(!!value), 'aria-describedby': helpId || undefined });
      input.addEventListener('change', () => {
        input.setAttribute('aria-checked', String(input.checked));
        set(input.checked);
      });
      return h('label.switch', { for: id }, input, h('span', { 'aria-hidden': 'true' }));
    }
    case 'text': case 'time': {
      const input = h('input.input', { id, type: field.secret ? 'password' : 'text', placeholder: tSchema(field.placeholder) || '', value: value ?? '', autocomplete: field.secret ? 'new-password' : 'off', spellcheck: 'false', 'aria-describedby': helpId || undefined });
      input.addEventListener('input', () => set(input.value));
      if (!field.secret) return input;
      const reveal = h('button.icon-btn.reveal', { type: 'button', 'aria-label': t('form.showPassword'), onclick: () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        reveal.setAttribute('aria-label', input.type === 'password' ? t('form.showPassword') : t('form.hidePassword'));
        reveal.replaceChildren(icon(input.type === 'password' ? 'eye' : 'eyeOff'));
      } }, icon('eye'));
      return h('div.input-wrap', input, reveal);
    }
    case 'textarea': {
      const ta = h('textarea.textarea', { id, placeholder: tSchema(field.placeholder) || '', rows: 3, spellcheck: 'false', 'aria-describedby': helpId || undefined });
      ta.value = value ?? '';
      ta.addEventListener('input', () => set(ta.value));
      return ta;
    }
    case 'color': {
      const empty = !value;
      const swatch = h('i', { style: { background: empty || value === 'transparent' ? 'transparent' : value }, 'aria-hidden': 'true' });
      const picker = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff', 'aria-label': `${tSchema(field.label)} (color)` });
      const text = h('input.input', { id, type: 'text', value: value ?? '', placeholder: field.allowEmpty ? 'none' : '#rrggbb', spellcheck: 'false', 'aria-describedby': helpId || undefined });
      const apply = (v) => { swatch.style.background = v && v !== 'transparent' ? v : 'transparent'; set(v); };
      picker.addEventListener('input', () => { text.value = picker.value; apply(picker.value); });
      text.addEventListener('input', () => { const v = text.value.trim(); if (!v || v === 'transparent' || /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) apply(v); });
      const extra = field.allowTransparent ? h('button.btn.btn-sm', { type: 'button', onclick: () => { text.value = 'transparent'; apply('transparent'); } }, t('form.transparent')) : null;
      return h('div.color-field', h('span.color-swatch', swatch, picker), text, extra);
    }
    case 'multi': {
      const cur = new Set((Array.isArray(value) ? value : []).map(String));
      return h('div.chips', { role: 'group', 'aria-label': tSchema(field.label) }, field.options.map((o) => {
        const transLabel = tSchema(o.label);
        const label = field.unit && /^\d+$/.test(transLabel) ? `${transLabel} ${field.unit}` : transLabel;
        const b = h('button.chip', { type: 'button', class: cur.has(String(o.value)) ? 'on' : '', 'aria-pressed': String(cur.has(String(o.value))) }, label);
        b.addEventListener('click', () => {
          if (cur.has(String(o.value))) cur.delete(String(o.value)); else cur.add(String(o.value));
          b.classList.toggle('on');
          b.setAttribute('aria-pressed', String(cur.has(String(o.value))));
          set(field.options.map((x) => String(x.value)).filter((v) => cur.has(v)));
        });
        return b;
      }));
    }
    default:
      return h('span', '');
  }
}

function fieldEl(field, values, fields, onChange, rerender) {
  if (field.type === 'note') return h('div.field-note', { role: 'note' }, icon('info'), h('span', tSchema(field.label)));
  const value = valueOf(values, fields, field.key);
  const set = (v) => {
    values[field.key] = v;
    if (field.type === 'range') valEl && (valEl.textContent = fmtRange(v, field));
    onChange?.();
    if (fields.some((f) => f.showIf && field.key in f.showIf)) rerender();
  };
  let valEl = null;
  const labelText = tSchema(field.label);
  const fieldId = `fld-${field.key}-${Math.random().toString(36).slice(2, 8)}`;
  const helpId = field.help ? `${fieldId}-help` : null;

  if (field.type === 'toggle') {
    return h('div.field.field-toggle.full',
      h('div.txt',
        h('label.field-label', { for: fieldId }, labelText),
        helpId ? h('div.field-help', { id: helpId }, tSchema(field.help)) : null),
      control(field, value, set, fieldId, helpId));
  }
  if (field.type === 'range') valEl = h('span.val', { 'aria-hidden': 'true' }, fmtRange(value ?? field.default, field));
  const full = FULL.has(field.type) || field.full || (field.type === 'select' && !segmentable(field) && field.options.some((o) => String(o.label).length > 18));
  return h(`div.field${full || field.type === 'select' ? '.full' : ''}`,
    h('label.field-label', { for: fieldId }, h('span', labelText), valEl),
    control(field, value, set, fieldId, helpId),
    helpId ? h('div.field-help', { id: helpId }, tSchema(field.help)) : null);
}

function fmtRange(v, f) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const digits = String(f.step ?? 1).includes('.') ? String(f.step).split('.')[1].length : 0;
  const s = n.toFixed(Math.min(digits, 3));
  const unit = f.unit ? (f.unit === '×' ? '×' : ` ${f.unit}`) : '';
  return (f.key === 'hue' || f.key === 'volume') && n > 0 ? `+${s}${unit}` : `${s}${unit}`;
}

/**
 * Render every step's groups. `values` is an array (one object per step) mutated in place.
 */
export function renderForm(steps, values, { onChange, openGroups } = {}) {
  const root = h('div.form');
  const collapsed = openGroups || new Map();
  function render() {
    const scroll = root.closest('.drawer-body, .modal-body')?.scrollTop;
    root.replaceChildren();
    steps.forEach((step, si) => {
      const vals = values[si] || (values[si] = {});
      const fields = step.groups.flatMap((g) => g.fields);
      if (steps.length > 1) {
        root.append(h('div.step-title', t('form.step', { count: si + 1 }), h('span.fmt', { dataset: { cat: '' } }, step.from), icon('arrowRight'), h('span.fmt', step.to), h('span', { style: { marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 500 } }, step.label)));
      }
      if (!step.groups.length) root.append(h('p.field-help', { style: { margin: '12px 0' } }, t('form.noSettings')));
      for (const g of step.groups) {
        const gkey = `${si}:${g.id}`;
        const gbodyId = `gbody-${si}-${g.id}`;
        const isClosed = collapsed.has(gkey) ? collapsed.get(gkey) : !!g.collapsed;
        const visibleFields = g.fields.filter((f) => visible(f, vals, fields));
        if (!visibleFields.length) continue;
        const changed = g.fields.some((f) => f.key in vals && !same(vals[f.key], f.default));
        const body = h('div.group-body', { id: gbodyId }, visibleFields.map((f) => fieldEl(f, vals, fields, () => { onChange?.(); markChanged(); }, render)));
        const dot = h('span.changed', { hidden: !changed, 'aria-label': 'Modificado' });
        const markChanged = () => { dot.hidden = !g.fields.some((f) => f.key in vals && !same(vals[f.key], f.default)); };
        const sec = h('section.group', { class: isClosed ? 'closed' : '' },
          h('button.group-head', { type: 'button', 'aria-expanded': String(!isClosed), 'aria-controls': gbodyId, onclick: () => {
            const now = !sec.classList.contains('closed');
            sec.classList.toggle('closed', now);
            collapsed.set(gkey, now);
          } }, h('span', tSchema(g.label), dot), icon('chevronDown')),
          body);
        root.append(sec);
      }
    });
    const container = root.closest('.drawer-body, .modal-body');
    if (container && scroll !== undefined) container.scrollTop = scroll;
  }
  render();
  return root;
}
