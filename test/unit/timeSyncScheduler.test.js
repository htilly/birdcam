const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const db = require('../../db');
const onvif = require('../../onvif');
const scheduler = require('../../timeSyncScheduler');

describe('timeSyncScheduler', { concurrency: false }, () => {
  let syncs;
  const orig = {};

  beforeEach(() => {
    syncs = 0;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    orig.getCamera = db.getCamera;
    orig.getOnvifCredentials = db.getOnvifCredentials;
    orig.createCam = onvif.createCam;
    orig.getSystemDateAndTime = onvif.getSystemDateAndTime;
    orig.setSystemDateAndTime = onvif.setSystemDateAndTime;
    db.getCamera = () => ({ id: 1, display_name: 'Test', rtsp_host: 'cam' });
    db.getOnvifCredentials = () => ({ port: 80, username: 'u', password: 'p' });
    onvif.createCam = async () => ({});
    onvif.getSystemDateAndTime = async () => new Date();
    onvif.setSystemDateAndTime = async () => { syncs++; return true; };
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
});
