const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const hlsBaseDir = path.join(__dirname, '..', 'hls');

// Active playback sessions: key -> {process, hlsDir, lastAccess}
const playbackSessions = new Map();
const PLAYBACK_TTL_MS = 5 * 60 * 1000; // clean up after 5 min idle

setInterval(() => {
  const now = Date.now();
  for (const [key, sess] of playbackSessions) {
    if (now - sess.lastAccess > PLAYBACK_TTL_MS) {
      stopPlayback(key, sess);
    }
  }
}, 60000);

function stopPlayback(key, sess) {
  if (sess.process && !sess.process.killed) sess.process.kill('SIGKILL');
  try {
    fs.readdirSync(sess.hlsDir).forEach((f) => fs.unlinkSync(path.join(sess.hlsDir, f)));
    fs.rmdirSync(sess.hlsDir);
  } catch (_) {}
  playbackSessions.delete(key);
}

// GET /api/recordings/:cameraId?date=YYYY-MM-DD
router.get('/:cameraId', requireLogin, (req, res) => {
  const cam = db.getCamera(Number(req.params.cameraId));
  if (!cam) return res.status(404).json({ error: 'Camera not found' });

  const dateStr = req.query.date; // YYYY-MM-DD
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });
  }

  if (!cam.rtsp_host) return res.status(400).json({ error: 'Camera has no host configured' });

  res.status(501).json({ error: 'Recording listing not supported' });
});

// POST /api/recordings/:cameraId/stream  body: {startTime, endTime}
// Starts an ffmpeg process that reads the recording RTSP playback and produces HLS
router.post('/:cameraId/stream', requireLogin, (req, res) => {
  const cam = db.getCamera(Number(req.params.cameraId));
  if (!cam) return res.status(404).json({ error: 'Camera not found' });

  const { startTime, endTime } = req.body || {};
  if (!startTime || !endTime) return res.status(400).json({ error: 'startTime and endTime required' });

  // Build a unique key for this playback
  const key = `pb-${cam.id}-${Date.now()}`;
  const pbDir = path.join(hlsBaseDir, key);
  fs.mkdirSync(pbDir, { recursive: true });

  const fmtRtsp = (t) => {
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}t${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}z`;
  };

  const rtspUrl = `${cam.rtsp_url}?starttime=${fmtRtsp(startTime)}&endtime=${fmtRtsp(endTime)}`;
  const outM3u8 = path.join(pbDir, 'index.m3u8');

  const args = [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
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
    '-hls_list_size', '0',
    '-hls_flags', 'append_list',
    '-hls_segment_filename', path.join(pbDir, '%03d.ts'),
    outM3u8,
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  playbackSessions.set(key, { process: proc, hlsDir: pbDir, lastAccess: Date.now() });

  proc.on('exit', () => {
    const sess = playbackSessions.get(key);
    if (sess) sess.process = null;
  });

  // Wait briefly for the first segment then respond
  const hlsUrl = `/hls/${key}/index.m3u8`;
  setTimeout(() => {
    res.json({ key, hlsUrl });
  }, 1500);
});

// DELETE /api/recordings/stream/:key  — stop a playback session
const PLAYBACK_KEY_REGEX = /^pb-\d+-\d+$/;
router.delete('/stream/:key', requireLogin, (req, res) => {
  const key = req.params.key;
  if (!PLAYBACK_KEY_REGEX.test(key)) return res.status(400).json({ error: 'Invalid key' });
  const sess = playbackSessions.get(key);
  if (sess) stopPlayback(key, sess);
  res.json({ ok: true });
});

module.exports = router;
