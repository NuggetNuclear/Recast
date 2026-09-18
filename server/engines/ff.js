// Shared FFmpeg helpers: running with progress, and probing media files.
import { tools } from '../tools.js';
import { run, UserError } from '../util.js';

/**
 * Run ffmpeg. `duration` (seconds) enables fractional progress reporting.
 */
export async function ffmpeg(args, { signal, duration, onProgress, cwd } = {}) {
  if (!tools.ffmpeg) throw new UserError('FFmpeg is not available');
  const full = ['-hide_banner', '-nostdin', '-y', ...(onProgress && duration ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
  let buf = '';
  return run(tools.ffmpeg, full, {
    signal,
    cwd,
    errorMessage: 'FFmpeg could not convert this file',
    onStdout: onProgress && duration ? (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / duration));
      }
    } : undefined,
  }).catch((err) => {
    throw refineError(err);
  });
}

function refineError(err) {
  const d = err.details || '';
  const rules = [
    [/Invalid data found when processing input|moov atom not found|could not find codec parameters/i, 'The file seems to be damaged or is not a supported media file'],
    [/does not contain any stream|Output file .* does not contain any stream|matches no streams/i, 'The input has no stream that fits this output (e.g. no audio track, or no subtitles)'],
    [/Subtitle encoding currently only possible from text to text or bitmap to bitmap/i, 'Image-based subtitles (DVD/Blu-ray) cannot be converted to text subtitles'],
    [/width not divisible by 2|height not divisible by 2/i, 'The chosen codec needs even width and height'],
    [/Could not open encoder before EOF|Error while opening encoder|Error initializing output stream/i, 'The encoder rejected these settings — try a different codec, sample rate or resolution'],
    [/Unknown encoder|Encoder not found/i, 'This codec is not available in the bundled FFmpeg build'],
    [/No such filter|Error parsing filterchain|Invalid argument.*filter/i, 'One of the filter settings is invalid'],
    [/Conversion failed!/i, null],
  ];
  for (const [re, msg] of rules) {
    if (msg && re.test(d)) {
      err.message = msg;
      break;
    }
  }
  return err;
}

const hms = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/** Probe a media file by parsing `ffmpeg -i` output. */
export async function probe(input) {
  if (!tools.ffmpeg) return null;
  let text = '';
  try {
    const r = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-i', input], { okCodes: [0, 1], timeoutMs: 20000 });
    text = r.stderr;
  } catch {
    return null;
  }
  const info = { streams: [], video: null, audio: [], subtitles: [] };
  const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) info.duration = hms(dur[1], dur[2], dur[3]);
  const br = text.match(/bitrate: (\d+) kb\/s/);
  if (br) info.bitrate = Number(br[1]);
  const fmt = text.match(/Input #0, ([^,]+(?:,[^,]+)*?), from/);
  if (fmt) info.container = fmt[1];
  const title = text.match(/^\s{4}title\s*:\s*(.+)$/m);
  if (title) info.title = title[1].trim();

  const re = /Stream #0:(\d+)(?:\[0x[0-9a-f]+\])?(?:\(([\w-]+)\))?: (Video|Audio|Subtitle|Data|Attachment): ([^\r\n]*)/g;
  let m;
  let aIdx = 0;
  let sIdx = 0;
  while ((m = re.exec(text))) {
    const [, index, lang, kind, rest] = m;
    const codec = rest.split(/[\s,(]/)[0];
    const s = { index: Number(index), lang: lang && lang !== 'und' ? lang : null, kind: kind.toLowerCase(), codec };
    if (kind === 'Video') {
      const res = rest.match(/, (\d{2,5})x(\d{2,5})/);
      if (res) { s.width = Number(res[1]); s.height = Number(res[2]); }
      const fps = rest.match(/([\d.]+) fps/) || rest.match(/([\d.]+) tbr/);
      if (fps) s.fps = Number(fps[1]);
      s.attachedPic = /\(attached pic\)/.test(rest);
      if (!info.video && !s.attachedPic) info.video = s;
      if (s.attachedPic) info.coverArt = true;
    } else if (kind === 'Audio') {
      const hz = rest.match(/(\d+) Hz/);
      if (hz) s.sampleRate = Number(hz[1]);
      const ch = rest.match(/Hz, ([^,]+)/);
      if (ch) s.layout = ch[1].trim();
      s.channels = /mono/.test(s.layout || '') ? 1 : /stereo/.test(s.layout || '') ? 2 : Number(((s.layout || '').match(/(\d)\.(\d)/) || [])[1] || 0) + Number(((s.layout || '').match(/(\d)\.(\d)/) || [])[2] || 0) || undefined;
      s.order = aIdx++;
      info.audio.push(s);
    } else if (kind === 'Subtitle') {
      s.order = sIdx++;
      s.bitmap = /dvd_subtitle|hdmv_pgs|pgssub|dvb_subtitle|xsub/i.test(codec);
      info.subtitles.push(s);
    }
    info.streams.push(s);
  }
  if (!info.streams.length && !info.duration) return null;
  return info;
}

/** Escape a path for use inside an ffmpeg filter argument (e.g. subtitles=...). */
export function filterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/,/g, '\\,');
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
