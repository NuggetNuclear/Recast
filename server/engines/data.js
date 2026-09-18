// Structured data: JSON, JSON Lines, YAML, XML, TOML, CSV/TSV, INI (+ Markdown/HTML tables).
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import * as TOML from 'smol-toml';
import Papa from 'papaparse';
import { f, group } from '../schema.js';
import { UserError, opt, clamp } from '../util.js';
import { readText } from './markup.js';
import { htmlDocument, escapeHtml } from './themes.js';

const FORMATS = ['json', 'jsonl', 'yaml', 'xml', 'toml', 'csv', 'tsv', 'ini'];
const OUT = [...FORMATS, 'md', 'html'];
const TABULAR = ['csv', 'tsv'];

// ---------- parsing

function parseIni(text) {
  const out = {};
  let cur = out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      cur = out;
      for (const part of sec[1].split('.')) cur = cur[part.trim()] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) { cur[line] = true; continue; }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^".*"$|^'.*'$/.test(val)) val = val.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    else if (/^(true|false)$/i.test(val)) val = val.toLowerCase() === 'true';
    cur[key] = val;
  }
  return out;
}

function parse(from, text, o) {
  try {
    switch (from) {
      case 'json': return JSON.parse(text);
      case 'jsonl': return text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
        try { return JSON.parse(l); } catch { throw new UserError(`Line ${i + 1} is not valid JSON`); }
      });
      case 'yaml': {
        const docs = yaml.loadAll(text);
        return docs.length === 1 ? docs[0] : docs;
      }
      case 'toml': return TOML.parse(text);
      case 'ini': return parseIni(text);
      case 'xml': {
        const parser = new XMLParser({
          ignoreAttributes: !opt.bool(o.xmlAttributes, true),
          attributeNamePrefix: opt.str(o.attrPrefix, '@'),
          textNodeName: '#text',
          parseTagValue: opt.bool(o.parseValues, true),
          parseAttributeValue: opt.bool(o.parseValues, true),
          trimValues: true,
          ignoreDeclaration: true,
          ignorePiTags: true,
          removeNSPrefix: opt.bool(o.stripNamespaces, false),
        });
        return parser.parse(text);
      }
      case 'csv': case 'tsv': {
        const delim = from === 'tsv' ? '\t' : o.inDelimiter === 'auto' || !o.inDelimiter ? '' : o.inDelimiter === 'tab' ? '\t' : o.inDelimiter;
        const res = Papa.parse(text.replace(/^\uFEFF/, ''), {
          header: opt.bool(o.inHeader, true),
          dynamicTyping: opt.bool(o.typed, true),
          skipEmptyLines: 'greedy',
          delimiter: delim,
        });
        if (res.errors?.length && !res.data?.length) throw new UserError(`CSV error: ${res.errors[0].message}`);
        let rows = res.data;
        if (opt.bool(o.unflatten)) rows = rows.map(unflatten);
        return rows;
      }
      default: throw new UserError(`Cannot read ${from}`);
    }
  } catch (e) {
    if (e.userFacing) throw e;
    throw new UserError(`The ${from.toUpperCase()} file is not valid: ${String(e.message).split('\n')[0]}`, e.message);
  }
}

// ---------- helpers

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.keys(v).sort((a, b) => a.localeCompare(b)).map((k) => [k, sortKeysDeep(v[k])]));
  return v;
}

function stripNulls(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(stripNulls);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, stripNulls(x)]));
  return v;
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = v.every((x) => x === null || typeof x !== 'object') ? v.join(', ') : JSON.stringify(v);
    else out[key] = v;
  }
  return out;
}

function unflatten(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const parts = k.split('.');
    let cur = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) cur[p] = v;
      else cur = cur[p] = cur[p] && typeof cur[p] === 'object' ? cur[p] : {};
    });
  }
  return out;
}

/** Find the list of records inside arbitrary data for table-like outputs. */
function toRecords(data, o) {
  let rows = data;
  if (!Array.isArray(rows) && rows && typeof rows === 'object') {
    const arrays = Object.values(rows).filter(Array.isArray);
    if (Object.keys(rows).length === 1 && arrays.length === 1) rows = arrays[0];
    else if (Object.keys(rows).length === 1 && typeof Object.values(rows)[0] === 'object') {
      const inner = Object.values(rows)[0];
      const innerArrays = Object.values(inner || {}).filter(Array.isArray);
      rows = innerArrays.length === 1 && Object.keys(inner).length === 1 ? innerArrays[0] : [rows];
    } else rows = [rows];
  }
  if (!Array.isArray(rows)) rows = [{ value: rows }];
  const flat = opt.bool(o.flatten, true);
  return rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (flat ? flatten(r) : Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : v]))) : Array.isArray(r) ? Object.fromEntries(r.map((x, i) => [`col${i + 1}`, x])) : { value: r }));
}

function columnsOf(records) {
  const cols = [];
  const seen = new Set();
  for (const r of records) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return cols;
}

const xmlName = (k) => {
  let n = String(k).replace(/[^\p{L}\p{N}_.:-]/gu, '_');
  if (!/^[\p{L}_]/u.test(n)) n = '_' + n;
  return n;
};

function sanitizeXml(v, prefix) {
  if (Array.isArray(v)) return v.map((x) => sanitizeXml(x, prefix));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.startsWith(prefix) || k === '#text' ? k : xmlName(k), sanitizeXml(x, prefix)]));
  }
  return v;
}

function toIni(obj) {
  const lines = [];
  const val = (v) => (typeof v === 'string' && /[;#=\s]/.test(v) ? `"${v}"` : v instanceof Date ? v.toISOString() : Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v);
  const top = Object.entries(obj || {}).filter(([, v]) => !(v && typeof v === 'object' && !Array.isArray(v)));
  for (const [k, v] of top) lines.push(`${k} = ${val(v)}`);
  const walk = (o, name) => {
    const prim = Object.entries(o).filter(([, v]) => !(v && typeof v === 'object' && !Array.isArray(v)));
    const sub = Object.entries(o).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
    if (prim.length) {
      if (lines.length) lines.push('');
      lines.push(`[${name}]`);
      for (const [k, v] of prim) lines.push(`${k} = ${val(v)}`);
    }
    for (const [k, v] of sub) walk(v, `${name}.${k}`);
  };
  for (const [k, v] of Object.entries(obj || {})) if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, k);
  return lines.join('\n') + '\n';
}

// ---------- serialisation

function serialize(to, data, o, title) {
  if (opt.bool(o.sortKeys)) data = sortKeysDeep(data);
  const indentOpt = o.indent || '2';
  const indent = indentOpt === 'tab' ? '\t' : indentOpt === '0' ? '' : ' '.repeat(Number(indentOpt) || 2);
  switch (to) {
    case 'json': {
      let s = JSON.stringify(data, null, indent);
      if (opt.bool(o.ascii)) s = s.replace(/[\u007F-\uFFFF]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      return s + '\n';
    }
    case 'jsonl':
      return (Array.isArray(data) ? data : [data]).map((x) => JSON.stringify(x)).join('\n') + '\n';
    case 'yaml':
      return yaml.dump(data, {
        indent: clamp(Number(indentOpt) || 2, 1, 8),
        lineWidth: opt.bool(o.wrapLines) ? 80 : -1,
        noRefs: true,
        quotingType: o.quotes === 'single' ? "'" : '"',
        forceQuotes: opt.bool(o.forceQuotes),
        skipInvalid: true,
      });
    case 'toml': {
      let d = stripNulls(data);
      if (Array.isArray(d)) d = { [opt.str(o.rootName, 'items') || 'items']: d };
      if (!d || typeof d !== 'object') d = { value: d };
      try { return TOML.stringify(d) + '\n'; } catch (e) { throw new UserError(`This data cannot be expressed as TOML: ${e.message}`); }
    }
    case 'ini':
      return toIni(Array.isArray(data) ? Object.fromEntries(data.map((x, i) => [`item${i + 1}`, x])) : data && typeof data === 'object' ? data : { value: data });
    case 'xml': {
      const prefix = opt.str(o.attrPrefix, '@');
      const root = xmlName(opt.str(o.rootName).trim() || 'root');
      const item = xmlName(opt.str(o.itemName).trim() || 'item');
      let d = sanitizeXml(data, prefix);
      // XML needs exactly one root element; a lone key is only reused as root when it holds an object.
      const keys = d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d) : [];
      const loneObject = keys.length === 1 && d[keys[0]] && typeof d[keys[0]] === 'object' && !Array.isArray(d[keys[0]]);
      if (Array.isArray(d)) d = { [root]: { [item]: d } };
      else if (!d || typeof d !== 'object') d = { [root]: d };
      else if (!loneObject || opt.str(o.rootName).trim()) d = { [root]: d };
      const builder = new XMLBuilder({ format: indent !== '', indentBy: indent || '  ', ignoreAttributes: false, attributeNamePrefix: prefix, textNodeName: '#text', suppressEmptyNode: true, suppressBooleanAttributes: false });
      const body = builder.build(d);
      return (opt.bool(o.declaration, true) ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '') + body.trim() + '\n';
    }
    case 'csv': case 'tsv': {
      const records = toRecords(data, o);
      const fields = columnsOf(records);
      const delim = to === 'tsv' ? '\t' : { tab: '\t', semicolon: ';', pipe: '|', comma: ',' }[o.delimiter] || ',';
      const csv = Papa.unparse({ fields, data: records.map((r) => fields.map((k) => (r[k] instanceof Date ? r[k].toISOString() : r[k] ?? ''))) }, {
        delimiter: delim,
        header: opt.bool(o.header, true),
        quotes: opt.bool(o.quoteAll),
        newline: o.newline === 'lf' ? '\n' : '\r\n',
      });
      return (opt.bool(o.bom) ? '\uFEFF' : '') + csv + (o.newline === 'lf' ? '\n' : '\r\n');
    }
    case 'md': {
      const records = toRecords(data, o);
      const fields = columnsOf(records);
      if (!fields.length) return '';
      const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
      const lines = [`| ${fields.map(cell).join(' | ')} |`, `| ${fields.map(() => '---').join(' | ')} |`];
      for (const r of records) lines.push(`| ${fields.map((k) => cell(r[k])).join(' | ')} |`);
      return lines.join('\n') + '\n';
    }
    case 'html': {
      const records = toRecords(data, o);
      const fields = columnsOf(records);
      const table = `<table>\n<thead><tr>${fields.map((k) => `<th>${escapeHtml(k)}</th>`).join('')}</tr></thead>\n<tbody>\n${records.map((r) => `<tr>${fields.map((k) => `<td>${escapeHtml(r[k] ?? '')}</td>`).join('')}</tr>`).join('\n')}\n</tbody>\n</table>`;
      return htmlDocument(`<h1>${escapeHtml(title)}</h1>\n${table}`, { title, maxWidth: 1400, fontSize: 14 });
    }
    default:
      throw new UserError(`Cannot write ${to}`);
  }
}

function schema({ from, to }) {
  const input = [];
  if (TABULAR.includes(from)) {
    if (from === 'csv') input.push(f.select('inDelimiter', 'Delimiter', [{ value: 'auto', label: 'Detect automatically' }, { value: ',', label: 'Comma ,' }, { value: ';', label: 'Semicolon ;' }, { value: 'tab', label: 'Tab' }, { value: '|', label: 'Pipe |' }], 'auto'));
    input.push(f.toggle('inHeader', 'First row is a header', true), f.toggle('typed', 'Detect numbers & booleans', true), f.toggle('unflatten', 'Nest “a.b” columns', false));
  }
  if (from === 'xml') {
    input.push(f.toggle('xmlAttributes', 'Keep attributes', true), f.text('attrPrefix', 'Attribute prefix', { default: '@' }), f.toggle('parseValues', 'Detect numbers & booleans', true), f.toggle('stripNamespaces', 'Remove namespace prefixes'));
  }
  const output = [];
  switch (to) {
    case 'json':
      output.push(f.select('indent', 'Indentation', [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }, { value: 'tab', label: 'Tabs' }, { value: '0', label: 'Minified' }], '2'), f.toggle('sortKeys', 'Sort keys'), f.toggle('ascii', 'Escape non-ASCII characters'));
      break;
    case 'yaml':
      output.push(f.select('indent', 'Indentation', [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }], '2'), f.toggle('sortKeys', 'Sort keys'), f.select('quotes', 'Quote style', [{ value: 'double', label: 'Double "…"' }, { value: 'single', label: "Single '…'" }], 'double'), f.toggle('forceQuotes', 'Quote every string'), f.toggle('wrapLines', 'Wrap long lines'));
      break;
    case 'xml':
      output.push(f.text('rootName', 'Root element', { placeholder: 'root' }), f.text('itemName', 'Array item element', { placeholder: 'item' }), f.select('indent', 'Indentation', [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }, { value: 'tab', label: 'Tabs' }, { value: '0', label: 'Minified' }], '2'), f.toggle('declaration', 'XML declaration', true), from !== 'xml' ? f.text('attrPrefix', 'Attribute key prefix', { default: '@', help: 'Keys starting with this become attributes.' }) : null);
      break;
    case 'toml':
      output.push(f.toggle('sortKeys', 'Sort keys'), f.text('rootName', 'Key for top-level arrays', { placeholder: 'items' }));
      break;
    case 'csv': case 'tsv':
      if (to === 'csv') output.push(f.select('delimiter', 'Delimiter', [{ value: 'comma', label: 'Comma ,' }, { value: 'semicolon', label: 'Semicolon ; (European Excel)' }, { value: 'tab', label: 'Tab' }, { value: 'pipe', label: 'Pipe |' }], 'comma'));
      output.push(f.toggle('header', 'Header row', true), f.toggle('quoteAll', 'Quote every field'), f.toggle('flatten', 'Flatten nested objects (a.b)', true), f.select('newline', 'Line endings', [{ value: 'crlf', label: 'Windows (CRLF)' }, { value: 'lf', label: 'Unix (LF)' }], 'crlf'), f.toggle('bom', 'Add BOM (Excel-friendly UTF-8)'));
      break;
    case 'md': case 'html':
      output.push(f.toggle('flatten', 'Flatten nested objects (a.b)', true));
      break;
    default: break;
  }
  const groups = [];
  if (input.length) groups.push(group('in', `${from.toUpperCase()} input`, input));
  if (output.length) groups.push(group('out', `${to.toUpperCase()} output`, output));
  return groups;
}

async function convert({ input, from, to, o, outDir, baseName }) {
  const text = await readText(input);
  const data = parse(from, text, o);
  const out = path.join(outDir, `${baseName}.${to}`);
  await fsp.writeFile(out, serialize(to, data, o, baseName), 'utf8');
  return [out];
}

export default {
  id: 'data',
  label: 'Data engine',
  detect: () => ({ available: true, version: 'js-yaml · fast-xml-parser · smol-toml · Papa Parse' }),
  routes: () => [{ from: FORMATS, to: OUT, cost: 1, same: true }],
  schema,
  convert,
};
