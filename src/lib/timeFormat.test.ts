import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSemver,
  formatDateTimeCN,
  formatTimeCN,
  parseFlexibleTimestamp,
} from './timeFormat';

test('parseFlexibleTimestamp handles Go Unix seconds without falling back to 1970', () => {
  // 2026-11-26T10:39:55Z in Unix seconds
  const sec = 1795603195;
  const d = parseFlexibleTimestamp(sec);
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
  const formatted = formatDateTimeCN(sec);
  assert.ok(formatted.startsWith('2026'), `Expected 2026 date, got: ${formatted}`);
  assert.ok(!formatted.includes('1970'), `Should never format as 1970: ${formatted}`);
});

test('parseFlexibleTimestamp handles numeric string Unix seconds, milliseconds, and ISO strings', () => {
  const fromStrSec = parseFlexibleTimestamp('1795603195');
  assert.equal(fromStrSec?.getUTCFullYear(), 2026);

  const fromMs = parseFlexibleTimestamp(1795603195000);
  assert.equal(fromMs?.getUTCFullYear(), 2026);

  const fromIso = parseFlexibleTimestamp('2026-11-26T18:39:55.000Z');
  assert.equal(fromIso?.getUTCFullYear(), 2026);
  assert.ok(formatTimeCN('2026-11-26T18:39:55.000Z').includes(':'));
});

test('parseFlexibleTimestamp returns fallback dash for zero, empty, or invalid timestamps', () => {
  assert.equal(parseFlexibleTimestamp(0), null);
  assert.equal(parseFlexibleTimestamp(''), null);
  assert.equal(parseFlexibleTimestamp(null), null);
  assert.equal(parseFlexibleTimestamp('not-a-date'), null);
  assert.equal(formatDateTimeCN(0), '—');
  assert.equal(formatTimeCN(undefined), '—');
});

test('compareSemver accurately compares release tags with or without v prefix', () => {
  assert.equal(compareSemver('1.0.0', 'v1.0.1'), -1);
  assert.equal(compareSemver('v1.0.1', '1.0.1'), 0);
  assert.equal(compareSemver('1.2.0', '1.1.9'), 1);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
});
