const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const db = require('../../db');
const onvif = require('../../onvif');
const scheduler = require('../../timeSyncScheduler');

describe('timeSyncScheduler', { concurrency: false }, () => {
  let syncs;
  let sentZones;
  const orig = {};

  beforeEach(() => {
    syncs = 0;
    sentZones = [];
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    orig.getCamera = db.getCamera;
    orig.getOnvifCredentials = db.getOnvifCredentials;
    orig.createCam = onvif.createCam;
    orig.getSystemDateAndTime = onvif.getSystemDateAndTime;
    orig.setSystemDateAndTime = onvif.setSystemDateAndTime;
    db.getCamera = () => ({ id: 1, display_name: 'Test', rtsp_host: 'cam', time_zone: 'Europe/Stockholm' });
    db.getOnvifCredentials = () => ({ port: 80, username: 'u', password: 'p' });
    onvif.createCam = async () => ({});
    onvif.getSystemDateAndTime = async () => new Date();
    onvif.setSystemDateAndTime = async (cam, date, tz) => { syncs++; sentZones.push(tz); return true; };
  });

  afterEach(() => {
    scheduler.stopAll();
    mock.timers.reset();
    Object.assign(db, { getCamera: orig.getCamera, getOnvifCredentials: orig.getOnvifCredentials });
    Object.assign(onvif, {
      createCam: orig.createCam,
      getSystemDateAndTime: orig.getSystemDateAndTime,
      setSystemDateAndTime: orig.setSystemDateAndTime,
    });
  });

  const flush = () => new Promise((r) => setImmediate(r));

  it('syncs shortly after scheduling, not only after the full interval', async () => {
    scheduler.scheduleTimeSync(1, 24);
    mock.timers.tick(60 * 1000);
    await flush();
    assert.strictEqual(syncs, 1);
  });

  it('keeps syncing on the interval', async () => {
    scheduler.scheduleTimeSync(1, 24);
    mock.timers.tick(60 * 1000);
    mock.timers.tick(24 * 60 * 60 * 1000);
    await flush();
    assert.strictEqual(syncs, 2);
  });

  it('stopTimeSync cancels the pending initial sync', async () => {
    scheduler.scheduleTimeSync(1, 24);
    scheduler.stopTimeSync(1);
    mock.timers.tick(25 * 60 * 60 * 1000);
    await flush();
    assert.strictEqual(syncs, 0);
  });

  it('sends the camera time zone as a fixed offset', async () => {
    mock.timers.setTime(Date.parse('2026-01-15T12:00:00Z'));
    scheduler.scheduleTimeSync(1, 24);
    mock.timers.tick(60 * 1000);
    await flush();
    assert.deepStrictEqual(sentZones, ['CET-1']);
  });

  it('re-syncs within an hour of a summer time switch', async () => {
    // Stockholm switches to summer time at 2026-03-29T01:00Z
    mock.timers.setTime(Date.parse('2026-03-28T23:00:00Z'));
    scheduler.scheduleTimeSync(1, 24);
    mock.timers.tick(60 * 1000);
    await flush();
    assert.deepStrictEqual(sentZones, ['CET-1']);
    mock.timers.tick(3 * 60 * 60 * 1000);
    await flush();
    assert.deepStrictEqual(sentZones, ['CET-1', 'CEST-2']);
  });
});
