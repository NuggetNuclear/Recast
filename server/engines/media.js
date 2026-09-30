// Audio & video via FFmpeg: transcoding, extraction, animated images, frame grabs, visualisers.
import path from 'node:path';
import { f, group } from '../schema.js';
import { tools, versionOf } from '../tools.js';
import fsp from 'node:fs/promises';
import { run, UserError, opt, parseTime, clamp, hexToRgb, ensureDir } from '../util.js';
import { ffmpeg, probe, filterPath, fmtDuration } from './ff.js';

export const VIDEO_IN = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpeg', 'm4v', '3gp', '3g2', 'ogv', 'ts', 'mts', 'm2ts', 'vob', 'asf', 'f4v', 'mxf', 'rm', 'rmvb', 'divx', 'y4m', 'dv', 'nut', 'ivf', 'h264', 'hevc', 'wtv'];
export const AUDIO_IN = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'ogg', 'opus', 'wma', 'aiff', 'ac3', 'eac3', 'dts', 'amr', 'mka', 'weba', 'caf', 'au', 'mp2', 'wv', 'ape', 'tta', 'spx', 'mpc', 'voc', 'w64', 'ra', 'gsm', 'mod', 'xm', 'it', 's3m'];
const VIDEO_OUT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpeg', 'm4v', '3gp', 'ogv', 'ts'];
const ANIM_OUT = ['gif', 'apng', 'webp'];
const FRAME_OUT = ['jpg', 'png'];
const AUDIO_OUT = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'ogg', 'opus', 'wma', 'aiff', 'ac3', 'amr', 'caf', 'au', 'mp2', 'wv', 'weba', 'mka'];
const STILL_IN = ['jpg', 'png', 'bmp', 'tiff'];
const VIS_OUT = ['mp4', 'webm', 'mkv', 'mov'];

const VCODECS = {
  h264: { lib: 'libx264', label: 'H.264 / AVC' },
  h265: { lib: 'libx265', label: 'H.265 / HEVC' },
  av1: { lib: 'libaom-av1', label: 'AV1 (slow)' },
  vp9: { lib: 'libvpx-vp9', label: 'VP9' },
  vp8: { lib: 'libvpx', label: 'VP8' },
  mpeg4: { lib: 'mpeg4', label: 'MPEG-4 Part 2 (Xvid)' },
  mpeg2: { lib: 'mpeg2video', label: 'MPEG-2' },
  mpeg1: { lib: 'mpeg1video', label: 'MPEG-1' },
  wmv2: { lib: 'wmv2', label: 'Windows Media Video 8' },
  flv1: { lib: 'flv', label: 'Sorenson Spark' },
  theora: { lib: 'libtheora', label: 'Theora' },
  prores: { lib: 'prores_ks', label: 'Apple ProRes' },
  mjpeg: { lib: 'mjpeg', label: 'Motion JPEG' },
  ffv1: { lib: 'ffv1', label: 'FFV1 (lossless)' },
  copy: { lib: 'copy', label: 'Copy stream (no re-encode)' },
};
const CONTAINER_V = {
  mp4: ['h264', 'h265', 'av1', 'mpeg4', 'copy'],
  m4v: ['h264', 'h265', 'copy'],
  mov: ['h264', 'h265', 'prores', 'mjpeg', 'mpeg4', 'copy'],
  mkv: ['h264', 'h265', 'av1', 'vp9', 'vp8', 'mpeg4', 'ffv1', 'copy'],
  webm: ['vp9', 'vp8', 'av1', 'copy'],
  avi: ['mpeg4', 'h264', 'mjpeg', 'copy'],
  wmv: ['wmv2'],
  flv: ['h264', 'flv1'],
  mpeg: ['mpeg2', 'mpeg1'],
  '3gp': ['h264'],
  ogv: ['theora'],
  ts: ['h264', 'h265', 'mpeg2', 'copy'],
};
const DEFAULT_V = { mp4: 'h264', m4v: 'h264', mov: 'h264', mkv: 'h264', webm: 'vp9', avi: 'mpeg4', wmv: 'wmv2', flv: 'h264', mpeg: 'mpeg2', '3gp': 'h264', ogv: 'theora', ts: 'h264' };

const ACODECS = {
  aac: { lib: 'aac', label: 'AAC' },
  mp3: { lib: 'libmp3lame', label: 'MP3' },
  opus: { lib: 'libopus', label: 'Opus' },
  vorbis: { lib: 'libvorbis', label: 'Vorbis' },
  ac3: { lib: 'ac3', label: 'Dolby Digital (AC-3)' },
  eac3: { lib: 'eac3', label: 'Dolby Digital Plus' },
  flac: { lib: 'flac', label: 'FLAC (lossless)' },
  alac: { lib: 'alac', label: 'Apple Lossless' },
  pcm: { lib: 'pcm_s16le', label: 'PCM (uncompressed)' },
  mp2: { lib: 'mp2', label: 'MPEG Layer II' },
  wmav2: { lib: 'wmav2', label: 'WMA' },
  amr: { lib: 'libopencore_amrnb', label: 'AMR-NB' },
  copy: { lib: 'copy', label: 'Copy stream (no re-encode)' },
  none: { lib: null, label: 'Remove audio' },
};
const CONTAINER_A = {
  mp4: ['aac', 'mp3', 'opus', 'ac3', 'eac3', 'alac', 'copy', 'none'],
  m4v: ['aac', 'ac3', 'copy', 'none'],
  mov: ['aac', 'alac', 'pcm', 'mp3', 'ac3', 'copy', 'none'],
  mkv: ['aac', 'opus', 'vorbis', 'mp3', 'flac', 'ac3', 'eac3', 'pcm', 'copy', 'none'],
  webm: ['opus', 'vorbis', 'copy', 'none'],
  avi: ['mp3', 'ac3', 'pcm', 'mp2', 'copy', 'none'],
  wmv: ['wmav2', 'none'],
  flv: ['aac', 'mp3', 'none'],
  mpeg: ['mp2', 'ac3', 'mp3', 'none'],
  '3gp': ['aac', 'amr', 'none'],
  ogv: ['vorbis', 'opus', 'none'],
  ts: ['aac', 'mp3', 'ac3', 'mp2', 'copy', 'none'],
};
const DEFAULT_A = { mp4: 'aac', m4v: 'aac', mov: 'aac', mkv: 'aac', webm: 'opus', avi: 'mp3', wmv: 'wmav2', flv: 'aac', mpeg: 'mp2', '3gp': 'aac', ogv: 'vorbis', ts: 'aac' };

// Hardware encoders are probed once with a one-frame test encode.
let hwCache = null;
async function detectHw() {
  if (hwCache) return hwCache;
  const tests = { nvenc: 'h264_nvenc', amf: 'h264_amf', qsv: 'h264_qsv' };
  const found = [];
  await Promise.all(Object.entries(tests).map(async ([id, enc]) => {
    try {
      await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'], { timeoutMs: 15000 });
      found.push(id);
    } catch {}
  }));
  hwCache = found;
  return found;
}

const modeOf = (from, to) => {
  const fromAudio = AUDIO_IN.includes(from);
  if (AUDIO_OUT.includes(to)) return 'audio';
  if (fromAudio && VIS_OUT.includes(to)) return 'visualize';
  if (STILL_IN.includes(from) && VIDEO_OUT.includes(to)) return 'still';
  if (ANIM_OUT.includes(to)) return 'anim';
  if (FRAME_OUT.includes(to)) return 'frames';
  return 'video';
};

const bitrateOptions = (list) => list.map((k) => ({ value: String(k), label: `${k} kbps` }));
const SAMPLE_RATES = [{ value: '', label: 'Keep original' }, ...[8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000].map((r) => ({ value: String(r), label: `${(r / 1000).toFixed(r % 1000 ? 3 : 0).replace(/\.?0+$/, '')} kHz` }))];
const CHANNELS = [{ value: '', label: 'Keep original' }, { value: '1', label: 'Mono' }, { value: '2', label: 'Stereo' }, { value: '6', label: '5.1 surround' }];
const FPS = [{ value: '', label: 'Keep original' }, ...['60', '50', '30', '29.97', '25', '24', '23.976', '15', '12', '10'].map((v) => ({ value: v, label: `${v} fps` })), { value: 'custom', label: 'Custom…' }];
const RESOLUTIONS = [
  { value: '', label: 'Keep original' },
  { value: '2160', label: '2160p · 4K' }, { value: '1440', label: '1440p · QHD' }, { value: '1080', label: '1080p · Full HD' },
  { value: '720', label: '720p · HD' }, { value: '480', label: '480p · SD' }, { value: '360', label: '360p' }, { value: '240', label: '240p' },
  { value: 'custom', label: 'Custom…' },
];

function trimGroup(info, { speed = true, fades = true } = {}) {
  return group('trim', 'Trim & timing', [
    f.time('trimStart', 'Start at', { placeholder: '0:00', help: info?.duration ? `Duration ${fmtDuration(info.duration)}` : undefined }),
    f.time('trimEnd', 'End at', { placeholder: info?.duration ? fmtDuration(info.duration) : 'end' }),
    speed ? f.range('speed', 'Speed', 0.25, 4, 0.05, 1, { unit: '×' }) : null,
    fades ? f.number('fadeIn', 'Fade in', { unit: 's', min: 0, max: 60, step: 0.5, placeholder: '0' }) : null,
    fades ? f.number('fadeOut', 'Fade out', { unit: 's', min: 0, max: 60, step: 0.5, placeholder: '0' }) : null,
  ]);
}

function transformGroup() {
  return group('transform', 'Rotate & crop', [
    f.select('rotate', 'Rotate', [{ value: '0', label: 'None' }, { value: '90', label: '90° clockwise' }, { value: '180', label: '180°' }, { value: '270', label: '90° counter-clockwise' }], '0'),
    f.toggle('flipH', 'Mirror horizontally'),
    f.toggle('flipV', 'Flip vertically'),
    f.number('cropW', 'Crop width', { unit: 'px', min: 2, placeholder: 'full' }),
    f.number('cropH', 'Crop height', { unit: 'px', min: 2, placeholder: 'full' }),
    f.number('cropX', 'Crop left', { unit: 'px', min: 0, placeholder: 'center' }),
    f.number('cropY', 'Crop top', { unit: 'px', min: 0, placeholder: 'center' }),
  ], { collapsed: true });
}

function audioTrackField(info) {
  if (!info?.audio || info.audio.length < 2) return null;
  return f.select('audioTrack', 'Audio track', info.audio.map((a, i) => ({ value: String(i), label: `Track ${i + 1}${a.lang ? ` · ${a.lang}` : ''} · ${a.codec}${a.layout ? ` ${a.layout}` : ''}` })), '0');
}

function audioCodecFields(to, prefix = '') {
  const fields = [];
  const key = (k) => prefix + k;
  switch (to) {
    case 'mp3':
      fields.push(
        f.select(key('mp3Mode'), 'Bitrate mode', [{ value: 'cbr', label: 'Constant (CBR)' }, { value: 'vbr', label: 'Variable (VBR)' }], 'cbr'),
        f.select(key('bitrate'), 'Bitrate', bitrateOptions([64, 96, 128, 160, 192, 224, 256, 320]), '192', { showIf: { [key('mp3Mode')]: ['cbr'] } }),
        f.select(key('vbrQuality'), 'VBR quality', Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: `V${i}${i === 0 ? ' · best' : i === 2 ? ' · transparent' : i === 9 ? ' · smallest' : ''}` })), '2', { showIf: { [key('mp3Mode')]: ['vbr'] } }),
      );
      break;
    case 'm4a':
      fields.push(
        f.select(key('m4aCodec'), 'Codec', [{ value: 'aac', label: 'AAC' }, { value: 'alac', label: 'Apple Lossless (ALAC)' }], 'aac'),
        f.select(key('bitrate'), 'Bitrate', bitrateOptions([64, 96, 128, 160, 192, 256, 320]), '192', { showIf: { [key('m4aCodec')]: ['aac'] } }),
      );
      break;
    case 'aac': case 'm4b':
      fields.push(f.select(key('bitrate'), 'Bitrate', bitrateOptions([32, 48, 64, 96, 128, 160, 192, 256, 320]), to === 'm4b' ? '64' : '192'));
      break;
    case 'wma':
      fields.push(f.select(key('bitrate'), 'Bitrate', bitrateOptions([64, 96, 128, 160, 192, 256, 320]), '192'));
      break;
    case 'ac3':
      fields.push(f.select(key('bitrate'), 'Bitrate', bitrateOptions([96, 128, 192, 256, 384, 448, 640]), '384'));
      break;
    case 'mp2':
      fields.push(f.select(key('bitrate'), 'Bitrate', bitrateOptions([96, 128, 192, 256, 320, 384]), '192'));
      break;
    case 'opus': case 'weba':
      fields.push(
        f.select(key('bitrate'), 'Bitrate', bitrateOptions([16, 24, 32, 48, 64, 96, 128, 160, 192, 256, 320]), '128'),
        f.select(key('opusApp'), 'Optimise for', [{ value: 'audio', label: 'Music' }, { value: 'voip', label: 'Speech' }, { value: 'lowdelay', label: 'Low latency' }], 'audio'),
      );
      break;
    case 'ogg':
      fields.push(
        f.select(key('oggCodec'), 'Codec', [{ value: 'vorbis', label: 'Vorbis' }, { value: 'opus', label: 'Opus' }, { value: 'flac', label: 'FLAC (lossless)' }], 'vorbis'),
        f.range(key('vorbisQuality'), 'Quality', -1, 10, 1, 5, { showIf: { [key('oggCodec')]: ['vorbis'] }, help: '5 ≈ 160 kbps, 10 ≈ 500 kbps' }),
        f.select(key('bitrate'), 'Bitrate', bitrateOptions([32, 48, 64, 96, 128, 160, 192, 256]), '128', { showIf: { [key('oggCodec')]: ['opus'] } }),
      );
      break;
    case 'flac':
      fields.push(
        f.range(key('flacLevel'), 'Compression level', 0, 12, 1, 5, { help: 'Lossless at every level — higher is smaller and slower.' }),
        f.select(key('bitDepth'), 'Bit depth', [{ value: '', label: 'Keep original' }, { value: '16', label: '16-bit' }, { value: '24', label: '24-bit' }], ''),
      );
      break;
    case 'wav':
      fields.push(f.select(key('wavFormat'), 'Sample format', [
        { value: 'pcm_s16le', label: '16-bit PCM' }, { value: 'pcm_s24le', label: '24-bit PCM' }, { value: 'pcm_s32le', label: '32-bit PCM' },
        { value: 'pcm_f32le', label: '32-bit float' }, { value: 'pcm_u8', label: '8-bit PCM' }, { value: 'pcm_mulaw', label: 'μ-law' },
        { value: 'pcm_alaw', label: 'A-law' }, { value: 'adpcm_ima_wav', label: 'IMA ADPCM' },
      ], 'pcm_s16le'));
      break;
    case 'aiff':
      fields.push(f.select(key('aiffFormat'), 'Sample format', [{ value: 'pcm_s16be', label: '16-bit PCM' }, { value: 'pcm_s24be', label: '24-bit PCM' }, { value: 'pcm_s32be', label: '32-bit PCM' }], 'pcm_s16be'));
      break;
    case 'caf':
      fields.push(f.select(key('cafCodec'), 'Codec', [{ value: 'pcm_s16le', label: '16-bit PCM' }, { value: 'alac', label: 'Apple Lossless' }, { value: 'aac', label: 'AAC' }], 'pcm_s16le'));
      break;
    case 'au':
      fields.push(f.select(key('auFormat'), 'Sample format', [{ value: 'pcm_s16be', label: '16-bit PCM' }, { value: 'pcm_mulaw', label: 'μ-law' }, { value: 'pcm_alaw', label: 'A-law' }], 'pcm_s16be'));
      break;
    case 'amr':
      fields.push(f.select(key('amrRate'), 'Bitrate', ['4.75k', '5.15k', '5.9k', '6.7k', '7.4k', '7.95k', '10.2k', '12.2k'].map((v) => ({ value: v, label: v.replace('k', ' kbps') })), '12.2k', { help: 'AMR is always 8 kHz mono.' }));
      break;
    case 'wv':
      fields.push(f.range(key('wvLevel'), 'Compression level', 0, 8, 1, 3));
      break;
    case 'mka':
      fields.push(
        f.select(key('mkaCodec'), 'Codec', [{ value: 'flac', label: 'FLAC' }, { value: 'opus', label: 'Opus' }, { value: 'vorbis', label: 'Vorbis' }, { value: 'aac', label: 'AAC' }, { value: 'mp3', label: 'MP3' }, { value: 'ac3', label: 'AC-3' }, { value: 'copy', label: 'Copy (no re-encode)' }], 'flac'),
        f.select(key('bitrate'), 'Bitrate', bitrateOptions([64, 96, 128, 160, 192, 256, 320]), '192', { showIf: { [key('mkaCodec')]: ['opus', 'vorbis', 'aac', 'mp3', 'ac3'] } }),
      );
      break;
    default:
      break;
  }
  return fields;
}

function schema({ from, to, info }) {
  const mode = modeOf(from, to);
  const groups = [];

  if (mode === 'audio') {
    groups.push(group('audio', `${to.toUpperCase()} audio`, [
      ...audioCodecFields(to),
      audioTrackField(info),
      to === 'amr' ? null : f.select('channels', 'Channels', CHANNELS, ''),
      to === 'amr' ? null : f.select('sampleRate', 'Sample rate', SAMPLE_RATES, ''),
    ]));
    groups.push(group('levels', 'Volume', [
      f.range('volume', 'Volume', -30, 30, 0.5, 0, { unit: 'dB' }),
      f.select('normalize', 'Loudness normalisation', [{ value: '', label: 'Off' }, { value: '-14', label: 'Streaming · −14 LUFS' }, { value: '-16', label: 'Podcast · −16 LUFS' }, { value: '-23', label: 'Broadcast · −23 LUFS' }], ''),
      f.toggle('trimSilence', 'Trim leading & trailing silence'),
    ]));
    const tg = trimGroup(info);
    tg.fields.push(f.toggle('reverse', 'Reverse'));
    groups.push(tg);
    const canCover = ['mp3', 'm4a', 'm4b', 'flac'].includes(to) && info?.coverArt;
    groups.push(group('tags', 'Tags', [
      canCover ? f.toggle('keepCover', 'Keep cover art', true) : null,
      f.toggle('stripMetadata', 'Remove existing tags'),
      f.text('title', 'Title', { placeholder: info?.title || '' }),
      f.text('artist', 'Artist'),
      f.text('album', 'Album'),
      f.text('genre', 'Genre'),
      f.text('date', 'Year'),
      f.text('track', 'Track number'),
      f.text('comment', 'Comment'),
    ], { collapsed: true }));
    return groups;
  }

  if (mode === 'visualize') {
    groups.push(group('visual', 'Visual', [
      f.select('style', 'Style', [{ value: 'waveform', label: 'Waveform' }, { value: 'bars', label: 'Frequency bars' }, { value: 'spectrum', label: 'Spectrogram' }, { value: 'cqt', label: 'Musical spectrum' }, { value: 'solid', label: 'Solid color' }], 'waveform'),
      f.select('size', 'Resolution', [{ value: '1920x1080', label: '1920 × 1080' }, { value: '1280x720', label: '1280 × 720' }, { value: '1080x1080', label: '1080 × 1080 (square)' }, { value: '1080x1920', label: '1080 × 1920 (vertical)' }, { value: '854x480', label: '854 × 480' }], '1280x720'),
      f.color('bg', 'Background', '#0b0b0c'),
      f.color('fg', 'Foreground', '#e8e8e8', { showIf: { style: ['waveform', 'bars'] } }),
      f.select('fps', 'Frame rate', ['24', '25', '30', '60'].map((v) => ({ value: v, label: `${v} fps` })), '25'),
      f.range('crf', 'Quality (CRF)', 14, 40, 1, 23, { help: 'Lower is better quality.' }),
    ]));
    groups.push(group('audio', 'Audio', [f.select('bitrate', 'Bitrate', bitrateOptions([96, 128, 160, 192, 256, 320]), '192')]));
    groups.push(trimGroup(info, { speed: false, fades: false }));
    return groups;
  }

  if (mode === 'still') {
    groups.push(group('video', 'Video', [
      f.number('duration', 'Duration', { unit: 's', min: 0.5, max: 3600, step: 0.5, default: 10 }),
      f.select('fps', 'Frame rate', ['24', '25', '30', '60'].map((v) => ({ value: v, label: `${v} fps` })), '25'),
      f.select('resolution', 'Resolution', RESOLUTIONS.filter((r) => r.value !== 'custom'), ''),
      f.toggle('kenBurns', 'Slow zoom effect'),
      f.toggle('silentAudio', 'Add silent audio track', false, { help: 'Some platforms reject videos without audio.' }),
      f.range('crf', 'Quality (CRF)', 14, 40, 1, 20),
    ]));
    return groups;
  }

  if (mode === 'anim') {
    const fields = [
      f.select('fps', 'Frame rate', [{ value: '', label: 'Keep original' }, ...['5', '8', '10', '12', '15', '20', '24', '25', '30', '50'].map((v) => ({ value: v, label: `${v} fps` }))], to === 'gif' ? '12' : '15'),
      f.number('width', 'Width', { unit: 'px', min: 16, max: 4096, placeholder: info?.video?.width ? String(info.video.width) : 'original', default: to === 'gif' ? 480 : undefined, help: 'Height follows the aspect ratio.' }),
      f.select('loop', 'Loop', [{ value: 'forever', label: 'Forever' }, { value: '1', label: 'Play once' }, { value: '2', label: 'Play twice' }, { value: '3', label: 'Play 3 times' }], 'forever'),
    ];
    if (to === 'gif') {
      fields.push(
        f.range('colors', 'Colors', 8, 256, 1, 256),
        f.select('dither', 'Dithering', [{ value: 'sierra2_4a', label: 'Sierra (balanced)' }, { value: 'floyd_steinberg', label: 'Floyd–Steinberg' }, { value: 'bayer', label: 'Bayer (ordered)' }, { value: 'none', label: 'None' }], 'sierra2_4a'),
        f.select('palette', 'Palette', [{ value: 'full', label: 'Optimised for whole clip' }, { value: 'diff', label: 'Optimised for motion' }], 'full'),
      );
    } else if (to === 'webp') {
      fields.push(f.range('quality', 'Quality', 1, 100, 1, 75), f.toggle('lossless', 'Lossless'), f.range('effort', 'Compression effort', 0, 6, 1, 4));
    }
    groups.push(group('anim', 'Animation', fields));
    groups.push(trimGroup(info, { fades: false }));
    groups.push(transformGroup());
    return groups;
  }

  if (mode === 'frames') {
    groups.push(group('frames', 'Frames', [
      f.select('frameMode', 'Extract', [
        { value: 'single', label: 'A single frame' },
        { value: 'interval', label: 'One frame every N seconds' },
        { value: 'count', label: 'A number of evenly spaced frames' },
        { value: 'tile', label: 'A contact sheet (grid)' },
        { value: 'all', label: 'Every frame' },
      ], 'single'),
      f.time('at', 'At time', { placeholder: info?.duration ? fmtDuration(info.duration * 0.1) : '0:01', showIf: { frameMode: ['single'] }, help: 'Leave empty to take a frame at 10%.' }),
      f.number('interval', 'Every', { unit: 's', min: 0.1, step: 0.5, default: 10, showIf: { frameMode: ['interval'] } }),
      f.number('count', 'Frames', { min: 1, max: 500, default: 12, showIf: { frameMode: ['count'] } }),
      f.number('cols', 'Columns', { min: 1, max: 12, default: 4, showIf: { frameMode: ['tile'] } }),
      f.number('rows', 'Rows', { min: 1, max: 12, default: 4, showIf: { frameMode: ['tile'] } }),
      f.number('width', 'Width', { unit: 'px', min: 16, max: 8192, placeholder: 'original', help: 'For contact sheets this is the width of each tile.' }),
      to === 'jpg' ? f.range('quality', 'JPEG quality', 1, 100, 1, 90) : null,
    ]));
    return groups;
  }

  // Video
  const vcodecs = CONTAINER_V[to] || ['h264'];
  const hw = hwCache || [];
  const hwOptions = [{ value: '', label: 'Software (best quality)' }, ...hw.map((h) => ({ value: h, label: { nvenc: 'NVIDIA NVENC', amf: 'AMD AMF', qsv: 'Intel Quick Sync' }[h] }))];
  groups.push(group('video', 'Video', [
    f.select('vcodec', 'Codec', vcodecs.map((c) => ({ value: c, label: VCODECS[c].label })), DEFAULT_V[to]),
    hw.length > 1 || (hw.length && vcodecs.some((c) => c === 'h264' || c === 'h265'))
      ? f.select('hw', 'Encoder', hwOptions, '', { showIf: { vcodec: ['h264', 'h265'] }, help: 'Hardware encoding is much faster, files are a bit larger.' }) : null,
    f.select('qualityMode', 'Rate control', [{ value: 'crf', label: 'Constant quality' }, { value: 'bitrate', label: 'Target bitrate' }, { value: 'size', label: 'Target file size' }], 'crf', { showIf: { vcodec: { not: ['copy', 'ffv1', 'prores'] } } }),
    f.range('crf', 'Quality (CRF)', 0, 51, 1, 23, { showIf: { vcodec: ['h264', 'h265'], qualityMode: ['crf'] }, help: 'Lower is better. 18 ≈ visually lossless, 28 ≈ small.' }),
    f.range('crfVp', 'Quality (CRF)', 0, 63, 1, 32, { showIf: { vcodec: ['vp9', 'vp8', 'av1'], qualityMode: ['crf'] }, help: 'Lower is better quality.' }),
    f.range('qscale', 'Quality', 1, 31, 1, 4, { showIf: { vcodec: ['mpeg4', 'mpeg2', 'mpeg1', 'wmv2', 'flv1', 'mjpeg'], qualityMode: ['crf'] }, help: '1 is best, 31 is smallest.' }),
    f.range('theoraQ', 'Quality', 0, 10, 1, 7, { showIf: { vcodec: ['theora'], qualityMode: ['crf'] }, help: '10 is best.' }),
    f.number('vbitrate', 'Video bitrate', { unit: 'kbps', min: 50, max: 200000, default: 4000, showIf: { qualityMode: ['bitrate'], vcodec: { not: ['copy', 'ffv1', 'prores'] } } }),
    f.number('targetSize', 'Target size', { unit: 'MB', min: 1, max: 100000, default: 25, showIf: { qualityMode: ['size'], vcodec: { not: ['copy', 'ffv1', 'prores'] } }, help: info?.duration ? `For ${fmtDuration(info.duration)} of video, including audio.` : undefined }),
    f.select('preset', 'Encoding speed', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((p) => ({ value: p, label: p === 'medium' ? 'medium (default)' : p })), 'medium', { showIf: { vcodec: ['h264', 'h265'] }, help: 'Slower presets give smaller files at the same quality.' }),
    f.range('cpuUsed', 'Encoding speed', 0, 8, 1, 6, { showIf: { vcodec: ['vp9', 'vp8', 'av1'] }, help: 'Higher is faster, lower is more efficient.' }),
    f.select('prores', 'ProRes profile', [{ value: '0', label: 'Proxy' }, { value: '1', label: 'LT' }, { value: '2', label: 'Standard' }, { value: '3', label: 'HQ' }, { value: '4', label: '4444' }], '2', { showIf: { vcodec: ['prores'] } }),
    f.select('resolution', 'Resolution', RESOLUTIONS, ''),
    f.number('width', 'Width', { unit: 'px', min: 16, max: 8192, placeholder: info?.video?.width ? String(info.video.width) : 'auto', showIf: { resolution: ['custom'] } }),
    f.number('height', 'Height', { unit: 'px', min: 16, max: 8192, placeholder: info?.video?.height ? String(info.video.height) : 'auto', showIf: { resolution: ['custom'] } }),
    f.select('fit', 'Fit', [{ value: 'pad', label: 'Fit and pad (letterbox)' }, { value: 'crop', label: 'Fill and crop' }, { value: 'stretch', label: 'Stretch' }], 'pad', { showIf: { resolution: ['custom'] }, help: 'Used when both width and height are set.' }),
    f.select('fps', 'Frame rate', FPS, ''),
    f.number('fpsCustom', 'Custom frame rate', { unit: 'fps', min: 1, max: 240, step: 0.001, showIf: { fps: ['custom'] } }),
  ]));

  groups.push(group('advanced', 'Advanced video', [
    f.select('pixfmt', 'Pixel format', [{ value: '', label: 'Auto (8-bit 4:2:0, most compatible)' }, { value: 'yuv420p10le', label: '10-bit 4:2:0' }, { value: 'yuv422p', label: '8-bit 4:2:2' }, { value: 'yuv444p', label: '8-bit 4:4:4' }], '', { showIf: { vcodec: ['h264', 'h265', 'vp9', 'av1'] } }),
    f.select('profile', 'H.264 profile', [{ value: '', label: 'Auto' }, { value: 'baseline', label: 'Baseline' }, { value: 'main', label: 'Main' }, { value: 'high', label: 'High' }], '', { showIf: { vcodec: ['h264'] } }),
    f.select('tune', 'Tune', [{ value: '', label: 'None' }, 'film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency'].map((t) => (typeof t === 'string' ? { value: t, label: t } : t)), '', { showIf: { vcodec: ['h264'] } }),
    f.number('gop', 'Keyframe interval', { unit: 'frames', min: 1, max: 1000, placeholder: 'auto' }),
    f.toggle('twoPass', 'Two-pass encoding', false, { showIf: { qualityMode: ['bitrate', 'size'], vcodec: ['h264', 'h265', 'vp9'] }, help: 'More accurate bitrate, takes twice as long.' }),
    ['mp4', 'mov', 'm4v', '3gp'].includes(to) ? f.toggle('faststart', 'Optimise for web streaming', true, { help: 'Moves the index to the start of the file (fast start).' }) : null,
  ], { collapsed: true }));

  groups.push(group('audio', 'Audio', [
    f.select('acodec', 'Codec', (CONTAINER_A[to] || ['aac']).map((c) => ({ value: c, label: ACODECS[c].label })), info && !info.audio?.length ? 'none' : DEFAULT_A[to]),
    f.select('abitrate', 'Bitrate', bitrateOptions([64, 96, 128, 160, 192, 256, 320, 384, 448, 640]), '192', { showIf: { acodec: ['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'mp2', 'wmav2'] } }),
    audioTrackField(info) ? { ...audioTrackField(info), showIf: { acodec: { not: ['none'] } } } : null,
    f.select('channels', 'Channels', CHANNELS, '', { showIf: { acodec: { not: ['none', 'copy'] } } }),
    f.select('sampleRate', 'Sample rate', SAMPLE_RATES, '', { showIf: { acodec: { not: ['none', 'copy'] } } }),
    f.range('volume', 'Volume', -30, 30, 0.5, 0, { unit: 'dB', showIf: { acodec: { not: ['none', 'copy'] } } }),
    f.select('normalize', 'Loudness normalisation', [{ value: '', label: 'Off' }, { value: '-14', label: 'Streaming · −14 LUFS' }, { value: '-16', label: 'Podcast · −16 LUFS' }, { value: '-23', label: 'Broadcast · −23 LUFS' }], '', { showIf: { acodec: { not: ['none', 'copy'] } } }),
  ]));

  groups.push(trimGroup(info));
  groups.push(transformGroup());
  groups.push(group('filters', 'Filters', [
    f.toggle('deinterlace', 'Deinterlace'),
    f.select('denoise', 'Denoise', [{ value: '', label: 'Off' }, { value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'strong', label: 'Strong' }], ''),
    f.range('sharpen', 'Sharpen', 0, 2, 0.1, 0),
    f.range('brightness', 'Brightness', -1, 1, 0.02, 0),
    f.range('contrast', 'Contrast', 0, 2, 0.02, 1),
    f.range('saturation', 'Saturation', 0, 3, 0.05, 1),
    f.range('gamma', 'Gamma', 0.1, 3, 0.05, 1),
    f.toggle('grayscale', 'Black & white'),
  ], { collapsed: true }));

  const subs = info?.subtitles || [];
  if (subs.length) {
    groups.push(group('subs', 'Subtitles', [
      f.select('subtitles', 'Subtitles', [{ value: 'none', label: 'Remove' }, { value: 'keep', label: 'Keep as soft subtitles' }, { value: 'burn', label: 'Burn into video' }], 'none'),
      f.select('subTrack', 'Track', subs.map((s, i) => ({ value: String(i), label: `Track ${i + 1}${s.lang ? ` · ${s.lang}` : ''} · ${s.codec}` })), '0', { showIf: { subtitles: ['burn'] } }),
    ]));
  }

  groups.push(group('meta', 'Metadata', [
    f.toggle('stripMetadata', 'Remove metadata & chapters'),
    f.text('title', 'Title', { placeholder: info?.title || '' }),
  ], { collapsed: true }));
  return groups;
}

// ---- conversion helpers ----------------------------------------------------

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  if (Math.abs(s - 1) > 1e-3) parts.push(`atempo=${s.toFixed(4)}`);
  return parts;
}

function timing(o, info) {
  const start = parseTime(o.trimStart) || 0;
  const end = parseTime(o.trimEnd);
  const total = info?.duration;
  if (end !== null && end <= start) throw new UserError('“End at” must be after “Start at”');
  if (total && start >= total) throw new UserError(`“Start at” is beyond the end of the file (${fmtDuration(total)})`);
  const speed = clamp(opt.num(o.speed, 1), 0.25, 4);
  const span = (end ?? total ?? 0) - start;
  // Both are input options so the trim applies to the source timeline, before speed changes.
  const inArgs = [...(start ? ['-ss', String(start)] : []), ...(end !== null ? ['-t', String(end - start)] : [])];
  const outArgs = [];
  return { start, end, speed, span: span > 0 ? span : null, outDur: span > 0 ? span / speed : null, inArgs, outArgs };
}

function audioFilters(o, t, { fades = true, sampleRateFallback } = {}) {
  const af = [];
  af.push(...atempoChain(t.speed));
  const vol = opt.num(o.volume, 0);
  if (vol) af.push(`volume=${vol}dB`);
  const lufs = opt.num(o.normalize);
  if (lufs) af.push(`loudnorm=I=${lufs}:TP=-1.5:LRA=11`);
  if (fades) {
    const fi = opt.num(o.fadeIn, 0);
    const fo = opt.num(o.fadeOut, 0);
    if (fi > 0) af.push(`afade=t=in:st=0:d=${fi}`);
    if (fo > 0 && t.outDur) af.push(`afade=t=out:st=${Math.max(0, t.outDur - fo).toFixed(3)}:d=${fo}`);
  }
  const needsRate = lufs && !o.sampleRate;
  return { af, extra: needsRate ? ['-ar', String(sampleRateFallback || 48000)] : [] };
}

function transformFilters(o, info) {
  const vf = [];
  const cw = opt.num(o.cropW);
  const ch = opt.num(o.cropH);
  if (cw || ch) {
    const x = opt.num(o.cropX);
    const y = opt.num(o.cropY);
    vf.push(`crop=${cw || 'iw'}:${ch || 'ih'}:${x ?? '(iw-ow)/2'}:${y ?? '(ih-oh)/2'}`);
  }
  switch (String(o.rotate || '0')) {
    case '90': vf.push('transpose=1'); break;
    case '180': vf.push('hflip', 'vflip'); break;
    case '270': vf.push('transpose=2'); break;
    default: break;
  }
  if (opt.bool(o.flipH)) vf.push('hflip');
  if (opt.bool(o.flipV)) vf.push('vflip');
  return vf;
}

function scaleFilters(o, pad = '#000000') {
  const vf = [];
  const res = String(o.resolution || '');
  if (res && res !== 'custom') {
    const h = Number(res);
    vf.push(`scale=w='if(gte(iw,ih),-2,${h})':h='if(gte(iw,ih),${h},-2)':flags=lanczos`, 'setsar=1');
  } else if (res === 'custom') {
    const w = opt.num(o.width);
    const h = opt.num(o.height);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    if (w && h) {
      const W = even(w);
      const H = even(h);
      if (o.fit === 'stretch') vf.push(`scale=${W}:${H}:flags=lanczos`, 'setsar=1');
      else if (o.fit === 'crop') vf.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${W}:${H}`, 'setsar=1');
      else vf.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${pad}`, 'setsar=1');
    } else if (w) vf.push(`scale=${even(w)}:-2:flags=lanczos`, 'setsar=1');
    else if (h) vf.push(`scale=-2:${even(h)}:flags=lanczos`, 'setsar=1');
  }
  return vf;
}

const loopValue = (loop, kind) => {
  const n = loop === 'forever' || !loop ? 0 : Number(loop);
  if (kind === 'gif') return n === 0 ? '0' : String(n - 1 === 0 ? -1 : n - 1);
  return String(n); // apng plays, webp loop
};

async function convertAudio(ctx, info, t) {
  const { input, to, o, outDir, baseName, signal, tmpDir } = ctx;
  let { progress } = ctx;
  const out = path.join(outDir, `${baseName}.${to}`);
  const track = opt.num(o.audioTrack, 0);
  const cover = opt.bool(o.keepCover, true) && info?.coverArt && ['mp3', 'm4a', 'm4b', 'flac'].includes(to);
  if (info && !info.audio?.length) throw new UserError('This file has no audio track');

  // Silence trimming and reversing run in their own pass: combined with loudnorm in a single
  // graph they deadlock in FFmpeg 6.1, and the trimmed length is needed to place fade-outs.
  const pre = [];
  const SIL = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1';
  if (opt.bool(o.trimSilence)) pre.push(SIL, 'areverse', SIL, 'areverse');
  if (opt.bool(o.reverse)) pre.push('areverse');
  let args;
  if (pre.length) {
    await ensureDir(tmpDir);
    const tmp = path.join(tmpDir, 'prepass.wav');
    await ffmpeg([...t.inArgs, '-i', input, '-map', `0:a:${track}`, '-vn', '-af', pre.join(','), '-c:a', 'pcm_f32le', tmp], { signal, duration: t.span || info?.duration, onProgress: (p) => ctx.progress(p * 0.4) });
    const d = (await probe(tmp))?.duration;
    t = { ...t, inArgs: [], outDur: d ? d / t.speed : t.outDur };
    progress = (p) => ctx.progress(0.4 + p * 0.6);
    args = ['-i', tmp, ...(cover ? ['-i', input] : []), '-map', '0:a:0'];
    if (cover) args.push('-map', '1:v?', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    else args.push('-vn');
  } else {
    args = [...t.inArgs, '-i', input, '-map', `0:a:${track}`];
    if (cover) args.push('-map', '0:v?', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    else args.push('-vn');
  }
  args.push('-sn', '-dn');

  const srcRate = info?.audio?.[track]?.sampleRate;
  const { af, extra } = audioFilters(o, t, { sampleRateFallback: srcRate && srcRate >= 44100 ? srcRate : 48000 });
  let codecCopy = false;
  const br = (d) => `${opt.num(o.bitrate, d)}k`;
  switch (to) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame');
      if (o.mp3Mode === 'vbr') args.push('-q:a', String(clamp(opt.num(o.vbrQuality, 2), 0, 9)));
      else args.push('-b:a', br(192));
      args.push('-id3v2_version', '3');
      break;
    case 'm4a':
      if (o.m4aCodec === 'alac') args.push('-c:a', 'alac');
      else args.push('-c:a', 'aac', '-b:a', br(192));
      break;
    case 'm4b': case 'aac':
      args.push('-c:a', 'aac', '-b:a', br(to === 'm4b' ? 64 : 192));
      break;
    case 'wma': args.push('-c:a', 'wmav2', '-b:a', br(192)); break;
    case 'ac3': args.push('-c:a', 'ac3', '-b:a', br(384)); break;
    case 'mp2': args.push('-c:a', 'mp2', '-b:a', br(192)); break;
    case 'opus': case 'weba':
      args.push('-c:a', 'libopus', '-b:a', br(128), '-application', o.opusApp || 'audio');
      if (to === 'weba') args.push('-f', 'webm');
      break;
    case 'ogg':
      if (o.oggCodec === 'opus') args.push('-c:a', 'libopus', '-b:a', br(128));
      else if (o.oggCodec === 'flac') args.push('-c:a', 'flac');
      else args.push('-c:a', 'libvorbis', '-q:a', String(clamp(opt.num(o.vorbisQuality, 5), -1, 10)));
      break;
    case 'flac':
      args.push('-c:a', 'flac', '-compression_level', String(clamp(opt.num(o.flacLevel, 5), 0, 12)));
      if (o.bitDepth === '16') args.push('-sample_fmt', 's16');
      if (o.bitDepth === '24') args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24');
      break;
    case 'wav': args.push('-c:a', o.wavFormat || 'pcm_s16le'); break;
    case 'aiff': args.push('-c:a', o.aiffFormat || 'pcm_s16be'); break;
    case 'caf': args.push('-c:a', o.cafCodec || 'pcm_s16le'); break;
    case 'au': args.push('-c:a', o.auFormat || 'pcm_s16be'); break;
    case 'amr': args.push('-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', o.amrRate || '12.2k'); break;
    case 'wv': args.push('-c:a', 'wavpack', '-compression_level', String(clamp(opt.num(o.wvLevel, 3), 0, 8))); break;
    case 'mka': {
      const c = o.mkaCodec || 'flac';
      if (c === 'copy') { args.push('-c:a', 'copy'); codecCopy = true; } else {
        args.push('-c:a', ACODECS[c]?.lib || 'flac');
        if (c !== 'flac') args.push('-b:a', br(192));
      }
      break;
    }
    default: break;
  }
  if (codecCopy && (af.length || o.channels || o.sampleRate)) throw new UserError('Stream copy cannot be combined with audio filters or resampling');
  if (!codecCopy) {
    if (af.length) args.push('-af', af.join(','));
    args.push(...extra);
    if (o.channels && to !== 'amr') args.push('-ac', String(o.channels));
    if (o.sampleRate && to !== 'amr') args.push('-ar', String(o.sampleRate));
  }
  args.push(...metadataArgs(o));
  args.push(out);
  await ffmpeg(args, { signal, duration: t.outDur, onProgress: progress });
  return [out];
}

function metadataArgs(o) {
  const args = [];
  if (opt.bool(o.stripMetadata)) args.push('-map_metadata', '-1', '-map_chapters', '-1');
  for (const k of ['title', 'artist', 'album', 'genre', 'date', 'track', 'comment']) {
    const v = opt.str(o[k]).trim();
    if (v) args.push('-metadata', `${k}=${v}`);
  }
  return args;
}

async function convertVideo(ctx, info, t) {
  const { input, to, o, outDir, baseName, signal, progress, tmpDir } = ctx;
  const out = path.join(outDir, `${baseName}.${to}`);
  const allowedV = CONTAINER_V[to] || ['h264'];
  const vcodec = allowedV.includes(o.vcodec) ? o.vcodec : DEFAULT_V[to];
  const allowedA = CONTAINER_A[to] || ['aac'];
  let acodec = allowedA.includes(o.acodec) ? o.acodec : DEFAULT_A[to];
  if (info && !info.audio?.length) acodec = 'none';
  if (info && !info.video) throw new UserError('This file has no video stream');

  // ---- video filter chain
  const vf = [];
  if (opt.bool(o.deinterlace)) vf.push('yadif');
  const subMode = info?.subtitles?.length ? o.subtitles || 'none' : 'none';
  const subIdx = clamp(opt.num(o.subTrack, 0), 0, Math.max(0, (info?.subtitles?.length || 1) - 1));
  const burnBitmap = subMode === 'burn' && info.subtitles[subIdx]?.bitmap;
  if (subMode === 'burn' && !burnBitmap) {
    // The subtitles filter reads the file from the start, so shift timestamps when trimming.
    const shift = t.start ? [`setpts=PTS+${t.start}/TB`] : [];
    vf.push(...shift, `subtitles='${filterPath(input)}':si=${subIdx}`, ...(t.start ? ['setpts=PTS-STARTPTS'] : []));
  }
  vf.push(...transformFilters(o, info));
  vf.push(...scaleFilters(o));
  let fps = o.fps === 'custom' ? opt.num(o.fpsCustom) : opt.num(o.fps);
  if (['mpeg2', 'mpeg1'].includes(vcodec)) {
    const std = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
    const src = fps || info?.video?.fps;
    if (!src || !std.some((s) => Math.abs(s - src) < 0.01)) fps = 25;
  }
  if (fps) vf.push(`fps=${fps}`);
  const denoise = { light: 'hqdn3d=1.5:1.5:6:6', medium: 'hqdn3d=3:3:9:9', strong: 'hqdn3d=6:5:14:14' }[o.denoise];
  if (denoise) vf.push(denoise);
  const sh = opt.num(o.sharpen, 0);
  if (sh > 0) vf.push(`unsharp=5:5:${sh}:5:5:0`);
  const eq = { brightness: opt.num(o.brightness, 0), contrast: opt.num(o.contrast, 1), saturation: opt.num(o.saturation, 1), gamma: opt.num(o.gamma, 1) };
  if (eq.brightness || eq.contrast !== 1 || eq.saturation !== 1 || eq.gamma !== 1) vf.push(`eq=brightness=${eq.brightness}:contrast=${eq.contrast}:saturation=${eq.saturation}:gamma=${eq.gamma}`);
  if (opt.bool(o.grayscale)) vf.push('hue=s=0');
  if (t.speed !== 1) vf.push(`setpts=PTS/${t.speed}`);
  const fi = opt.num(o.fadeIn, 0);
  const fo = opt.num(o.fadeOut, 0);
  if (fi > 0) vf.push(`fade=t=in:st=0:d=${fi}`);
  if (fo > 0 && t.outDur) vf.push(`fade=t=out:st=${Math.max(0, t.outDur - fo).toFixed(3)}:d=${fo}`);

  if (vcodec === 'copy' && (vf.length || burnBitmap)) {
    throw new UserError('“Copy stream” cannot be combined with resizing, speed, filters or burned subtitles — pick a codec instead');
  }
  // 4:2:0 codecs need even dimensions.
  if (vcodec !== 'copy' && !['ffv1', 'prores'].includes(vcodec)) vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');

  // ---- inputs & mapping
  const head = [...t.inArgs, '-i', input, ...t.outArgs];
  const track = opt.num(o.audioTrack, 0);
  if (burnBitmap) {
    head.push('-filter_complex', `[0:V:0][0:s:${subIdx}]overlay${vf.length ? ',' + vf.join(',') : ''}[vout]`, '-map', '[vout]');
  } else {
    head.push('-map', '0:V:0');
    if (vf.length) head.push('-vf', vf.join(','));
  }
  if (acodec !== 'none') head.push('-map', `0:a:${track}?`);

  // ---- video encoder
  const hw = ['h264', 'h265'].includes(vcodec) && (hwCache || []).includes(o.hw) ? o.hw : '';
  const qualityMode = ['copy', 'ffv1', 'prores'].includes(vcodec) ? 'none' : o.qualityMode || 'crf';
  let vbitrate = null;
  if (qualityMode === 'bitrate') vbitrate = clamp(opt.num(o.vbitrate, 4000), 50, 200000);
  if (qualityMode === 'size') {
    const dur = t.outDur || info?.duration;
    if (!dur) throw new UserError('Target size needs a known duration; use a bitrate instead');
    const audioK = acodec === 'none' ? 0 : opt.num(o.abitrate, 192);
    vbitrate = Math.floor((opt.num(o.targetSize, 25) * 8192 * 0.96) / dur - audioK);
    if (vbitrate < 50) throw new UserError('That target size is too small for this duration — try a larger size or lower audio bitrate');
  }
  const venc = [];
  let x265Params = ['log-level=error'];
  if (hw) {
    venc.push('-c:v', `${vcodec === 'h265' ? 'hevc' : 'h264'}_${hw}`);
    const q = String(clamp(opt.num(o.crf, 23), 0, 51));
    if (vbitrate) venc.push('-b:v', `${vbitrate}k`);
    else if (hw === 'nvenc') venc.push('-rc', 'vbr', '-cq', q, '-b:v', '0');
    else if (hw === 'amf') venc.push('-rc', 'cqp', '-qp_i', q, '-qp_p', q, '-qp_b', q);
    else if (hw === 'qsv') venc.push('-global_quality', q);
    venc.push('-pix_fmt', hw === 'qsv' ? 'nv12' : 'yuv420p');
  } else {
    venc.push('-c:v', VCODECS[vcodec].lib);
    switch (vcodec) {
      case 'h264': case 'h265':
        venc.push('-preset', o.preset || 'medium');
        if (vbitrate) venc.push('-b:v', `${vbitrate}k`, '-maxrate', `${Math.round(vbitrate * 1.5)}k`, '-bufsize', `${vbitrate * 2}k`);
        else venc.push('-crf', String(clamp(opt.num(o.crf, 23), 0, 51)));
        if (vcodec === 'h264' && o.tune) venc.push('-tune', o.tune);
        if (vcodec === 'h264' && o.profile) venc.push('-profile:v', o.profile);
        if (vcodec === 'h265' && ['mp4', 'mov', 'm4v'].includes(to)) venc.push('-tag:v', 'hvc1');
        venc.push('-pix_fmt', o.pixfmt || 'yuv420p');
        break;
      case 'vp9': case 'av1': case 'vp8': {
        const cpu = clamp(opt.num(o.cpuUsed, 6), 0, 8);
        if (vbitrate) venc.push('-b:v', `${vbitrate}k`);
        else venc.push('-crf', String(clamp(opt.num(o.crfVp, 32), 0, 63)), '-b:v', vcodec === 'vp8' ? '8M' : '0');
        if (vcodec === 'av1') venc.push('-cpu-used', String(cpu), '-row-mt', '1', '-tiles', '2x2');
        else venc.push('-deadline', 'good', '-cpu-used', String(Math.min(cpu, 5)), ...(vcodec === 'vp9' ? ['-row-mt', '1'] : []));
        venc.push('-pix_fmt', vcodec === 'vp8' ? 'yuv420p' : o.pixfmt || 'yuv420p');
        break;
      }
      case 'mpeg4': case 'mpeg2': case 'mpeg1': case 'wmv2': case 'flv1': case 'mjpeg':
        if (vbitrate) venc.push('-b:v', `${vbitrate}k`);
        else venc.push('-q:v', String(clamp(opt.num(o.qscale, 4), 1, 31)));
        if (vcodec === 'mpeg4' && to === 'avi') venc.push('-vtag', 'xvid');
        venc.push('-pix_fmt', vcodec === 'mjpeg' ? 'yuvj420p' : 'yuv420p');
        break;
      case 'theora':
        if (vbitrate) venc.push('-b:v', `${vbitrate}k`);
        else venc.push('-q:v', String(clamp(opt.num(o.theoraQ, 7), 0, 10)));
        venc.push('-pix_fmt', 'yuv420p');
        break;
      case 'prores': {
        const p = String(clamp(opt.num(o.prores, 2), 0, 4));
        venc.push('-profile:v', p, '-vendor', 'apl0', '-pix_fmt', p === '4' ? 'yuva444p10le' : 'yuv422p10le');
        break;
      }
      case 'ffv1': venc.push('-level', '3', '-g', '1'); break;
      default: break;
    }
  }
  const gop = opt.num(o.gop);
  if (gop && vcodec !== 'copy') venc.push('-g', String(Math.round(gop)));

  // ---- audio encoder
  const aenc = [];
  if (acodec === 'none') aenc.push('-an');
  else if (acodec === 'copy') {
    if (t.speed !== 1 || opt.num(o.volume, 0) || o.normalize || fi || fo) throw new UserError('Audio “Copy stream” cannot be combined with speed, volume or fades');
    aenc.push('-c:a', 'copy');
  } else {
    const srcRate = info?.audio?.[track]?.sampleRate;
    const { af, extra } = audioFilters(o, t, { sampleRateFallback: srcRate && srcRate >= 44100 ? srcRate : 48000 });
    aenc.push('-c:a', ACODECS[acodec].lib);
    if (['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'mp2', 'wmav2'].includes(acodec)) aenc.push('-b:a', `${opt.num(o.abitrate, 192)}k`);
    if (af.length) aenc.push('-af', af.join(','));
    if (acodec === 'amr') aenc.push('-ar', '8000', '-ac', '1', '-b:a', '12.2k');
    else {
      aenc.push(...extra);
      if (o.channels) aenc.push('-ac', String(o.channels));
      if (o.sampleRate) aenc.push('-ar', String(o.sampleRate));
      else if (to === 'flv' && acodec === 'mp3') aenc.push('-ar', '44100');
    }
  }

  // ---- subtitles, container flags, metadata
  const tail = [];
  if (subMode === 'keep') {
    const textSubs = info.subtitles.filter((s) => !s.bitmap);
    if (to === 'mkv') tail.push('-map', '0:s?', '-c:s', 'copy');
    else if (['mp4', 'mov', 'm4v'].includes(to) && textSubs.length) tail.push(...textSubs.flatMap((s) => ['-map', `0:${s.index}`]), '-c:s', 'mov_text');
    else if (to === 'webm' && textSubs.length) tail.push(...textSubs.flatMap((s) => ['-map', `0:${s.index}`]), '-c:s', 'webvtt');
    else tail.push('-sn');
  } else tail.push('-sn');
  tail.push('-dn');
  if (['mp4', 'mov', 'm4v', '3gp'].includes(to) && opt.bool(o.faststart, true)) tail.push('-movflags', '+faststart');
  if (opt.bool(o.stripMetadata)) tail.push('-map_metadata', '-1', '-map_chapters', '-1');
  if (opt.str(o.title).trim()) tail.push('-metadata', `title=${o.title.trim()}`);
  if (to === 'mpeg') tail.push('-f', vcodec === 'mpeg1' ? 'mpeg' : 'dvd');
  tail.push('-max_muxing_queue_size', '9999');

  const duration = t.outDur || info?.duration;
  const twoPass = opt.bool(o.twoPass) && vbitrate && !hw && ['h264', 'h265', 'vp9'].includes(vcodec);
  if (!twoPass) {
    if (vcodec === 'h265' && !hw) venc.push('-x265-params', x265Params.join(':'));
    await ffmpeg([...head, ...venc, ...aenc, ...tail, out], { signal, duration, onProgress: progress });
    return [out];
  }

  // Two-pass: stats files live in the job's temp dir (relative paths avoid ':' issues in x265 params).
  await ensureDir(tmpDir);
  const passArgs = (n) => (vcodec === 'h265' ? ['-x265-params', [...x265Params, `pass=${n}`, 'stats=ffpass.log'].join(':')] : ['-pass', String(n), '-passlogfile', 'ffpass']);
  const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
  await ffmpeg([...head, ...venc, ...passArgs(1), '-an', '-sn', '-dn', '-f', 'null', nullOut], { signal, duration, onProgress: (p) => progress(p / 2), cwd: tmpDir });
  await ffmpeg([...head, ...venc, ...passArgs(2), ...aenc, ...tail, out], { signal, duration, onProgress: (p) => progress(0.5 + p / 2), cwd: tmpDir });
  return [out];
}

async function convertAnim(ctx, info, t) {
  const { input, to, o, outDir, baseName, signal, progress } = ctx;
  const out = path.join(outDir, `${baseName}.${to}`);
  const vf = [...transformFilters(o, info)];
  const fps = opt.num(o.fps);
  if (t.speed !== 1) vf.push(`setpts=PTS/${t.speed}`);
  if (fps) vf.push(`fps=${fps}`);
  const w = opt.num(o.width);
  if (w) vf.push(`scale=${Math.round(w)}:-1:flags=lanczos`);
  const args = [...t.inArgs, '-i', input, ...t.outArgs, '-an', '-sn'];
  if (to === 'gif') {
    const colors = clamp(opt.num(o.colors, 256), 8, 256);
    const dither = ['sierra2_4a', 'floyd_steinberg', 'bayer', 'none'].includes(o.dither) ? o.dither : 'sierra2_4a';
    const stats = o.palette === 'diff' ? 'diff' : 'full';
    const pre = vf.length ? vf.join(',') + ',' : '';
    args.push('-filter_complex', `[0:V:0]${pre}split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=${stats}[p];[b][p]paletteuse=dither=${dither}${dither === 'bayer' ? ':bayer_scale=3' : ''}${stats === 'diff' ? ':diff_mode=rectangle' : ''}`);
    args.push('-loop', loopValue(o.loop, 'gif'));
  } else if (to === 'apng') {
    args.push('-map', '0:V:0');
    if (vf.length) args.push('-vf', vf.join(','));
    args.push('-c:v', 'apng', '-plays', loopValue(o.loop, 'apng'), '-f', 'apng');
  } else {
    args.push('-map', '0:V:0');
    if (vf.length) args.push('-vf', vf.join(','));
    args.push('-c:v', 'libwebp_anim', '-lossless', opt.bool(o.lossless) ? '1' : '0', '-q:v', String(clamp(opt.num(o.quality, 75), 1, 100)), '-compression_level', String(clamp(opt.num(o.effort, 4), 0, 6)), '-loop', loopValue(o.loop, 'webp'), '-pix_fmt', 'yuva420p');
  }
  args.push(out);
  await ffmpeg(args, { signal, duration: t.outDur || info?.duration, onProgress: progress });
  return [out];
}

async function convertFrames(ctx, info, t) {
  const { input, to, o, outDir, baseName, signal, progress } = ctx;
  const mode = o.frameMode || 'single';
  const dur = t.span || info?.duration || 0;
  const w = opt.num(o.width);
  const scale = w ? [`scale=${Math.round(w)}:-2:flags=lanczos`] : [];
  const q = to === 'jpg' ? ['-q:v', String(Math.round(2 + (100 - clamp(opt.num(o.quality, 90), 1, 100)) * 0.29))] : [];
  if (mode === 'single') {
    const at = parseTime(o.at) ?? (dur ? dur * 0.1 : 0);
    const out = path.join(outDir, `${baseName}.${to}`);
    await ffmpeg(['-ss', String(at), '-i', input, '-map', '0:V:0', '-frames:v', '1', '-update', '1', ...(scale.length ? ['-vf', scale.join(',')] : []), ...q, out], { signal });
    return [out];
  }
  if (mode === 'tile') {
    const cols = clamp(opt.num(o.cols, 4), 1, 12);
    const rows = clamp(opt.num(o.rows, 4), 1, 12);
    if (!dur) throw new UserError('A contact sheet needs a known duration');
    const n = cols * rows;
    const out = path.join(outDir, `${baseName}.${to}`);
    const tileW = w || 320;
    await ffmpeg([...t.inArgs, '-i', input, ...t.outArgs, '-map', '0:V:0', '-vf', `fps=${n}/${dur.toFixed(3)},scale=${Math.round(tileW)}:-2:flags=lanczos,tile=${cols}x${rows}:padding=4:margin=4:color=black`, '-frames:v', '1', '-update', '1', ...q, out], { signal, duration: dur, onProgress: progress });
    return [out];
  }
  const vf = [];
  let max = 10000;
  if (mode === 'interval') vf.push(`fps=1/${clamp(opt.num(o.interval, 10), 0.05, 36000)}`);
  if (mode === 'count') {
    if (!dur) throw new UserError('Evenly spaced frames need a known duration');
    max = clamp(opt.num(o.count, 12), 1, 500);
    vf.push(`fps=${max}/${dur.toFixed(3)}`);
  }
  vf.push(...scale);
  const pattern = path.join(outDir, `${baseName}-%05d.${to}`);
  await ffmpeg([...t.inArgs, '-i', input, ...t.outArgs, '-map', '0:V:0', ...(vf.length ? ['-vf', vf.join(',')] : []), '-frames:v', String(max), '-fps_mode', 'passthrough', ...q, pattern], { signal, duration: dur, onProgress: progress });

  const files = (await fsp.readdir(outDir)).filter((n) => n.startsWith(`${baseName}-`) && n.endsWith(`.${to}`)).sort();
  if (!files.length) throw new UserError('No frames were extracted — check the time settings');
  return files.map((n) => path.join(outDir, n));
}

async function convertVisualize(ctx, info, t) {
  const { input, to, o, outDir, baseName, signal, progress } = ctx;
  const out = path.join(outDir, `${baseName}.${to}`);
  const [W, H] = String(o.size || '1280x720').split('x').map(Number);
  const fps = clamp(opt.num(o.fps, 25), 1, 60);
  const bg = (hexToRgb(o.bg) ? o.bg : '#0b0b0c').replace('#', '0x');
  const fg = (hexToRgb(o.fg) ? o.fg : '#e8e8e8').replace('#', '0x');
  let graph;
  switch (o.style) {
    case 'bars':
      graph = `color=c=${bg}:s=${W}x${H}:r=${fps}[bg];[0:a]showfreqs=s=${W}x${H}:mode=bar:ascale=log:fscale=log:colors=${fg}:win_size=2048[w];[bg][w]overlay=shortest=1:format=auto,format=yuv420p[v]`;
      break;
    case 'spectrum':
      graph = `[0:a]showspectrum=s=${W}x${H}:mode=combined:color=intensity:slide=scroll:scale=log:legend=0,fps=${fps},format=yuv420p[v]`;
      break;
    case 'cqt':
      graph = `[0:a]showcqt=s=${W}x${H}:r=${fps}:axis=0,format=yuv420p[v]`;
      break;
    case 'solid':
      graph = `color=c=${bg}:s=${W}x${H}:r=${fps},format=yuv420p[v]`;
      break;
    default:
      graph = `color=c=${bg}:s=${W}x${H}:r=${fps}[bg];[0:a]showwaves=s=${W}x${H}:mode=cline:colors=${fg}:rate=${fps}:scale=sqrt[w];[bg][w]overlay=shortest=1:format=auto,format=yuv420p[v]`;
  }
  const vcodec = to === 'webm' ? ['-c:v', 'libvpx-vp9', '-crf', String(clamp(opt.num(o.crf, 23) + 8, 0, 63)), '-b:v', '0', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(clamp(opt.num(o.crf, 23), 0, 51)), ...(o.style === 'solid' ? ['-tune', 'stillimage'] : [])];
  const acodec = to === 'webm' ? ['-c:a', 'libopus'] : ['-c:a', 'aac'];
  const args = [...t.inArgs, '-i', input, ...t.outArgs, '-filter_complex', graph, '-map', '[v]', '-map', '0:a:0', ...vcodec, ...acodec, '-b:a', `${opt.num(o.bitrate, 192)}k`, '-shortest'];
  if (['mp4', 'mov'].includes(to)) args.push('-movflags', '+faststart');
  args.push(out);
  await ffmpeg(args, { signal, duration: t.outDur || info?.duration, onProgress: progress });
  return [out];
}

async function convertStill(ctx) {
  const { input, to, o, outDir, baseName, signal, progress } = ctx;
  const out = path.join(outDir, `${baseName}.${to}`);
  const dur = clamp(opt.num(o.duration, 10), 0.5, 3600);
  const fps = clamp(opt.num(o.fps, 25), 1, 60);
  const res = Number(o.resolution) || 0;
  const vf = [];
  if (opt.bool(o.kenBurns)) {
    const h = res || 1080;
    const w = Math.round((h * 16) / 9 / 2) * 2;
    vf.push(`scale=${w * 2}:-2`, `zoompan=z='min(zoom+0.0008,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(dur * fps)}:s=${w}x${h}:fps=${fps}`);
  } else if (res) {
    vf.push(`scale=w='if(gte(iw,ih),-2,${res})':h='if(gte(iw,ih),${res},-2)':flags=lanczos`);
  }
  vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2', 'format=yuv420p');
  const args = ['-loop', '1', '-framerate', String(fps), '-i', input];
  if (opt.bool(o.silentAudio)) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-t', String(dur), '-vf', vf.join(','));
  const crf = String(clamp(opt.num(o.crf, 20), 0, 51));
  if (to === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', String(Math.min(63, Number(crf) + 10)), '-b:v', '0', '-deadline', 'good', '-cpu-used', '5');
  else if (to === 'avi') args.push('-c:v', 'mpeg4', '-q:v', '3', '-vtag', 'xvid');
  else args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-tune', 'stillimage');
  if (opt.bool(o.silentAudio)) args.push('-c:a', to === 'webm' ? 'libopus' : to === 'avi' ? 'libmp3lame' : 'aac', '-shortest');
  if (['mp4', 'mov'].includes(to)) args.push('-movflags', '+faststart');
  args.push(out);
  await ffmpeg(args, { signal, duration: dur, onProgress: progress });
  return [out];
}

async function convert(ctx) {
  const { from, to, info: known } = ctx;
  const mode = modeOf(from, to);
  const info = mode === 'still' ? null : known?.streams ? known : await probe(ctx.input);
  if (!info && mode !== 'still') throw new UserError('This file could not be read as audio or video');
  const t = timing(ctx.o, info);
  switch (mode) {
    case 'audio': return convertAudio(ctx, info, t);
    case 'visualize': return convertVisualize(ctx, info, t);
    case 'still': return convertStill(ctx);
    case 'anim': return convertAnim(ctx, info, t);
    case 'frames': return convertFrames(ctx, info, t);
    default: return convertVideo(ctx, info, t);
  }
}

export default {
  id: 'media',
  label: 'FFmpeg',
  async detect() {
    if (!tools.ffmpeg) return { available: false, note: 'FFmpeg binary not found' };
    const v = await versionOf(tools.ffmpeg, ['-version'], /ffmpeg version (\S+)/);
    await detectHw();
    return { available: !!v, version: v?.replace(/-.*$/, ''), detail: hwCache.length ? `Hardware encoding: ${hwCache.join(', ')}` : 'Software encoding' };
  },
  routes: () => [
    { from: VIDEO_IN, to: [...VIDEO_OUT, ...ANIM_OUT, ...FRAME_OUT, ...AUDIO_OUT], cost: 1, same: true },
    { from: ['gif'], to: [...VIDEO_OUT, 'apng'], cost: 1 },
    { from: ['apng'], to: [...VIDEO_OUT, 'gif', 'webp', ...FRAME_OUT], cost: 1 },
    { from: AUDIO_IN, to: AUDIO_OUT, cost: 1, same: true },
    { from: AUDIO_IN, to: VIS_OUT, cost: 2 },
    { from: STILL_IN, to: ['mp4', 'webm', 'mkv', 'mov', 'avi'], cost: 3 },
  ],
  probe: async (input) => {
    const p = await probe(input);
    if (!p) return {};
    return p;
  },
  probeFormats: () => [...VIDEO_IN, ...AUDIO_IN, 'apng'],
  schema,
  convert,
};
