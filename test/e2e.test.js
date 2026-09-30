import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { tools } from '../server/tools.js';
import image from '../server/engines/image.js';
import imagepdf from '../server/engines/imagepdf.js';
import data from '../server/engines/data.js';
import markup from '../server/engines/markup.js';
import media from '../server/engines/media.js';
import subtitle from '../server/engines/subtitle.js';
import archive from '../server/engines/archive.js';

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
