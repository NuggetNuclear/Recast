import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { config } from '../server/config.js';
import { initEngines } from '../server/registry.js';
import * as store from '../server/jobs.js';

async function waitFor(job) {
  for (let i = 0; i < 200 && !['done', 'error', 'cancelled'].includes(job.status); i++) await new Promise((r) => setTimeout(r, 50));
  return job;
}

test('an image over the pixel limit fails with a message that names MAX_IMAGE_PIXELS', async () => {
  await initEngines();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'recast-px-'));
  const previous = config.maxPixels;
  try {
    const file = path.join(dir, 'wide.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#123456' } }).png().toFile(file);
    const id = randomUUID();
    await store.registerUpload({ id, filePath: file, name: 'wide.png', size: 1 });
    config.maxPixels = 100;
    const job = await waitFor(store.createJob({ uploadId: id, to: 'jpg', options: [{}] }));
    assert.equal(job.status, 'error');
    assert.match(job.error, /MAX_IMAGE_PIXELS/);
  } finally {
    config.maxPixels = previous;
    for (const j of [...store.jobs.values()]) await store.deleteJob(j.id);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('link probing follows redirects but never into the local network', async () => {
  const { probeKind } = await import('../server/fetch.js');
  const { assertSafeUrl } = await import('../server/security.js');
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { location: '/file' }); return res.end(); }
    if (req.url === '/leak') { res.writeHead(302, { location: 'http://10.0.0.1/secret' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end('%PDF-1.4');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // The test server lives on loopback, so only its own origin is allowed through the guard.
  const assertUrl = async (u) => (new URL(u).port === String(port) ? new URL(u) : assertSafeUrl(u));
  try {
    const signal = new AbortController().signal;
    assert.equal(await probeKind(new URL(`http://127.0.0.1:${port}/go`), signal, { assertUrl }), 'file');
    await assert.rejects(probeKind(new URL(`http://127.0.0.1:${port}/leak`), signal, { assertUrl }), /Local network/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
