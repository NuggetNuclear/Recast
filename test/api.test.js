import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetch, FormData } from 'undici';
import sharp from 'sharp';
import { app } from '../server/index.js';
import { initEngines } from '../server/registry.js';
import { tools } from '../server/tools.js';
import { makeCraftedZip, createZip } from './zip-helpers.js';

// These tests go through the real HTTP API: upload, route, job, polling and download.
let server;
let base;
const created = { uploads: [], jobs: [] };

before(async () => {
  await initEngines();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const id of created.jobs) await fetch(`${base}/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
  for (const id of created.uploads) await fetch(`${base}/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function upload(name, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const res = await fetch(`${base}/api/uploads`, { method: 'POST', body: form, headers: { 'x-file-name': encodeURIComponent(name) } });
  assert.equal(res.status, 200, await res.clone().text());
  const up = await res.json();
  created.uploads.push(up.id);
  return up;
}

async function convert(uploadId, to, options) {
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId, to, options }) });
  const body = await res.json();
  if (res.status !== 200) return { status: res.status, body };
  created.jobs.push(body.id);
  let job = body;
  for (let i = 0; i < 300 && !['done', 'error', 'cancelled'].includes(job.status); i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = await (await fetch(`${base}/api/jobs/${body.id}`)).json();
  }
  return { status: 200, job };
}

test('API: upload, convert with UI-shaped options and download a valid JPEG', async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#2266aa' } }).png().toBuffer();
  const up = await upload('photo.png', png);
  assert.equal(up.format, 'png');

  // Build the payload the way form.js does: every field at its default, empty strings where the UI leaves inputs blank.
  const route = await (await fetch(`${base}/api/route?upload=${up.id}&to=jpg`)).json();
  const options = route.steps.map((step) => {
    const values = {};
    for (const g of step.groups) for (const f of g.fields) {
      if (f.default !== undefined) values[f.key] = f.default;
      else if (f.type === 'number' || f.type === 'text') values[f.key] = '';
    }
    return values;
  });
  const { job } = await convert(up.id, 'jpg', options);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputs.length, 1);

  const dl = await fetch(`${base}/api/jobs/${job.id}/download`);
  assert.equal(dl.status, 200);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const meta = await sharp(bytes).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 8, 6]);
});

test('API: an invalid option value is rejected instead of silently replaced', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
  const up = await upload('invalid-option.png', png);
  const res = await convert(up.id, 'jpg', [{ quality: 'not-a-number' }]);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /quality/i);
});

test('API: an archive with a zip-slip entry is rejected', { skip: !tools.sevenZip }, async () => {
  const up = await upload('slip.zip', makeCraftedZip('../../evil.txt', 'payload'));
  const { job } = await convert(up.id, 'tar', [{}]);
  assert.equal(job.status, 'error');
  assert.match(job.error, /unsafe path|outside extraction/i);
});

test('API: an archive above the extraction size cap is rejected', { skip: !tools.sevenZip }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'recast-api-'));
  try {
    const zip = path.join(dir, 'big.zip');
    await createZip(zip, { 'big.bin': Buffer.alloc(200_000) });
    const up = await upload('big.zip', await fsp.readFile(zip));
    process.env.MAX_EXTRACT_MB = '0.05';
    try {
      const { job } = await convert(up.id, 'tar', [{}]);
      assert.equal(job.status, 'error');
      assert.match(job.error, /size exceeds limit/i);
    } finally {
      delete process.env.MAX_EXTRACT_MB;
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
