import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIASES, OUTPUT_ALIASES, detectFormat } from '../server/formats.js';
import { findRoute, initEngines } from '../server/registry.js';

test('format aliases resolve to canonical formats', () => {
  assert.equal(detectFormat('photo.jpeg'), 'jpg');
  assert.equal(detectFormat('bundle.tar.gz'), 'tar.gz');
  assert.equal(ALIASES.jpeg, 'jpg');
  assert.equal(OUTPUT_ALIASES.jfif, 'jpg');
});

test('router chains through a pivot when direct conversion is unavailable', async () => {
  await initEngines();
  const route = findRoute('md', 'png');
  assert.ok(route, 'expected Markdown to PNG route');
  assert.ok(route.steps.length >= 2, 'expected a chained route');
  assert.equal(route.steps[0].from, 'md');
  assert.equal(route.steps.at(-1).to, 'png');
});
