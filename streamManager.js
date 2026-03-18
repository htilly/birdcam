const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const hlsDir = path.join(__dirname, 'hls');
const processes = new Map();
const stopping = new Set(); // tracks intentional stops to prevent auto-restart
const MAX_LOG_LINES = 200;
const logs = new Map(); // cameraId -> string[]

const DEFAULT_FFMPEG_OPTIONS = {
  rtsp_transport: 'tcp',
  reconnect: 1,
  reconnect_streamed: 1,
  reconnect_delay_max: 5,
  fflags: 'flush_packets',
  max_delay: 2,
  flags: '-global_header',
  video_codec: 'libx264',
  preset: 'ultrafast',
  tune: 'zerolatency',
  crf: 28,
  pix_fmt: 'yuv420p',
  g: 16,
  keyint_min: 8,
  force_key_frames: 'expr:gte(t,n_forced*2)',
  audio_codec: 'aac',
  audio_channels: 1,
  audio_sample_rate: 44100,
  hls_time: 1,
  hls_list_size: 2,
  hls_flags: 'delete_segments+append_list',
  extra_input_args: '',
  extra_output_args: '',
};

function ensureHlsDir() {
  fs.mkdirSync(hlsDir, { recursive: true });
}

function parseFfmpegOptions(camera) {
  const raw = camera.ffmpeg_options;
  if (!raw) return { ...DEFAULT_FFMPEG_OPTIONS };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...DEFAULT_FFMPEG_OPTIONS, ...parsed };
  } catch (_) {
    return { ...DEFAULT_FFMPEG_OPTIONS };
  }
}

function pushOpt(args, key, value) {
  if (value === undefined || value === null) {
    args.push(key);
    return;
  }
  if (value === '') return;
  args.push(key);
  const s = String(value);
  if (s !== '') args.push(s);
}

function parseExtraArgs(str) {
  if (!str || typeof str !== 'string') return [];
  return str.trim().split(/\s+/).filter(Boolean);
}

function buildFfmpegArgs(rtspUrl, outBase, options, enableMotionFrames = false) {
  const o = { ...DEFAULT_FFMPEG_OPTIONS, ...options };
  const args = [];

  pushOpt(args, '-rtsp_transport', o.rtsp_transport);
  pushOpt(args, '-i', rtspUrl);
  pushOpt(args, '-reconnect', o.reconnect);
  pushOpt(args, '-reconnect_streamed', o.reconnect_streamed);
  pushOpt(args, '-reconnect_delay_max', o.reconnect_delay_max);
  pushOpt(args, '-fflags', o.fflags);
  pushOpt(args, '-max_delay', o.max_delay);
  pushOpt(args, '-flags', o.flags);

  const extraInput = parseExtraArgs(o.extra_input_args);
  for (let i = 0; i < extraInput.length; i++) args.push(extraInput[i]);

  // HLS output (main stream for viewers)
  if (o.video_codec === 'copy') {
    pushOpt(args, '-c:v', 'copy');
  } else {
    pushOpt(args, '-c:v', o.video_codec || 'libx264');
    pushOpt(args, '-preset', o.preset);
    pushOpt(args, '-tune', o.tune);
    pushOpt(args, '-crf', o.crf);
    pushOpt(args, '-pix_fmt', o.pix_fmt);
    pushOpt(args, '-g', o.g);
    pushOpt(args, '-keyint_min', o.keyint_min);
    pushOpt(args, '-force_key_frames', o.force_key_frames);
  }

  if (o.audio_codec && o.audio_codec !== 'none') {
    pushOpt(args, '-c:a', o.audio_codec);
    pushOpt(args, '-ac', o.audio_channels);
    pushOpt(args, '-ar', o.audio_sample_rate);
  } else if (o.audio_codec === 'none') {
    pushOpt(args, '-an');
  } else {
    pushOpt(args, '-c:a', 'aac');
    pushOpt(args, '-ac', o.audio_channels ?? 1);
    pushOpt(args, '-ar', o.audio_sample_rate ?? 44100);
  }

  pushOpt(args, '-f', 'hls');
  pushOpt(args, '-hls_time', o.hls_time);
  pushOpt(args, '-hls_list_size', o.hls_list_size);
  pushOpt(args, '-hls_flags', o.hls_flags);
  pushOpt(args, '-hls_segment_filename', `${outBase}-%03d.ts`);

  const extraOutput = parseExtraArgs(o.extra_output_args);
  for (let i = 0; i < extraOutput.length; i++) args.push(extraOutput[i]);

  args.push(`${outBase}.m3u8`);

  // Optional: raw BGR24 frames to stdout for motion detection (avoids duplicate RTSP connection)
  if (enableMotionFrames) {
    pushOpt(args, '-f', 'rawvideo');
    pushOpt(args, '-pix_fmt', 'bgr24');
    pushOpt(args, '-r', '10'); // 10fps for motion detection (reduce CPU)
    pushOpt(args, '-s', '640x360'); // lower resolution for motion detection
    args.push('pipe:1');
  }

  return args;
}

function startStream(cameraId, camera, enableMotionFrames = false) {
  const rtspUrl = typeof camera === 'string' ? camera : camera.rtsp_url;
  if (!db.validateRtspUrl(rtspUrl)) {
    console.error(`Camera ${cameraId}: refusing to start — invalid RTSP URL`);
    return null;
  }

  stopStream(cameraId);
  stopping.delete(cameraId);
  ensureHlsDir();
  const outBase = path.join(hlsDir, `cam-${cameraId}`);
  const options = typeof camera === 'string' ? {} : parseFfmpegOptions(camera);
  const args = buildFfmpegArgs(rtspUrl, outBase, options, enableMotionFrames);
  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', enableMotionFrames ? 'pipe' : 'ignore', 'pipe'],
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
      if (cam) startStream(cameraId, cam);
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
  for (const c of cameras) startStream(c.id, c);
}

function isRunning(cameraId) {
  const p = processes.get(cameraId);
  return p && !p.killed;
}

function getProcess(cameraId) {
  return processes.get(cameraId);
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
  getProcess,
  getLogs,
  getAllLogs,
  getStreamInfo,
  hlsDir,
  DEFAULT_FFMPEG_OPTIONS,
  parseFfmpegOptions,
  buildFfmpegArgs,
};
