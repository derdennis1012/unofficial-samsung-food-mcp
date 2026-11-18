import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { addDays, daysBetween, assertRange, today } from '../src/core/dates.js';
import { toProtoDate, fromProtoDate } from '../src/core/client.js';

test('addDays / daysBetween are pure calendar arithmetic', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365);
  assert.throws(() => addDays('2026-1-1', 1), /invalid date/);
});

test('assertRange enforces order and span', () => {
  assert.equal(assertRange('2026-01-01', '2026-01-07'), 7);
  assert.throws(() => assertRange('2026-01-08', '2026-01-07'), /must not be after/);
  assert.throws(() => assertRange('2026-01-01', '2026-04-01'), /too long/);
  assert.equal(assertRange('2026-01-01', '2026-03-01', 60), 60);
});

test('proto date conversion does not depend on the time zone', () => {
  assert.deepEqual(toProtoDate('2026-03-29'), { year: 2026, month: 3, day: 29 });
  assert.equal(fromProtoDate(toProtoDate('2026-12-05')), '2026-12-05');
  assert.throws(() => toProtoDate('29.03.2026'), /invalid date/);
});

const ZONES = ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe'];

test('today() is the local calendar date and arithmetic survives DST in every zone', () => {
  const code = `
    const { today, addDays, daysBetween } = await import(${JSON.stringify(new URL('../src/core/dates.js', import.meta.url).href)});
    const lateEvening = new Date(2026, 5, 15, 23, 30);   // local 23:30
    const justAfterMidnight = new Date(2026, 5, 16, 0, 30); // local 00:30
    const out = [
      today(lateEvening), today(justAfterMidnight),
      addDays('2026-03-28', 2), addDays('2026-10-24', 2), addDays('2026-04-04', 2),
      daysBetween('2026-03-28', '2026-03-30'), daysBetween('2026-10-24', '2026-10-26'),
    ];
    console.log(JSON.stringify(out));`;
  for (const TZ of ZONES) {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' }));
    assert.deepEqual(out, ['2026-06-15', '2026-06-16', '2026-03-30', '2026-10-26', '2026-04-06', 2, 2], TZ);
  }
});

test('today() default uses the local date of "now"', () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  assert.equal(today(), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
});

test('impossible calendar days are rejected, not rolled over', () => {
  for (const d of ['2026-02-31', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
    assert.throws(() => addDays(d, 0), /invalid date/, d);
    assert.throws(() => toProtoDate(d), /invalid date/, d);
  }
  assert.equal(addDays('2028-02-29', 0), '2028-02-29');
  assert.deepEqual(toProtoDate('2028-02-29'), { year: 2028, month: 2, day: 29 });
});
