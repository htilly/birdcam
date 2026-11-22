const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const childProcess = require('child_process');

const streamManager = require('../../streamManager');
const db = require('../../db');

const FRAME_BYTES = 320 * 180;

// Fake motion.py child: records frames written to its stdin.
function fakeProc() {
  const p = new EventEmitter();
  p.stdin = new PassThrough();
  p.received = [];
  p.stdin.on('data', (b) => p.received.push(b));
  p.exitCode = null;
  p.signalCode = null;
  p.kill = (sig) => {
    p.signalCode = sig;
    setImmediate(() => p.emit('exit', null, sig));
  };
  return p;
}

describe('motionManager (one detector per camera)', { concurrency: false }, () => {
  let motionManager;
  let spawned;
  let ffmpeg;
  let cams;
  const orig = {};

  beforeEach(() => {
    spawned = [];
    cams = [
      { id: 1, display_name: 'Holk 1', rtsp_url: 'rtsp://a' },
      { id: 2, display_name: 'Holk 2', rtsp_url: 'rtsp://b' },
    ];
    // One fake ffmpeg (with raw frame stdout) per camera
    ffmpeg = new Map(cams.map((c) => [c.id, { stdout: new PassThrough() }]));

    orig.spawn = childProcess.spawn;
    orig.getProcess = streamManager.getProcess;
    orig.startStream = streamManager.startStream;
    orig.listCameras = db.listCameras;
    orig.getCamera = db.getCamera;
    orig.getSetting = db.getSetting;

    childProcess.spawn = (cmd, args, opts) => {
      const p = fakeProc();
      p.env = opts.env;
      spawned.push(p);
      return p;
    };
    streamManager.getProcess = (id) => ffmpeg.get(id);
    streamManager.startStream = async (id) => ffmpeg.get(id);
    db.listCameras = () => cams;
    db.getCamera = (id) => cams.find((c) => c.id === Number(id));
    db.getSetting = () => '';

    // Fresh module so its state (enabled, processes) starts clean, and it
    // picks up the patched child_process.spawn.
    delete require.cache[require.resolve('../../motionManager')];
    motionManager = require('../../motionManager');
  });

  afterEach(() => {
    motionManager.stopMotionDetector();
    mock.timers.reset();
    childProcess.spawn = orig.spawn;
    Object.assign(streamManager, { getProcess: orig.getProcess, startStream: orig.startStream });
    Object.assign(db, { listCameras: orig.listCameras, getCamera: orig.getCamera, getSetting: orig.getSetting });
  });

  const tick = () => new Promise((r) => setImmediate(r));

  it('starts one motion.py per camera with its camera id and name', async () => {
    await motionManager.startMotionDetector();
    assert.strictEqual(spawned.length, 2);
    assert.deepStrictEqual(spawned.map((p) => p.env.MOTION_CAMERA_ID), ['1', '2']);
    assert.deepStrictEqual(spawned.map((p) => p.env.MOTION_CAMERA_NAME), ['Holk 1', 'Holk 2']);
  });

  it("forwards each camera's frames only to that camera's detector", async () => {
    await motionManager.startMotionDetector();
    ffmpeg.get(2).stdout.write(Buffer.alloc(FRAME_BYTES, 2));
    await tick();
    assert.strictEqual(spawned[0].received.length, 0);
    assert.strictEqual(Buffer.concat(spawned[1].received).length, FRAME_BYTES);
    assert.strictEqual(Buffer.concat(spawned[1].received)[0], 2);
  });

  it('does nothing for a single camera until motion detection is enabled', async () => {
    await motionManager.startForCamera(1);
    assert.strictEqual(spawned.length, 0);
  });

  it('starts a detector for a camera added later', async () => {
    await motionManager.startMotionDetector();
    cams.push({ id: 3, display_name: 'Holk 3', rtsp_url: 'rtsp://c' });
    ffmpeg.set(3, { stdout: new PassThrough() });
    await motionManager.startForCamera(3);
    assert.strictEqual(spawned.length, 3);
    assert.strictEqual(spawned[2].env.MOTION_CAMERA_ID, '3');
  });

  it('restarts a crashed detector, but not one stopped on purpose', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    await motionManager.startMotionDetector();

    // Camera 1's detector crashes -> restarted after 7s
    spawned[0].exitCode = 1;
    spawned[0].emit('exit', 1, null);
    mock.timers.tick(7000);
    await tick();
    assert.strictEqual(spawned.length, 3);
    assert.strictEqual(spawned[2].env.MOTION_CAMERA_ID, '1');

    // Camera 2 is deleted -> stopped and not restarted
    motionManager.stopForCamera(2);
    await tick();
    mock.timers.tick(10000);
    await tick();
    assert.strictEqual(spawned[1].signalCode, 'SIGTERM');
    assert.strictEqual(spawned.length, 3);
  });
});
