// Images → PDF (pdf-lib) and merging PDFs/images into one PDF (MuPDF).
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as mupdf from 'mupdf';
import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from 'pdf-lib';
import { f, group, PAPER_SIZES, paperMm } from '../schema.js';
import { UserError, opt, clamp, hexToRgb } from '../util.js';
import { imageInputs, loadImage } from './image.js';
import { config } from '../config.js';

const MM = 72 / 25.4;

export function pdfPageSchema({ info, multi = false } = {}) {
  return [
    group('page', 'Page', [
      f.select('pageSize', 'Page size', [{ value: 'image', label: 'Same as image' }, ...PAPER_SIZES], 'image'),
      f.number('paperW', 'Width', { unit: 'mm', min: 20, max: 5000, default: 210, showIf: { pageSize: ['custom'] } }),
      f.number('paperH', 'Height', { unit: 'mm', min: 20, max: 5000, default: 297, showIf: { pageSize: ['custom'] } }),
      f.select('orientation', 'Orientation', [{ value: 'auto', label: 'Match image' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }], 'auto', { showIf: { pageSize: { not: ['image'] } } }),
      f.select('fit', 'Image placement', [{ value: 'contain', label: 'Fit to page' }, { value: 'cover', label: 'Fill page (crop)' }, { value: 'stretch', label: 'Stretch' }, { value: 'actual', label: 'Actual size (at DPI)' }], 'contain', { showIf: { pageSize: { not: ['image'] } } }),
      f.number('margin', 'Margin', { unit: 'mm', min: 0, max: 100, default: 0 }),
      f.number('dpi', 'Image DPI', { min: 36, max: 1200, default: 150, help: 'Sets the physical size of “Same as image” and “Actual size” pages.' }),
      f.color('background', 'Page color', '#ffffff'),
    ]),
    group('images', 'Image encoding', [
      f.select('encoding', 'Encoding', [{ value: 'auto', label: 'Original quality (JPEG kept as-is)' }, { value: 'jpeg', label: 'Compress as JPEG' }, { value: 'png', label: 'Lossless (PNG)' }], 'auto'),
      f.range('quality', 'JPEG quality', 10, 100, 1, 82, { showIf: { encoding: ['jpeg'] } }),
      f.number('maxSide', 'Downscale to', { unit: 'px', min: 100, max: 20000, placeholder: 'no limit', help: 'Longest side of each image.' }),
      !multi && info?.pages > 1 ? f.toggle('allFrames', `All ${info.pages} frames as pages`, true) : null,
    ]),
    group('meta', 'Document info', [f.text('title', 'Title'), f.text('author', 'Author')], { collapsed: true }),
  ];
}

/** Add one image file (all frames if requested) to a pdf-lib document. */
export async function addImagePages(pdf, input, from, o, tmpDir) {
  const meta = SHARP_META.includes(from) ? await sharp(input, { limitInputPixels: config.maxPixels }).metadata().catch(() => ({})) : {};
  const frames = opt.bool(o.allFrames, false) && (meta.pages || 1) > 1 ? meta.pages : 1;
  for (let fi = 0; fi < frames; fi++) {
    let embedded;
    const maxSide = opt.num(o.maxSide);
    const passthroughJpeg = from === 'jpg' && (o.encoding || 'auto') === 'auto' && !maxSide && (meta.orientation || 1) === 1 && meta.space !== 'cmyk';
    if (passthroughJpeg) {
      embedded = await pdf.embedJpg(await fsp.readFile(input));
    } else {
      let img = await loadImage(input, from, { page: fi, tmpDir });
      img = typeof img.autoOrient === 'function' ? img.autoOrient() : img.rotate();
      if (maxSide) img = img.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
      const enc = o.encoding || 'auto';
      const useJpeg = enc === 'jpeg' || (enc === 'auto' && from === 'jpg');
      if (useJpeg) {
        const bg = hexToRgb(o.background) || { r: 255, g: 255, b: 255 };
        embedded = await pdf.embedJpg(await img.flatten({ background: bg }).toColourspace('srgb').jpeg({ quality: clamp(opt.num(o.quality, 82), 10, 100), mozjpeg: true }).toBuffer());
      } else {
        embedded = await pdf.embedPng(await img.toColourspace('srgb').png({ compressionLevel: 6 }).toBuffer());
      }
    }
    placeOnPage(pdf, embedded, o);
  }
}

const SHARP_META = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff'];

function placeOnPage(pdf, img, o) {
  const dpi = clamp(opt.num(o.dpi, 150), 36, 1200);
  const margin = clamp(opt.num(o.margin, 0), 0, 100) * MM;
  const iw = (img.width * 72) / dpi;
  const ih = (img.height * 72) / dpi;
  let pw;
  let ph;
  const size = o.pageSize || 'image';
  if (size === 'image') {
    pw = iw + margin * 2;
    ph = ih + margin * 2;
  } else {
    const p = size === 'custom' ? { w: opt.num(o.paperW, 210), h: opt.num(o.paperH, 297) } : paperMm(size);
    pw = p.w * MM;
    ph = p.h * MM;
    const orient = o.orientation || 'auto';
    const landscape = orient === 'landscape' || (orient === 'auto' && img.width > img.height);
    if (landscape !== pw > ph) [pw, ph] = [ph, pw];
  }
  const page = pdf.addPage([pw, ph]);
  const bg = hexToRgb(o.background);
  if (bg && !(bg.r === 255 && bg.g === 255 && bg.b === 255)) page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: rgb(bg.r / 255, bg.g / 255, bg.b / 255) });
  const bw = pw - margin * 2;
  const bh = ph - margin * 2;
  let w;
  let h;
  const fit = size === 'image' ? 'actual' : o.fit || 'contain';
  if (fit === 'stretch') { w = bw; h = bh; } else if (fit === 'actual') { w = iw; h = ih; } else {
    const s = fit === 'cover' ? Math.max(bw / img.width, bh / img.height) : Math.min(bw / img.width, bh / img.height);
    w = img.width * s;
    h = img.height * s;
  }
  const x = margin + (bw - w) / 2;
  const y = margin + (bh - h) / 2;
  if (fit === 'cover') {
    // Clip to the content box so the overflowing part of the image is cropped.
    page.pushOperators(pushGraphicsState(), rectangle(margin, margin, bw, bh), clip(), endPath());
    page.drawImage(img, { x, y, width: w, height: h });
    page.pushOperators(popGraphicsState());
  } else {
    page.drawImage(img, { x, y, width: w, height: h });
  }
}

function setInfo(pdf, o) {
  pdf.setProducer('Recast');
  pdf.setCreator('Recast');
  if (opt.str(o.title).trim()) pdf.setTitle(o.title.trim());
  if (opt.str(o.author).trim()) pdf.setAuthor(o.author.trim());
}

async function convert({ input, from, o, outDir, baseName, tmpDir, progress }) {
  const pdf = await PDFDocument.create();
  setInfo(pdf, o);
  await addImagePages(pdf, input, from, o, tmpDir);
  progress(0.8);
  const out = path.join(outDir, `${baseName}.pdf`);
  await fsp.writeFile(out, await pdf.save());
  return [out];
}

/**
 * Merge several PDFs and/or images into a single PDF, in order.
 * items: [{ path, format, name }]
 */
export async function mergeToPdf(items, o, outPath, { tmpDir, progress } = {}) {
  const dst = new mupdf.PDFDocument();
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    let bytes;
    if (it.format === 'pdf') bytes = await fsp.readFile(it.path);
    else if (imageInputs().includes(it.format)) {
      const pdf = await PDFDocument.create();
      await addImagePages(pdf, it.path, it.format, o, tmpDir);
      bytes = await pdf.save();
    } else {
      throw new UserError(`${it.name} cannot be merged — only PDFs and images are supported`);
    }
    const src = mupdf.Document.openDocument(bytes, 'pdf').asPDF();
    if (src.needsPassword()) throw new UserError(`${it.name} is password-protected`);
    const map = dst.newGraftMap ? dst.newGraftMap() : null;
    for (let i = 0; i < src.countPages(); i++) {
      if (map) map.graftPage(-1, src, i);
      else dst.graftPage(-1, src, i);
    }
    progress?.((n + 1) / items.length * 0.9);
  }
  if (opt.str(o.title).trim()) dst.setMetaData('info:Title', o.title.trim());
  if (opt.str(o.author).trim()) dst.setMetaData('info:Author', o.author.trim());
  const buf = dst.saveToBuffer('garbage=compact,compress,compress-fonts');
  await fsp.writeFile(outPath, buf.asUint8Array());
  return outPath;
}

export default {
  id: 'imagepdf',
  label: 'PDF builder',
  detect: () => ({ available: true, version: 'pdf-lib' }),
  routes: () => [{ from: imageInputs().filter((x) => x !== 'svg'), to: ['pdf'], cost: 1 }],
  schema: ({ info }) => pdfPageSchema({ info }),
  convert,
};
