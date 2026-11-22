const crypto = require('crypto');
const { spawn } = require('child_process');
const streamManager = require('./streamManager');
const db = require('./db');

// cameraId -> running motion.py child process (one detector per camera)
const motionProcesses = new Map();
// cameraId -> pending restart timer
const restartTimers = new Map();
// Cameras whose detector was stopped on purpose (deleted camera): don't restart.
const stoppedCameras = new Set();
let enabled = false;
let isShuttingDown = false;

const MOTION_FRAME_WIDTH = 320;
const MOTION_FRAME_HEIGHT = 180;
const MOTION_FRAME_FORMAT = 'gray';
const MOTION_FRAME_BYTES = MOTION_FRAME_WIDTH * MOTION_FRAME_HEIGHT; // gray = 1 byte/px

// ffmpeg stdout -> frame forwarder. Keyed weakly so a stopped ffmpeg process
// (and its stream) can be garbage collected.
const frameForwarders = new WeakMap();

// Per-process secret the spawned motion.py presents when connecting to /motion-ws
// as the detector. Without it, any client could claim role=detector.
const detectorToken = process.env.MOTION_DETECTOR_TOKEN || crypto.randomBytes(32).toString('hex');
function getDetectorToken() {
  return detectorToken;
}

/**
 * Start a motion detector for every configured camera. Each reads raw frames
 * from its camera's ffmpeg process (the same one that writes HLS), so no
 * second RTSP connection is opened.
 */
async function startMotionDetector() {
  enabled = true;
  const cameras = db.listCameras();
  if (cameras.length === 0) {
    console.log('[motion-manager] No cameras configured, skipping motion detection');
    return;
  }
  for (const camera of cameras) {
    await startForCamera(camera.id);
  }
}

/**
 * Start the motion detector for one camera (no-op if motion detection is
 * disabled, the camera does not exist, or its detector already runs).
 */
async function startForCamera(cameraId) {
  cameraId = Number(cameraId);
  if (!enabled || isShuttingDown) return;
  stoppedCameras.delete(cameraId);
  clearTimeout(restartTimers.get(cameraId));
  restartTimers.delete(cameraId);
  if (motionProcesses.has(cameraId)) {
    console.log(`[motion-manager] Motion detector for camera ${cameraId} already running`);
    return;
  }
  const camera = db.getCamera(cameraId);
  if (!camera) return;

  // Reuse the already-started ffmpeg process if it was started with raw
  // frame output (pipe:1). Otherwise, restart with motion frames enabled.
  let ffmpegProc = streamManager.getProcess(cameraId);
  if (!ffmpegProc || !ffmpegProc.stdout) {
    console.log(`[motion-manager] Starting camera ${cameraId} with motion frame output`);
    // await ensures old process is fully dead before new one starts
    ffmpegProc = await streamManager.startStream(cameraId, camera, true);
  } else {
    console.log(`[motion-manager] Reusing existing ffmpeg stdout for camera ${cameraId}`);
  }

  if (!ffmpegProc || !ffmpegProc.stdout) {
    console.error(`[motion-manager] Failed to start ffmpeg with motion frames for camera ${cameraId}`);
    scheduleRestart(cameraId);
    return;
  }
  // Another call may have started it while we awaited ffmpeg.
  if (motionProcesses.has(cameraId) || stoppedCameras.has(cameraId) || isShuttingDown) return;

  // Start motion.py and pipe ffmpeg stdout to it
  console.log(`[motion-manager] Starting motion.py for camera ${cameraId} with piped frames`);
  // Pass VAPID keys from DB (or env) so motion.py can send push notifications
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || db.getSetting('vapid_private_key') || '';
  const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY  || db.getSetting('vapid_public_key')  || '';

  const proc = spawn('python3', ['-u', 'motion/motion.py', '--stdin'], {
    stdio: ['pipe', 'inherit', 'inherit'], // stdin=pipe, stdout/stderr=inherit (show in logs)
    env: {
      ...process.env,
      MOTION_FRAME_WIDTH: String(MOTION_FRAME_WIDTH),
      MOTION_FRAME_HEIGHT: String(MOTION_FRAME_HEIGHT),
      MOTION_FRAME_FORMAT: MOTION_FRAME_FORMAT,
      MOTION_CAMERA_ID: String(cameraId),
      MOTION_CAMERA_NAME: camera.display_name || '',
      VAPID_PRIVATE_KEY: vapidPrivateKey,
      VAPID_PUBLIC_KEY:  vapidPublicKey,
      MOTION_DETECTOR_TOKEN: detectorToken,
    },
  });
  motionProcesses.set(cameraId, proc);

  // Writes after motion.py dies fail with EPIPE; without a listener that
  // would be an uncaught 'error' and take down the server.
  proc.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
      console.error(`[motion-manager] Motion stdin error (camera ${cameraId}):`, err);
    }
  });

  // Forward ffmpeg's raw frame output to motion.py stdin
  const forwarder = getFrameForwarder(ffmpegProc.stdout);
  forwarder.target = proc.stdin;

  proc.on('error', (err) => {
    console.error(`[motion-manager] Motion process error (camera ${cameraId}):`, err);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[motion-manager] Motion process for camera ${cameraId} exited code=${code} signal=${signal}`);
    // Detach; the forwarder keeps consuming (and discarding) frames so ffmpeg
    // is never back-pressured and the live HLS output keeps flowing.
    if (forwarder.target === proc.stdin) forwarder.target = null;
    if (motionProcesses.get(cameraId) === proc) motionProcesses.delete(cameraId);
    scheduleRestart(cameraId);
  });
}

function scheduleRestart(cameraId) {
  if (isShuttingDown || stoppedCameras.has(cameraId) || restartTimers.has(cameraId)) return;
  console.log(`[motion-manager] Restarting motion detector for camera ${cameraId} in 7s...`);
  restartTimers.set(cameraId, setTimeout(() => {
    restartTimers.delete(cameraId);
    startForCamera(cameraId).catch((err) =>
      console.error(`[motion-manager] Restart failed for camera ${cameraId}:`, err.message));
  }, 7000));
}

function killProcess(proc) {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGTERM');
    // proc.killed is already true once SIGTERM is sent, so check real exit state.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }
}

/** Stop one camera's detector and don't restart it (e.g. the camera was deleted). */
function stopForCamera(cameraId) {
  cameraId = Number(cameraId);
  stoppedCameras.add(cameraId);
  clearTimeout(restartTimers.get(cameraId));
  restartTimers.delete(cameraId);
  const proc = motionProcesses.get(cameraId);
  if (proc) {
    console.log(`[motion-manager] Stopping motion detector for camera ${cameraId}`);
    killProcess(proc);
  }
}

/**
 * Return the frame forwarder for an ffmpeg stdout, creating it (and attaching
 * its listeners) only once per ffmpeg process — motion.py restarts reuse it
 * instead of stacking new 'data'/'end'/'error' listeners on the same stream.
 *
 * The forwarder always consumes stdout, so a dead or slow motion.py can never
 * back-pressure ffmpeg (which would stall the HLS stream it also writes).
 * Frames are forwarded or dropped whole, so motion.py always sees a stream
 * aligned to frame boundaries — also after a restart mid-stream. A frame is
 * dropped when there is no target or its stdin buffer is still full.
 */
function getFrameForwarder(stdout) {
  let fwd = frameForwarders.get(stdout);
  if (fwd) return fwd;

  fwd = { target: null, current: null, pos: 0 };
  stdout.on('data', (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      if (fwd.pos === 0) {
        // Frame boundary: decide where this whole frame goes.
        const t = fwd.target;
        fwd.current = t && !t.destroyed && !t.writableEnded && !t.writableNeedDrain ? t : null;
      }
      const n = Math.min(chunk.length - i, MOTION_FRAME_BYTES - fwd.pos);
      const cur = fwd.current;
      if (cur && cur === fwd.target && !cur.destroyed) cur.write(chunk.subarray(i, i + n));
      i += n;
      fwd.pos = (fwd.pos + n) % MOTION_FRAME_BYTES;
    }
  });

  // Handle ffmpeg stdout end (stream stopped)
  stdout.on('end', () => {
    console.log('[motion-manager] FFmpeg frame stream ended');
    const t = fwd.target;
    fwd.target = null;
    if (t && !t.destroyed && !t.writableEnded) t.end();
  });

  stdout.on('error', (err) => {
    console.error('[motion-manager] FFmpeg stdout error:', err);
  });

  frameForwarders.set(stdout, fwd);
  return fwd;
}

function stopMotionDetector() {
  isShuttingDown = true;
  for (const t of restartTimers.values()) clearTimeout(t);
  restartTimers.clear();
  for (const [cameraId, proc] of motionProcesses) {
    console.log(`[motion-manager] Stopping motion detector for camera ${cameraId}`);
    killProcess(proc);
  }
}

module.exports = {
  startMotionDetector,
  stopMotionDetector,
  startForCamera,
  stopForCamera,
  getDetectorToken,
};
