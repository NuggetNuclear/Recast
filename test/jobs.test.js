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
