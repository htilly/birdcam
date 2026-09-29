const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const db = require('./db');

// -fps_mode was added in FFmpeg 5.0; Debian 11 (and similar) ship 4.x
let fpsModeSupported = null;
function getFpsModeSupported() {
  if (fpsModeSupported !== null) return fpsModeSupported;
  try {
    const out = execSync('ffmpeg -hide_banner -fps_mode vfr -f null - 2>&1', {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fpsModeSupported = !out.includes("Unrecognized option 'fps_mode'");
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    fpsModeSupported = !out.includes("Unrecognized option 'fps_mode'");
  }
  return fpsModeSupported;
}

// RTSP socket I/O timeout flag. FFmpeg 4.x calls it -stimeout; FFmpeg 5.0 removed
// -stimeout and -timeout took over its meaning (socket I/O timeout, microseconds).
// On 4.x, -timeout means something else (listen timeout, implies listen mode), so
// we must pick the right one. Detected once from the rtsp demuxer's help output.
// If detection fails (ffmpeg missing/broken), default to the modern -timeout:
// streams cannot start without ffmpeg anyway, and every supported image ships 5+.
let rtspTimeoutFlag = null;
function getRtspTimeoutFlag() {
  if (rtspTimeoutFlag !== null) return rtspTimeoutFlag;
  let out = '';
  try {
    out = execSync('ffmpeg -hide_banner -h demuxer=rtsp 2>&1', {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  rtspTimeoutFlag = out.includes('-stimeout') ? '-stimeout' : '-timeout';
  return rtspTimeoutFlag;
}

const hlsDir = path.join(__dirname, 'hls');
const processes = new Map();
const stopping = new Set();
const motionEnabled = new Set();
const MAX_LOG_LINES = 200;
const logs = new Map(); // cameraId -> string[]

// Upper bound for the motion detector's frame rate, used when the camera's
// input_fps is unknown. Always clamped down to the camera rate when known.
const DEFAULT_MOTION_FPS = 10;

const DEFAULT_FFMPEG_OPTIONS = {
  rtsp_transport: 'tcp',
  use_wallclock_as_timestamps: 1,
  fflags: 'genpts+discardcorrupt',
  avoid_negative_ts: 'make_zero',
  max_delay: 2,
  flags: '-global_header',
  input_fps: 8,
  video_codec: 'libx264',
  preset: 'veryfast',
  tune: 'zerolatency',
  crf: 28,
  pix_fmt: 'yuv420p',
  scale_vf: 'scale=in_range=full:out_range=tv',
  color_range: 'tv',
  g: 16,
  keyint_min: 16,
  force_key_frames: '',
  audio_codec: 'none',
  audio_channels: 1,
  audio_sample_rate: 44100,
  hls_time: 2,
  hls_list_size: 6,
  hls_flags: 'delete_segments',
  fps_mode: 'vfr',
  extra_input_args: '',
  extra_output_args: '',
  // 0 / unset means "match the camera" (see getMotionFps).
  motion_fps: 0,
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

// Options an admin may add via extra_input_args / extra_output_args. Each must be followed by
// exactly one value. Nothing here takes a file name (e.g. -x264-params is excluded because its
// stats= key writes files), so extra args can't add outputs or read/write arbitrary files.
const SAFE_EXTRA_ARG_FLAGS = new Set([
  '-analyzeduration',
  '-probesize',
  '-thread_queue_size',
  '-err_detect',
  '-vsync',
  '-threads',
  '-loglevel',
  '-tag:v',
  '-profile:v',
  '-level',
  '-maxrate',
  '-bufsize',
  '-b:v',
  '-hls_segment_type',
  '-hls_playlist_type',
  '-start_number',
  '-rtbufsize',
  '-timeout',
  '-rw_timeout',
  '-metadata',
]);

// Conservative video filter chain: only simple, file-free filters with plain key=value args.
// No movie/amovie, no paths, no ';' or '[' (filtergraph labels / multiple chains).
const SAFE_VF_FILTER = '(?:scale|fps|format|crop|transpose|hflip|vflip|setsar|colorspace)(?:=[\\w=:.+-]*)?';
const SAFE_VF_RE = new RegExp(`^${SAFE_VF_FILTER}(?:,${SAFE_VF_FILTER})*$`);

function isSafeExtraArgValue(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.startsWith('-') && !/^-\d+(\.\d+)?$/.test(value)) return false;
  return true;
}

function checkExtraArgs(str, field, errors) {
  const tokens = parseExtraArgs(str);
  const safe = [];
  let i = 0;
  while (i < tokens.length) {
    const flag = tokens[i];
    if (!SAFE_EXTRA_ARG_FLAGS.has(flag)) {
      errors.push(`${field}: option "${flag}" is not allowed`);
      i += 1;
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined) {
      errors.push(`${field}: option "${flag}" is missing a value`);
      i += 1;
      continue;
    }
    if (!isSafeExtraArgValue(value)) {
      errors.push(`${field}: invalid value "${value}" for "${flag}"`);
      // A non-numeric "-xxx" is probably the next option; re-examine it rather than consuming it
      i += value.startsWith('-') ? 1 : 2;
      continue;
    }
    safe.push(flag, value);
    i += 2;
  }
  return safe;
}

/**
 * Validate admin-supplied custom ffmpeg options (extra_input_args, extra_output_args, scale_vf).
 * Returns the safe parts plus a list of errors; callers either reject on errors (admin save)
 * or drop the invalid parts (buildFfmpegArgs).
 */
function validateCustomFfmpegOptions(options) {
  const o = options || {};
  const errors = [];
  const extraInputArgs = checkExtraArgs(o.extra_input_args, 'Extra input args', errors);
  const extraOutputArgs = checkExtraArgs(o.extra_output_args, 'Extra output args', errors);
  let scaleVf = '';
  if (o.scale_vf) {
    const vf = String(o.scale_vf).trim();
    if (SAFE_VF_RE.test(vf)) {
      scaleVf = vf;
    } else {
      errors.push(`Scale filter: "${o.scale_vf}" is not allowed (only scale, fps, format, crop, transpose, hflip, vflip, setsar, colorspace with simple arguments)`);
    }
  }
  return { extraInputArgs, extraOutputArgs, scaleVf, errors };
}

/**
 * Frames per second to feed the motion detector, clamped to the camera's own
 * input rate so ffmpeg never pads the stream with duplicate frames.
 * Falls back to DEFAULT_MOTION_FPS when neither value is usable.
 */
function getMotionFps(options) {
  const o = options || {};
  const cameraFps = Number(o.input_fps);
  const wanted = Number(o.motion_fps) || DEFAULT_MOTION_FPS;
  if (!Number.isFinite(cameraFps) || cameraFps <= 0) {
    return Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_MOTION_FPS;
  }
  return Math.min(wanted, cameraFps);
}

function buildFfmpegArgs(rtspUrl, outBase, options, enableMotionFrames = false) {
  const o = { ...DEFAULT_FFMPEG_OPTIONS, ...options };
  const args = [];

  // Defensive: options may predate validation on save; drop anything unsafe.
  const custom = validateCustomFfmpegOptions(o);
  for (const err of custom.errors) {
    console.warn(`[ffmpeg] Ignoring unsafe custom option: ${err}`);
  }

  pushOpt(args, '-rtsp_transport', o.rtsp_transport);
  if (o.use_wallclock_as_timestamps) pushOpt(args, '-use_wallclock_as_timestamps', '1');
  pushOpt(args, '-fflags', o.fflags);
  if (o.avoid_negative_ts) pushOpt(args, '-avoid_negative_ts', o.avoid_negative_ts);
  if (o.input_fps) pushOpt(args, '-r', o.input_fps);
  pushOpt(args, getRtspTimeoutFlag(), '5000000');
  pushOpt(args, '-max_delay', o.max_delay);
  pushOpt(args, '-flags', o.flags);
  pushOpt(args, '-i', rtspUrl);

  const extraInput = custom.extraInputArgs;
  for (let i = 0; i < extraInput.length; i++) args.push(extraInput[i]);

  // Frame rate mode: 'vfr' passes through camera timing as-is (FFmpeg 5.0+).
  // Skip on older FFmpeg (e.g. 4.x in Debian 11) which does not support -fps_mode.
  if (o.fps_mode && getFpsModeSupported()) pushOpt(args, '-fps_mode', o.fps_mode);

  // HLS output (main stream for viewers)
  if (o.video_codec === 'copy') {
    pushOpt(args, '-c:v', 'copy');
  } else {
    if (custom.scaleVf) pushOpt(args, '-vf', custom.scaleVf);
    if (o.color_range) pushOpt(args, '-color_range', o.color_range);
    pushOpt(args, '-c:v', o.video_codec || 'libx264');
    pushOpt(args, '-preset', o.preset);
    pushOpt(args, '-tune', o.tune);
    pushOpt(args, '-crf', o.crf);
    pushOpt(args, '-pix_fmt', o.pix_fmt);
    pushOpt(args, '-g', o.g);
    pushOpt(args, '-keyint_min', o.keyint_min);
    if (o.force_key_frames) pushOpt(args, '-force_key_frames', o.force_key_frames);
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

  const extraOutput = custom.extraOutputArgs;
  for (let i = 0; i < extraOutput.length; i++) args.push(extraOutput[i]);

  args.push(`${outBase}.m3u8`);

  // Optional: raw BGR24 frames to stdout for motion detection (avoids duplicate RTSP connection)
  if (enableMotionFrames) {
    pushOpt(args, '-f', 'rawvideo');
    // Grayscale (1 byte/px) at 320x180: motion.py only needs luma, and this is
    // 1/12 of the bytes of 640x360 bgr24 through the pipe. Must match the
    // MOTION_FRAME_WIDTH/HEIGHT/FORMAT env passed in motionManager.js.
    pushOpt(args, '-pix_fmt', 'gray');
    // Motion frame rate. Asking for more frames per second than the camera
    // actually sends does not produce more information -- ffmpeg just duplicates
    // frames to pad the rate, and motion.py then does real work (blur, bg
    // subtraction, contours) on frames identical to ones it has already seen.
    // So clamp to the camera's own rate. motion_fps may be set lower than the
    // camera rate to save CPU; it is never allowed to exceed it.
    pushOpt(args, '-r', String(getMotionFps(o)));
    pushOpt(args, '-s', '320x180'); // lower resolution for motion detection
    args.push('pipe:1');
  }

  return args;
}

// Maps/Sets below are keyed by numeric camera id; callers may pass "1" (from URLs)
// or 1 (from the DB), and a mismatch would spawn a duplicate ffmpeg for the same camera.
function normalizeId(cameraId) {
  const n = Number(cameraId);
  return Number.isFinite(n) ? n : cameraId;
}

async function startStream(cameraId, camera, enableMotionFrames = false) {
  cameraId = normalizeId(cameraId);
  const rtspUrl = typeof camera === 'string' ? camera : camera.rtsp_url;
  if (!db.validateRtspUrl(rtspUrl)) {
    console.error(`Camera ${cameraId}: refusing to start — invalid RTSP URL`);
    return null;
  }

  if (enableMotionFrames) motionEnabled.add(cameraId);
  const shouldEnableMotion = motionEnabled.has(cameraId);

  await stopStream(cameraId);
  stopping.delete(cameraId);
  ensureHlsDir();
  const outBase = path.join(hlsDir, `cam-${cameraId}`);
  const options = typeof camera === 'string' ? {} : parseFfmpegOptions(camera);
  const args = buildFfmpegArgs(rtspUrl, outBase, options, shouldEnableMotion);
  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', shouldEnableMotion ? 'pipe' : 'ignore', 'pipe'],
    detached: false,
  });
  if (!logs.has(cameraId)) logs.set(cameraId, []);
  const camLog = logs.get(cameraId);
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
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
    if (wasIntentionalStop) {
      motionEnabled.delete(cameraId);
      return;
    }
    if (signal === 'SIGTERM') return;
    console.log(`[stream] Camera ${cameraId} ffmpeg exited code=${code} signal=${signal}, restarting in 5s...`);
    setTimeout(async () => {
      const cam = db.getCamera(cameraId);
      if (cam) await startStream(cameraId, cam, shouldEnableMotion);
    }, 5000);
  });
  processes.set(cameraId, child);
  return child;
}

/**
 * Stop the stream for a camera and wait for the ffmpeg process to fully exit.
 * Returns a Promise so callers can await the actual exit before starting a replacement,
 * preventing multiple ffmpeg instances from writing to the same HLS files simultaneously.
 */
async function stopStream(cameraId) {
  cameraId = normalizeId(cameraId);
  const child = processes.get(cameraId);
  // (#11) Delete HLS files for this camera asynchronously to avoid blocking the event loop
  const prefix = `cam-${cameraId}`;
  try {
    const files = await fsPromises.readdir(hlsDir);
    await Promise.all(
      files
        .filter((f) => f === `${prefix}.m3u8` || (f.startsWith(`${prefix}-`) && f.endsWith('.ts')))
        .map((f) => fsPromises.unlink(path.join(hlsDir, f)).catch(() => {}))
    );
  } catch (_) {}

  if (!child || !child.kill) return;

  return new Promise((resolve) => {
    stopping.add(cameraId); // mark as intentional stop

    // (#20) Safety timeout — resolve even if ffmpeg ignores signals
    const maybeDeleteProcess = () => {
      // Only delete if this camera still points to the same child.
      if (processes.get(cameraId) === child) processes.delete(cameraId);
    };
    const safetyTimer = setTimeout(() => {
      maybeDeleteProcess();
      resolve();
    }, 12_000);

    // Resolve as soon as the process exits
    child.once('exit', () => {
      clearTimeout(safetyTimer);
      maybeDeleteProcess();
      resolve();
    });

    // Graceful: SIGTERM first, force SIGKILL after 5s
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
    }, 5000);
  });
}

async function stopAll() {
  await Promise.all([...processes.keys()].map((id) => stopStream(id)));
}

async function startAll({ motionCameraId = null } = {}) {
  const cameras = db.listCameras();
  for (const c of cameras) {
    // Enable the rawvideo stdout pipe only for the motion camera to avoid
    // having two separate ffmpeg processes at steady state.
    const enableMotionFrames = motionCameraId != null && c.id === motionCameraId;
    await startStream(c.id, c, enableMotionFrames);
  }
}

function isRunning(cameraId) {
  const p = processes.get(normalizeId(cameraId));
  return p && !p.killed;
}

function getProcess(cameraId) {
  return processes.get(normalizeId(cameraId));
}

function getLogs(cameraId) {
  return logs.get(normalizeId(cameraId)) || [];
}

function getStreamInfo(cameraId) {
  const camLog = logs.get(normalizeId(cameraId)) || [];
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
  validateCustomFfmpegOptions,
  getMotionFps,
};
