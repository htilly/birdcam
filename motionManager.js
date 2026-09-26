const crypto = require('crypto');
const { spawn } = require('child_process');
const streamManager = require('./streamManager');
const db = require('./db');

let motionProcess = null;
let isShuttingDown = false;

// Raw frame geometry — must match the enableMotionFrames block of
// streamManager.buildFfmpegArgs (-pix_fmt gray -s 320x180).
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
 * Start motion detector that reads frames from the ffmpeg HLS stream.
 * This avoids opening a duplicate RTSP connection.
 */
async function startMotionDetector() {
  if (motionProcess) {
    console.log('[motion-manager] Motion detector already running');
    return;
  }

  // Get the first camera to detect motion for
  const cameras = db.listCameras();
  if (cameras.length === 0) {
    console.log('[motion-manager] No cameras configured, skipping motion detection');
    return;
  }

  const camera = cameras[0];
  const cameraId = camera.id;

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
    console.error('[motion-manager] Failed to start ffmpeg with motion frames');
    return;
  }

  // Start motion.py and pipe ffmpeg stdout to it
  console.log('[motion-manager] Starting motion.py with piped frames');
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
      VAPID_PRIVATE_KEY: vapidPrivateKey,
      VAPID_PUBLIC_KEY:  vapidPublicKey,
      MOTION_DETECTOR_TOKEN: detectorToken,
    },
  });
  motionProcess = proc;

  // Writes after motion.py dies fail with EPIPE; without a listener that
  // would be an uncaught 'error' and take down the server.
  proc.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
      console.error('[motion-manager] Motion stdin error:', err);
    }
  });

  // Forward ffmpeg's raw frame output to motion.py stdin
  const forwarder = getFrameForwarder(ffmpegProc.stdout);
  forwarder.target = proc.stdin;

  proc.on('error', (err) => {
    console.error('[motion-manager] Motion process error:', err);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[motion-manager] Motion process exited code=${code} signal=${signal}`);
    // Detach; the forwarder keeps consuming (and discarding) frames so ffmpeg
    // is never back-pressured and the live HLS output keeps flowing.
    if (forwarder.target === proc.stdin) forwarder.target = null;
    if (motionProcess === proc) motionProcess = null;

    if (!isShuttingDown) {
      console.log('[motion-manager] Restarting motion detector in 7s...');
      setTimeout(startMotionDetector, 7000);
    }
  });
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
  const proc = motionProcess;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    console.log('[motion-manager] Stopping motion detector');
    proc.kill('SIGTERM');
    // proc.killed is already true once SIGTERM is sent, so check real exit state.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }
}

module.exports = {
  startMotionDetector,
  stopMotionDetector,
  getDetectorToken,
};
