// Tiny builders for option schemas that the UI renders into forms.
//
// Field types: select, number, range, toggle, text, color, time, multi, textarea
// `showIf`: { otherKey: [allowed values] } or { otherKey: { not: [values] } } or { otherKey: { truthy: true } }

const opts = (options) =>
  options.map((o) => (typeof o === 'object' ? o : { value: String(o), label: String(o) }));

export const f = {
  select: (key, label, options, def, extra = {}) => ({ type: 'select', key, label, options: opts(options), default: def, ...extra }),
  number: (key, label, extra = {}) => ({ type: 'number', key, label, ...extra }),
  range: (key, label, min, max, step, def, extra = {}) => ({ type: 'range', key, label, min, max, step, default: def, ...extra }),
  toggle: (key, label, def = false, extra = {}) => ({ type: 'toggle', key, label, default: def, ...extra }),
  text: (key, label, extra = {}) => ({ type: 'text', key, label, ...extra }),
  textarea: (key, label, extra = {}) => ({ type: 'textarea', key, label, ...extra }),
  color: (key, label, def = '#ffffff', extra = {}) => ({ type: 'color', key, label, default: def, ...extra }),
  time: (key, label, extra = {}) => ({ type: 'time', key, label, placeholder: 'hh:mm:ss', ...extra }),
  multi: (key, label, options, def = [], extra = {}) => ({ type: 'multi', key, label, options: opts(options), default: def, ...extra }),
};

export const group = (id, label, fields, extra = {}) => ({ id, label, fields: fields.filter(Boolean), ...extra });

/** Collect the defaults of a schema into a plain object. */
export function defaults(groups) {
  const out = {};
  for (const g of groups) for (const fl of g.fields) if (fl.default !== undefined) out[fl.key] = fl.default;
  return out;
}

export const PAPER_SIZES = [
  { value: 'A4', label: 'A4 · 210 × 297 mm', w: 210, h: 297 },
  { value: 'A3', label: 'A3 · 297 × 420 mm', w: 297, h: 420 },
  { value: 'A5', label: 'A5 · 148 × 210 mm', w: 148, h: 210 },
  { value: 'B5', label: 'B5 · 176 × 250 mm', w: 176, h: 250 },
  { value: 'Letter', label: 'US Letter · 8.5 × 11 in', w: 215.9, h: 279.4 },
  { value: 'Legal', label: 'US Legal · 8.5 × 14 in', w: 215.9, h: 355.6 },
  { value: 'Tabloid', label: 'Tabloid · 11 × 17 in', w: 279.4, h: 431.8 },
  { value: 'custom', label: 'Custom size…' },
];

export const paperMm = (name) => PAPER_SIZES.find((p) => p.value === name) || PAPER_SIZES[0];
