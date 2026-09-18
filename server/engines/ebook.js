// Ebooks via Calibre's ebook-convert (optional — enabled when Calibre is installed).
import path from 'node:path';
import { f, group } from '../schema.js';
import { tools, versionOf } from '../tools.js';
import { run, UserError, opt, clamp } from '../util.js';

const IN = ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'lit', 'pdb', 'lrf', 'rb', 'snb', 'tcr', 'txtz', 'htmlz', 'cbz', 'cbr', 'docx', 'odt', 'rtf', 'txt', 'html', 'md', 'pml', 'pdf'];
const EBOOK_OUT = ['epub', 'mobi', 'azw3', 'fb2', 'lrf', 'pdb', 'rb', 'snb', 'tcr', 'txtz', 'htmlz', 'pml'];
const DOC_OUT = ['pdf', 'docx', 'rtf', 'txt'];

function schema({ from, to }) {
  const groups = [group('book', 'Book', [
    f.text('title', 'Title', { placeholder: 'keep' }),
    f.text('authors', 'Author(s)', { placeholder: 'keep', help: 'Separate several with “&”.' }),
    f.select('profile', 'Target device', [
      { value: 'default', label: 'Generic' }, { value: 'kindle_pw3', label: 'Kindle Paperwhite' }, { value: 'kindle_oasis', label: 'Kindle Oasis' },
      { value: 'kindle', label: 'Kindle (basic)' }, { value: 'kobo', label: 'Kobo' }, { value: 'tablet', label: 'Tablet' },
      { value: 'generic_eink_hd', label: 'E-ink HD' }, { value: 'generic_eink_large', label: 'E-ink large' },
    ], 'default'),
  ])];
  groups.push(group('look', 'Look & feel', [
    f.number('baseFont', 'Base font size', { unit: 'pt', min: 6, max: 30, placeholder: 'auto' }),
    f.number('margin', 'Page margins', { unit: 'pt', min: 0, max: 200, placeholder: 'default' }),
    f.select('justify', 'Text justification', [{ value: 'original', label: 'Original' }, { value: 'left', label: 'Left' }, { value: 'justify', label: 'Justified' }], 'original'),
    f.toggle('removeSpacing', 'Remove spacing between paragraphs'),
    f.toggle('smarten', 'Smarten punctuation'),
    f.toggle('embedFonts', 'Embed all fonts'),
    f.textarea('css', 'Extra CSS', { placeholder: 'p { text-indent: 1.2em }' }),
  ], { collapsed: true }));
  if (to === 'pdf') {
    groups.push(group('pdf', 'PDF', [
      f.select('paper', 'Paper size', ['a4', 'a5', 'a6', 'letter', 'legal', 'b5'].map((p) => ({ value: p, label: p.toUpperCase() })), 'a5'),
      f.toggle('pageNumbers', 'Page numbers', true),
    ]));
  }
  if (to === 'mobi') groups.push(group('mobi', 'MOBI', [f.select('mobiType', 'Kindle format', [{ value: 'both', label: 'Old + KF8 (most compatible)' }, { value: 'old', label: 'Old MOBI only' }, { value: 'new', label: 'KF8 only' }], 'both')]));
  if (to === 'epub') groups.push(group('epub', 'EPUB', [f.select('epubVersion', 'EPUB version', ['2', '3'], '3'), f.toggle('noCover', 'Do not generate a default cover')]));
  if (to === 'txt') groups.push(group('txt', 'Text', [f.select('txtFormat', 'Formatting', [{ value: 'plain', label: 'Plain' }, { value: 'markdown', label: 'Markdown' }, { value: 'textile', label: 'Textile' }], 'plain')]));
  return groups;
}

async function convert({ input, to, o, outDir, baseName, signal, progress }) {
  if (!tools.calibre) throw new UserError('Calibre is not installed');
  const out = path.join(outDir, `${baseName}.${to}`);
  const args = [input, out];
  if (opt.str(o.title).trim()) args.push('--title', o.title.trim());
  if (opt.str(o.authors).trim()) args.push('--authors', o.authors.trim());
  if (o.profile && o.profile !== 'default') args.push('--output-profile', o.profile);
  const bf = opt.num(o.baseFont);
  if (bf) args.push('--base-font-size', String(clamp(bf, 6, 30)));
  const m = opt.num(o.margin);
  if (m !== undefined) for (const side of ['top', 'bottom', 'left', 'right']) args.push(`--margin-${side}`, String(clamp(m, 0, 200)));
  if (o.justify && o.justify !== 'original') args.push('--change-justification', o.justify);
  if (opt.bool(o.removeSpacing)) args.push('--remove-paragraph-spacing');
  if (opt.bool(o.smarten)) args.push('--smarten-punctuation');
  if (opt.bool(o.embedFonts)) args.push('--embed-all-fonts');
  if (opt.str(o.css).trim()) args.push('--extra-css', o.css.trim());
  if (to === 'pdf') {
    args.push('--paper-size', o.paper || 'a5');
    if (opt.bool(o.pageNumbers, true)) args.push('--pdf-page-numbers');
  }
  if (to === 'mobi') args.push('--mobi-file-type', o.mobiType || 'both');
  if (to === 'epub') {
    args.push('--epub-version', o.epubVersion || '3');
    if (opt.bool(o.noCover)) args.push('--no-default-epub-cover');
  }
  if (to === 'txt' && o.txtFormat && o.txtFormat !== 'plain') args.push('--txt-output-formatting', o.txtFormat);
  await run(tools.calibre, args, {
    signal,
    timeoutMs: 20 * 60 * 1000,
    errorMessage: 'Calibre could not convert this book',
    onStdout: (s) => {
      const mm = s.match(/(\d{1,3})% /g);
      if (mm) progress(Number(mm[mm.length - 1].replace('% ', '')) / 100);
    },
  });
  return [out];
}

export default {
  id: 'ebook',
  label: 'Calibre',
  optional: { install: 'winget install calibre.calibre', url: 'https://calibre-ebook.com/download', adds: 'Kindle (MOBI/AZW3), FB2, LIT, LRF and professional ebook conversion' },
  async detect() {
    if (!tools.calibre) return { available: false };
    const v = await versionOf(tools.calibre, ['--version'], /calibre ([\d.]+)/);
    return { available: true, version: `Calibre ${v || ''}`.trim() };
  },
  routes: () => [
    { from: IN, to: EBOOK_OUT, cost: 1, same: true },
    { from: IN.filter((x) => !['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'md'].includes(x)), to: DOC_OUT, cost: 1.4 },
  ],
  schema,
  convert,
};
