import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  todayLocal, addDays, addMonths, addInterval, daysBetween,
  daysInMonth, monthKey, effectiveMonth, parseYmd,
} from './dates.js';

// Each test file runs in its own process, so switching TZ here is isolated.
function inTz(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { process.env.TZ = prev; }
}

test('todayLocal uses local date parts, not UTC (evening boundary)', () => {
  // 03:00 UTC on Nov 17 is 8pm on Nov 16 in Denver.
  inTz('America/Denver', () => {
    const now = new Date(Date.UTC(2026, 10, 17, 3, 0));
    assert.equal(now.toISOString().slice(0, 10), '2026-11-17'); // the bug we avoid
    assert.equal(todayLocal(now), '2026-11-16');
  });
});

test('todayLocal uses local date parts, not UTC (morning boundary)', () => {
  // 20:00 UTC on Nov 16 is 9am on Nov 17 in Auckland.
  inTz('Pacific/Auckland', () => {
    const now = new Date(Date.UTC(2026, 10, 16, 20, 0));
    assert.equal(todayLocal(now), '2026-11-17');
  });
});

test('todayLocal at 23:59 local is still that day in any timezone', () => {
  assert.equal(todayLocal(new Date(2026, 10, 16, 23, 59)), '2026-11-16');
});

test('parseYmd rejects malformed and impossible dates', () => {
  assert.deepEqual(parseYmd('2026-02-28'), { y: 2026, m: 2, d: 28 });
  assert.throws(() => parseYmd('2026-2-28'));
  assert.throws(() => parseYmd('2026-02-29'));
  assert.throws(() => parseYmd('2026-13-01'));
  assert.throws(() => parseYmd(null));
});

test('daysInMonth handles leap years', () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
});

test('addMonths clamps to month end', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-03-15', -3), '2025-12-15');
});

test('addMonths with an anchor day restores the day after a short month', () => {
  assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(addMonths('2026-03-31', 1, 31), '2026-04-30');
});

test('addDays crosses month, year and DST boundaries', () => {
  inTz('America/Denver', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // US DST starts
    assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // US DST ends
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});

test('addInterval covers every billing interval', () => {
  assert.equal(addInterval('2026-12-28', 'weekly'), '2027-01-04');
  assert.equal(addInterval('2026-11-16', 'monthly'), '2026-12-16');
  assert.equal(addInterval('2026-11-30', 'quarterly'), '2027-02-28');
  assert.equal(addInterval('2028-02-29', 'annual'), '2029-02-28');
  assert.equal(addInterval('2026-11-16', 'monthly', 3), '2027-02-16');
  assert.throws(() => addInterval('2026-11-16', 'yearly'));
});

test('daysBetween is b minus a in whole days', () => {
  assert.equal(daysBetween('2026-11-16', '2026-11-30'), 14);
  assert.equal(daysBetween('2026-11-30', '2026-11-16'), -14);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  inTz('America/Denver', () => {
    assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31); // spans DST start
  });
});

test('monthKey returns YYYY-MM', () => {
  assert.equal(monthKey('2026-11-16'), '2026-11');
});

test('effectiveMonth: current year uses today, past is 12, future is 0', () => {
  assert.equal(effectiveMonth(2026, '2026-11-16'), 11);
  assert.equal(effectiveMonth(2026, '2026-01-01'), 1);
  assert.equal(effectiveMonth(2025, '2026-11-16'), 12);
  assert.equal(effectiveMonth(2027, '2026-11-16'), 0);
});
