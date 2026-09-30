import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserError } from './util.js';

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

export function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (net.isIP(normalized) === 4) return PRIVATE_RANGES.some((re) => re.test(normalized));
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  return false;
}

export async function assertSafeUrl(raw, { lookup = dns.lookup } = {}) {
  let url;
  try { url = raw instanceof URL ? new URL(raw.href) : new URL(String(raw || '').trim()); } catch { throw new UserError('That does not look like a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('Only http and https links are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateAddress(host)) throw new UserError('Local network URLs are not allowed');
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new UserError('Local network URLs are not allowed');
  return url;
}

export function assertId(value, label = 'id') {
  const id = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new UserError(`Invalid ${label}`);
  return id;
}

export function assertIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index > 10000) throw new UserError('Invalid file index');
  return index;
}

export function assertOptionValue(value, label = 'option') {
  if (typeof value === 'string' && (value.includes('\u0000') || value.length > 4096)) throw new UserError(`Invalid ${label}`);
  return value;
}

export function validateOptions(value, label = 'option') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item, i) => validateOptions(item, `${label}[${i}]`));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, validateOptions(item, `${label}.${key}`)]));
  return assertOptionValue(value, label);
}

export function assertArchiveEntry(name) {
  const entry = String(name || '').replaceAll('\\', '/');
  if (!entry || entry.startsWith('/') || /^[a-zA-Z]:\//.test(entry) || entry.split('/').includes('..')) throw new UserError('The archive contains an unsafe path');
  return path.posix.normalize(entry);
}

export function basicAuthValid(header, user, password) {
  if (!user || !password || typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let supplied;
  try { supplied = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const expected = `${user}:${password}`;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}