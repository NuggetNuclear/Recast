// Locates the external programs the engines rely on.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { run } from './util.js';

const require = createRequire(import.meta.url);
const isWin = process.platform === 'win32';

function onPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of isWin && !path.extname(name) ? exts : ['']) {
        const p = path.join(dir, name + ext);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
      }
    }
  }
  return null;
}

function firstExisting(paths) {
  for (const p of paths) {
    if (!p) continue;
    if (p.includes('*')) {
      // Very small glob: only the last-but-one path segment may contain '*'.
      const dir = path.dirname(path.dirname(p));
      const pattern = new RegExp('^' + path.basename(path.dirname(p)).replace(/\*/g, '.*') + '$', 'i');
      try {
        const hits = fs.readdirSync(dir).filter((d) => pattern.test(d)).sort().reverse();
        for (const h of hits) {
          const candidate = path.join(dir, h, path.basename(p));
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {}
      continue;
    }
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LAD = process.env.LOCALAPPDATA || '';

function locate(envVar, names, winPaths = [], unixPaths = []) {
  return firstExisting([process.env[envVar]]) || onPath(names) || firstExisting(isWin ? winPaths : unixPaths);
}

export function findTools() {
  let ffmpeg = process.env.FFMPEG_PATH || null;
  if (!ffmpeg) {
    try { ffmpeg = require('ffmpeg-static'); } catch {}
    if (!ffmpeg || !fs.existsSync(ffmpeg)) ffmpeg = onPath(['ffmpeg']);
  }

  let sevenZip = locate('SEVENZIP_PATH', ['7z', '7zz'], [path.join(PF, '7-Zip', '7z.exe'), path.join(PF86, '7-Zip', '7z.exe')], ['/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7zz']);
  let sevenZipFull = !!sevenZip;
  if (!sevenZip) {
    try { sevenZip = require('7zip-bin').path7za; } catch {}
    if (sevenZip && !isWin) try { fs.chmodSync(sevenZip, 0o755); } catch {}
    sevenZipFull = false;
  }

  const soffice = locate('SOFFICE_PATH', ['soffice', 'libreoffice'], [
    path.join(PF, 'LibreOffice', 'program', 'soffice.exe'),
    path.join(PF86, 'LibreOffice', 'program', 'soffice.exe'),
  ], ['/usr/bin/soffice', '/usr/bin/libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']);

  const pandoc = locate('PANDOC_PATH', ['pandoc'], [path.join(PF, 'Pandoc', 'pandoc.exe'), path.join(LAD, 'Pandoc', 'pandoc.exe')], ['/usr/bin/pandoc', '/usr/local/bin/pandoc', '/opt/homebrew/bin/pandoc']);

  const calibre = locate('CALIBRE_PATH', ['ebook-convert'], [
    path.join(PF, 'Calibre2', 'ebook-convert.exe'),
    path.join(PF86, 'Calibre2', 'ebook-convert.exe'),
  ], ['/usr/bin/ebook-convert', '/Applications/calibre.app/Contents/MacOS/ebook-convert']);

  const magick = locate('MAGICK_PATH', ['magick'], [path.join(PF, 'ImageMagick-*', 'magick.exe')], ['/usr/bin/magick', '/usr/local/bin/magick', '/opt/homebrew/bin/magick']);

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const ytDlp = locate('YTDLP_PATH', ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos'], [
    path.join(LAD, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    path.join(PF, 'yt-dlp', 'yt-dlp.exe'),
    home && path.join(home, 'scoop', 'shims', 'yt-dlp.exe'),
  ], [
    '/usr/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/snap/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    home && path.join(home, '.local', 'bin', 'yt-dlp'),
  ]);

  const assimp = locate('ASSIMP_PATH', ['assimp'], [path.join(PF, 'Assimp', 'bin', 'x64', 'assimp.exe')], ['/usr/bin/assimp', '/usr/local/bin/assimp', '/opt/homebrew/bin/assimp']);

  const browser = locate('BROWSER_PATH', isWin ? [] : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'], [
    path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LAD, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ], [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]);

  let ffprobe = locate('FFPROBE_PATH', ['ffprobe'], [
    path.join(PF, 'ffmpeg', 'bin', 'ffprobe.exe'),
  ], ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', '/opt/homebrew/bin/ffprobe']);
  if (!ffprobe && ffmpeg) {
    const beside = path.join(path.dirname(ffmpeg), isWin ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(beside)) ffprobe = beside;
  }

  return { ffmpeg, ffprobe, sevenZip, sevenZipFull, soffice, pandoc, calibre, magick, browser, ytDlp, assimp };
}

export let tools = findTools();
export function rescanTools() {
  tools = findTools();
  return tools;
}

export async function versionOf(cmd, args = ['--version'], pattern = /(\d+\.\d+(\.\d+)?)/) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeoutMs: 20000, okCodes: [0, 1] });
    return ((stdout || stderr).match(pattern) || [])[1] || 'unknown';
  } catch {
    return null;
  }
}

/** Version of an installed npm package, for display. */
export function pkgVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
  } catch {
    try {
      let dir = path.dirname(require.resolve(name));
      for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
        const p = path.join(dir, 'package.json');
        if (fs.existsSync(p)) {
          const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (pkg.name === name) return pkg.version;
        }
      }
    } catch {}
    return '';
  }
}
