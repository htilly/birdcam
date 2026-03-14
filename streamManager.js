const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const hlsDir = path.join(__dirname, 'hls');
const processes = new Map();
const stopping = new Set(); // tracks intentional stops to prevent auto-restart
const MAX_LOG_LINES = 200;
const logs = new Map(); // cameraId -> string[]

function ensureHlsDir() {
  fs.mkdirSync(hlsDir, { recursive: true });
}

function startStream(cameraId, rtspUrl) {
  // Validate RTSP URL scheme
  if (!db.validateRtspUrl(rtspUrl)) {
    console.error(`Camera ${cameraId}: refusing to start — invalid RTSP URL`);
    return null;
  }

  stopStream(cameraId);
  stopping.delete(cameraId); // clear stop flag since we're intentionally starting
  ensureHlsDir();
  const outBase = path.join(hlsDir, `cam-${cameraId}`);
  const outM3u8 = `${outBase}.m3u8`;
  const args = [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-fflags', 'flush_packets',
    '-max_delay', '2',
    '-flags', '-global_header',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-g', '16',
    '-keyint_min', '8',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac',
    '-ac', '1',
    '-ar', '44100',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', `${outBase}-%03d.ts`,
    outM3u8,
  ];
  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  if (!logs.has(cameraId)) logs.set(cameraId, []);
  const camLog = logs.get(cameraId);
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      // Filter high-volume noise lines
      if (line.includes('deprecated pixel format used')) continue;
      if (line.includes('Non-monotonous DTS')) continue;
      camLog.push(line);
      if (camLog.length > MAX_LOG_LINES) camLog.shift();
    }
  });
  child.on('error', (err) => {
    console.error(`FFmpeg camera ${cameraId} error:`, err.message);
  });
  child.on('exit', (code, signal) => {
    const wasIntentionalStop = stopping.has(cameraId);
    processes.delete(cameraId);
    stopping.delete(cameraId);
    // Only auto-restart on unexpected failure (not intentional stop, not SIGTERM from shutdown)
    if (wasIntentionalStop) return;
    if (signal === 'SIGTERM') return; // container/process shutting down, don't restart
    if (code === 0 && code !== null) return; // clean exit
    setTimeout(() => {
      const cam = db.getCamera(cameraId);
      if (cam) startStream(cameraId, cam.rtsp_url);
    }, 5000);
  });
  processes.set(cameraId, child);
  return child;
}

function stopStream(cameraId) {
  const child = processes.get(cameraId);
  if (child && child.kill) {
    stopping.add(cameraId); // mark as intentional stop
    // Graceful: SIGTERM first, force SIGKILL after 5s
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
    }, 5000);
    child.once('exit', () => clearTimeout(killTimer));
    processes.delete(cameraId);
  }
  const prefix = `cam-${cameraId}`;
  try {
    fs.readdirSync(hlsDir).forEach((f) => {
      if (f === `${prefix}.m3u8` || (f.startsWith(`${prefix}-`) && f.endsWith('.ts'))) {
        fs.unlinkSync(path.join(hlsDir, f));
      }
    });
  } catch (_) {}
}

function stopAll() {
  for (const id of processes.keys()) stopStream(id);
}

function startAll() {
  const cameras = db.listCameras();
  for (const c of cameras) startStream(c.id, c.rtsp_url);
}

function isRunning(cameraId) {
  const p = processes.get(cameraId);
  return p && !p.killed;
}

function getLogs(cameraId) {
  return logs.get(cameraId) || [];
}

function getStreamInfo(cameraId) {
  const camLog = logs.get(cameraId) || [];
  const infoLines = camLog.filter((l) =>
    /Stream #\d|Stream mapping|->|Input #|Output #|profile |libx264|fps=/.test(l)
  );
  return infoLines.slice(-20);
}

function getAllLogs() {
  const result = {};
  for (const [id, lines] of logs) {
    result[id] = lines;
  }
  return result;
}

module.exports = {
  startStream,
  stopStream,
  startAll,
  stopAll,
  isRunning,
  getLogs,
  getAllLogs,
  getStreamInfo,
  hlsDir,
};
