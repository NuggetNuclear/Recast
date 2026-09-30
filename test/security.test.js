import test from 'node:test';
import assert from 'node:assert/strict';
import nodeDns from 'node:dns';
import http from 'node:http';
import { fetch } from 'undici';
import { assertArchiveEntry, assertId, assertIndex, assertSafeUrl, basicAuthValid, isPrivateAddress, safeAgent } from '../server/security.js';
import { getEngine, validateStepOptions } from '../server/registry.js';

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
});

