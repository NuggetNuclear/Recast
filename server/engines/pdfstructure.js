// Turns laid-out pages (PDF, XPS, EPUB…) into a semantic model — headings, paragraphs,
// list items, images — and renders that model as DOCX, Markdown or clean HTML.
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, PageBreak, AlignmentType } from 'docx';

const BULLET = /^\s*([•◦▪▫‣∙·●○■□\-–*])\s+/;
const NUMBERED = /^\s*(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/;

/**
 * Extract a semantic model from a mupdf document.
 * Returns { blocks: [...], pageSize: {w,h} } where blocks are
 *   { type: 'heading', level, text } | { type: 'p', text, bold, italic, align }
 *   { type: 'li', ordered, text } | { type: 'image', png, width, height } | { type: 'pagebreak' }
 */
export async function extractStructure(doc, pages, { images = true, headings = true, dehyphenate = true, imageDpi = 150, onPage } = {}) {
  const raw = [];
  const sizeHist = new Map();
  let pageSize = null;

  for (let n = 0; n < pages.length; n++) {
    const page = doc.loadPage(pages[n]);
    const bounds = page.getBounds();
    if (!pageSize) pageSize = { w: bounds[2] - bounds[0], h: bounds[3] - bounds[1] };
    const st = page.toStructuredText(`preserve-whitespace${images ? ',preserve-images' : ''}${dehyphenate ? ',dehyphenate' : ''}`);
    const json = JSON.parse(st.asJSON());
    let pagePng = null;
    const pageBlocks = [];
    for (const b of json.blocks || []) {
      if (b.type === 'image') {
        if (!images || b.bbox.w < 8 || b.bbox.h < 8) continue;
        if (!pagePng) {
          const scale = imageDpi / 72;
          const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
          pagePng = { buf: Buffer.from(pix.asPNG()), scale, w: pix.getWidth(), h: pix.getHeight() };
        }
        const s = pagePng.scale;
        const left = Math.max(0, Math.floor((b.bbox.x - bounds[0]) * s));
        const top = Math.max(0, Math.floor((b.bbox.y - bounds[1]) * s));
        const width = Math.min(pagePng.w - left, Math.ceil(b.bbox.w * s));
        const height = Math.min(pagePng.h - top, Math.ceil(b.bbox.h * s));
        if (width < 4 || height < 4) continue;
        const png = await sharp(pagePng.buf).extract({ left, top, width, height }).png({ compressionLevel: 8 }).toBuffer();
        pageBlocks.push({ type: 'image', png, width: b.bbox.w, height: b.bbox.h });
        continue;
      }
      const lines = (b.lines || []).filter((l) => l.text && l.text.trim());
      if (!lines.length) continue;
      for (const l of lines) {
        const sz = Math.round((l.font?.size || 0) * 2) / 2;
        sizeHist.set(sz, (sizeHist.get(sz) || 0) + l.text.length);
      }
      pageBlocks.push({ type: 'text', lines, bbox: b.bbox, pageW: pageSize.w });
    }
    raw.push(pageBlocks);
    onPage?.(n + 1, pages.length);
  }

  const bodySize = [...sizeHist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
  const blocks = [];
  raw.forEach((pageBlocks, pi) => {
    if (pi > 0) blocks.push({ type: 'pagebreak' });
    for (const b of pageBlocks) {
      if (b.type === 'image') { blocks.push(b); continue; }
      // Split a block into list items when lines start with bullets/numbers.
      const groups = [];
      let cur = null;
      for (const l of b.lines) {
        const t = l.text.replace(/\s+$/, '');
        const isItem = BULLET.test(t) || NUMBERED.test(t);
        if (!cur || isItem) {
          cur = { lines: [], item: isItem ? (BULLET.test(t) ? 'ul' : 'ol') : null };
          groups.push(cur);
        }
        cur.lines.push(l);
      }
      for (const g of groups) {
        const text = joinLines(g.lines.map((l) => l.text));
        if (!text) continue;
        const size = avg(g.lines.map((l) => l.font?.size || bodySize));
        const bold = g.lines.every((l) => l.font?.weight === 'bold' || /bold|black|heavy|semibold/i.test(l.font?.name || ''));
        const italic = g.lines.every((l) => l.font?.style === 'italic' || /italic|oblique/i.test(l.font?.name || ''));
        const ratio = size / bodySize;
        if (g.item) {
          blocks.push({ type: 'li', ordered: g.item === 'ol', text: text.replace(g.item === 'ul' ? BULLET : /^$/, '') });
          continue;
        }
        if (headings && text.length < 180 && g.lines.length <= 3 && (ratio >= 1.15 || (bold && ratio >= 1.0 && text.length < 90 && !/[.:;,]$/.test(text)))) {
          const level = ratio >= 1.9 ? 1 : ratio >= 1.45 ? 2 : ratio >= 1.15 ? 3 : 4;
          blocks.push({ type: 'heading', level, text });
          continue;
        }
        const center = b.pageW && Math.abs(b.bbox.x + b.bbox.w / 2 - b.pageW / 2) < 12 && b.bbox.w < b.pageW * 0.6;
        blocks.push({ type: 'p', text, bold, italic, align: center ? 'center' : 'left' });
      }
    }
  });
  return { blocks, pageSize: pageSize || { w: 595, h: 842 } };
}

function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (!l) continue;
    if (!out) out = l;
    else if (/[A-Za-zÀ-ÿ]-$/.test(out)) out = out.slice(0, -1) + l;
    else out += ' ' + l;
  }
  return out;
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdEsc = (s) => String(s).replace(/([\\`*_[\]#])/g, '\\$1').replace(/^(\d+)\. /, '$1\\. ');

export function toMarkdown({ blocks }, { pageBreaks = false } = {}) {
  const out = [];
  let imgN = 0;
  let prevList = null;
  for (const b of blocks) {
    if (b.type !== 'li' && prevList !== null) { out.push(''); prevList = null; }
    switch (b.type) {
      case 'heading': out.push(`${'#'.repeat(b.level)} ${mdEsc(b.text)}`, ''); break;
      case 'p': {
        let t = mdEsc(b.text);
        if (b.bold) t = `**${t}**`;
        else if (b.italic) t = `*${t}*`;
        out.push(t, '');
        break;
      }
      case 'li': out.push(`${b.ordered ? '1.' : '-'} ${mdEsc(b.text.replace(NUMBERED, ''))}`); prevList = b.ordered; break;
      case 'image': out.push(`![Image ${++imgN}](data:image/png;base64,${b.png.toString('base64')})`, ''); break;
      case 'pagebreak': if (pageBreaks) out.push('---', ''); break;
      default: break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function toHtml({ blocks }, { title = 'Document', pageBreaks = false } = {}) {
  const body = [];
  let list = null;
  const closeList = () => { if (list) { body.push(`</${list}>`); list = null; } };
  for (const b of blocks) {
    if (b.type === 'li') {
      const tag = b.ordered ? 'ol' : 'ul';
      if (list !== tag) { closeList(); body.push(`<${tag}>`); list = tag; }
      body.push(`<li>${esc(b.ordered ? b.text.replace(NUMBERED, '') : b.text)}</li>`);
      continue;
    }
    closeList();
    if (b.type === 'heading') body.push(`<h${b.level}>${esc(b.text)}</h${b.level}>`);
    else if (b.type === 'p') {
      let t = esc(b.text);
      if (b.bold) t = `<strong>${t}</strong>`;
      if (b.italic) t = `<em>${t}</em>`;
      body.push(`<p${b.align === 'center' ? ' style="text-align:center"' : ''}>${t}</p>`);
    } else if (b.type === 'image') body.push(`<figure><img src="data:image/png;base64,${b.png.toString('base64')}" width="${Math.round(b.width)}" alt=""></figure>`);
    else if (b.type === 'pagebreak' && pageBreaks) body.push('<hr class="page-break">');
  }
  closeList();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.65 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:760px;margin:48px auto;padding:0 24px}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.2em}
figure{margin:1.5em 0}img{max-width:100%;height:auto}hr.page-break{border:0;border-top:1px dashed #ccc;margin:2.5em 0}
</style></head><body>
${body.join('\n')}
</body></html>
`;
}

export async function toDocx({ blocks, pageSize }, { title = 'Document', font = 'Calibri', fontSize = 11, pageBreaks = true, margins = 20 } = {}) {
  const children = [];
  const headingMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
  const contentWidthPt = pageSize.w - (margins * 72) / 25.4 * 2;
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        children.push(new Paragraph({ heading: headingMap[b.level] || HeadingLevel.HEADING_4, children: [new TextRun({ text: b.text })] }));
        break;
      case 'p':
        children.push(new Paragraph({ alignment: b.align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 120 }, children: [new TextRun({ text: b.text, bold: b.bold, italics: b.italic })] }));
        break;
      case 'li':
        // Ordered items keep their original numbers in the text; unordered ones become real bullets.
        children.push(new Paragraph({ bullet: b.ordered ? undefined : { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: b.text })] }));
        break;
      case 'image': {
        const scale = Math.min(1, contentWidthPt / b.width);
        const px = (pt) => Math.max(1, Math.round((pt * scale * 96) / 72));
        children.push(new Paragraph({ spacing: { after: 120 }, children: [new ImageRun({ type: 'png', data: b.png, transformation: { width: px(b.width), height: px(b.height) } })] }));
        break;
      }
      case 'pagebreak':
        if (pageBreaks) children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      default: break;
    }
  }
  const twip = (pt) => Math.round(pt * 20);
  const marginTw = Math.round((margins / 25.4) * 1440);
  const doc = new Document({
    title,
    creator: 'Recast',
    styles: { default: { document: { run: { font, size: Math.round(fontSize * 2) } } } },
    sections: [{
      properties: { page: { size: { width: twip(pageSize.w), height: twip(pageSize.h) }, margin: { top: marginTw, bottom: marginTw, left: marginTw, right: marginTw } } },
      children: children.length ? children : [new Paragraph('')],
    }],
  });
  return Packer.toBuffer(doc);
}
