// Optional. When yt-dlp is installed, pasted links can be downloaded from YouTube and
// the other sites it supports, then converted like any other file.
import fs from 'node:fs';
import { tools, versionOf } from '../tools.js';

function cookiesConfigured() {
  const cookies = process.env.YTDLP_COOKIES;
  if (!cookies) return false;
  try { return fs.statSync(cookies).isFile(); } catch { return false; }
}

function installCommand() {
  if (process.platform === 'win32') return 'winget install yt-dlp.yt-dlp';
  if (process.platform === 'darwin') return 'brew install yt-dlp';
  return 'mkdir -p ~/.local/bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ~/.local/bin/yt-dlp && chmod +x ~/.local/bin/yt-dlp';
}

export default {
  id: 'ytdlp',
  label: 'yt-dlp',
  optional: {
    install: installCommand(),
    url: 'https://github.com/yt-dlp/yt-dlp/wiki/Installation',
    adds: 'downloads from YouTube and most other sites when you paste a link',
  },
  async detect() {
    if (!tools.ytDlp) return { available: false };
    const version = await versionOf(tools.ytDlp, ['--version']);
    const detail = cookiesConfigured()
      ? 'YouTube and most other sites from a pasted link. A cookies file is configured.'
      : 'YouTube and most other sites from a pasted link.';
    return { available: true, version: version ? `yt-dlp ${version}` : 'yt-dlp', detail };
  },
  routes: () => [],
};
