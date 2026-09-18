// PDF, XPS, EPUB, FB2, CBZ, MOBI via MuPDF: render, extract, optimise, encrypt, reflow.
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import { f, group, PAPER_SIZES, paperMm } from '../schema.js';
import { UserError, opt, clamp, parsePageRange } from '../util.js';
import { pkgVersion } from '../tools.js';
import { extractStructure, toDocx, toMarkdown, toHtml } from './pdfstructure.js';

const REFLOWABLE = ['epub', 'fb2', 'mobi', 'html', 'xhtml', 'txt'];
const PAGED_IN = ['pdf', 'xps', 'oxps', 'epub', 'fb2', 'cbz', 'mobi'];
const OUT = ['png', 'svg', 'txt', 'html', 'pdf', 'docx', 'md', 'ps', 'cbz'];

function open(buf, from, o) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(buf, from);
  } catch (e) {
    throw new UserError(`This ${from.toUpperCase()} file could not be opened — it may be damaged`, e.message);
  }
  if (doc.needsPassword()) {
    const pw = opt.str(o.password);
    if (!pw) throw new UserError('This document is password-protected — enter its password in the settings');
    if (!doc.authenticatePassword(pw)) throw new UserError('The password is not correct');
  }
  if (REFLOWABLE.includes(from)) {
    const p = paperMm(o.paper || 'A5');
    const w = o.paper === 'custom' ? opt.num(o.paperW, 148) : p.w;
    const h = o.paper === 'custom' ? opt.num(o.paperH, 210) : p.h;
    const mm = 72 / 25.4;
    try {
      const margin = clamp(opt.num(o.bookMargin, 12), 0, 50);
      doc.style?.(true, `@page{margin:${margin}mm !important} body{margin:0 !important}`);
    } catch {}
    doc.layout(w * mm, h * mm, clamp(opt.num(o.fontSize, 11), 5, 40));
  }
  return doc;
}

async function probe(input, from) {
  try {
    const buf = await fsp.readFile(input);
    const doc = mupdf.Document.openDocument(buf, from);
    if (doc.needsPassword()) return { encrypted: true };
    const info = { pages: REFLOWABLE.includes(from) ? undefined : doc.countPages() };
    const title = doc.getMetaData('info:Title');
    if (title) info.title = title;
    if (from === 'pdf') {
      const b = doc.loadPage(0).getBounds();
      info.width = Math.round(b[2] - b[0]);
      info.height = Math.round(b[3] - b[1]);
    }
    return info;
  } catch {
    return {};
  }
}

const pagesField = (info) => f.text('pages', 'Pages', { placeholder: info?.pages ? `all (1–${info.pages})` : 'all', help: 'e.g. 1-3, 5, 8- · leave empty for all pages' });

function schema({ from, to, info }) {
  const groups = [];
  const fields = [];
  if (info?.encrypted) fields.push(f.text('password', 'Document password', { secret: true, placeholder: 'required to open this file' }));
  if (REFLOWABLE.includes(from)) {
    groups.push(group('layout', 'Page layout', [
      f.select('paper', 'Page size', [...PAPER_SIZES.filter((p) => p.value !== 'custom'), { value: 'custom', label: 'Custom size…' }], 'A5'),
      f.number('paperW', 'Width', { unit: 'mm', min: 30, max: 1000, default: 148, showIf: { paper: ['custom'] } }),
      f.number('paperH', 'Height', { unit: 'mm', min: 30, max: 1000, default: 210, showIf: { paper: ['custom'] } }),
      f.range('fontSize', 'Font size', 6, 24, 0.5, 11, { unit: 'pt' }),
      f.range('bookMargin', 'Margins', 0, 40, 1, 12, { unit: 'mm' }),
    ]));
  }
  switch (to) {
    case 'png':
      fields.push(
        pagesField(info),
        f.range('dpi', 'Resolution', 36, 600, 1, 150, { unit: 'dpi' }),
        f.select('colorspace', 'Color', [{ value: 'rgb', label: 'Color' }, { value: 'gray', label: 'Grayscale' }], 'rgb'),
        f.toggle('alpha', 'Transparent background'),
        f.toggle('annotations', 'Render annotations & form fields', true),
      );
      break;
    case 'svg':
      fields.push(pagesField(info), f.select('svgText', 'Text', [{ value: 'path', label: 'Convert to outlines (exact look)' }, { value: 'text', label: 'Keep as text (searchable)' }], 'path'));
      break;
    case 'txt':
      fields.push(
        pagesField(info),
        f.toggle('dehyphenate', 'Join hyphenated words', true),
        f.toggle('preserveWhitespace', 'Preserve spacing', false),
        f.select('pageSeparator', 'Between pages', [{ value: 'blank', label: 'Blank line' }, { value: 'ff', label: 'Form feed' }, { value: 'marker', label: '--- Page N ---' }, { value: 'none', label: 'Nothing' }], 'blank'),
      );
      break;
    case 'html':
      fields.push(
        pagesField(info),
        f.select('htmlMode', 'Layout', [{ value: 'reflow', label: 'Reflowed (clean, responsive)' }, { value: 'faithful', label: 'Faithful (positioned like the original)' }], 'reflow'),
        f.toggle('images', 'Include images', true, { showIf: { htmlMode: ['reflow'] } }),
        f.toggle('headings', 'Detect headings', true, { showIf: { htmlMode: ['reflow'] } }),
      );
      break;
    case 'md':
      fields.push(pagesField(info), f.toggle('images', 'Embed images', false, { help: 'Images are embedded as data URIs.' }), f.toggle('headings', 'Detect headings', true), f.toggle('pageBreaks', 'Mark page breaks'));
      break;
    case 'docx':
      fields.push(
        pagesField(info),
        f.toggle('images', 'Include images', true),
        f.toggle('headings', 'Detect headings', true),
        f.toggle('pageBreaks', 'Keep page breaks', true),
        f.select('font', 'Font', ['Calibri', 'Arial', 'Aptos', 'Georgia', 'Times New Roman', 'Cambria', 'Garamond', 'Helvetica'], 'Calibri'),
        f.range('docFontSize', 'Font size', 8, 16, 0.5, 11, { unit: 'pt' }),
      );
      break;
    case 'pdf':
      if (from === 'pdf') {
        groups.push(group('pages', 'Pages', [
          pagesField(info),
          f.select('rotate', 'Rotate pages', [{ value: '0', label: 'None' }, { value: '90', label: '90° clockwise' }, { value: '180', label: '180°' }, { value: '270', label: '90° counter-clockwise' }], '0'),
          f.toggle('flatten', 'Flatten forms & annotations'),
        ]));
        groups.push(group('compress', 'Compression', [
          f.select('compression', 'Optimisation', [{ value: 'none', label: 'None (rewrite only)' }, { value: 'standard', label: 'Standard' }, { value: 'max', label: 'Maximum' }], 'standard'),
          f.toggle('recompress', 'Recompress images', false, { help: 'Re-encodes large images as JPEG. Big savings for scanned documents.' }),
          f.number('maxImage', 'Max image size', { unit: 'px', min: 200, max: 10000, default: 2000, showIf: { recompress: [true] }, help: 'Longest side of each image.' }),
          f.range('imageQuality', 'Image quality', 10, 100, 1, 75, { showIf: { recompress: [true] } }),
          f.toggle('grayscaleImages', 'Convert images to grayscale', false, { showIf: { recompress: [true] } }),
        ]));
        groups.push(group('security', 'Security', [
          f.select('encrypt', 'Encryption', [{ value: 'keep', label: 'Keep as is' }, { value: 'none', label: 'Remove password' }, { value: 'aes-256', label: 'AES-256' }, { value: 'aes-128', label: 'AES-128' }, { value: 'rc4-128', label: 'RC4-128 (legacy)' }], 'keep'),
          f.text('userPassword', 'Open password', { secret: true, showIf: { encrypt: ['aes-256', 'aes-128', 'rc4-128'] }, help: 'Needed to open the file. Commas are not allowed.' }),
          f.text('ownerPassword', 'Permissions password', { secret: true, showIf: { encrypt: ['aes-256', 'aes-128', 'rc4-128'] } }),
          f.multi('allow', 'Allow', [{ value: 'print', label: 'Print' }, { value: 'copy', label: 'Copy' }, { value: 'edit', label: 'Edit' }, { value: 'annotate', label: 'Annotate' }, { value: 'form', label: 'Fill forms' }, { value: 'assemble', label: 'Assemble' }], ['print', 'copy', 'edit', 'annotate', 'form', 'assemble'], { showIf: { encrypt: ['aes-256', 'aes-128', 'rc4-128'] } }),
        ], { collapsed: true }));
        groups.push(group('meta', 'Document info', [
          f.text('title', 'Title', { placeholder: info?.title || '' }),
          f.text('author', 'Author'),
          f.text('subject', 'Subject'),
          f.text('keywords', 'Keywords'),
        ], { collapsed: true }));
      } else {
        fields.push(pagesField(info));
      }
      break;
    case 'ps':
    case 'cbz':
      fields.push(pagesField(info));
      if (to === 'cbz') fields.push(f.range('dpi', 'Resolution', 72, 300, 1, 150, { unit: 'dpi' }));
      break;
    default: break;
  }
  if (fields.length) groups.unshift(group('main', `${to.toUpperCase()} output`, fields));
  return groups;
}

function writeWith(doc, pages, format, options = '', onPage) {
  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, format, options);
  pages.forEach((i, n) => {
    const page = doc.loadPage(i);
    const dev = writer.beginPage(page.getBounds());
    page.run(dev, mupdf.Matrix.identity);
    writer.endPage();
    onPage?.(n + 1, pages.length);
  });
  writer.close();
  return Buffer.from(buf.asUint8Array());
}

async function recompressImages(pdoc, o, progress) {
  const maxSide = clamp(opt.num(o.maxImage, 2000), 200, 10000);
  const quality = clamp(opt.num(o.imageQuality, 75), 10, 100);
  const gray = opt.bool(o.grayscaleImages);
  const done = new Map();
  const count = pdoc.countPages();
  for (let i = 0; i < count; i++) {
    const res = pdoc.findPage(i).getInheritable('Resources');
    if (!res || res.isNull()) continue;
    const xo = res.get('XObject');
    if (!xo || !xo.isDictionary()) continue;
    const entries = [];
    xo.forEach((val, key) => entries.push([key, val]));
    for (const [key, val] of entries) {
      if (!val.isIndirect()) continue;
      const num = val.asIndirect();
      if (done.has(num)) { if (done.get(num)) xo.put(key, done.get(num)); continue; }
      done.set(num, null);
      const obj = val.resolve();
      if (obj.get('Subtype').asName() !== 'Image' || obj.get('ImageMask').asBoolean?.() || !obj.get('SMask').isNull() || !obj.get('Mask').isNull()) continue;
      try {
        const img = pdoc.loadImage(val);
        const w = img.getWidth();
        const h = img.getHeight();
        if (w * h < 40000 || img.getBitsPerComponent() < 8) continue;
        let pix = img.toPixmap();
        const n = pix.getColorSpace()?.getNumberOfComponents?.() ?? img.getNumberOfComponents();
        if (n !== 1 && n !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
        let s = sharp(Buffer.from(pix.asPNG()));
        if (Math.max(w, h) > maxSide) s = s.resize({ width: w >= h ? maxSide : null, height: h > w ? maxSide : null, fit: 'inside' });
        if (gray) s = s.grayscale();
        const jpg = await s.jpeg({ quality, mozjpeg: true }).toBuffer();
        const oldLen = obj.readRawStream().getLength();
        if (jpg.length >= oldLen * 0.9) continue;
        const ref = pdoc.addImage(new mupdf.Image(jpg));
        done.set(num, ref);
        xo.put(key, ref);
      } catch {
        // Leave images we cannot decode untouched.
      }
    }
    progress?.(0.1 + (0.6 * (i + 1)) / count);
  }
}

async function convert({ input, from, to, o, outDir, baseName, progress }) {
  const buf = await fsp.readFile(input);
  const doc = open(buf, from, o);
  const count = doc.countPages();
  const pages = parsePageRange(o.pages, count);
  const onPage = (n, total) => progress(Math.min(0.95, n / total));
  const outPath = (suffix = '', ext = to) => path.join(outDir, `${baseName}${suffix}.${ext}`);
  const pad = String(pages.length).length;

  if (to === 'png') {
    const scale = clamp(opt.num(o.dpi, 150), 36, 600) / 72;
    const cs = o.colorspace === 'gray' ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
    const outs = [];
    for (let n = 0; n < pages.length; n++) {
      const page = doc.loadPage(pages[n]);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), cs, opt.bool(o.alpha), opt.bool(o.annotations, true));
      const p = pages.length === 1 ? outPath() : outPath(`-${String(pages[n] + 1).padStart(pad, '0')}`);
      await fsp.writeFile(p, pix.asPNG());
      outs.push(p);
      onPage(n + 1, pages.length);
    }
    return outs;
  }

  if (to === 'svg') {
    const outs = [];
    for (let n = 0; n < pages.length; n++) {
      const data = writeWith(doc, [pages[n]], 'svg', o.svgText === 'text' ? 'text=text' : 'text=path');
      const p = pages.length === 1 ? outPath() : outPath(`-${String(pages[n] + 1).padStart(pad, '0')}`);
      await fsp.writeFile(p, data);
      outs.push(p);
      onPage(n + 1, pages.length);
    }
    return outs;
  }

  if (to === 'txt') {
    const flags = [opt.bool(o.preserveWhitespace) ? 'preserve-whitespace' : '', opt.bool(o.dehyphenate, true) ? 'dehyphenate' : ''].filter(Boolean).join(',');
    const parts = [];
    pages.forEach((i, n) => {
      const text = doc.loadPage(i).toStructuredText(flags).asText().replace(/\s+$/, '');
      if (n > 0) parts.push({ blank: '\n\n', ff: '\n\f\n', marker: `\n\n--- Page ${i + 1} ---\n\n`, none: '\n' }[o.pageSeparator || 'blank']);
      else if (o.pageSeparator === 'marker') parts.push(`--- Page ${i + 1} ---\n\n`);
      parts.push(text);
      onPage(n + 1, pages.length);
    });
    await fsp.writeFile(outPath(), parts.join('') + '\n', 'utf8');
    return [outPath()];
  }

  if (to === 'html' && o.htmlMode === 'faithful') {
    await fsp.writeFile(outPath(), writeWith(doc, pages, 'html', 'preserve-images', onPage));
    return [outPath()];
  }

  if (['html', 'md', 'docx'].includes(to)) {
    const model = await extractStructure(doc, pages, {
      images: opt.bool(o.images, to !== 'md'),
      headings: opt.bool(o.headings, true),
      onPage: (n, t) => progress(0.85 * (n / t)),
    });
    const title = doc.getMetaData('info:Title') || baseName;
    if (to === 'html') await fsp.writeFile(outPath(), toHtml(model, { title }), 'utf8');
    else if (to === 'md') await fsp.writeFile(outPath(), toMarkdown(model, { pageBreaks: opt.bool(o.pageBreaks) }), 'utf8');
    else await fsp.writeFile(outPath(), await toDocx(model, { title, font: o.font || 'Calibri', fontSize: opt.num(o.docFontSize, 11), pageBreaks: opt.bool(o.pageBreaks, true) }));
    return [outPath()];
  }

  if (to === 'ps') {
    await fsp.writeFile(outPath(), writeWith(doc, pages, 'ps', '', onPage));
    return [outPath()];
  }
  if (to === 'cbz') {
    await fsp.writeFile(outPath(), writeWith(doc, pages, 'cbz', `resolution=${clamp(opt.num(o.dpi, 150), 72, 300)}`, onPage));
    return [outPath()];
  }

  if (to === 'pdf' && from !== 'pdf') {
    await fsp.writeFile(outPath(), writeWith(doc, pages, 'pdf', 'compress,compress-fonts,compress-images,garbage', onPage));
    return [outPath()];
  }

  if (to === 'pdf') {
    const pdoc = doc.asPDF();
    if (pages.length !== count) pdoc.rearrangePages(pages);
    progress(0.1);
    const rot = opt.num(o.rotate, 0);
    if (rot) {
      for (let i = 0; i < pdoc.countPages(); i++) {
        const pobj = pdoc.findPage(i);
        const cur = pobj.getInheritable('Rotate');
        const base = cur && !cur.isNull() ? cur.asNumber() : 0;
        pobj.put('Rotate', (((base + rot) % 360) + 360) % 360);
      }
    }
    if (opt.bool(o.flatten)) pdoc.bake(true, true);
    if (opt.bool(o.recompress)) await recompressImages(pdoc, o, progress);
    const meta = { title: 'info:Title', author: 'info:Author', subject: 'info:Subject', keywords: 'info:Keywords' };
    for (const [k, key] of Object.entries(meta)) if (opt.str(o[k]).trim()) pdoc.setMetaData(key, o[k].trim());

    const saveOpts = [];
    const comp = o.compression || 'standard';
    if (comp === 'standard') saveOpts.push('garbage=compact', 'compress', 'compress-fonts', 'compress-images');
    if (comp === 'max') saveOpts.push('garbage=deduplicate', 'compress', 'compress-fonts', 'compress-images', 'clean', 'sanitize', 'objstms');
    const enc = o.encrypt || 'keep';
    if (enc === 'none') saveOpts.push('decrypt');
    else if (enc !== 'keep') {
      const clean = (s) => opt.str(s).replace(/,/g, '');
      const user = clean(o.userPassword);
      const owner = clean(o.ownerPassword) || user;
      if (!user && !owner) throw new UserError('Enter an open or permissions password to encrypt the PDF');
      const bits = { print: 4, edit: 8, copy: 16, annotate: 32, form: 256, accessibility: 512, assemble: 1024, 'print-hq': 2048 };
      const allow = Array.isArray(o.allow) ? o.allow : ['print', 'copy', 'edit', 'annotate', 'form', 'assemble'];
      let perms = -3904 & ~(4 | 8 | 16 | 32 | 256 | 512 | 1024 | 2048);
      for (const a of [...allow, 'accessibility']) perms |= bits[a] || 0;
      if (allow.includes('print')) perms |= bits['print-hq'];
      saveOpts.push(`encrypt=${enc}`, `owner-password=${owner}`, `permissions=${perms}`);
      if (user) saveOpts.push(`user-password=${user}`);
    }
    progress(0.8);
    const out = pdoc.saveToBuffer(saveOpts.join(','));
    await fsp.writeFile(outPath(), out.asUint8Array());
    return [outPath()];
  }

  throw new UserError(`Unsupported conversion ${from} → ${to}`);
}

export default {
  id: 'pdf',
  label: 'MuPDF',
  detect: () => ({ available: true, version: `MuPDF ${pkgVersion('mupdf')}`.trim() }),
  routes: () => [
    { from: ['pdf'], to: OUT, cost: 1, same: true },
    { from: PAGED_IN.filter((x) => x !== 'pdf'), to: OUT, cost: 1.2 },
    { from: ['html', 'xhtml', 'txt'], to: ['pdf'], cost: 3 },
  ],
  probe,
  probeFormats: () => PAGED_IN,
  schema,
  convert,
};
