const { describe, it } = require('node:test');
const assert = require('node:assert');

const timeZone = require('../../timeZone');

const winter = new Date('2026-01-15T12:00:00Z');
const summer = new Date('2026-07-15T12:00:00Z');

describe('timeZone', () => {
  it('gives Stockholm a fixed offset that follows summer/winter time', () => {
    assert.strictEqual(timeZone.posixFixedOffset('Europe/Stockholm', winter), 'CET-1');
    assert.strictEqual(timeZone.posixFixedOffset('Europe/Stockholm', summer), 'CEST-2');
    assert.strictEqual(timeZone.offsetMinutes('Europe/Stockholm', winter), 60);
    assert.strictEqual(timeZone.offsetMinutes('Europe/Stockholm', summer), 120);
  });

  it('handles west-of-UTC, half-hour and zero offsets', () => {
    assert.strictEqual(timeZone.posixFixedOffset('America/New_York', winter), 'UTC5');
    assert.strictEqual(timeZone.posixFixedOffset('Asia/Kolkata', winter), 'UTC-5:30');
    assert.strictEqual(timeZone.posixFixedOffset('UTC', winter), 'UTC0');
    assert.strictEqual(timeZone.posixFixedOffset('Europe/London', winter), 'GMT0');
  });

  it('falls back to the server zone for empty or invalid zones', () => {
    assert.strictEqual(timeZone.resolveTimeZone('Europe/Helsinki'), 'Europe/Helsinki');
    assert.strictEqual(timeZone.resolveTimeZone(null), timeZone.resolveTimeZone(''));
    assert.strictEqual(timeZone.isValidTimeZone('Not/AZone'), false);
    assert.notStrictEqual(timeZone.resolveTimeZone('Not/AZone'), 'Not/AZone');
  });

  it('lists zones including UTC', () => {
    const zones = timeZone.listTimeZones();
    assert.ok(zones.includes('UTC'));
    assert.ok(zones.includes('Europe/Stockholm'));
  });
});
