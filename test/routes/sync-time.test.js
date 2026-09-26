const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createIsolatedTestDb } = require('../helpers/isolated-db');

let testDb = null;
let onvifCalls = [];

function getDb() {
  return testDb;
}

function setupTestDb() {
  testDb = createIsolatedTestDb();
}

function teardownTestDb() {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
}

async function performTimeSync(camera) {
  const onvif = require('../../onvif');
  const db = require('../../db');
  
  const host = camera.rtsp_host;
  const onvifCreds = db.getOnvifCredentials(camera);
  const cam = await onvif.createCam(host, onvifCreds.port, onvifCreds.username, onvifCreds.password);
  const beforeTime = await onvif.getSystemDateAndTime(cam);
  const serverTime = new Date();
  await onvif.setSystemDateAndTime(cam, serverTime);
  return { beforeTime, serverTime };
}

function mockOnvif() {
  const onvif = require('../../onvif');
  const original = {
    createCam: onvif.createCam,
    getSystemDateAndTime: onvif.getSystemDateAndTime,
    setSystemDateAndTime: onvif.setSystemDateAndTime,
  };
  
  onvifCalls = [];
  
  onvif.createCam = async (host, port, username, password) => {
    onvifCalls.push({ method: 'createCam', args: { host, port, username, password } });
    return { mockCam: true };
  };
  
  onvif.getSystemDateAndTime = async (cam) => {
    onvifCalls.push({ method: 'getSystemDateAndTime', args: { cam } });
    return new Date('2026-01-01T00:00:00Z');
  };
  
  onvif.setSystemDateAndTime = async (cam, date) => {
    onvifCalls.push({ method: 'setSystemDateAndTime', args: { cam, date } });
    return true;
  };
  
  return () => {
    Object.assign(onvif, original);
  };
}

describe('sync-time route logic', { concurrency: false }, () => {
  let restoreOnvif = null;
  
  beforeEach(() => {
    setupTestDb();
    restoreOnvif = mockOnvif();
  });
  
  afterEach(() => {
    teardownTestDb();
    if (restoreOnvif) restoreOnvif();
  });
  
  it('calls ONVIF with correct parameters', async () => {
    const db = getDb();
    const camId = db.createCamera('Test Cam', '192.168.1.100', 554, '/stream1', 'admin', 'secret', '{}', 8899, 'onvifuser', 'onvifpass');
    
    const camera = db.getCamera(camId);
    assert.strictEqual(camera.onvif_username, 'onvifuser', 'ONVIF username should be stored');
    assert.strictEqual(camera.onvif_password, 'onvifpass', 'ONVIF password should be stored');
    
    const result = await performTimeSync(camera);
    
    assert.strictEqual(onvifCalls.length, 3, 'Should call createCam, getSystemDateAndTime, and setSystemDateAndTime');
    
    assert.strictEqual(onvifCalls[0].method, 'createCam');
    assert.strictEqual(onvifCalls[0].args.host, '192.168.1.100');
    assert.strictEqual(onvifCalls[0].args.port, 8899);
    assert.strictEqual(onvifCalls[0].args.username, 'onvifuser');
    assert.strictEqual(onvifCalls[0].args.password, 'onvifpass');
    
    assert.strictEqual(onvifCalls[1].method, 'getSystemDateAndTime');
    assert.deepStrictEqual(onvifCalls[1].args.cam, { mockCam: true });
    
    assert.strictEqual(onvifCalls[2].method, 'setSystemDateAndTime');
    assert.deepStrictEqual(onvifCalls[2].args.cam, { mockCam: true });
    assert.ok(onvifCalls[2].args.date instanceof Date, 'Should pass a Date object');
    
    assert.ok(result.beforeTime instanceof Date);
    assert.ok(result.serverTime instanceof Date);
  });
  
  it('uses RTSP credentials when ONVIF credentials are not set', async () => {
    const db = getDb();
    const camId = db.createCamera('Test Cam', '192.168.1.100', 554, '/stream1', 'rtspuser', 'rtsppass');
    
    const camera = db.getCamera(camId);
    await performTimeSync(camera);
    
    assert.strictEqual(onvifCalls[0].args.username, 'rtspuser');
    assert.strictEqual(onvifCalls[0].args.password, 'rtsppass');
  });
  
  it('propagates ONVIF errors', async () => {
    const db = getDb();
    const onvif = require('../../onvif');
    onvif.createCam = async () => {
      throw new Error('Connection refused');
    };
    
    const camId = db.createCamera('Test Cam', '192.168.1.100', 554, '/stream1', 'admin', 'secret');
    const camera = db.getCamera(camId);
    
    await assert.rejects(
      async () => await performTimeSync(camera),
      { message: 'Connection refused' }
    );
  });
});
