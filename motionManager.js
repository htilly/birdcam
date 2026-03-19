const { spawn } = require('child_process');
const streamManager = require('./streamManager');
const db = require('./db');

let motionProcess = null;
let isShuttingDown = false;

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

  motionProcess = spawn('python3', ['-u', 'motion/motion.py', '--stdin'], {
    stdio: ['pipe', 'inherit', 'inherit'], // stdin=pipe, stdout/stderr=inherit (show in logs)
    env: {
      ...process.env,
      MOTION_FRAME_WIDTH: '640',
      MOTION_FRAME_HEIGHT: '360',
      MOTION_FRAME_FORMAT: 'bgr24',
      MOTION_CAMERA_ID: String(cameraId),
      VAPID_PRIVATE_KEY: vapidPrivateKey,
      VAPID_PUBLIC_KEY:  vapidPublicKey,
    },
  });

  // Pipe ffmpeg's raw frame output to motion.py stdin
  ffmpegProc.stdout.pipe(motionProcess.stdin);

  motionProcess.on('error', (err) => {
    console.error('[motion-manager] Motion process error:', err);
  });

  motionProcess.on('exit', (code, signal) => {
    console.log(`[motion-manager] Motion process exited code=${code} signal=${signal}`);
    motionProcess = null;

    // Auto-restart if not intentional shutdown
    if (!isShuttingDown && code !== 0) {
      console.log('[motion-manager] Restarting motion detector in 5s...');
      setTimeout(startMotionDetector, 5000);
    }
  });

  // Handle ffmpeg stdout end (stream stopped)
  ffmpegProc.stdout.on('end', () => {
    console.log('[motion-manager] FFmpeg frame stream ended');
    if (motionProcess && !motionProcess.killed) {
      motionProcess.stdin.end();
    }
  });

  ffmpegProc.stdout.on('error', (err) => {
    console.error('[motion-manager] FFmpeg stdout error:', err);
  });
}

function stopMotionDetector() {
  isShuttingDown = true;
  if (motionProcess && !motionProcess.killed) {
    console.log('[motion-manager] Stopping motion detector');
    motionProcess.kill('SIGTERM');
    setTimeout(() => {
      if (motionProcess && !motionProcess.killed) {
        motionProcess.kill('SIGKILL');
      }
    }, 5000);
  }
}

module.exports = {
  startMotionDetector,
  stopMotionDetector,
};
