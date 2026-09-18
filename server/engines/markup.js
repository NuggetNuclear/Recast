// Markdown, HTML, plain text and Word (DOCX) conversions in pure JavaScript.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import mammoth from 'mammoth';
import HTMLtoDOCX from '@turbodocx/html-to-docx';
import { convert as htmlToText } from 'html-to-text';
import { f, group, PAPER_SIZES, paperMm } from '../schema.js';
import { UserError, opt, clamp } from '../util.js';
import { THEMES, htmlDocument, escapeHtml } from './themes.js';

const DOCX_IN = ['docx', 'docm', 'dotx'];
const HTML_IN = ['html', 'xhtml'];

/** Read a text file, honouring BOMs and falling back to Windows-1252 for non-UTF-8 files. */
export async function readText(file) {
  const buf = await fsp.readFile(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/&\w+;/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';

function markdownToHtml(md, o) {
  const marked = new Marked({ gfm: opt.bool(o.gfm, true), breaks: opt.bool(o.breaks, false) });
  const headings = [];
  const used = new Map();
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        let id = slug(text);
        const n = used.get(id) || 0;
        used.set(id, n + 1);
        if (n) id += `-${n}`;
        headings.push({ depth, text, id });
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
    },
  });
  let body = marked.parse(md);
  if (opt.bool(o.toc) && headings.length > 1) {
    const maxDepth = clamp(opt.num(o.tocDepth, 3), 1, 6);
    const items = headings.filter((h) => h.depth <= maxDepth);
    const min = Math.min(...items.map((h) => h.depth));
    let html = '<nav class="toc"><strong>Contents</strong>';
    let prev = min - 1;
    for (const h of items) {
      if (h.depth > prev) for (let l = prev; l < h.depth; l++) html += '<ul>';
      else {
        html += '</li>';
        for (let l = prev; l > h.depth; l--) html += '</ul></li>';
      }
      html += `<li><a href="#${h.id}">${h.text.replace(/<a [^>]*>|<\/a>/g, '')}</a>`;
      prev = h.depth;
    }
    html += '</li>';
    for (let l = prev; l > min; l--) html += '</ul></li>';
    html += '</ul></nav>';
    body = html + '\n' + body;
  }
  const title = opt.str(o.title).trim() || headings.find((h) => h.depth === 1)?.text.replace(/<[^>]+>/g, '') || '';
  return { body, title };
}

function textToHtml(text, o) {
  if (o.txtMode === 'pre') return `<pre style="white-space:pre-wrap;font-size:.92em">${escapeHtml(text)}</pre>`;
  return text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`).join('\n');
}

function turndown(html, o) {
  const td = new TurndownService({
    headingStyle: o.headingStyle === 'setext' ? 'setext' : 'atx',
    bulletListMarker: ['-', '*', '+'].includes(o.bullet) ? o.bullet : '-',
    codeBlockStyle: o.codeBlockStyle === 'indented' ? 'indented' : 'fenced',
    fence: o.fence === '~~~' ? '~~~' : '```',
    emDelimiter: o.emDelimiter === '*' ? '*' : '_',
    strongDelimiter: o.strongDelimiter === '__' ? '__' : '**',
    linkStyle: o.linkStyle === 'referenced' ? 'referenced' : 'inlined',
    hr: '---',
  });
  if (opt.bool(o.gfm, true)) {
    td.use(gfm);
    // Word and many web tables have no <th> row; GFM still needs a header, so use the first row.
    const insideTable = (node) => {
      for (let p = node.parentNode; p; p = p.parentNode) if (p.nodeName === 'TABLE') return true;
      return false;
    };
    const rowsOf = (el, rows = []) => {
      for (const c of Array.from(el.childNodes)) {
        if (c.nodeName === 'TR') rows.push(c);
        else if (['THEAD', 'TBODY', 'TFOOT'].includes(c.nodeName)) rowsOf(c, rows);
      }
      return rows;
    };
    td.addRule('anyTable', {
      filter: (node) => node.nodeName === 'TABLE' && !insideTable(node),
      replacement: (content, node) => {
        const cells = rowsOf(node).map((tr) => Array.from(tr.childNodes)
          .filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH')
          .map((c) => td.turndown(c.innerHTML || '').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()));
        if (!cells.length) return content;
        const width = Math.max(...cells.map((r) => r.length));
        const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
        return `\n\n${line(cells[0])}\n| ${Array(width).fill('---').join(' | ')} |\n${cells.slice(1).map(line).join('\n')}\n\n`;
      },
    });
  }
  td.remove(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link']);
  if (opt.bool(o.dropImages)) td.remove(['img', 'picture', 'svg']);
  return td.turndown(html)
    .replace(/^(\s*)([-*+]|\d+\.) {2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

function toText(html, o) {
  const wrap = opt.num(o.wrap, 0);
  return htmlToText(html, {
    wordwrap: wrap > 0 ? clamp(wrap, 20, 400) : false,
    selectors: [
      { selector: 'a', options: { ignoreHref: !opt.bool(o.links, false) } },
      { selector: 'img', format: 'skip' },
      { selector: 'h1', options: { uppercase: opt.bool(o.uppercaseHeadings, false) } },
      { selector: 'h2', options: { uppercase: opt.bool(o.uppercaseHeadings, false) } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
    ],
  }).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function toDocxBuffer(bodyHtml, o, title) {
  const p = o.paper === 'custom' ? { w: opt.num(o.paperW, 210), h: opt.num(o.paperH, 297) } : paperMm(o.paper || 'A4');
  const tw = (mm) => Math.round((mm / 25.4) * 1440);
  const m = tw(clamp(opt.num(o.margin, 25), 0, 100));
  const landscape = o.orientation === 'landscape';
  const buf = await HTMLtoDOCX(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${bodyHtml}</body></html>`, null, {
    orientation: landscape ? 'landscape' : 'portrait',
    pageSize: { width: tw(landscape ? p.h : p.w), height: tw(landscape ? p.w : p.h) },
    margins: { top: m, right: m, bottom: m, left: m, header: 720, footer: 720, gutter: 0 },
    title,
    creator: 'Recast',
    font: o.font || 'Calibri',
    fontSize: Math.round(clamp(opt.num(o.fontSizePt, 11), 6, 40) * 2),
    footer: opt.bool(o.pageNumbers, false),
    pageNumber: opt.bool(o.pageNumbers, false),
    table: { row: { cantSplit: true } },
    decodeUnicode: true,
  });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(await buf.arrayBuffer());
}

function schema({ from, to }) {
  const groups = [];
  if (from === 'md') {
    groups.push(group('md', 'Markdown', [
      f.toggle('gfm', 'GitHub-flavoured Markdown', true, { help: 'Tables, task lists, strikethrough, autolinks.' }),
      f.toggle('breaks', 'Treat line breaks as <br>'),
      to === 'html' || to === 'docx' ? f.toggle('toc', 'Table of contents') : null,
      f.select('tocDepth', 'Contents depth', ['1', '2', '3', '4'], '3', { showIf: { toc: [true] } }),
    ]));
  }
  if (from === 'txt' && to !== 'md') {
    groups.push(group('txt', 'Text', [f.select('txtMode', 'Layout', [{ value: 'paragraphs', label: 'Paragraphs' }, { value: 'pre', label: 'Preformatted (keep spacing)' }], 'paragraphs')]));
  }
  if (DOCX_IN.includes(from)) {
    groups.push(group('word', 'Word document', [
      f.toggle('images', 'Include images', true),
      f.toggle('ignoreEmpty', 'Skip empty paragraphs', true),
    ]));
  }
  if (to === 'html') {
    groups.push(group('html', 'HTML output', [
      f.select('theme', 'Style', THEMES, 'modern'),
      f.range('fontSize', 'Base font size', 12, 22, 1, 16, { unit: 'px', showIf: { theme: { not: ['none'] } } }),
      f.range('maxWidth', 'Content width', 480, 1400, 20, 780, { unit: 'px', showIf: { theme: { not: ['none'] } } }),
      f.toggle('standalone', 'Complete document', true, { help: 'Off returns just the HTML fragment.', finalOnly: true }),
      f.text('title', 'Title', { placeholder: 'from first heading' }),
    ]));
  }
  if (to === 'md') {
    groups.push(group('mdout', 'Markdown output', [
      f.toggle('gfm', 'GitHub-flavoured (tables, strikethrough)', true),
      f.select('headingStyle', 'Headings', [{ value: 'atx', label: '# ATX' }, { value: 'setext', label: 'Underlined (Setext)' }], 'atx'),
      f.select('bullet', 'Bullet marker', ['-', '*', '+'], '-'),
      f.select('codeBlockStyle', 'Code blocks', [{ value: 'fenced', label: 'Fenced' }, { value: 'indented', label: 'Indented' }], 'fenced'),
      f.select('emDelimiter', 'Emphasis', [{ value: '_', label: '_italic_' }, { value: '*', label: '*italic*' }], '_'),
      f.select('strongDelimiter', 'Strong', [{ value: '**', label: '**bold**' }, { value: '__', label: '__bold__' }], '**'),
      f.select('linkStyle', 'Links', [{ value: 'inlined', label: 'Inline' }, { value: 'referenced', label: 'Reference-style' }], 'inlined'),
      f.toggle('dropImages', 'Remove images'),
    ].filter((x) => from !== 'txt')));
  }
  if (to === 'txt') {
    groups.push(group('txtout', 'Text output', [
      f.number('wrap', 'Wrap lines at', { unit: 'chars', min: 0, max: 400, placeholder: 'no wrapping' }),
      f.toggle('links', 'Show link URLs'),
      f.toggle('uppercaseHeadings', 'Uppercase headings'),
    ]));
  }
  if (to === 'docx') {
    groups.push(group('docx', 'Word output', [
      f.select('paper', 'Page size', PAPER_SIZES, 'A4'),
      f.number('paperW', 'Width', { unit: 'mm', min: 50, max: 1000, default: 210, showIf: { paper: ['custom'] } }),
      f.number('paperH', 'Height', { unit: 'mm', min: 50, max: 1000, default: 297, showIf: { paper: ['custom'] } }),
      f.select('orientation', 'Orientation', [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }], 'portrait'),
      f.number('margin', 'Margins', { unit: 'mm', min: 0, max: 100, default: 25 }),
      f.select('font', 'Font', ['Calibri', 'Aptos', 'Arial', 'Helvetica', 'Georgia', 'Cambria', 'Times New Roman', 'Garamond', 'Consolas'], 'Calibri'),
      f.range('fontSizePt', 'Font size', 8, 18, 0.5, 11, { unit: 'pt' }),
      f.toggle('pageNumbers', 'Page numbers in footer'),
      f.text('title', 'Title'),
    ]));
  }
  return groups;
}

async function sourceToHtml(input, from, o) {
  if (from === 'md') {
    const { body, title } = markdownToHtml(await readText(input), o);
    return { body, title };
  }
  if (from === 'txt') return { body: textToHtml(await readText(input), o), title: '' };
  if (HTML_IN.includes(from)) {
    const html = await readText(input);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
    return { body: html, title, full: true };
  }
  if (DOCX_IN.includes(from)) {
    const res = await mammoth.convertToHtml({ path: input }, {
      ignoreEmptyParagraphs: opt.bool(o.ignoreEmpty, true),
      convertImage: opt.bool(o.images, true) ? mammoth.images.imgElement((img) => img.read('base64').then((d) => ({ src: `data:${img.contentType};base64,${d}` }))) : mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
    }).catch((e) => { throw new UserError('This Word document could not be read', e.message); });
    let body = res.value;
    if (!opt.bool(o.images, true)) body = body.replace(/<img[^>]*src=""[^>]*>/g, '');
    return { body, title: '' };
  }
  throw new UserError(`Cannot read ${from}`);
}

async function convert({ input, from, to, o, outDir, baseName }) {
  const out = path.join(outDir, `${baseName}.${to}`);
  if (from === 'txt' && to === 'md') {
    await fsp.writeFile(out, await readText(input), 'utf8');
    return [out];
  }
  const { body, title, full } = await sourceToHtml(input, from, o);
  const docTitle = opt.str(o.title).trim() || title || baseName;

  switch (to) {
    case 'html': {
      const theme = o.theme || 'modern';
      const standalone = opt.bool(o.standalone, true);
      const html = full ? body : standalone ? htmlDocument(body, { title: docTitle, theme, fontSize: opt.num(o.fontSize, 16), maxWidth: opt.num(o.maxWidth, 780) }) : body;
      await fsp.writeFile(out, html, 'utf8');
      break;
    }
    case 'md':
      await fsp.writeFile(out, turndown(body, o), 'utf8');
      break;
    case 'txt':
      await fsp.writeFile(out, toText(body, o), 'utf8');
      break;
    case 'docx': {
      const inner = full ? (body.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, body])[1] : body;
      await fsp.writeFile(out, await toDocxBuffer(inner, o, docTitle));
      break;
    }
    default:
      throw new UserError(`Unsupported output ${to}`);
  }
  return [out];
}

export default {
  id: 'markup',
  label: 'Markup engine',
  detect: () => ({ available: true, version: 'marked · turndown · mammoth' }),
  routes: () => [
    { from: ['md'], to: ['html', 'txt', 'docx'], cost: 1 },
    { from: HTML_IN, to: ['md', 'txt', 'docx'], cost: 1 },
    { from: ['xhtml'], to: ['html'], cost: 1 },
    { from: ['txt'], to: ['html', 'md', 'docx'], cost: 1 },
    { from: DOCX_IN, to: ['html', 'md', 'txt'], cost: 1 },
  ],
  schema,
  convert,
};
