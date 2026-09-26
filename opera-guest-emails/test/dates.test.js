import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yesterdayInTz, parseDateArg, formatDate, inferDateFormat, timeInTz } from '../src/dates.js';

test('yesterday in America/Edmonton, across the UTC midnight boundary', () => {
  // 2026-09-26 03:00 UTC is still 2026-09-25 21:00 in Edmonton (MDT, UTC-6)
  assert.deepEqual(yesterdayInTz('America/Edmonton', new Date('2026-09-26T03:00:00Z')), { y: 2026, m: 9, d: 24 });
  assert.deepEqual(yesterdayInTz('America/Edmonton', new Date('2026-03-01T12:00:00Z')), { y: 2026, m: 2, d: 28 });
  assert.equal(timeInTz('America/Edmonton', new Date('2026-09-26T12:30:00Z')), '06:30');
});

test('parseDateArg accepts both formats and rejects bad dates', () => {
  assert.deepEqual(parseDateArg('2026-09-25'), { y: 2026, m: 9, d: 25 });
  assert.deepEqual(parseDateArg('20260925'), { y: 2026, m: 9, d: 25 });
  assert.throws(() => parseDateArg('2026-02-30'));
  assert.throws(() => parseDateArg('25-09-2026'));
});

test('formatDate tokens', () => {
  const d = { y: 2026, m: 9, d: 5 };
  assert.equal(formatDate(d, 'MM-DD-YYYY'), '09-05-2026');
  assert.equal(formatDate(d, 'DD-MMM-YY'), '05-Sep-26');
});

test('inferDateFormat disambiguates with known candidate dates', () => {
  const today = { y: 2026, m: 9, d: 26 };
  const yest = { y: 2026, m: 9, d: 5 };
  assert.equal(inferDateFormat('09-26-2026', [today]), 'MM-DD-YYYY');
  assert.equal(inferDateFormat('26.09.2026', [today]), 'DD.MM.YYYY');
  assert.equal(inferDateFormat('05-09-2026', [today, yest]), 'DD-MM-YYYY');
  assert.equal(inferDateFormat('26-sep-2026', [today]), 'DD-MMM-YYYY');
  assert.equal(inferDateFormat('', [today]), null);
  assert.equal(inferDateFormat('garbage', [today]), null);
});
