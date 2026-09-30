// Raster images: sharp (libvips) for the main formats, FFmpeg/ImageMagick to decode/encode the exotic ones.
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import heicDecode from 'heic-decode';
import { f, group } from '../schema.js';
import { tools } from '../tools.js';
import { run, UserError, opt, hexToRgb, clamp, ensureDir } from '../util.js';
import { ffmpeg, probe as ffprobe } from './ff.js';

sharp.cache(false);

export const SHARP_IN = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'svg', 'heic'];
export const FF_IN = ['bmp', 'ico', 'psd', 'tga', 'dds', 'exr', 'hdr', 'jp2', 'pcx', 'ppm', 'pgm', 'pbm', 'pam', 'pfm', 'qoi', 'sgi', 'xbm', 'xpm', 'xwd', 'dpx', 'ras'];
const MAGICK_IN = ['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'raf', 'pef', 'nrw', 'srw', 'x3f', 'erf', 'kdc', 'mrw', '3fr', 'iiq', 'xcf', 'jxl', 'cur', 'pict', 'wbmp', 'mng', 'fits', 'dcm'];
const SHARP_OUT = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'ico'];
const FF_OUT = ['bmp', 'tga', 'ppm', 'pgm', 'pbm', 'pam', 'pcx', 'qoi', 'sgi', 'jp2', 'xbm', 'xwd', 'dpx', 'exr', 'hdr'];
const MAGICK_OUT = ['jxl'];
const ANIMATED_OUT = ['gif', 'webp'];
const ALPHA_OUT = ['png', 'webp', 'avif', 'gif', 'tiff', 'ico', 'tga', 'pam', 'qoi', 'sgi', 'exr', 'jxl'];

export const imageInputs = () => [...SHARP_IN, ...FF_IN, ...(tools.magick ? MAGICK_IN : [])];

/** Open any supported image as a sharp pipeline. */
export async function loadImage(input, from, { animated = false, page = 0, density, tmpDir, signal } = {}) {
  const common = { limitInputPixels: false, failOn: 'none' };
  if (from === 'heic') {
    const img = await heicDecode({ buffer: await fsp.readFile(input) });
    return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { ...common, raw: { width: img.width, height: img.height, channels: 4 } });
  }
  if (FF_IN.includes(from) || (MAGICK_IN.includes(from) && tools.magick)) {
    await ensureDir(tmpDir);
    const tmp = path.join(tmpDir, `decoded-${Date.now()}.png`);
    if (FF_IN.includes(from)) await ffmpeg(['-i', input, '-frames:v', '1', '-update', '1', tmp], { signal });
    else await run(tools.magick, [`${input}[0]`, '-auto-orient', `png:${tmp}`], { signal, errorMessage: 'ImageMagick could not read this image' });
    return sharp(tmp, common);
  }
  const o = { ...common };
  if (animated) o.animated = true;
  else if (page) o.page = page;
  if (from === 'svg' && density) o.density = clamp(density, 1, 2400);
  return sharp(input, o);
}

async function probe(input, from) {
  try {
    if (from === 'heic') {
      const meta = await sharp(input).metadata().catch(() => null);
      if (meta?.width) return { width: meta.width, height: meta.height };
      return {};
    }
    if (FF_IN.includes(from)) {
      const p = await ffprobe(input);
      return p?.video ? { width: p.video.width, height: p.video.height } : {};
    }
    if (!SHARP_IN.includes(from)) return {};
    const m = await sharp(input, { limitInputPixels: false }).metadata();
    return {
      width: m.width,
      height: m.pageHeight && m.pages > 1 ? m.pageHeight : m.height,
      pages: m.pages || 1,
      hasAlpha: m.hasAlpha,
      density: m.density,
      space: m.space,
      orientation: m.orientation,
    };
  } catch {
    return {};
  }
}

function schema({ from, to, info }) {
  const pages = info?.pages || 1;
  const groups = [];
  const canAnimate = ANIMATED_OUT.includes(to) && ['gif', 'webp'].includes(from);

  groups.push(group('size', 'Size', [
    f.number('width', 'Width', { unit: 'px', placeholder: info?.width ? String(info.width) : 'auto', min: 1, max: 32000 }),
    f.number('height', 'Height', { unit: 'px', placeholder: info?.height ? String(info.height) : 'auto', min: 1, max: 32000 }),
    f.number('scale', 'Scale', { unit: '%', placeholder: '100', min: 1, max: 1000, help: 'Overrides width and height when set.' }),
    f.select('fit', 'Fit', [
      { value: 'inside', label: 'Fit inside (keep ratio)' },
      { value: 'cover', label: 'Fill and crop' },
      { value: 'contain', label: 'Fit and pad' },
      { value: 'fill', label: 'Stretch' },
    ], 'inside', { help: 'How the image is fitted when both width and height are set.' }),
    f.select('position', 'Crop anchor', ['center', 'top', 'bottom', 'left', 'right', 'entropy', 'attention'].map((v) => ({ value: v, label: v === 'entropy' ? 'Smart (detail)' : v === 'attention' ? 'Smart (subject)' : v[0].toUpperCase() + v.slice(1) })), 'center', { showIf: { fit: ['cover'] } }),
    f.color('padColor', 'Padding color', '#ffffff', { showIf: { fit: ['contain'] }, allowTransparent: true }),
    f.toggle('enlarge', 'Allow upscaling', false),
    f.select('kernel', 'Resampling', [
      { value: 'lanczos3', label: 'Lanczos 3 (sharp)' },
      { value: 'mitchell', label: 'Mitchell (smooth)' },
      { value: 'cubic', label: 'Bicubic' },
      { value: 'linear', label: 'Bilinear' },
      { value: 'nearest', label: 'Nearest (pixel art)' },
    ], 'lanczos3'),
  ]));

  groups.push(group('transform', 'Transform', [
    f.toggle('autoOrient', 'Auto-orient from EXIF', true),
    f.select('rotate', 'Rotate', [
      { value: '0', label: 'None' }, { value: '90', label: '90° clockwise' }, { value: '180', label: '180°' }, { value: '270', label: '90° counter-clockwise' }, { value: 'custom', label: 'Custom angle' },
    ], '0'),
    f.number('angle', 'Angle', { unit: '°', min: -360, max: 360, placeholder: '0', showIf: { rotate: ['custom'] } }),
    f.toggle('flipH', 'Mirror horizontally'),
    f.toggle('flipV', 'Flip vertically'),
    f.toggle('trim', 'Auto-crop borders', false, { help: 'Removes uniform edges.' }),
    f.number('cropX', 'Crop left', { unit: 'px', min: 0, placeholder: '0' }),
    f.number('cropY', 'Crop top', { unit: 'px', min: 0, placeholder: '0' }),
    f.number('cropW', 'Crop width', { unit: 'px', min: 1, placeholder: 'full' }),
    f.number('cropH', 'Crop height', { unit: 'px', min: 1, placeholder: 'full' }),
  ], { collapsed: true }));

  groups.push(group('adjust', 'Adjustments', [
    f.range('brightness', 'Brightness', 0, 200, 1, 100, { unit: '%' }),
    f.range('saturation', 'Saturation', 0, 200, 1, 100, { unit: '%' }),
    f.range('hue', 'Hue shift', -180, 180, 1, 0, { unit: '°' }),
    f.range('sharpen', 'Sharpen', 0, 10, 0.1, 0),
    f.range('blur', 'Blur', 0, 50, 0.5, 0),
    f.range('denoise', 'Denoise (median)', 0, 9, 1, 0),
    f.toggle('grayscale', 'Grayscale'),
    f.toggle('normalize', 'Auto levels'),
    f.toggle('negate', 'Invert colors'),
    f.range('threshold', 'Black & white threshold', 0, 255, 1, 0, { help: '0 = off' }),
    f.color('tint', 'Tint', '', { allowEmpty: true }),
  ], { collapsed: true }));

  const out = [];
  if (to === 'jpg') {
    out.push(
      f.range('quality', 'Quality', 1, 100, 1, 85),
      f.toggle('progressive', 'Progressive'),
      f.toggle('mozjpeg', 'MozJPEG optimisation', true, { help: 'Smaller files, slightly slower.' }),
      f.select('chroma', 'Chroma subsampling', [{ value: '4:2:0', label: '4:2:0 (smaller)' }, { value: '4:4:4', label: '4:4:4 (sharper colors)' }], '4:2:0'),
      f.color('background', 'Background for transparency', '#ffffff'),
      f.select('colorspace', 'Color space', [{ value: 'srgb', label: 'sRGB' }, { value: 'cmyk', label: 'CMYK (print)' }], 'srgb'),
    );
  } else if (to === 'png') {
    out.push(
      f.range('compression', 'Compression level', 0, 9, 1, 9),
      f.toggle('palette', 'Quantize to palette', false, { help: 'Lossy, much smaller files (like TinyPNG).' }),
      f.range('colors', 'Colors', 2, 256, 1, 256, { showIf: { palette: [true] } }),
      f.range('quality', 'Quantize quality', 1, 100, 1, 100, { showIf: { palette: [true] } }),
      f.range('dither', 'Dithering', 0, 1, 0.05, 1, { showIf: { palette: [true] } }),
      f.toggle('interlace', 'Interlaced (Adam7)'),
    );
  } else if (to === 'webp') {
    out.push(
      f.range('quality', 'Quality', 1, 100, 1, 80),
      f.toggle('lossless', 'Lossless'),
      f.toggle('nearLossless', 'Near-lossless', false, { showIf: { lossless: [true] } }),
      f.range('alphaQuality', 'Alpha quality', 0, 100, 1, 100),
      f.range('effort', 'Effort', 0, 6, 1, 4, { help: 'Higher is slower and smaller.' }),
      f.select('preset', 'Preset', ['default', 'photo', 'picture', 'drawing', 'icon', 'text'], 'default'),
      f.toggle('smartSubsample', 'Smart subsampling'),
    );
  } else if (to === 'avif') {
    out.push(
      f.range('quality', 'Quality', 1, 100, 1, 55),
      f.toggle('lossless', 'Lossless'),
      f.range('effort', 'Effort', 0, 9, 1, 4, { help: 'Higher is much slower and smaller.' }),
      f.select('chroma', 'Chroma subsampling', [{ value: '4:2:0', label: '4:2:0 (smaller)' }, { value: '4:4:4', label: '4:4:4 (sharper colors)' }], '4:2:0'),
    );
  } else if (to === 'gif') {
    out.push(
      f.range('colors', 'Colors', 2, 256, 1, 256),
      f.range('dither', 'Dithering', 0, 1, 0.05, 1),
      f.range('effort', 'Effort', 1, 10, 1, 7),
    );
  } else if (to === 'tiff') {
    out.push(
      f.select('tiffCompression', 'Compression', [
        { value: 'lzw', label: 'LZW (lossless)' }, { value: 'deflate', label: 'Deflate (lossless)' }, { value: 'packbits', label: 'PackBits (lossless)' },
        { value: 'jpeg', label: 'JPEG (lossy)' }, { value: 'webp', label: 'WebP (lossy)' }, { value: 'none', label: 'None' },
      ], 'lzw'),
      f.range('quality', 'Quality', 1, 100, 1, 90, { showIf: { tiffCompression: ['jpeg', 'webp'] } }),
      f.select('predictor', 'Predictor', ['horizontal', 'none', 'float'], 'horizontal', { showIf: { tiffCompression: ['lzw', 'deflate'] } }),
      f.select('bitdepth', 'Bit depth', [{ value: '8', label: '8-bit' }, { value: '4', label: '4-bit' }, { value: '2', label: '2-bit' }, { value: '1', label: '1-bit' }], '8'),
      f.toggle('pyramid', 'Pyramidal (tiled)'),
      f.select('colorspace', 'Color space', [{ value: 'srgb', label: 'sRGB' }, { value: 'cmyk', label: 'CMYK (print)' }], 'srgb'),
    );
  } else if (to === 'ico') {
    out.push(f.multi('icoSizes', 'Icon sizes', ['16', '24', '32', '48', '64', '128', '256'], ['16', '32', '48', '256'], { unit: 'px' }));
  } else if (to === 'bmp') {
    out.push(f.select('bmpDepth', 'Bit depth', [{ value: '24', label: '24-bit' }, { value: '32', label: '32-bit (alpha)' }, { value: '8', label: '8-bit palette' }, { value: 'gray', label: '8-bit grayscale' }, { value: '1', label: '1-bit monochrome' }], '24'));
  } else if (to === 'tga') {
    out.push(f.toggle('rle', 'RLE compression', true));
  } else if (to === 'jp2') {
    out.push(f.range('jp2Quality', 'Quality', 1, 100, 1, 85), f.toggle('lossless', 'Lossless'));
  } else if (to === 'jxl') {
    out.push(f.range('quality', 'Quality', 1, 100, 1, 90), f.toggle('lossless', 'Lossless'));
  }

  if (canAnimate) {
    out.unshift(f.toggle('animated', 'Keep animation', pages > 1));
    out.push(
      f.number('delay', 'Frame delay', { unit: 'ms', placeholder: 'original', min: 10, showIf: { animated: [true] } }),
      f.select('loop', 'Loop', [{ value: '0', label: 'Forever' }, { value: '1', label: 'Once' }, { value: '2', label: 'Twice' }, { value: '3', label: '3 times' }], '0', { showIf: { animated: [true] } }),
    );
  }
  if (pages > 1 && !ANIMATED_OUT.includes(to)) {
    out.push(f.number('page', 'Frame / page', { min: 1, max: pages, placeholder: '1', help: `The input has ${pages} frames.` }));
  }
  if (from === 'svg') {
    out.push(f.number('svgDensity', 'Render DPI', { min: 10, max: 2400, placeholder: '96', help: 'Resolution used to rasterize the vector image.' }));
  }
  if (out.length) groups.unshift(group('output', `${to.toUpperCase()} output`, out));

  groups.push(group('meta', 'Metadata', [
    f.toggle('keepMetadata', 'Keep metadata (EXIF, ICC, XMP)', false),
    ['jpg', 'png', 'tiff', 'webp'].includes(to) ? f.number('dpi', 'DPI', { min: 1, max: 4800, placeholder: 'keep' }) : null,
  ], { collapsed: true }));

  return groups;
}

async function applyPipeline(img, o, meta, to) {
  const w = opt.num(o.width);
  const h = opt.num(o.height);
  const scale = opt.num(o.scale);

  if (opt.bool(o.autoOrient, true)) img = typeof img.autoOrient === 'function' ? img.autoOrient() : img.rotate();

  const cw = opt.num(o.cropW);
  const ch = opt.num(o.cropH);
  const cx = opt.num(o.cropX, 0);
  const cy = opt.num(o.cropY, 0);
  if (cw || ch || cx || cy) {
    const swapped = opt.bool(o.autoOrient, true) && meta.orientation >= 5;
    const W = (swapped ? meta.height : meta.width) || 0;
    const H = (swapped ? meta.width : meta.height) || 0;
    const width = Math.max(1, Math.min(cw || W - cx, W - cx));
    const height = Math.max(1, Math.min(ch || H - cy, H - cy));
    if (cx >= W || cy >= H) throw new UserError('The crop area lies outside the image');
    img = img.extract({ left: Math.round(cx), top: Math.round(cy), width: Math.round(width), height: Math.round(height) });
  }
  if (opt.bool(o.trim)) img = img.trim({ threshold: 10 });

  const rot = o.rotate === 'custom' ? opt.num(o.angle, 0) : opt.num(o.rotate, 0);
  if (rot) {
    const bg = ALPHA_OUT.includes(to) ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 255, g: 255, b: 255, alpha: 1 };
    img = img.rotate(rot, { background: bg });
  }
  if (opt.bool(o.flipV)) img = img.flip();
  if (opt.bool(o.flipH)) img = img.flop();

  if (scale || w || h) {
    // Materialise geometry changes so the resize sees the final orientation and size.
    const geometryChanged = rot || opt.bool(o.flipV) || opt.bool(o.flipH) || cw || ch || cx || cy || opt.bool(o.trim);
    if ((meta.pages || 1) <= 1 && geometryChanged) {
      const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
      img = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: false });
      meta = { ...meta, width: info.width, height: info.height, orientation: 1 };
    }
    let rw = w;
    let rh = h;
    if (scale) {
      const baseW = opt.bool(o.autoOrient, true) && meta.orientation >= 5 ? meta.height : meta.width;
      rw = Math.max(1, Math.round((baseW || 1) * scale / 100));
      rh = null;
    }
    const fit = rw && rh ? o.fit || 'inside' : 'inside';
    const position = o.position === 'entropy' ? sharp.strategy.entropy : o.position === 'attention' ? sharp.strategy.attention : o.position || 'center';
    const pad = o.padColor === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : hexToRgb(o.padColor) || { r: 255, g: 255, b: 255, alpha: 1 };
    img = img.resize({
      width: rw || null,
      height: rh || null,
      fit,
      position,
      background: pad,
      kernel: o.kernel || 'lanczos3',
      withoutEnlargement: !opt.bool(o.enlarge) && !scale,
    });
  }

  const brightness = opt.num(o.brightness, 100);
  const saturation = opt.num(o.saturation, 100);
  const hue = opt.num(o.hue, 0);
  if (brightness !== 100 || saturation !== 100 || hue) img = img.modulate({ brightness: brightness / 100, saturation: saturation / 100, hue: Math.round(hue) });
  const sh = opt.num(o.sharpen, 0);
  if (sh > 0) img = img.sharpen({ sigma: clamp(sh, 0.3, 10) });
  const bl = opt.num(o.blur, 0);
  if (bl > 0) img = img.blur(clamp(bl, 0.3, 1000));
  const med = opt.num(o.denoise, 0);
  if (med > 0) img = img.median(Math.round(clamp(med, 1, 9)) | 1);
  if (opt.bool(o.grayscale)) img = img.grayscale();
  if (opt.bool(o.normalize)) img = img.normalise();
  if (opt.bool(o.negate)) img = img.negate({ alpha: false });
  const th = opt.num(o.threshold, 0);
  if (th > 0) img = img.threshold(th);
  const tint = hexToRgb(o.tint);
  if (tint) img = img.tint({ r: tint.r, g: tint.g, b: tint.b });

  if (opt.bool(o.keepMetadata)) img = img.keepMetadata();
  const dpi = opt.num(o.dpi);
  if (dpi) img = img.withMetadata({ density: dpi });
  return img;
}

function encode(img, to, o, meta) {
  const q = (d) => Math.round(clamp(opt.num(o.quality, d), 1, 100));
  const animated = !!meta.animatedOut;
  const anim = {};
  if (animated) {
    const delay = opt.num(o.delay);
    if (delay) anim.delay = Array(meta.pages).fill(Math.round(delay));
    anim.loop = opt.num(o.loop, 0);
  }
  switch (to) {
    case 'jpg': {
      const bg = hexToRgb(o.background) || { r: 255, g: 255, b: 255 };
      img = img.flatten({ background: bg });
      if (o.colorspace === 'cmyk') img = img.toColourspace('cmyk');
      return img.jpeg({ quality: q(85), progressive: opt.bool(o.progressive), mozjpeg: opt.bool(o.mozjpeg, true), chromaSubsampling: o.chroma === '4:4:4' ? '4:4:4' : '4:2:0' });
    }
    case 'png': {
      const palette = opt.bool(o.palette);
      return img.png({
        compressionLevel: Math.round(clamp(opt.num(o.compression, 9), 0, 9)),
        progressive: opt.bool(o.interlace),
        palette,
        ...(palette ? { colours: Math.round(clamp(opt.num(o.colors, 256), 2, 256)), quality: q(100), dither: clamp(opt.num(o.dither, 1), 0, 1) } : {}),
        adaptiveFiltering: true,
      });
    }
    case 'webp':
      return img.webp({
        quality: q(80),
        alphaQuality: Math.round(clamp(opt.num(o.alphaQuality, 100), 0, 100)),
        lossless: opt.bool(o.lossless),
        nearLossless: opt.bool(o.lossless) && opt.bool(o.nearLossless),
        effort: Math.round(clamp(opt.num(o.effort, 4), 0, 6)),
        preset: o.preset || 'default',
        smartSubsample: opt.bool(o.smartSubsample),
        ...anim,
      });
    case 'avif':
      return img.avif({ quality: q(55), lossless: opt.bool(o.lossless), effort: Math.round(clamp(opt.num(o.effort, 4), 0, 9)), chromaSubsampling: o.chroma === '4:4:4' ? '4:4:4' : '4:2:0' });
    case 'gif':
      return img.gif({ colours: Math.round(clamp(opt.num(o.colors, 256), 2, 256)), dither: clamp(opt.num(o.dither, 1), 0, 1), effort: Math.round(clamp(opt.num(o.effort, 7), 1, 10)), ...anim });
    case 'tiff': {
      if (o.colorspace === 'cmyk') img = img.toColourspace('cmyk');
      const comp = o.tiffCompression || 'lzw';
      const dpi = opt.num(o.dpi);
      return img.tiff({
        compression: comp,
        quality: q(90),
        predictor: ['lzw', 'deflate'].includes(comp) ? o.predictor || 'horizontal' : undefined,
        bitdepth: Number(o.bitdepth || 8),
        pyramid: opt.bool(o.pyramid),
        tile: opt.bool(o.pyramid),
        ...(dpi ? { xres: dpi / 25.4, yres: dpi / 25.4, resolutionUnit: 'inch' } : {}),
      });
    }
    default:
      return img.png({ compressionLevel: 3 });
  }
}

async function writeIco(img, outPath, o) {
  const sizes = (Array.isArray(o.icoSizes) && o.icoSizes.length ? o.icoSizes : ['16', '32', '48', '256']).map(Number).filter((n) => n >= 1 && n <= 256).sort((a, b) => a - b);
  const base = await img.png().toBuffer();
  const images = [];
  for (const s of sizes) {
    images.push(await sharp(base).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: s <= 32 ? 'mitchell' : 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer());
  }
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((buf, i) => {
    const s = sizes[i];
    const e = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  await fsp.writeFile(outPath, Buffer.concat([header, ...images]));
}

async function convert({ input, from, to, o, outDir, baseName, tmpDir, signal, progress }) {
  const meta0 = (await probe(input, from)) || {};
  const pages = meta0.pages || 1;
  const animatedOut = ANIMATED_OUT.includes(to) && pages > 1 && opt.bool(o.animated, true);
  const page = !animatedOut && pages > 1 ? clamp(opt.num(o.page, 1), 1, pages) - 1 : 0;
  let img = await loadImage(input, from, { animated: animatedOut, page, density: opt.num(o.svgDensity), tmpDir, signal });
  progress(0.2);
  const meta = { ...meta0, pages: animatedOut ? pages : 1, animatedOut };
  if (!meta.width) {
    const m = await img.metadata();
    meta.width = m.width;
    meta.height = m.height;
  }
  img = await applyPipeline(img, o, meta, to);
  progress(0.5);

  const outPath = path.join(outDir, `${baseName}.${to}`);
  if (to === 'ico') {
    await writeIco(img, outPath, o);
    return [outPath];
  }
  if (SHARP_OUT.includes(to)) {
    await encode(img, to, o, meta).toFile(outPath);
    return [outPath];
  }

  // Exotic outputs: render a PNG with sharp, then transcode.
  await ensureDir(tmpDir);
  const tmp = path.join(tmpDir, `${baseName}-intermediate.png`);
  if (to === 'bmp' && o.bmpDepth === '8') img = img.png({ palette: true, colours: 256 });
  else if (to === 'bmp' && o.bmpDepth === '1') img = img.flatten({ background: '#ffffff' }).threshold(128).png();
  else if (!ALPHA_OUT.includes(to)) img = img.flatten({ background: '#ffffff' }).png({ compressionLevel: 1 });
  else img = img.png({ compressionLevel: 1 });
  await img.toFile(tmp);
  progress(0.75);

  if (MAGICK_OUT.includes(to)) {
    if (!tools.magick) throw new UserError('ImageMagick is required for this format');
    const args = [tmp];
    if (opt.bool(o.lossless)) args.push('-define', 'jxl:effort=7', '-quality', '100');
    else args.push('-quality', String(opt.num(o.quality, 90)));
    await run(tools.magick, [...args, outPath], { signal, errorMessage: 'ImageMagick could not write this image' });
    return [outPath];
  }

  const args = ['-i', tmp, '-frames:v', '1', '-update', '1'];
  switch (to) {
    case 'bmp': args.push('-pix_fmt', { 32: 'bgra', 8: 'pal8', gray: 'gray', 1: 'monob' }[o.bmpDepth] || 'bgr24'); break;
    case 'tga': args.push('-rle', opt.bool(o.rle, true) ? '1' : '0'); break;
    case 'pbm': args.push('-pix_fmt', 'monob'); break;
    case 'pgm': args.push('-pix_fmt', 'gray'); break;
    case 'ppm': args.push('-pix_fmt', 'rgb24'); break;
    case 'pcx': args.push('-pix_fmt', 'rgb24'); break;
    case 'xbm': args.push('-pix_fmt', 'monow'); break;
    case 'jp2':
      args.push('-c:v', 'libopenjpeg');
      if (opt.bool(o.lossless)) args.push('-compression_level', '0');
      else args.push('-q:v', String(Math.round(1 + (100 - clamp(opt.num(o.jp2Quality, 85), 1, 100)) * 0.3)));
      break;
    case 'exr': args.push('-c:v', 'exr', '-compression', 'zip1'); break;
    default: break;
  }
  args.push(outPath);
  await ffmpeg(args, { signal });
  return [outPath];
}

export default {
  id: 'image',
  label: 'Image engine',
  detect: () => ({ available: true, version: `libvips ${sharp.versions.vips}`, detail: tools.magick ? 'with ImageMagick for RAW/XCF/JXL' : 'sharp + FFmpeg' }),
  routes() {
    const inputs = imageInputs();
    const outputs = [...SHARP_OUT, ...FF_OUT, ...(tools.magick ? MAGICK_OUT : [])];
    return [{ from: inputs, to: outputs, cost: 1, same: true }];
  },
  probe,
  probeFormats: () => imageInputs(),
  schema,
  convert,
};
