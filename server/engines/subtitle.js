// Subtitles via FFmpeg: convert between text formats, or extract a track from a video.
import path from 'node:path';
import { f, group } from '../schema.js';
import { tools } from '../tools.js';
import { UserError, opt, clamp } from '../util.js';
import { ffmpeg, probe } from './ff.js';

const SUB_IN = ['srt', 'vtt', 'ass', 'ssa', 'lrc', 'sub', 'smi', 'scc', 'mpl'];
const SUB_OUT = ['srt', 'vtt', 'ass', 'ssa', 'lrc', 'ttml'];
const VIDEO_WITH_SUBS = ['mkv', 'mp4', 'mov', 'm4v', 'webm', 'ts', 'm2ts', 'mts', 'ogv'];
const ENC = { srt: 'srt', vtt: 'webvtt', ass: 'ass', ssa: 'ssa', lrc: 'text', ttml: 'ttml' };
const MUX = { srt: 'srt', vtt: 'webvtt', ass: 'ass', ssa: 'ass', lrc: 'lrc', ttml: 'ttml' };

function schema({ from, info }) {
  const fields = [];
  if (VIDEO_WITH_SUBS.includes(from)) {
    const subs = info?.subtitles || [];
    if (subs.length > 1) fields.push(f.select('subTrack', 'Subtitle track', subs.map((s, i) => ({ value: String(i), label: `Track ${i + 1}${s.lang ? ` · ${s.lang}` : ''} · ${s.codec}${s.bitmap ? ' (image)' : ''}` })), '0'));
  } else {
    fields.push(f.select('charenc', 'Input encoding', [
      { value: '', label: 'Auto (UTF-8)' }, { value: 'CP1252', label: 'Western (Windows-1252)' }, { value: 'ISO-8859-1', label: 'Latin-1 (ISO-8859-1)' },
      { value: 'ISO-8859-2', label: 'Central European (ISO-8859-2)' }, { value: 'CP1251', label: 'Cyrillic (Windows-1251)' }, { value: 'CP1256', label: 'Arabic (Windows-1256)' },
      { value: 'CP1253', label: 'Greek (Windows-1253)' }, { value: 'CP1254', label: 'Turkish (Windows-1254)' }, { value: 'GB18030', label: 'Chinese (GB18030)' },
      { value: 'BIG5', label: 'Chinese Traditional (Big5)' }, { value: 'SHIFT_JIS', label: 'Japanese (Shift JIS)' }, { value: 'EUC-KR', label: 'Korean (EUC-KR)' },
    ], ''));
    if (from === 'sub') fields.push(f.select('subFps', 'Frame rate', ['23.976', '24', '25', '29.97', '30'], '23.976', { help: 'MicroDVD timings are frame-based.' }));
  }
  fields.push(f.number('offset', 'Shift timing', { unit: 's', step: 0.1, min: -36000, max: 36000, placeholder: '0', help: 'Positive values delay the subtitles.' }));
  return [group('subs', 'Subtitles', fields)];
}

async function convert({ input, from, to, o, outDir, baseName, signal, info }) {
  const out = path.join(outDir, `${baseName}.${to}`);
  const args = [];
  const offset = opt.num(o.offset, 0);
  if (offset) args.push('-itsoffset', String(offset));
  if (SUB_IN.includes(from) && o.charenc) args.push('-sub_charenc', o.charenc);
  if (from === 'sub') args.push('-r', String(opt.num(o.subFps, 23.976)));
  args.push('-i', input);
  if (VIDEO_WITH_SUBS.includes(from)) {
    const meta = info?.subtitles ? info : await probe(input);
    const subs = meta?.subtitles || [];
    if (!subs.length) throw new UserError('This video has no subtitle tracks');
    const idx = clamp(opt.num(o.subTrack, 0), 0, subs.length - 1);
    if (subs[idx].bitmap) throw new UserError('This subtitle track is image-based (DVD/Blu-ray) and cannot be converted to text');
    args.push('-map', `0:s:${idx}`);
  } else {
    args.push('-map', '0:s:0');
  }
  args.push('-c:s', ENC[to], '-f', MUX[to], out);
  await ffmpeg(args, { signal });
  return [out];
}

export default {
  id: 'subtitle',
  label: 'Subtitles',
  detect: () => ({ available: !!tools.ffmpeg, version: 'FFmpeg' }),
  routes: () => [
    { from: SUB_IN, to: SUB_OUT, cost: 1, same: true },
    { from: VIDEO_WITH_SUBS, to: SUB_OUT, cost: 2 },
  ],
  probeFormats: () => [],
  schema,
  convert,
};
