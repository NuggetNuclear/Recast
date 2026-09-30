import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { tools } from '../server/tools.js';
import image from '../server/engines/image.js';
import imagepdf from '../server/engines/imagepdf.js';
import data from '../server/engines/data.js';
import markup from '../server/engines/markup.js';
import media from '../server/engines/media.js';
import subtitle from '../server/engines/subtitle.js';
import archive, { assertSafeExtractedDir } from '../server/engines/archive.js';
import trace from '../server/engines/trace.js';
import font from '../server/engines/font.js';
import sheet from '../server/engines/sheet.js';
import browser from '../server/engines/browser.js';

async function withDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'recast-test-'));
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

const ctx = (input, from, to, outDir, tmpDir) => ({ input, from, to, o: {}, outDir, baseName: 'result', tmpDir, signal: new AbortController().signal, progress() {} });

test('bundled image conversion', () => withDir(async (dir) => {
  const input = path.join(dir, 'input.png');
  await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toFile(input);
  const out = await image.convert(ctx(input, 'png', 'jpg', dir, dir));
  assert.equal(path.extname(out[0]), '.jpg');
}));

test('bundled image to PDF conversion', () => withDir(async (dir) => {
  const input = path.join(dir, 'input.png');
  await sharp({ create: { width: 2, height: 2, channels: 4, background: '#00ff00' } }).png().toFile(input);
  const out = await imagepdf.convert(ctx(input, 'png', 'pdf', dir, dir));
  assert.equal(path.extname(out[0]), '.pdf');
}));

test('bundled data conversion', () => withDir(async (dir) => {
  const input = path.join(dir, 'input.json');
  await fsp.writeFile(input, '{"answer":42}');
  const out = await data.convert(ctx(input, 'json', 'yaml', dir, dir));
  assert.match(await fsp.readFile(out[0], 'utf8'), /answer/);
}));

test('bundled markup conversion', () => withDir(async (dir) => {
  const input = path.join(dir, 'input.md');
  await fsp.writeFile(input, '# Recast');
  const out = await markup.convert(ctx(input, 'md', 'html', dir, dir));
  assert.match(await fsp.readFile(out[0], 'utf8'), /Recast/);
}));

test('bundled subtitle conversion', { skip: !tools.ffmpeg }, () => withDir(async (dir) => {
  const input = path.join(dir, 'input.srt');
  await fsp.writeFile(input, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  const out = await subtitle.convert(ctx(input, 'srt', 'vtt', dir, dir));
  assert.match(await fsp.readFile(out[0], 'utf8'), /WEBVTT/);
}));

test('bundled media conversion', { skip: !tools.ffmpeg }, () => withDir(async (dir) => {
  const input = path.join(dir, 'input.wav');
  await new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', input], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  const out = await media.convert(ctx(input, 'wav', 'mp3', dir, dir));
  assert.equal(path.extname(out[0]), '.mp3');
}));

test('bundled archive conversion when 7-Zip is available', { skip: !tools.sevenZip }, () => withDir(async (dir) => {
  const input = path.join(dir, 'input.txt');
  await fsp.writeFile(input, 'archive me');
  const out = await archive.convert(ctx(input, 'txt', 'zip', dir, dir));
  assert.equal(path.extname(out[0]), '.zip');
}));

function createZip(filePath, entries) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const zip = new ZipArchive();
    output.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(output);
    for (const [name, content] of Object.entries(entries)) {
      zip.append(content, { name });
    }
    zip.finalize();
  });
}

function makeCraftedZip(filename, content) {
  const nameBuf = Buffer.from(filename, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');

  const lfh = Buffer.alloc(30 + nameBuf.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(0, 8);
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(0, 14);
  lfh.writeUInt32LE(dataBuf.length, 18);
  lfh.writeUInt32LE(dataBuf.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  nameBuf.copy(lfh, 30);

  const lfhOffset = 0;

  const cdh = Buffer.alloc(46 + nameBuf.length);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt16LE(0, 12);
  cdh.writeUInt16LE(0, 14);
  cdh.writeUInt32LE(0, 16);
  cdh.writeUInt32LE(dataBuf.length, 20);
  cdh.writeUInt32LE(dataBuf.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30);
  cdh.writeUInt16LE(0, 32);
  cdh.writeUInt16LE(0, 34);
  cdh.writeUInt16LE(0, 36);
  cdh.writeUInt32LE(0, 38);
  cdh.writeUInt32LE(lfhOffset, 42);
  nameBuf.copy(cdh, 46);

  const cdOffset = lfh.length + dataBuf.length;
  const cdSize = cdh.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, dataBuf, cdh, eocd]);
}

test('archive zip to tar round trip', { skip: !tools.sevenZip }, () => withDir(async (dir) => {
  const zipPath = path.join(dir, 'input.zip');
  await createZip(zipPath, { 'hello.txt': 'Hello Recast' });
  const outTar = await archive.convert(ctx(zipPath, 'zip', 'tar', dir, path.join(dir, 't1')));
  assert.equal(path.extname(outTar[0]), '.tar');
  assert.equal(fs.existsSync(outTar[0]), true);

  const outZip = await archive.convert(ctx(outTar[0], 'tar', 'zip', dir, path.join(dir, 't2')));
  assert.equal(path.extname(outZip[0]), '.zip');
  assert.equal(fs.existsSync(outZip[0]), true);
}));

test('archive with zip-slip entry is rejected', { skip: !tools.sevenZip }, () => withDir(async (dir) => {
  const zipPath = path.join(dir, 'slip.zip');
  const buf = makeCraftedZip('../slip.txt', 'evil payload');
  await fsp.writeFile(zipPath, buf);
  await assert.rejects(
    archive.convert(ctx(zipPath, 'zip', 'tar', dir, path.join(dir, 't1'))),
    /unsafe path|outside extraction directory/i
  );
}));

test('archive exceeding file count cap is rejected', { skip: !tools.sevenZip }, () => withDir(async (dir) => {
  const zipPath = path.join(dir, 'many.zip');
  await createZip(zipPath, {
    'f1.txt': '1',
    'f2.txt': '2',
    'f3.txt': '3',
    'f4.txt': '4',
    'f5.txt': '5',
  });
  process.env.MAX_EXTRACT_FILES = '3';
  try {
    await assert.rejects(
      archive.convert(ctx(zipPath, 'zip', 'tar', dir, path.join(dir, 't1'))),
      /too many files/i
    );
  } finally {
    delete process.env.MAX_EXTRACT_FILES;
  }
}));

test('extracted archive containing symlink is rejected', async (t) => {
  if (process.platform === 'win32') {
    try {
      await fsp.symlink('test-target', 'test-link');
      await fsp.unlink('test-link');
    } catch {
      t.skip('Skipping symlink test: Windows requires administrative privileges or Developer Mode to create/extract symlinks');
      return;
    }
  }
  await withDir(async (dir) => {
    const target = path.join(dir, 'target.txt');
    await fsp.writeFile(target, 'target');
    const link = path.join(dir, 'link.txt');
    await fsp.symlink(target, link);
    await assert.rejects(
      assertSafeExtractedDir(dir),
      /symbolic link/i
    );
  });
});

test('assertSafeExtractedDir rejects size limits', () => withDir(async (dir) => {
  const file = path.join(dir, 'test.txt');
  await fsp.writeFile(file, 'hello world content');
  process.env.MAX_EXTRACT_MB = '0.000001';
  try {
    await assert.rejects(
      assertSafeExtractedDir(dir),
      /size exceeds limit/i
    );
  } finally {
    delete process.env.MAX_EXTRACT_MB;
  }
}));

test('archive exceeding uncompressed size cap fast-fails before extraction', { skip: !tools.sevenZip }, () => withDir(async (dir) => {
  const zipPath = path.join(dir, 'large.zip');
  await createZip(zipPath, { 'big.bin': Buffer.alloc(1000) });
  process.env.MAX_EXTRACT_MB = '0.0001';
  try {
    await assert.rejects(
      archive.convert(ctx(zipPath, 'zip', 'tar', dir, path.join(dir, 't1'))),
      /uncompressed size exceeds limit/i
    );
  } finally {
    delete process.env.MAX_EXTRACT_MB;
  }
}));

test('bundled vector conversion (potrace)', () => withDir(async (dir) => {
  const input = path.join(dir, 'input.png');
  await sharp({ create: { width: 10, height: 10, channels: 4, background: '#000000' } }).png().toFile(input);
  const out = await trace.convert(ctx(input, 'png', 'svg', dir, dir));
  assert.equal(path.extname(out[0]), '.svg');
  assert.match(await fsp.readFile(out[0], 'utf8'), /<svg/);
}));

test('bundled font conversion (fonteditor-core)', () => withDir(async (dir) => {
  const sampleWoff2 = path.resolve('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
  const outTtf = await font.convert(ctx(sampleWoff2, 'woff2', 'ttf', dir, dir));
  assert.equal(path.extname(outTtf[0]), '.ttf');
  assert.equal(fs.existsSync(outTtf[0]), true);

  const outWoff = await font.convert(ctx(outTtf[0], 'ttf', 'woff', dir, dir));
  assert.equal(path.extname(outWoff[0]), '.woff');
  assert.equal(fs.existsSync(outWoff[0]), true);
}));

test('bundled spreadsheet conversion (SheetJS)', () => withDir(async (dir) => {
  const input = path.join(dir, 'input.csv');
  await fsp.writeFile(input, 'name,score\nAlice,100\nBob,90\n');
  const out = await sheet.convert(ctx(input, 'csv', 'xlsx', dir, dir));
  assert.equal(path.extname(out[0]), '.xlsx');
  assert.equal(fs.existsSync(out[0]), true);
}));

test('bundled video media conversion', { skip: !tools.ffmpeg }, () => withDir(async (dir) => {
  const input = path.join(dir, 'input.mkv');
  await new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:size=64x64:duration=0.5:rate=10', input], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  const out = await media.convert(ctx(input, 'mkv', 'mp4', dir, dir));
  assert.equal(path.extname(out[0]), '.mp4');
  assert.equal(fs.existsSync(out[0]), true);
}));

test('bundled browser html to pdf conversion', async (t) => {
  const detection = await browser.detect();
  if (!detection.available) {
    t.skip(`Skipping browser test: ${detection.note || 'No Chromium-based browser found'}`);
    return;
  }
  await withDir(async (dir) => {
    const input = path.join(dir, 'input.html');
    await fsp.writeFile(input, '<h1>Recast PDF Test</h1><p>Rendering via Chromium</p>');
    try {
      const out = await browser.convert(ctx(input, 'html', 'pdf', dir, dir));
      assert.equal(path.extname(out[0]), '.pdf');
      assert.equal(fs.existsSync(out[0]), true);
    } finally {
      await browser.shutdown();
    }
  });
});



test('browser rendering cannot reach the network, including WebSockets', async (t) => {
  const detection = await browser.detect();
  if (!detection.available) {
    t.skip(`Skipping browser test: ${detection.note || 'No Chromium-based browser found'}`);
    return;
  }
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(`HTTP ${req.url}`); res.end('ok'); });
  server.on('upgrade', (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await withDir(async (dir) => {
      const input = path.join(dir, 'probe.html');
      await fsp.writeFile(input, `<h1>probe</h1><script>
        try { new WebSocket('ws://127.0.0.1:${port}/ws'); } catch (e) {}
        fetch('http://127.0.0.1:${port}/fetch').catch(() => {});
        new Image().src = 'http://127.0.0.1:${port}/img';
      </script>`);
      await browser.convert({ ...ctx(input, 'html', 'pdf', dir, dir), o: { waitMs: 1500 } });
    });
  } finally {
    await browser.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(hits, [], 'the rendered page must not connect to local servers');
});
