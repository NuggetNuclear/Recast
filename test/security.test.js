import test from 'node:test';
import assert from 'node:assert/strict';
import { assertArchiveEntry, assertId, assertIndex, assertSafeUrl, basicAuthValid } from '../server/security.js';

test('SSRF guard rejects private and loopback destinations', async () => {
  for (const url of ['http://127.0.0.1', 'http://10.0.0.1', 'http://[::1]', 'http://169.254.169.254']) {
    await assert.rejects(assertSafeUrl(url), /Local network/);
  }
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
