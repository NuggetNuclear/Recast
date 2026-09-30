import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const minNode = (range) => {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range || '');
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};

// A dependency whose engines field asks for a newer Node than package.json declares would break
// `npm start` on the oldest supported Node (undici 8 did exactly that while Recast declared Node 20).
test('undici, used by the URL importer, supports the Node version range Recast declares', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const undici = require('undici/package.json');
  const declared = minNode(pkg.engines.node);
  const needed = minNode(undici.engines?.node);
  assert.ok(declared && needed, 'engines ranges should be readable');
  assert.equal(needed[0] <= declared[0], true, `undici ${undici.version} requires Node ${undici.engines.node} but package.json declares ${pkg.engines.node}`);
});
