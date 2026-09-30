import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserError } from './util.js';

const blockList = new net.BlockList();
blockList.addSubnet('0.0.0.0', 8, 'ipv4');
blockList.addSubnet('10.0.0.0', 8, 'ipv4');
blockList.addSubnet('100.64.0.0', 10, 'ipv4');
blockList.addSubnet('127.0.0.0', 8, 'ipv4');
blockList.addSubnet('169.254.0.0', 16, 'ipv4');
blockList.addSubnet('172.16.0.0', 12, 'ipv4');
blockList.addSubnet('192.0.0.0', 24, 'ipv4');
blockList.addSubnet('192.168.0.0', 16, 'ipv4');
blockList.addSubnet('198.18.0.0', 15, 'ipv4');
blockList.addSubnet('224.0.0.0', 4, 'ipv4');
blockList.addSubnet('240.0.0.0', 4, 'ipv4');

blockList.addSubnet('::', 128, 'ipv6');
blockList.addSubnet('::1', 128, 'ipv6');
blockList.addSubnet('fc00::', 7, 'ipv6');
blockList.addSubnet('fe80::', 10, 'ipv6');
blockList.addSubnet('ff00::', 8, 'ipv6');

export function extractEmbeddedV4(address) {
  const norm = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const m = norm.match(/^(?:::ffff:(?:0:)?|::ffff:0:0:|64:ff9b::)(.+)$/);
  if (m) {
    const rest = m[1];
    if (net.isIP(rest) === 4) return rest;
    const parts = rest.split(':');
    if (parts.length === 2) {
      const high = parseInt(parts[0], 16);
      const low = parseInt(parts[1], 16);
      if (!Number.isNaN(high) && !Number.isNaN(low) && high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff) {
        const ip = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        if (net.isIP(ip) === 4) return ip;
      }
    }
  }
  return null;
}

export function isPrivateAddress(address) {
  const norm = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = extractEmbeddedV4(norm);
  if (v4) return blockList.check(v4, 'ipv4');
  const ipType = net.isIP(norm);
  if (ipType === 4) return blockList.check(norm, 'ipv4');
  if (ipType === 6) return blockList.check(norm, 'ipv6');
  return true;
}

export async function assertSafeUrl(raw, { lookup = dns.lookup } = {}) {
  let url;
  try { url = raw instanceof URL ? new URL(raw.href) : new URL(String(raw || '').trim()); } catch { throw new UserError('That does not look like a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('Only http and https links are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new UserError('Local network URLs are not allowed');
  const isDirectIp = net.isIP(host) || extractEmbeddedV4(host);
  let addresses;
  if (isDirectIp) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      throw new UserError('Could not resolve hostname');
    }
  }
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
  if (!entry || entry.startsWith('/') || /^[a-zA-Z]:/i.test(entry) || entry.split('/').includes('..')) throw new UserError('The archive contains an unsafe path');
  return path.posix.normalize(entry);
}

export function basicAuthValid(header, user, password) {
  if (!user || !password || typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let supplied;
  try { supplied = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const expected = `${user}:${password}`;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}