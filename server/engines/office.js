// Office documents via LibreOffice (optional — enabled when soffice is installed).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { f, group } from '../schema.js';
import { tools, versionOf } from '../tools.js';
import { dirs } from '../config.js';
import { run, UserError, opt, clamp, ensureDir, rmrf } from '../util.js';

const WRITER_IN = ['doc', 'docx', 'docm', 'dotx', 'odt', 'ott', 'rtf', 'wpd', 'wps', 'pages', 'abw', 'txt', 'html', 'xhtml', 'hwp', 'sxw', 'wri'];
const CALC_IN = ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'fods', 'csv', 'tsv', 'numbers', 'dbf', 'wk1', 'wks', 'qpw', 'slk', 'dif', 'sxc'];
const IMPRESS_IN = ['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key', 'sxi'];
const DRAW_IN = ['odg', 'vsdx', 'vsd', 'emf', 'wmf', 'cdr', 'dxf', 'wpg', 'sxd', 'pub'];

const WRITER_OUT = ['docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub', 'png', 'jpg'];
const CALC_OUT = ['xlsx', 'xls', 'ods', 'csv', 'html', 'png'];
const IMPRESS_OUT = ['pptx', 'ppt', 'odp', 'png', 'jpg', 'svg'];
const DRAW_OUT = ['png', 'svg', 'odg', 'jpg'];

const kindOf = (fmt) => (WRITER_IN.includes(fmt) ? 'writer' : CALC_IN.includes(fmt) ? 'calc' : IMPRESS_IN.includes(fmt) ? 'impress' : 'draw');

const FILTERS = {
  docx: 'docx:"MS Word 2007 XML"', doc: 'doc:"MS Word 97"', odt: 'odt', rtf: 'rtf:"Rich Text Format"', txt: 'txt:Text (encoded):UTF8', epub: 'epub',
  xlsx: 'xlsx:"Calc MS Excel 2007 XML"', xls: 'xls:"MS Excel 97"', ods: 'ods',
  pptx: 'pptx:"Impress MS PowerPoint 2007 XML"', ppt: 'ppt:"MS PowerPoint 97"', odp: 'odp',
  odg: 'odg', png: 'png', jpg: 'jpg', svg: 'svg',
};

// LibreOffice cannot run two conversions on the same profile at once.
let queue = Promise.resolve();
const serial = (fn) => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
};

function schema({ from, to }) {
  const kind = kindOf(from);
  if (to === 'pdf') {
    return [group('pdf', 'PDF export', [
      f.text('pages', 'Pages', { placeholder: 'all', help: kind === 'calc' ? 'For spreadsheets, printed pages.' : 'e.g. 1-3, 5' }),
      f.select('pdfa', 'Standard', [{ value: '0', label: 'PDF 1.7' }, { value: '1', label: 'PDF/A-1b (archival)' }, { value: '2', label: 'PDF/A-2b (archival)' }, { value: '3', label: 'PDF/A-3b (archival)' }], '0'),
      f.range('quality', 'JPEG image quality', 10, 100, 1, 90, { unit: '%' }),
      f.toggle('lossless', 'Lossless images'),
      f.select('maxDpi', 'Downsample images to', [{ value: '', label: 'Keep resolution' }, { value: '75', label: '75 dpi' }, { value: '150', label: '150 dpi' }, { value: '300', label: '300 dpi' }, { value: '600', label: '600 dpi' }], ''),
      f.toggle('tagged', 'Tagged PDF (accessibility)', true),
      f.toggle('bookmarks', 'Export bookmarks', true),
      kind === 'writer' || kind === 'impress' ? f.toggle('comments', 'Include comments') : null,
      kind === 'impress' ? f.toggle('notes', 'Include speaker notes pages') : null,
      kind === 'writer' ? f.toggle('formFields', 'Create PDF form fields', true) : null,
      f.text('watermark', 'Watermark text'),
      f.text('password', 'Open password', { secret: true }),
    ])];
  }
  if (to === 'csv') {
    return [group('csv', 'CSV export', [
      f.select('delimiter', 'Delimiter', [{ value: '44', label: 'Comma ,' }, { value: '59', label: 'Semicolon ;' }, { value: '9', label: 'Tab' }, { value: '124', label: 'Pipe |' }], '44'),
      f.select('encoding', 'Encoding', [{ value: '76', label: 'UTF-8' }, { value: '1', label: 'Windows-1252' }, { value: '65535', label: 'UTF-16' }], '76'),
      f.toggle('allSheets', 'Export every sheet (one file each)'),
    ])];
  }
  if (['png', 'jpg', 'svg'].includes(to)) return [group('img', 'Image export', [{ type: 'note', key: 'note', label: 'LibreOffice exports the first page or slide. For every page, convert to PDF first, then PDF to images.' }])];
  return [];
}

function pdfFilter(kind, o) {
  const P = {};
  const s = (k, v) => (P[k] = { type: 'string', value: String(v) });
  const b = (k, v) => (P[k] = { type: 'boolean', value: !!v });
  const l = (k, v) => (P[k] = { type: 'long', value: Number(v) });
  if (opt.str(o.pages).trim()) s('PageRange', opt.str(o.pages).replace(/\s+/g, ''));
  const pdfa = opt.num(o.pdfa, 0);
  if (pdfa) { l('SelectPdfVersion', pdfa); b('PDFUACompliance', false); }
  l('Quality', clamp(opt.num(o.quality, 90), 1, 100));
  b('UseLosslessCompression', opt.bool(o.lossless));
  const dpi = opt.num(o.maxDpi);
  if (dpi) { b('ReduceImageResolution', true); l('MaxImageResolution', dpi); }
  b('UseTaggedPDF', opt.bool(o.tagged, true));
  b('ExportBookmarks', opt.bool(o.bookmarks, true));
  if (kind === 'writer' || kind === 'impress') b('ExportNotes', opt.bool(o.comments));
  if (kind === 'impress') b('ExportNotesPages', opt.bool(o.notes));
  if (kind === 'writer') b('ExportFormFields', opt.bool(o.formFields, true));
  if (opt.str(o.watermark).trim()) s('Watermark', o.watermark.trim());
  if (opt.str(o.password)) { b('EncryptFile', true); s('DocumentOpenPassword', o.password); }
  return `pdf:${kind}_pdf_Export:${JSON.stringify(P)}`;
}

async function convert({ input, from, to, o, outDir, baseName, tmpDir, signal, progress }) {
  if (!tools.soffice) throw new UserError('LibreOffice is not installed');
  const kind = kindOf(from);
  const work = path.join(tmpDir, 'lo');
  await ensureDir(work);
  const src = path.join(work, `${baseName}.${from}`);
  await fsp.copyFile(input, src);
  let spec;
  if (to === 'pdf') spec = pdfFilter(kind, o);
  else if (to === 'csv') spec = `csv:"Text - txt - csv (StarCalc)":${opt.num(o.delimiter, 44)},34,${opt.num(o.encoding, 76)},1,,0,false,true,false,false,false,${opt.bool(o.allSheets) ? -1 : 1}`;
  else if (to === 'html') spec = kind === 'calc' ? 'html:"HTML (StarCalc)"' : 'html:"HTML (StarWriter)":EmbedImages';
  else spec = FILTERS[to] || to;
  const profile = path.join(dirs.profiles, 'libreoffice');
  await ensureDir(profile);
  const outLo = path.join(work, 'out');
  await ensureDir(outLo);
  progress(0.1);
  await serial(() => run(tools.soffice, [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--headless', '--invisible', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
    '--convert-to', spec, '--outdir', outLo, src,
  ], { signal, timeoutMs: 10 * 60 * 1000, errorMessage: 'LibreOffice could not convert this document' }));
  const produced = (await fsp.readdir(outLo)).filter((n) => !n.startsWith('.'));
  if (!produced.length) throw new UserError('LibreOffice produced no output — the document may be damaged or password-protected');
  const outs = [];
  for (const n of produced.sort()) {
    const dest = path.join(outDir, produced.length === 1 ? `${baseName}.${to}` : n);
    await fsp.rename(path.join(outLo, n), dest).catch(async () => { await fsp.copyFile(path.join(outLo, n), dest); });
    outs.push(dest);
  }
  await rmrf(work);
  return outs;
}

export default {
  id: 'office',
  label: 'LibreOffice',
  optional: { install: 'winget install TheDocumentFoundation.LibreOffice', url: 'https://www.libreoffice.org/download/', adds: 'Word, Excel, PowerPoint, OpenDocument and legacy office formats with full layout fidelity' },
  async detect() {
    if (!tools.soffice) return { available: false };
    const v = await versionOf(tools.soffice, ['--version'], /LibreOffice ([\d.]+)/);
    return { available: true, version: `LibreOffice ${v || ''}`.trim() };
  },
  routes: () => [
    { from: [...WRITER_IN, ...CALC_IN, ...IMPRESS_IN, ...DRAW_IN], to: ['pdf'], cost: 0.9 },
    { from: WRITER_IN, to: WRITER_OUT, cost: 1.5, same: true },
    { from: CALC_IN, to: CALC_OUT, cost: 1.5, same: true },
    { from: IMPRESS_IN, to: IMPRESS_OUT, cost: 1.5, same: true },
    { from: DRAW_IN, to: DRAW_OUT, cost: 1.5 },
  ],
  schema,
  convert,
};
