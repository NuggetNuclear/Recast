import test from 'node:test';
import assert from 'node:assert/strict';
import nodeDns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fetch } from 'undici';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { assertArchiveEntry, assertId, assertIndex, assertSafeUrl, basicAuthValid, isPrivateAddress, safeAgent } from '../server/security.js';
import { getEngine, validateStepOptions, validateEngineSchemaFields } from '../server/registry.js';
import { pdfPageSchema } from '../server/engines/imagepdf.js';
import { startFetch } from '../server/fetch.js';
import { app, verifyHostAndAuth } from '../server/index.js';
import * as store from '../server/jobs.js';
import { run, killAllChildren } from '../server/util.js';
import { dirs } from '../server/config.js';

test('SSRF guard rejects private and loopback destinations', async () => {
  const privateIps = [
    // IPv4 CIDRs
    '0.0.0.0', '0.1.2.3',
    '10.0.0.1', '10.255.255.255',
    '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1', '172.31.255.255',
    '192.0.0.1',
    '192.168.0.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255',
    '224.0.0.1',
    '240.0.0.1', '255.255.255.255',
    // IPv6 CIDRs
    '::', '::1',
    'fc00::1', 'fd00::1',
    'fe80::1',
    'ff02::1',
    // Mapped / translated bypasses
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    // Invalid IP strings
    'not-an-ip',
  ];

  for (const ip of privateIps) {
    assert.equal(isPrivateAddress(ip), true, `Expected ${ip} to be private`);
  }

  // Public IPs must pass
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `Expected ${ip} to be public`);
  }

  // assertSafeUrl URL-level checks
  const blockedUrls = [
    'http://127.0.0.1',
    'http://10.0.0.1',
    'http://[::1]',
    'http://169.254.169.254',
    'http://0.0.0.0',
    'http://0',
    'http://100.64.0.1',
    'http://[::ffff:7f00:1]',
    'http://[64:ff9b::7f00:1]',
    'http://[fc00::1]',
    'http://[fe80::1]',
  ];

  for (const url of blockedUrls) {
    await assert.rejects(assertSafeUrl(url), /Local network/, `Expected ${url} to be rejected`);
  }

  // Public URLs must pass
  await assert.doesNotReject(assertSafeUrl('http://8.8.8.8'));
  await assert.doesNotReject(assertSafeUrl('http://1.1.1.1'));
  await assert.doesNotReject(assertSafeUrl('http://[2606:4700::1111]'));
  await assert.doesNotReject(assertSafeUrl('https://example.test', { lookup: async () => [{ address: '93.184.216.34' }] }));
  await assert.rejects(assertSafeUrl('https://rebound.test', { lookup: async () => [{ address: '127.0.0.1' }] }), /Local network/);
});

test('filesystem identifiers and archive entries are constrained', () => {
  assert.doesNotThrow(() => assertId('184ea42e-0700-4861-86cf-2d5d807a373b'));
  assert.throws(() => assertId('../jobs/x'), /Invalid/);
  assert.throws(() => assertIndex('../0'), /Invalid/);
  assert.throws(() => assertArchiveEntry('../outside.txt'), /unsafe path/);
  assert.throws(() => assertArchiveEntry('/absolute.txt'), /unsafe path/);
  assert.throws(() => assertArchiveEntry('C:/absolute.txt'), /unsafe path/);
  assert.doesNotThrow(() => assertArchiveEntry('folder/file.txt'));
});

test('basic auth is opt-in and constant-time comparable', () => {
  const header = `Basic ${Buffer.from('alice:secret').toString('base64')}`;
  assert.equal(basicAuthValid(header, 'alice', 'secret'), true);
  assert.equal(basicAuthValid(header, 'alice', 'wrong'), false);
  assert.equal(basicAuthValid(header, '', ''), false);
});

test('safeAgent blocks DNS rebinding at connect time', async () => {
  const originalLookup = nodeDns.lookup;
  // Simulates hostname that resolves to 127.0.0.1 at connect time
  nodeDns.lookup = function(h, o, cb) {
    if (typeof o === 'function') { cb = o; o = {}; }
    cb(null, [{ address: '127.0.0.1', family: 4 }]);
  };
  try {
    await assert.rejects(
      fetch('http://rebind-attack.test', { dispatcher: safeAgent }),
      /fetch failed/
    );
  } finally {
    nodeDns.lookup = originalLookup;
  }
});

test('redirect whose Location points at a private IP is rejected', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: 'http://192.168.1.1/secret' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    let current = new URL(`http://127.0.0.1:${port}/redirect`);
    await assert.rejects(async () => {
      for (let i = 0; i <= 5; i++) {
        const r = await fetch(current, { redirect: 'manual', dispatcher: safeAgent });
        if ([301, 302, 303, 307, 308].includes(r.status)) {
          const loc = r.headers.get('location');
          current = await assertSafeUrl(new URL(loc, current));
        }
      }
    }, /Local network URLs are not allowed/);
  } finally {
    server.close();
  }
});

test('engine option schemas are enforced server-side', () => {
  const pandocSchema = getEngine('pandoc').schema({ from: 'md', to: 'html' });

  // 1. Injected pandoc math value is rejected
  assert.throws(
    () => validateStepOptions({ math: '--extract-media=/tmp' }, pandocSchema),
    /Invalid choice for math/
  );

  // 2. Unknown key is dropped
  const cleaned = validateStepOptions({ evilKey: 'injected', standalone: true }, pandocSchema);
  assert.equal(cleaned.evilKey, undefined);
  assert.equal(cleaned.standalone, true);

  // 3. Valid negative number passes
  const mediaSchema = getEngine('media').schema({ from: 'mp3', to: 'mp3' });
  const validNegative = validateStepOptions({ volume: -16 }, mediaSchema);
  assert.equal(validNegative.volume, -16);

  // 4. Out-of-range number fails
  assert.throws(
    () => validateStepOptions({ volume: 100 }, mediaSchema),
    /must be at most/
  );

  // 5. Select and multi return matched option's original value (keeping numbers as numbers)
  const numericSelectGroup = [{
    id: 'test',
    fields: [
      { type: 'select', key: 'level', options: [{ value: 0, label: 'Zero' }, { value: 1, label: 'One' }, { value: 2, label: 'Two' }] },
      { type: 'multi', key: 'modes', options: [{ value: 10, label: 'Ten' }, { value: 20, label: 'Twenty' }] },
    ],
  }];
  const keptNumbers = validateStepOptions({ level: '1', modes: ['10', 20] }, numericSelectGroup);
  assert.equal(keptNumbers.level, 1);
  assert.equal(typeof keptNumbers.level, 'number');
  assert.deepEqual(keptNumbers.modes, [10, 20]);
  assert.equal(typeof keptNumbers.modes[0], 'number');

  // 6. Unknown field type throws at startup naming engine and field type
  assert.throws(
    () => validateEngineSchemaFields('dummyEngine', [{ fields: [{ type: 'fancy_slider', key: 'slider' }] }]),
    /Unknown field type "fancy_slider" in engine "dummyEngine"/
  );

  // 7. /api/merge options are validated
  const mergeSchema = pdfPageSchema({ multi: true });
  assert.throws(
    () => validateStepOptions({ pageSize: 'hacked_paper' }, mergeSchema),
    /Invalid choice for pageSize/
  );
  const validMerge = validateStepOptions({ margin: 5, background: '#000000' }, mergeSchema);
  assert.equal(validMerge.margin, 5);
  assert.equal(validMerge.background, '#000000');

  // 8. /api/uploads/url preference parameter is validated
  assert.throws(
    () => startFetch({ url: 'https://example.com/video.mp4', preference: '--exec=id' }),
    /Invalid preference/
  );
});

test('startup validation refuses non-loopback hosts without auth and partial credentials', () => {
  // 1. Refuses non-loopback host with no creds
  assert.throws(
    () => verifyHostAndAuth('0.0.0.0', '', '', false),
    /Refusing to bind non-loopback host/
  );
  assert.throws(
    () => verifyHostAndAuth('192.168.1.100', '', '', false),
    /Refusing to bind non-loopback host/
  );

  // 2. Refuses with only one credential set
  assert.throws(
    () => verifyHostAndAuth('127.0.0.1', 'user', '', false),
    /Both RECAST_AUTH_USER and RECAST_AUTH_PASSWORD must be set/
  );
  assert.throws(
    () => verifyHostAndAuth('127.0.0.1', '', 'pass', false),
    /Both RECAST_AUTH_USER and RECAST_AUTH_PASSWORD must be set/
  );
  assert.throws(
    () => verifyHostAndAuth('0.0.0.0', 'user', '', false),
    /Both RECAST_AUTH_USER and RECAST_AUTH_PASSWORD must be set/
  );

  // 3. Starts on loopback with no creds
  assert.doesNotThrow(() => verifyHostAndAuth('127.0.0.1', '', '', false));
  assert.doesNotThrow(() => verifyHostAndAuth('localhost', '', '', false));
  assert.doesNotThrow(() => verifyHostAndAuth('::1', '', '', false));

  // 4. Starts on non-loopback with both creds
  assert.doesNotThrow(() => verifyHostAndAuth('0.0.0.0', 'user', 'pass', false));
  assert.doesNotThrow(() => verifyHostAndAuth('192.168.1.100', 'user', 'pass', false));

  // 5. Starts on non-loopback without creds when allowUnauthenticated is true
  assert.doesNotThrow(() => verifyHostAndAuth('0.0.0.0', '', '', true));
});

test('server spawns on random loopback port and responds to /api/health', async () => {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));

  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RECAST_AUTH_USER: '', RECAST_AUTH_PASSWORD: '' },
    stdio: 'pipe',
  });

  try {
    let ok = false;
    let body = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status === 200) {
          body = await res.json();
          ok = true;
          break;
        }
      } catch {}
    }
    assert.equal(ok, true, 'Server failed to respond to /api/health within timeout');
    assert.equal(body?.ok, true);
  } finally {
    child.kill();
  }
});

test('sweep and DELETE /api/uploads/:id protect uploads referenced by queued and processing jobs', async () => {
  await fsp.mkdir(dirs.uploads, { recursive: true });
  const dummyFile = path.join(dirs.uploads, 'test-protect-file.txt');
  await fsp.writeFile(dummyFile, 'content for upload protection test');

  const uploadId = '11111111-1111-4111-8111-111111111111';
  await store.registerUpload({
    id: uploadId,
    filePath: dummyFile,
    name: 'test-protect-file.txt',
    size: 32,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const jobId = '22222222-2222-4222-8222-222222222222';
    // 1. Queued job references the upload: sweep must preserve it, DELETE must return 409
    store.jobs.set(jobId, { id: jobId, status: 'queued', uploadId, createdAt: Date.now() });
    store.uploads.get(uploadId).createdAt = Date.now() - 100_000_000; // simulate old upload

    assert.equal(store.isUploadInUse(uploadId), true);
    await store.sweep();
    assert.ok(store.uploads.has(uploadId), 'sweep() must not delete upload used by queued job');

    const delQueuedRes = await fetch(`http://127.0.0.1:${port}/api/uploads/${uploadId}`, { method: 'DELETE' });
    assert.equal(delQueuedRes.status, 409);
    const delQueuedBody = await delQueuedRes.json();
    assert.match(delQueuedBody.error, /in use/i);
    assert.ok(store.uploads.has(uploadId), 'DELETE must not remove upload while job is queued');

    // 2. Processing job (with uploadIds list, as in merge jobs): sweep preserves, DELETE returns 409
    store.jobs.get(jobId).status = 'processing';
    delete store.jobs.get(jobId).uploadId;
    store.jobs.get(jobId).uploadIds = [uploadId];

    assert.equal(store.isUploadInUse(uploadId), true);
    await store.sweep();
    assert.ok(store.uploads.has(uploadId), 'sweep() must not delete upload used by processing job');

    const delProcRes = await fetch(`http://127.0.0.1:${port}/api/uploads/${uploadId}`, { method: 'DELETE' });
    assert.equal(delProcRes.status, 409);
    assert.ok(store.uploads.has(uploadId));

    // 3. Done job: upload is no longer in use, DELETE returns 200 and removes it
    store.jobs.get(jobId).status = 'done';
    assert.equal(store.isUploadInUse(uploadId), false);

    const delDoneRes = await fetch(`http://127.0.0.1:${port}/api/uploads/${uploadId}`, { method: 'DELETE' });
    assert.equal(delDoneRes.status, 200);
    assert.equal(store.uploads.has(uploadId), false);

    // 4. Repeated DELETE returns 404
    const del404Res = await fetch(`http://127.0.0.1:${port}/api/uploads/${uploadId}`, { method: 'DELETE' });
    assert.equal(del404Res.status, 404);

    store.jobs.delete(jobId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dummyFile, { force: true }).catch(() => {});
  }
});

test('run() terminates child process tree on abort and timeout', async () => {
  // 1. Process tree terminates promptly on abort signal
  const controller = new AbortController();
  const startAbort = Date.now();
  const pAbort = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pAbort, /Cancelled/);
  assert.ok(Date.now() - startAbort < 4000, 'Process was not terminated promptly on abort');

  // 2. Process tree terminates promptly on timeoutMs
  const startTimeout = Date.now();
  const pTimeout = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 150,
  });
  await assert.rejects(pTimeout, /timed out/);
  assert.ok(Date.now() - startTimeout < 4000, 'Process was not terminated promptly on timeout');

  // 3. Process tree with nested child process terminates promptly
  const controllerTree = new AbortController();
  const nestedScript = 'const { spawn } = require("child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]); setInterval(() => {}, 1000);';
  const startTree = Date.now();
  const pTree = run(process.execPath, ['-e', nestedScript], {
    signal: controllerTree.signal,
  });
  setTimeout(() => controllerTree.abort(), 150);
  await assert.rejects(pTree, /Cancelled/);
  assert.ok(Date.now() - startTree < 4000, 'Nested process tree was not terminated promptly on abort');
});




test('killAllChildren() stops every tracked child and its descendants', async () => {
  const pidFile = path.join(os.tmpdir(), `recast-grandchild-${process.pid}.pid`);
  await fsp.rm(pidFile, { force: true });
  const grand = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  const pending = run(process.execPath, ['-e', parent]);
  let grandPid = 0;
  for (let i = 0; i < 100 && !grandPid; i++) {
    await new Promise((r) => setTimeout(r, 100));
    grandPid = Number(await fsp.readFile(pidFile, 'utf8').catch(() => 0));
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    assert.ok(grandPid && alive(grandPid), 'grandchild should be running before shutdown');
    killAllChildren();
    await assert.rejects(pending, /Cancelled|timed out/);
    for (let i = 0; i < 50 && alive(grandPid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(grandPid), false, 'grandchild must not survive killAllChildren()');
  } finally {
    if (alive(grandPid)) process.kill(grandPid, 'SIGKILL');
    await fsp.rm(pidFile, { force: true });
  }
});

test('abortAllJobs() aborts processing jobs and cancels queued ones', () => {
  const controller = new AbortController();
  const running = { id: '33333333-3333-4333-8333-333333333333', status: 'processing', controller };
  const waiting = { id: '44444444-4444-4444-8444-444444444444', status: 'queued', outputs: [], progress: 0 };
  store.jobs.set(running.id, running);
  store.jobs.set(waiting.id, waiting);
  try {
    store.abortAllJobs();
    assert.equal(controller.signal.aborted, true);
    assert.equal(waiting.status, 'cancelled');
  } finally {
    store.jobs.delete(running.id);
    store.jobs.delete(waiting.id);
  }
});

test('docker healthcheck script authenticates against a password-protected server', async () => {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'recast-health-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, RECAST_AUTH_USER: 'probe', RECAST_AUTH_PASSWORD: 'secret' };
  const server = spawn(process.execPath, ['server/index.js'], { env, stdio: 'ignore' });
  const probe = (extraEnv) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['docker/healthcheck.js'], { env: { ...env, ...extraEnv }, stdio: 'ignore' });
    child.on('close', resolve);
  });
  try {
    let code = 1;
    for (let i = 0; i < 50 && code !== 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      code = await probe({});
    }
    assert.equal(code, 0, 'healthcheck must pass when credentials are configured');
    assert.notEqual(await probe({ RECAST_AUTH_PASSWORD: 'wrong' }), 0, 'healthcheck must fail with wrong credentials');
  } finally {
    server.kill();
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
