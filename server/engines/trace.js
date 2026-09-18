// Raster → SVG vectorisation with Potrace (single colour or posterised tones).
import fsp from 'node:fs/promises';
import path from 'node:path';
import potrace from 'potrace';
import { f, group } from '../schema.js';
import { opt, clamp, UserError } from '../util.js';
import { loadImage, imageInputs } from './image.js';

function schema() {
  return [group('trace', 'Vectorise', [
    f.select('mode', 'Mode', [{ value: 'trace', label: 'Single colour (logo, line art)' }, { value: 'posterize', label: 'Tones (posterised shades)' }], 'trace'),
    f.range('threshold', 'Threshold', 0, 255, 1, 128, { help: 'Brightness cut-off between ink and paper. 128 is neutral.' }),
    f.toggle('autoThreshold', 'Automatic threshold', true),
    f.range('steps', 'Number of tones', 2, 8, 1, 4, { showIf: { mode: ['posterize'] } }),
    f.toggle('invert', 'Trace light areas instead of dark'),
    f.range('turdSize', 'Ignore specks smaller than', 0, 100, 1, 2, { unit: 'px' }),
    f.range('alphaMax', 'Corner smoothness', 0, 1.34, 0.01, 1, { help: '0 gives sharp corners, 1.33 very round.' }),
    f.toggle('optCurve', 'Optimise curves', true),
    f.range('optTolerance', 'Curve tolerance', 0, 1, 0.05, 0.2, { showIf: { optCurve: [true] } }),
    f.color('color', 'Fill colour', '#000000'),
    f.color('background', 'Background', '', { allowEmpty: true, help: 'Empty = transparent.' }),
    f.select('upscale', 'Pre-scale', [{ value: '1', label: 'None' }, { value: '2', label: '2× (smoother)' }, { value: '4', label: '4× (smoothest, slow)' }], '1'),
  ])];
}

async function convert({ input, from, o, outDir, baseName, tmpDir, signal }) {
  let img = await loadImage(input, from, { tmpDir, signal });
  img = (typeof img.autoOrient === 'function' ? img.autoOrient() : img.rotate()).flatten({ background: '#ffffff' });
  const meta = await img.metadata();
  const up = clamp(opt.num(o.upscale, 1), 1, 4);
  if (up > 1 && meta.width) img = img.resize({ width: Math.round(meta.width * up), kernel: 'lanczos3' });
  const png = await img.png().toBuffer();
  const params = {
    turdSize: clamp(opt.num(o.turdSize, 2), 0, 1000),
    alphaMax: clamp(opt.num(o.alphaMax, 1), 0, 1.34),
    optCurve: opt.bool(o.optCurve, true),
    optTolerance: clamp(opt.num(o.optTolerance, 0.2), 0, 1),
    threshold: opt.bool(o.autoThreshold, true) ? potrace.Potrace.THRESHOLD_AUTO : clamp(opt.num(o.threshold, 128), 0, 255),
    blackOnWhite: !opt.bool(o.invert),
    color: o.color || '#000000',
    background: o.background || potrace.Potrace.COLOR_TRANSPARENT,
  };
  const svg = await new Promise((resolve, reject) => {
    const cb = (err, out) => (err ? reject(err) : resolve(out));
    if (o.mode === 'posterize') potrace.posterize(png, { ...params, steps: clamp(opt.num(o.steps, 4), 2, 8), fillStrategy: potrace.Posterizer.FILL_DOMINANT }, cb);
    else potrace.trace(png, params, cb);
  }).catch((e) => { throw new UserError('Tracing failed', e.message); });
  let out = svg;
  if (up > 1) {
    // Keep the physical size of the original image.
    out = out.replace(/<svg([^>]*)width="(\d+(?:\.\d+)?)"\s+height="(\d+(?:\.\d+)?)"/, (m, pre, w, h) => `<svg${pre}width="${Math.round(w / up)}" height="${Math.round(h / up)}" viewBox="0 0 ${w} ${h}"`);
  }
  const p = path.join(outDir, `${baseName}.svg`);
  await fsp.writeFile(p, out, 'utf8');
  return [p];
}

export default {
  id: 'trace',
  label: 'Potrace',
  detect: () => ({ available: true, version: 'Potrace (JS)' }),
  routes: () => [{ from: imageInputs().filter((x) => x !== 'svg'), to: ['svg'], cost: 1.5 }],
  schema,
  convert,
};
