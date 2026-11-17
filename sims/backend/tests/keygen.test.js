'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { generateKey, normalizeKey, KEY_REGEX, ALPHABET, PREFIXES } = require('../src/utils/keygen');

test('alphabet has 32 unambiguous symbols (no 0, 1, I, O)', () => {
  assert.equal(ALPHABET.length, 32);
  assert.equal(new Set(ALPHABET).size, 32);
  assert.ok(!/[01IO]/.test(ALPHABET));
});

test('generated keys match PFX-XXXX-XXXX for every prefix', () => {
  for (const prefix of Object.values(PREFIXES)) {
    const k = generateKey(prefix);
    assert.match(k, KEY_REGEX);
    assert.ok(k.startsWith(`${prefix}-`));
  }
  assert.throws(() => generateKey('XXX'));
});

test('keys are unique across 20,000 draws and use the whole alphabet', () => {
  const seen = new Set();
  const symbols = new Set();
  for (let i = 0; i < 20000; i++) {
    const k = generateKey('CLS');
    seen.add(k);
    for (const ch of k.slice(4).replace('-', '')) symbols.add(ch);
  }
  assert.equal(seen.size, 20000);
  assert.equal(symbols.size, 32);
});

test('normalizeKey tolerates case, spaces and missing hyphens, rejects junk', () => {
  assert.equal(normalizeKey('  cls-8f3k-92qa '), 'CLS-8F3K-92QA');
  assert.equal(normalizeKey('CLS8F3K92QA'), 'CLS-8F3K-92QA');
  assert.equal(normalizeKey('cls 8f3k 92qa'), 'CLS-8F3K-92QA');
  assert.equal(normalizeKey('CLS-8F3K-92Q'), null);        // too short
  assert.equal(normalizeKey('XYZ-8F3K-92QA'), null);       // unknown prefix
  assert.equal(normalizeKey('CLS-8F3K-92Q0'), null);       // 0 is not in the alphabet
  assert.equal(normalizeKey("CLS-8F3K-92QA'; DROP TABLE"), null);
  assert.equal(normalizeKey(null), null);
  assert.equal(normalizeKey({}), null);
});

test('JS key pattern and the schema.sql CHECK constraint are the same regex', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8');
  const m = sql.match(/key_value ~ '([^']+)'/);
  assert.ok(m, 'CHECK constraint not found in schema.sql');
  assert.equal(m[1], KEY_REGEX.source.replace(/\\/g, ''));
});
