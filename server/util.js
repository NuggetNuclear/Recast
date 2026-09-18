import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** An error whose message is safe and useful to show to the user. */
export class UserError extends Error {
  constructor(message, details) {
    super(message);
    this.userFacing = true;
    this.details = details;
  }
}

/**
 * Spawn a process and collect its output.
 * Rejects with a UserError carrying the stderr tail when the exit code is non-zero.
 */
export function run(cmd, args, { cwd, signal, onStdout, onStderr, env, timeoutMs, errorMessage, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UserError('Cancelled'));
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let killedByUs = false;
    const cap = (s, add) => (s.length > 200_000 ? s.slice(-100_000) : s) + add;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout = cap(stdout, s);
      onStdout?.(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr = cap(stderr, s);
      onStderr?.(s);
    });
    const kill = () => {
      killedByUs = true;
      try { child.kill('SIGKILL'); } catch {}
    };
    signal?.addEventListener('abort', kill, { once: true });
    const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null;
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new UserError(`Could not start ${path.basename(cmd)}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (killedByUs) return reject(new UserError(signal?.aborted ? 'Cancelled' : 'The conversion timed out'));
      if (okCodes.includes(code)) return resolve({ code, stdout, stderr });
      const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-25).join('\n');
      reject(new UserError(errorMessage || `${path.basename(cmd)} exited with code ${code}`, tail));
    });
  });
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
}

export async function fileSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** Make a filename safe for every OS while keeping it readable. */
export function safeName(name, fallback = 'file') {
  const base = String(name || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return base || fallback;
}

/** "01:02:03.5", "2:03", "93.2" → seconds. Returns null for empty input. */
export function parseTime(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n)) || parts.length > 3) throw new UserError(`Invalid time "${s}". Use hh:mm:ss or seconds.`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "1-3, 5, 8-" with a page count → zero-based sorted unique indices. Empty → all pages. */
export function parsePageRange(spec, count) {
  const s = String(spec ?? '').trim();
  if (!s) return Array.from({ length: count }, (_, i) => i);
  const out = new Set();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : count;
      for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= count) out.add(n - 1);
    } else if (part.toLowerCase() === 'odd' || part.toLowerCase() === 'even') {
      for (let i = part.toLowerCase() === 'odd' ? 1 : 2; i <= count; i += 2) out.add(i - 1);
    } else {
      throw new UserError(`Invalid page range "${part}". Use e.g. 1-3, 5, 8-`);
    }
  }
  const pages = [...out].sort((a, b) => a - b);
  if (!pages.length) throw new UserError(`The page range "${s}" selects no pages (document has ${count}).`);
  return pages;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Coerce option values coming from JSON/forms. */
export const opt = {
  num(v, d = undefined) {
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  },
  bool(v, d = false) {
    if (v === undefined || v === null || v === '') return d;
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  },
  str(v, d = '') {
    if (v === undefined || v === null) return d;
    return String(v);
  },
};

export function hexToRgb(hex, alpha = 1) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), alpha };
}

export function stripExt(name) {
  return name.replace(/\.(tar\.(gz|bz2|xz|zst))$/i, '').replace(/\.[^.]+$/, '');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
