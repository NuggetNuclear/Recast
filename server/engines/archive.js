// Archives via 7-Zip: repack between formats, or compress any file.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { f, group } from '../schema.js';
import { tools, versionOf } from '../tools.js';
import { run, UserError, opt, clamp, ensureDir } from '../util.js';
import { assertArchiveEntry } from '../security.js';

const ARCHIVE_IN_BASE = ['zip', '7z', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'gz', 'bz2', 'xz', 'iso', 'cab', 'wim', 'lzh', 'arj', 'cpio', 'rpm', 'deb', 'jar', 'apk', 'z', 'cbz', 'lzma'];
const ARCHIVE_IN_FULL = ['rar', 'cbr', 'zst', 'lz', 'dmg', 'vhd', 'vhdx', 'vmdk', 'msi', 'xar', 'squashfs'];
const PACK_OUT = ['zip', '7z', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz'];
const SINGLE_OUT = ['gz', 'bz2', 'xz'];

const archiveInputs = () => [...ARCHIVE_IN_BASE, ...(tools.sevenZipFull ? ARCHIVE_IN_FULL : [])];

function sevenZip(args, { signal, progress, cwd } = {}) {
  return run(tools.sevenZip, ['-y', '-bb0', '-bsp1', '-sccUTF-8', ...args], {
    signal,
    cwd,
    errorMessage: '7-Zip could not process this archive',
    onStdout: progress ? (s) => {
      const m = s.match(/(\d{1,3})%/g);
      if (m) progress(Number(m[m.length - 1].replace('%', '')) / 100);
    } : undefined,
  }).catch((e) => {
    if (/Wrong password|Can not open encrypted archive|encrypted/i.test(e.details || '')) throw new UserError('This archive is password-protected — enter the password in the settings');
    if (/Can not open the file as archive|is not archive|Unexpected end/i.test(e.details || '')) throw new UserError('The archive is damaged or not in a supported format');
    throw e;
  });
}

function schema({ from, to }) {
  const fields = [];
  const isArchive = archiveInputs().includes(from);
  if (isArchive) fields.push(f.text('inPassword', 'Archive password', { secret: true, placeholder: 'only if protected' }));
  if (!SINGLE_OUT.includes(to) && to !== 'tar') {
    fields.push(f.select('level', 'Compression', [
      { value: '0', label: 'Store (no compression)' }, { value: '1', label: 'Fastest' }, { value: '3', label: 'Fast' },
      { value: '5', label: 'Normal' }, { value: '7', label: 'Maximum' }, { value: '9', label: 'Ultra' },
    ], '5'));
  } else if (SINGLE_OUT.includes(to)) {
    fields.push(f.select('level', 'Compression', [{ value: '1', label: 'Fastest' }, { value: '5', label: 'Normal' }, { value: '9', label: 'Maximum' }], '5'));
  }
  if (to === 'zip') {
    fields.push(
      f.select('method', 'Method', [{ value: 'Deflate', label: 'Deflate (most compatible)' }, { value: 'Deflate64', label: 'Deflate64' }, { value: 'BZip2', label: 'BZip2' }, { value: 'LZMA', label: 'LZMA' }, { value: 'PPMd', label: 'PPMd (text)' }], 'Deflate'),
      f.text('password', 'Password', { secret: true, placeholder: 'none' }),
      f.select('zipCrypto', 'Encryption', [{ value: 'AES256', label: 'AES-256' }, { value: 'ZipCrypto', label: 'ZipCrypto (legacy, most compatible)' }], 'AES256', { showIf: { password: { truthy: true } } }),
    );
  }
  if (to === '7z') {
    fields.push(
      f.select('method', 'Method', [{ value: 'LZMA2', label: 'LZMA2' }, { value: 'LZMA', label: 'LZMA' }, { value: 'PPMd', label: 'PPMd (text)' }, { value: 'BZip2', label: 'BZip2' }], 'LZMA2'),
      f.toggle('solid', 'Solid archive', true, { help: 'Better compression for many small files.' }),
      f.text('password', 'Password', { secret: true, placeholder: 'none' }),
      f.toggle('encryptNames', 'Encrypt file names', true, { showIf: { password: { truthy: true } } }),
    );
  }
  return fields.length ? [group('archive', `${to.toUpperCase()} archive`, fields)] : [];
}

async function listFiles(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) out.push(e.name);
  return out;
}

async function assertSafeArchive(input, password) {
  const { stdout } = await run(tools.sevenZip, ['l', '-slt', `-p${password || 'none'}`, '-sccUTF-8', input], { timeoutMs: 30000, okCodes: [0, 1, 2] });
  const parts = stdout.split(/^-{10,}\r?\n/m);
  const entriesText = parts.slice(1).join('\n');
  for (const line of entriesText.split(/\r?\n/)) if (line.startsWith('Path = ')) assertArchiveEntry(line.slice(7));
}

async function convert({ input, from, to, o, outDir, baseName, tmpDir, signal, progress, originalName }) {
  if (!tools.sevenZip) throw new UserError('7-Zip is not available');
  const out = path.join(outDir, `${baseName}.${to}`);
  const level = String(clamp(opt.num(o.level, 5), 0, 9));
  const isArchive = archiveInputs().includes(from);

  // Single-stream compression of any file (e.g. report.pdf → report.pdf.gz).
  if (SINGLE_OUT.includes(to)) {
    const type = { gz: 'gzip', bz2: 'bzip2', xz: 'xz' }[to];
    const named = path.join(outDir, `${originalName || path.basename(input)}.${to}`);
    await sevenZip(['a', `-t${type}`, `-mx=${level}`, named, input], { signal, progress });
    return [named];
  }

  // 1. Gather the content to pack.
  const content = path.join(tmpDir, 'content');
  await ensureDir(content);
  if (isArchive) {
    const password = opt.str(o.inPassword);
    await assertSafeArchive(input, password);
    const pw = `-p${password || 'none'}`;
    await sevenZip(['x', pw, `-o${content}`, input], { signal, progress: (p) => progress(p * 0.45) });
    // Compressed tarballs extract to a .tar first — unpack that too.
    const first = await listFiles(content);
    if (first.length === 1 && /\.tar$/i.test(first[0]) && /^(tar\.|gz|bz2|xz|z|zst)/.test(from)) {
      const tarPath = path.join(content, first[0]);
      await assertSafeArchive(tarPath);
      await sevenZip(['x', `-o${content}`, tarPath], { signal });
      await fsp.rm(tarPath, { force: true });
    }
  } else {
    await fsp.copyFile(input, path.join(content, originalName || path.basename(input)));
  }
  const entries = await listFiles(content);
  if (!entries.length) throw new UserError('The archive is empty');

  // 2. Pack.
  const packProgress = (p) => progress(0.5 + p * 0.5);
  if (to === 'zip' || to === '7z') {
    const args = ['a', `-t${to}`, `-mx=${level}`];
    const pw = opt.str(o.password);
    if (to === 'zip') {
      args.push(`-mm=${o.method || 'Deflate'}`, '-mcu=on');
      if (pw) args.push(`-p${pw}`, `-mem=${o.zipCrypto === 'ZipCrypto' ? 'ZipCrypto' : 'AES256'}`);
    } else {
      args.push(`-m0=${o.method || 'LZMA2'}`, `-ms=${opt.bool(o.solid, true) ? 'on' : 'off'}`, '-mmt=on');
      if (pw) args.push(`-p${pw}`, `-mhe=${opt.bool(o.encryptNames, true) ? 'on' : 'off'}`);
    }
    args.push(out, '*');
    await sevenZip(args, { signal, progress: packProgress, cwd: content });
    return [out];
  }
  const tarPath = to === 'tar' ? out : path.join(tmpDir, `${baseName}.tar`);
  await sevenZip(['a', '-ttar', tarPath, '*'], { signal, progress: to === 'tar' ? packProgress : (p) => progress(0.5 + p * 0.2), cwd: content });
  if (to === 'tar') return [out];
  const type = { 'tar.gz': 'gzip', 'tar.bz2': 'bzip2', 'tar.xz': 'xz' }[to];
  await sevenZip(['a', `-t${type}`, `-mx=${level}`, out, tarPath], { signal, progress: (p) => progress(0.7 + p * 0.3) });
  return [out];
}

async function probe(input, from) {
  if (!archiveInputs().includes(from) || !tools.sevenZip) return {};
  try {
    const { stdout } = await run(tools.sevenZip, ['l', '-slt', '-pnone', '-sccUTF-8', input], { timeoutMs: 20000, okCodes: [0, 1, 2] });
    const files = (stdout.match(/^Folder = -$/gm) || []).length;
    const encrypted = /^Encrypted = \+$/m.test(stdout);
    return { files, encrypted };
  } catch {
    return {};
  }
}

export default {
  id: 'archive',
  label: '7-Zip',
  async detect() {
    if (!tools.sevenZip) return { available: false, note: '7-Zip not found' };
    const v = await versionOf(tools.sevenZip, [], /7-Zip(?: \(a\))?\s+([\d.]+)/);
    return { available: true, version: `7-Zip ${v || ''}`.trim(), detail: tools.sevenZipFull ? 'Full edition (RAR supported)' : 'Standalone edition (no RAR)' };
  },
  routes: () => [
    { from: archiveInputs(), to: PACK_OUT, cost: 1, same: true },
    { from: ['*'], to: [...PACK_OUT, ...SINGLE_OUT], cost: 5 },
  ],
  probe,
  probeFormats: () => archiveInputs(),
  schema,
  convert,
};
