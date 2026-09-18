// Spreadsheets via SheetJS: Excel (xlsx/xlsm/xlsb/xls), OpenDocument, Numbers, CSV, dBASE, SYLK, DIF, Lotus…
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import * as cpexcel from 'xlsx/dist/cpexcel.full.mjs';
import XLSX_ZAHL from 'xlsx/dist/xlsx.zahl.mjs';
import Papa from 'papaparse';
import { f, group } from '../schema.js';
import { UserError, opt, safeName } from '../util.js';
import { readText } from './markup.js';
import { htmlDocument, escapeHtml } from './themes.js';

XLSX.set_fs(fs);
XLSX.set_cptable(cpexcel);

const BOOK_IN = ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'fods', 'numbers', 'dbf', 'slk', 'dif', 'wk1', 'wks', 'qpw'];
const IN = [...BOOK_IN, 'csv', 'tsv', 'json', 'html'];
const MULTI_OUT = { xlsx: 'xlsx', xlsm: 'xlsm', xlsb: 'xlsb', xls: 'biff8', ods: 'ods', fods: 'fods', numbers: 'numbers' };
const SINGLE_OUT = { csv: null, tsv: null, json: null, html: null, md: null, dbf: 'dbf', slk: 'sylk', dif: 'dif', rtf: 'rtf' };
const OUT = [...Object.keys(MULTI_OUT), ...Object.keys(SINGLE_OUT)];

async function readWorkbook(input, from, o) {
  try {
    if (from === 'csv' || from === 'tsv') {
      const text = await readText(input);
      const delim = from === 'tsv' ? '\t' : !o.inDelimiter || o.inDelimiter === 'auto' ? '' : o.inDelimiter === 'tab' ? '\t' : o.inDelimiter;
      const res = Papa.parse(text.replace(/^\uFEFF/, ''), { delimiter: delim, skipEmptyLines: 'greedy', dynamicTyping: opt.bool(o.typed, true) });
      const ws = XLSX.utils.aoa_to_sheet(res.data, { cellDates: true });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, safeSheet(opt.str(o.sheetName).trim() || 'Sheet1'));
      return wb;
    }
    if (from === 'json') {
      const data = JSON.parse(await readText(input));
      const wb = XLSX.utils.book_new();
      const add = (name, rows) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        const ws = arr.every((r) => Array.isArray(r)) ? XLSX.utils.aoa_to_sheet(arr) : XLSX.utils.json_to_sheet(arr.map((r) => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : v])) : { value: r })));
        XLSX.utils.book_append_sheet(wb, ws, safeSheet(name));
      };
      if (Array.isArray(data)) add(opt.str(o.sheetName).trim() || 'Sheet1', data);
      else if (data && typeof data === 'object' && Object.values(data).every(Array.isArray)) for (const [k, v] of Object.entries(data)) add(k, v);
      else add('Sheet1', [data]);
      return wb;
    }
    const buf = await fsp.readFile(input);
    const codepage = opt.num(o.codepage);
    return XLSX.read(buf, { type: 'buffer', cellDates: true, cellNF: true, ...(codepage ? { codepage } : {}) });
  } catch (e) {
    if (e.userFacing) throw e;
    if (/password|encrypt/i.test(e.message)) throw new UserError('This workbook is password-protected');
    throw new UserError(`This ${from.toUpperCase()} file could not be read`, e.message);
  }
}

const safeSheet = (n) => String(n).replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1';

function autofit(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });
  const widths = [];
  for (const row of aoa.slice(0, 2000)) row.forEach((v, i) => { widths[i] = Math.max(widths[i] || 6, Math.min(60, String(v ?? '').length + 2)); });
  ws['!cols'] = widths.map((w) => ({ wch: w }));
}

function pickSheets(wb, o) {
  const sel = o.sheet || '';
  if (sel === '__all__') return wb.SheetNames;
  if (sel && wb.SheetNames.includes(sel)) return [sel];
  return [wb.SheetNames[0]];
}

function sheetToAoa(ws, o) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: !opt.bool(o.formatted, true), rawNumbers: !opt.bool(o.formatted, true), defval: '', blankrows: opt.bool(o.blankRows), dateNF: o.dateFormat || 'yyyy-mm-dd' });
}

async function convert({ input, from, to, o, outDir, baseName, progress }) {
  const wb = await readWorkbook(input, from, o);
  if (!wb.SheetNames.length) throw new UserError('The workbook has no sheets');
  progress(0.4);

  if (MULTI_OUT[to]) {
    let out = wb;
    const multiDefault = o.sheet === undefined ? '__all__' : o.sheet;
    const names = pickSheets(wb, { sheet: multiDefault || '__all__' });
    if (names.length !== wb.SheetNames.length) {
      out = XLSX.utils.book_new();
      for (const n of names) XLSX.utils.book_append_sheet(out, wb.Sheets[n], n);
    }
    for (const n of out.SheetNames) {
      const ws = out.Sheets[n];
      if (opt.bool(o.autofit, ['csv', 'tsv', 'json'].includes(from)) && ws['!ref']) autofit(ws);
      if (opt.bool(o.autofilter) && ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };
    }
    out.Props = { ...(out.Props || {}), Title: opt.str(o.title).trim() || out.Props?.Title || baseName, Author: opt.str(o.author).trim() || out.Props?.Author || '' };
    const p = path.join(outDir, `${baseName}.${to}`);
    const writeOpts = { bookType: MULTI_OUT[to], type: 'buffer', compression: opt.bool(o.compress, true) };
    if (to === 'numbers') writeOpts.numbers = XLSX_ZAHL;
    await fsp.writeFile(p, XLSX.write(out, writeOpts));
    return [p];
  }

  const names = pickSheets(wb, o);
  const outs = [];
  const fileFor = (n) => path.join(outDir, names.length > 1 ? `${baseName}-${safeName(n)}.${to}` : `${baseName}.${to}`);

  if (to === 'json') {
    const conv = (ws) => (o.jsonShape === 'arrays' ? sheetToAoa(ws, o) : XLSX.utils.sheet_to_json(ws, { raw: !opt.bool(o.formatted, false), defval: o.empty === 'omit' ? undefined : o.empty === 'empty' ? '' : null, blankrows: opt.bool(o.blankRows), dateNF: o.dateFormat || 'yyyy-mm-dd' }));
    const data = names.length > 1 ? Object.fromEntries(names.map((n) => [n, conv(wb.Sheets[n])])) : conv(wb.Sheets[names[0]]);
    const p = path.join(outDir, `${baseName}.json`);
    await fsp.writeFile(p, JSON.stringify(data, (k, v) => v, o.indent === '0' ? '' : 2) + '\n', 'utf8');
    return [p];
  }

  if (to === 'html' || to === 'md') {
    const parts = [];
    for (const n of names) {
      const aoa = sheetToAoa(wb.Sheets[n], o);
      if (to === 'md') {
        if (names.length > 1) parts.push(`## ${n}\n`);
        if (aoa.length) {
          const width = Math.max(...aoa.map((r) => r.length));
          const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
          const row = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
          parts.push(row(aoa[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...aoa.slice(1).map(row), '');
        }
      } else {
        const html = XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' }).replace(/^[\s\S]*?<table/, '<table').replace(/<\/table>[\s\S]*$/, '</table>');
        parts.push(`${names.length > 1 ? `<h2>${escapeHtml(n)}</h2>` : ''}${html}`);
      }
    }
    const p = path.join(outDir, `${baseName}.${to}`);
    const content = to === 'md' ? parts.join('\n') + '\n' : htmlDocument(`<h1>${escapeHtml(baseName)}</h1>\n${parts.join('\n')}`, { title: baseName, maxWidth: 1600, fontSize: 14 });
    await fsp.writeFile(p, content, 'utf8');
    return [p];
  }

  for (const n of names) {
    const ws = wb.Sheets[n];
    const p = fileFor(n);
    if (to === 'csv' || to === 'tsv') {
      const FS = to === 'tsv' ? '\t' : { tab: '\t', semicolon: ';', pipe: '|', comma: ',' }[o.delimiter] || ',';
      const csv = XLSX.utils.sheet_to_csv(ws, {
        FS,
        RS: o.newline === 'lf' ? '\n' : '\r\n',
        blankrows: opt.bool(o.blankRows),
        skipHidden: opt.bool(o.skipHidden),
        strip: true,
        forceQuotes: opt.bool(o.quoteAll),
        rawNumbers: !opt.bool(o.formatted, true),
        dateNF: o.dateFormat || 'yyyy-mm-dd',
      });
      await fsp.writeFile(p, (opt.bool(o.bom) ? '\uFEFF' : '') + csv, 'utf8');
    } else {
      const single = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(single, ws, n);
      await fsp.writeFile(p, XLSX.write(single, { bookType: SINGLE_OUT[to], type: 'buffer' }));
    }
    outs.push(p);
  }
  return outs;
}

async function probe(input, from) {
  if (!BOOK_IN.includes(from)) return {};
  try {
    const wb = XLSX.read(await fsp.readFile(input), { type: 'buffer', bookSheets: true });
    return { sheets: wb.SheetNames };
  } catch {
    return {};
  }
}

function schema({ from, to, info }) {
  const sheets = info?.sheets || [];
  const groups = [];
  const input = [];
  if (from === 'csv') input.push(f.select('inDelimiter', 'Delimiter', [{ value: 'auto', label: 'Detect automatically' }, { value: ',', label: 'Comma ,' }, { value: ';', label: 'Semicolon ;' }, { value: 'tab', label: 'Tab' }, { value: '|', label: 'Pipe |' }], 'auto'));
  if (['csv', 'tsv'].includes(from)) input.push(f.toggle('typed', 'Detect numbers', true));
  if (['csv', 'tsv', 'json'].includes(from) && MULTI_OUT[to]) input.push(f.text('sheetName', 'Sheet name', { placeholder: 'Sheet1' }));
  if (['dbf', 'xls', 'wk1', 'wks'].includes(from)) input.push(f.select('codepage', 'Text encoding', [{ value: '', label: 'Auto' }, { value: '65001', label: 'UTF-8' }, { value: '1252', label: 'Western (1252)' }, { value: '1250', label: 'Central European (1250)' }, { value: '1251', label: 'Cyrillic (1251)' }, { value: '437', label: 'DOS (437)' }, { value: '850', label: 'DOS Latin-1 (850)' }], ''));
  if (input.length) groups.push(group('in', `${from.toUpperCase()} input`, input));

  const out = [];
  if (sheets.length > 1 || (!sheets.length && BOOK_IN.includes(from))) {
    const opts = [...(MULTI_OUT[to] ? [{ value: '__all__', label: 'All sheets' }] : []), ...sheets.map((s) => ({ value: s, label: s })), ...(!MULTI_OUT[to] ? [{ value: '__all__', label: to === 'json' ? 'All sheets (one object)' : ['html', 'md'].includes(to) ? 'All sheets' : 'All sheets (one file each)' }] : [])];
    if (!sheets.length) opts.unshift({ value: '', label: 'First sheet' });
    out.push(f.select('sheet', 'Sheet', opts, MULTI_OUT[to] ? '__all__' : sheets[0] || ''));
  }
  if (MULTI_OUT[to]) {
    out.push(f.toggle('autofit', 'Auto-fit column widths', ['csv', 'tsv', 'json'].includes(from)), f.toggle('autofilter', 'Add filters to the header row'), f.text('title', 'Title'), f.text('author', 'Author'));
    if (to !== 'xls') out.push(f.toggle('compress', 'Compress', true));
  }
  if (to === 'csv' || to === 'tsv') {
    if (to === 'csv') out.push(f.select('delimiter', 'Delimiter', [{ value: 'comma', label: 'Comma ,' }, { value: 'semicolon', label: 'Semicolon ; (European Excel)' }, { value: 'tab', label: 'Tab' }, { value: 'pipe', label: 'Pipe |' }], 'comma'));
    out.push(f.toggle('formatted', 'Use displayed (formatted) values', true), f.text('dateFormat', 'Date format', { placeholder: 'yyyy-mm-dd' }), f.toggle('quoteAll', 'Quote every field'), f.toggle('skipHidden', 'Skip hidden rows & columns'), f.toggle('blankRows', 'Keep blank rows'), f.select('newline', 'Line endings', [{ value: 'crlf', label: 'Windows (CRLF)' }, { value: 'lf', label: 'Unix (LF)' }], 'crlf'), f.toggle('bom', 'Add BOM (Excel-friendly UTF-8)'));
  }
  if (to === 'json') {
    out.push(
      f.select('jsonShape', 'Shape', [{ value: 'objects', label: 'Array of objects (header keys)' }, { value: 'arrays', label: 'Array of rows' }], 'objects'),
      f.select('empty', 'Empty cells', [{ value: 'null', label: 'null' }, { value: 'empty', label: 'Empty string' }, { value: 'omit', label: 'Omit key' }], 'null', { showIf: { jsonShape: ['objects'] } }),
      f.toggle('formatted', 'Use displayed (formatted) values', false),
      f.select('indent', 'Indentation', [{ value: '2', label: 'Pretty' }, { value: '0', label: 'Minified' }], '2'),
    );
  }
  if (to === 'html' || to === 'md') out.push(f.toggle('formatted', 'Use displayed (formatted) values', true));
  if (out.length) groups.push(group('out', `${to.toUpperCase()} output`, out));
  return groups;
}

export default {
  id: 'sheet',
  label: 'SheetJS',
  detect: () => ({ available: true, version: `SheetJS ${XLSX.version}` }),
  routes: () => [
    { from: BOOK_IN, to: OUT, cost: 1, same: true },
    { from: ['csv', 'tsv'], to: Object.keys(MULTI_OUT).concat(['dbf', 'slk', 'dif', 'rtf']), cost: 1 },
    { from: ['json'], to: Object.keys(MULTI_OUT), cost: 1 },
    { from: ['html'], to: ['xlsx', 'ods', 'csv'], cost: 2.5 },
  ],
  probe,
  probeFormats: () => BOOK_IN,
  schema,
  convert,
};
