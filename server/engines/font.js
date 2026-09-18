// Fonts via fonteditor-core: TTF/OTF/WOFF/WOFF2/EOT/SVG, with subsetting and renaming.
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Font, woff2 } from 'fonteditor-core';
import { f, group } from '../schema.js';
import { UserError, opt } from '../util.js';

const IN = ['ttf', 'otf', 'woff', 'woff2', 'eot'];
const OUT = ['ttf', 'otf', 'woff', 'woff2', 'eot', 'svg'];
let woff2Ready = null;

const inflate = (data) => Array.from(zlib.inflateSync(Buffer.from(data)));
const deflate = (data) => Array.from(zlib.deflateSync(Buffer.from(data), { level: 9 }));

function schema({ to }) {
  return [group('font', 'Font', [
    f.textarea('subset', 'Keep only these characters', { placeholder: 'e.g. ABCabc0123 — leave empty to keep every glyph', help: 'Subsetting can shrink web fonts dramatically. Kerning is dropped from subsets.' }),
    f.toggle('hinting', 'Keep hinting', true, { help: 'Hinting improves rendering at small sizes on Windows.' }),
    f.toggle('kerning', 'Keep kerning', true),
    f.text('family', 'Rename font family', { placeholder: 'keep original' }),
    to === 'otf' ? { type: 'note', key: 'otfNote', label: 'OTF output uses TrueType outlines (valid OpenType, glyf-based).' } : null,
  ])];
}

const nonEmpty = (b) => (b && (b.length ?? b.byteLength) > 0 ? Buffer.from(b) : null);

async function convert({ input, from, to, o, outDir, baseName }) {
  woff2Ready ??= woff2.init();
  await woff2Ready;
  let buffer = await fsp.readFile(input);
  const subsetText = opt.str(o.subset);
  const subset = subsetText ? [...new Set([...subsetText].map((c) => c.codePointAt(0)))] : undefined;
  const family = opt.str(o.family).trim();
  const hinting = opt.bool(o.hinting, true);
  // A subset keeps the original GPOS/kern tables, which would then point at missing glyphs.
  const kerning = opt.bool(o.kerning, true) && !subset;
  const untouched = !subset && !family && hinting && opt.bool(o.kerning, true);
  const out = path.join(outDir, `${baseName}.${to}`);

  // WOFF2 input: unwrap to the original sfnt tables first.
  let type = from;
  if (from === 'woff2') {
    const raw = nonEmpty(woff2.decode(buffer));
    if (!raw) throw new UserError('This WOFF2 font could not be decoded');
    buffer = raw;
    type = buffer.readUInt32BE(0) === 0x4f54544f ? 'otf' : 'ttf';
  }

  // Unmodified TTF/OTF → WOFF2 is compressed straight from the original bytes (keeps CFF outlines).
  if (to === 'woff2' && untouched && ['ttf', 'otf'].includes(type)) {
    const data = nonEmpty(woff2.encode(buffer));
    if (data) {
      await fsp.writeFile(out, data);
      return [out];
    }
  }

  const load = (opts) => {
    try {
      const font = Font.create(buffer, { type, subset, compound2simple: false, inflate, ...opts });
      if (family) {
        const ttf = font.get();
        const style = ttf.name.fontSubFamily || 'Regular';
        ttf.name.fontFamily = family;
        ttf.name.fullName = `${family} ${style}`.trim();
        ttf.name.postScriptName = `${family.replace(/\s+/g, '')}-${style.replace(/\s+/g, '')}`;
        ttf.name.preferredFamily = family;
        font.set(ttf);
      }
      return font;
    } catch (e) {
      throw new UserError('This font could not be read', e.message);
    }
  };

  let data;
  if (to === 'woff2') {
    // fonteditor's own WOFF2 writer is unreliable; write TTF and compress it, dropping optional
    // tables only if the encoder rejects them.
    for (const opts of [{ hinting, kerning }, { hinting, kerning: false }, { hinting: false, kerning: false }]) {
      const ttf = load(opts).write({ type: 'ttf', toBuffer: true, ...opts });
      data = nonEmpty(woff2.encode(ttf));
      if (data) break;
    }
  } else {
    try {
      const written = load({ hinting, kerning }).write({ type: to === 'otf' ? 'ttf' : to, toBuffer: true, hinting, kerning, deflate });
      data = typeof written === 'string' ? Buffer.from(written, 'utf8') : nonEmpty(written);
    } catch (e) {
      throw new UserError(`Could not write ${to.toUpperCase()}`, e.message);
    }
  }
  if (!data) throw new UserError(`Could not write ${to.toUpperCase()}`);
  await fsp.writeFile(out, data);
  return [out];
}

export default {
  id: 'font',
  label: 'Font engine',
  detect: () => ({ available: true, version: 'fonteditor-core' }),
  routes: () => [{ from: IN, to: OUT, cost: 1, same: true }],
  schema,
  convert,
};
