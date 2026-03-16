const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();
const db = require('../db');
const streamManager = require('../streamManager');
const { requireLogin, requireSetup, requireNoSetup } = require('../middleware/auth');
const { DEFAULT_FFMPEG_OPTIONS } = streamManager;

function getFfmpegOptsForForm(camera) {
  const def = { ...DEFAULT_FFMPEG_OPTIONS };
  if (!camera || !camera.ffmpeg_options) return def;
  try {
    const parsed = typeof camera.ffmpeg_options === 'string' ? JSON.parse(camera.ffmpeg_options) : camera.ffmpeg_options;
    return { ...def, ...parsed };
  } catch (_) {
    return def;
  }
}

function ffmpegOptionsFromBody(body) {
  const o = {};
  if (body.ffmpeg_rtsp_transport != null) o.rtsp_transport = body.ffmpeg_rtsp_transport;
  if (body.ffmpeg_reconnect != null) o.reconnect = body.ffmpeg_reconnect === '' ? DEFAULT_FFMPEG_OPTIONS.reconnect : Number(body.ffmpeg_reconnect) || 1;
  if (body.ffmpeg_reconnect_streamed != null) o.reconnect_streamed = body.ffmpeg_reconnect_streamed === '' ? DEFAULT_FFMPEG_OPTIONS.reconnect_streamed : Number(body.ffmpeg_reconnect_streamed) || 1;
  if (body.ffmpeg_reconnect_delay_max != null) o.reconnect_delay_max = body.ffmpeg_reconnect_delay_max === '' ? DEFAULT_FFMPEG_OPTIONS.reconnect_delay_max : Number(body.ffmpeg_reconnect_delay_max) || 5;
  if (body.ffmpeg_fflags != null) o.fflags = body.ffmpeg_fflags;
  if (body.ffmpeg_max_delay != null) o.max_delay = body.ffmpeg_max_delay === '' ? DEFAULT_FFMPEG_OPTIONS.max_delay : Number(body.ffmpeg_max_delay) || 2;
  if (body.ffmpeg_flags != null) o.flags = body.ffmpeg_flags;
  if (body.ffmpeg_video_codec != null) o.video_codec = body.ffmpeg_video_codec;
  if (body.ffmpeg_preset != null) o.preset = body.ffmpeg_preset;
  if (body.ffmpeg_tune != null) o.tune = body.ffmpeg_tune;
  if (body.ffmpeg_crf != null) o.crf = body.ffmpeg_crf === '' ? DEFAULT_FFMPEG_OPTIONS.crf : Number(body.ffmpeg_crf);
  if (body.ffmpeg_pix_fmt != null) o.pix_fmt = body.ffmpeg_pix_fmt;
  if (body.ffmpeg_g != null) o.g = body.ffmpeg_g === '' ? DEFAULT_FFMPEG_OPTIONS.g : Number(body.ffmpeg_g) || 16;
  if (body.ffmpeg_keyint_min != null) o.keyint_min = body.ffmpeg_keyint_min === '' ? DEFAULT_FFMPEG_OPTIONS.keyint_min : Number(body.ffmpeg_keyint_min) || 8;
  if (body.ffmpeg_force_key_frames != null) o.force_key_frames = body.ffmpeg_force_key_frames;
  if (body.ffmpeg_audio_codec != null) o.audio_codec = body.ffmpeg_audio_codec;
  if (body.ffmpeg_audio_channels != null) o.audio_channels = body.ffmpeg_audio_channels === '' ? 1 : Number(body.ffmpeg_audio_channels) || 1;
  if (body.ffmpeg_audio_sample_rate != null) o.audio_sample_rate = body.ffmpeg_audio_sample_rate === '' ? 44100 : Number(body.ffmpeg_audio_sample_rate) || 44100;
  if (body.ffmpeg_hls_time != null) o.hls_time = body.ffmpeg_hls_time === '' ? 2 : Number(body.ffmpeg_hls_time) || 2;
  if (body.ffmpeg_hls_list_size != null) o.hls_list_size = body.ffmpeg_hls_list_size === '' ? 3 : Number(body.ffmpeg_hls_list_size) || 3;
  if (body.ffmpeg_hls_flags != null) o.hls_flags = body.ffmpeg_hls_flags;
  if (body.ffmpeg_extra_input_args != null) o.extra_input_args = body.ffmpeg_extra_input_args;
  if (body.ffmpeg_extra_output_args != null) o.extra_output_args = body.ffmpeg_extra_output_args;
  return o;
}

function ffmpegFormSection(opts) {
  const v = (key) => escapeHtml(String(opts[key] ?? ''));
  return `
      <div class="form-section">
        <p class="form-section-title">FFmpeg / Stream options</p>
        <p class="field-hint" style="margin-bottom:0.75rem;">Override defaults for this camera. Leave defaults for typical IP cameras.</p>
        <div class="form-row">
          <div>
            <label for="ffmpeg-rtsp-transport">RTSP transport</label>
            <select id="ffmpeg-rtsp-transport" name="ffmpeg_rtsp_transport">
              <option value="tcp" ${opts.rtsp_transport === 'tcp' ? 'selected' : ''}>tcp</option>
              <option value="udp" ${opts.rtsp_transport === 'udp' ? 'selected' : ''}>udp</option>
              <option value="http" ${opts.rtsp_transport === 'http' ? 'selected' : ''}>http</option>
            </select>
          </div>
          <div>
            <label for="ffmpeg-reconnect">Reconnect</label>
            <input type="number" id="ffmpeg-reconnect" name="ffmpeg_reconnect" value="${v('reconnect')}" min="0" placeholder="1">
          </div>
          <div>
            <label for="ffmpeg-reconnect-streamed">Reconnect streamed</label>
            <input type="number" id="ffmpeg-reconnect-streamed" name="ffmpeg_reconnect_streamed" value="${v('reconnect_streamed')}" min="0" placeholder="1">
          </div>
          <div>
            <label for="ffmpeg-reconnect-delay-max">Reconnect delay max (s)</label>
            <input type="number" id="ffmpeg-reconnect-delay-max" name="ffmpeg_reconnect_delay_max" value="${v('reconnect_delay_max')}" min="0" placeholder="5">
          </div>
        </div>
        <div class="form-row">
          <div>
            <label for="ffmpeg-fflags">Input fflags</label>
            <input type="text" id="ffmpeg-fflags" name="ffmpeg_fflags" value="${v('fflags')}" placeholder="flush_packets">
          </div>
          <div>
            <label for="ffmpeg-max-delay">Max delay (s)</label>
            <input type="number" id="ffmpeg-max-delay" name="ffmpeg_max_delay" value="${v('max_delay')}" placeholder="2">
          </div>
          <div>
            <label for="ffmpeg-flags">Flags</label>
            <input type="text" id="ffmpeg-flags" name="ffmpeg_flags" value="${v('flags')}" placeholder="-global_header">
          </div>
        </div>
        <p class="form-section-title" style="margin-top:1rem;">Video</p>
        <div class="form-row">
          <div>
            <label for="ffmpeg-video-codec">Video codec</label>
            <select id="ffmpeg-video-codec" name="ffmpeg_video_codec">
              <option value="libx264" ${opts.video_codec === 'libx264' ? 'selected' : ''}>libx264 (re-encode)</option>
              <option value="copy" ${opts.video_codec === 'copy' ? 'selected' : ''}>copy (passthrough)</option>
            </select>
          </div>
          <div>
            <label for="ffmpeg-preset">Preset</label>
            <select id="ffmpeg-preset" name="ffmpeg_preset">
              <option value="ultrafast" ${opts.preset === 'ultrafast' ? 'selected' : ''}>ultrafast</option>
              <option value="superfast" ${opts.preset === 'superfast' ? 'selected' : ''}>superfast</option>
              <option value="veryfast" ${opts.preset === 'veryfast' ? 'selected' : ''}>veryfast</option>
              <option value="fast" ${opts.preset === 'fast' ? 'selected' : ''}>fast</option>
              <option value="medium" ${opts.preset === 'medium' ? 'selected' : ''}>medium</option>
              <option value="slow" ${opts.preset === 'slow' ? 'selected' : ''}>slow</option>
            </select>
          </div>
          <div>
            <label for="ffmpeg-tune">Tune</label>
            <input type="text" id="ffmpeg-tune" name="ffmpeg_tune" value="${v('tune')}" placeholder="zerolatency">
          </div>
          <div>
            <label for="ffmpeg-crf">CRF (0–51)</label>
            <input type="number" id="ffmpeg-crf" name="ffmpeg_crf" value="${v('crf')}" min="0" max="51" placeholder="28">
          </div>
          <div>
            <label for="ffmpeg-pix-fmt">Pixel format</label>
            <input type="text" id="ffmpeg-pix-fmt" name="ffmpeg_pix_fmt" value="${v('pix_fmt')}" placeholder="yuv420p">
          </div>
        </div>
        <div class="form-row">
          <div>
            <label for="ffmpeg-g">GOP size (keyframe interval)</label>
            <input type="number" id="ffmpeg-g" name="ffmpeg_g" value="${v('g')}" min="1" placeholder="16">
          </div>
          <div>
            <label for="ffmpeg-keyint-min">Keyint min</label>
            <input type="number" id="ffmpeg-keyint-min" name="ffmpeg_keyint_min" value="${v('keyint_min')}" min="1" placeholder="8">
          </div>
          <div style="flex:1;">
            <label for="ffmpeg-force-key-frames">Force key frames</label>
            <input type="text" id="ffmpeg-force-key-frames" name="ffmpeg_force_key_frames" value="${v('force_key_frames')}" placeholder="expr:gte(t,n_forced*2)">
          </div>
        </div>
        <p class="form-section-title" style="margin-top:1rem;">Audio</p>
        <div class="form-row">
          <div>
            <label for="ffmpeg-audio-codec">Audio codec</label>
            <select id="ffmpeg-audio-codec" name="ffmpeg_audio_codec">
              <option value="aac" ${opts.audio_codec === 'aac' ? 'selected' : ''}>aac</option>
              <option value="copy" ${opts.audio_codec === 'copy' ? 'selected' : ''}>copy</option>
              <option value="none" ${opts.audio_codec === 'none' ? 'selected' : ''}>none (no audio)</option>
            </select>
          </div>
          <div>
            <label for="ffmpeg-audio-channels">Channels</label>
            <input type="number" id="ffmpeg-audio-channels" name="ffmpeg_audio_channels" value="${v('audio_channels')}" min="0" placeholder="1">
          </div>
          <div>
            <label for="ffmpeg-audio-sample-rate">Sample rate (Hz)</label>
            <input type="number" id="ffmpeg-audio-sample-rate" name="ffmpeg_audio_sample_rate" value="${v('audio_sample_rate')}" placeholder="44100">
          </div>
        </div>
        <p class="form-section-title" style="margin-top:1rem;">HLS output</p>
        <div class="form-row">
          <div>
            <label for="ffmpeg-hls-time">HLS segment length (s)</label>
            <input type="number" id="ffmpeg-hls-time" name="ffmpeg_hls_time" value="${v('hls_time')}" min="1" placeholder="2">
          </div>
          <div>
            <label for="ffmpeg-hls-list-size">HLS list size (segments)</label>
            <input type="number" id="ffmpeg-hls-list-size" name="ffmpeg_hls_list_size" value="${v('hls_list_size')}" min="0" placeholder="3">
          </div>
          <div style="flex:1;">
            <label for="ffmpeg-hls-flags">HLS flags</label>
            <input type="text" id="ffmpeg-hls-flags" name="ffmpeg_hls_flags" value="${v('hls_flags')}" placeholder="delete_segments+append_list">
          </div>
        </div>
        <div style="margin-top:0.75rem;">
          <label for="ffmpeg-extra-input-args">Extra input arguments (space-separated, e.g. -analyzeduration 1M)</label>
          <input type="text" id="ffmpeg-extra-input-args" name="ffmpeg_extra_input_args" value="${v('extra_input_args')}" placeholder="" style="width:100%;max-width:480px;">
        </div>
        <div style="margin-top:0.5rem;">
          <label for="ffmpeg-extra-output-args">Extra output arguments (space-separated)</label>
          <input type="text" id="ffmpeg-extra-output-args" name="ffmpeg_extra_output_args" value="${v('extra_output_args')}" placeholder="" style="width:100%;max-width:480px;">
        </div>
      </div>`;
}

const BUILD_TIME = new Date().toISOString();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function friendlyDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'Z');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) { return iso; }
}

// --- Simple CSRF using session-bound tokens ---
function getCsrfToken(req) {
  if (!req.session._csrf) req.session._csrf = crypto.randomBytes(32).toString('hex');
  return req.session._csrf;
}

function csrfField(req) {
  return `<input type="hidden" name="_csrf" value="${getCsrfToken(req)}">`;
}

function verifyCsrf(req, res, next) {
  let token = (req.body && req.body._csrf) || '';
  if (Array.isArray(token)) {
    // In cases like the snapshots page where multiple forms with _csrf exist,
    // express.urlencoded can give us an array. Use the last value (the one
    // from the submitted form) for verification.
    token = token[token.length - 1] || '';
  }
  if (!req.session._csrf || token !== req.session._csrf) {
    return res.status(403).send(layout('Error', '', `
      <h1>Invalid request</h1>
      <p>Your session may have expired. Please <a href="/admin">go back</a> and try again.</p>
    `));
  }
  // Don't delete token so multiple forms on the same page (e.g. star/delete per snapshot) all work
  next();
}

function nav(active) {
  const items = [
    { id: 'cameras', label: 'Cameras', icon: '&#x1F3A5;', href: '/admin' },
    { id: 'snapshots', label: 'Snapshots', icon: '&#x1F4F7;', href: '/admin/snapshots' },
    { id: 'visitors', label: 'Visitors', icon: '&#x1F4CA;', href: '/admin/visitors' },
    { id: 'users', label: 'Users', icon: '&#x1F465;', href: '/admin/users' },
    { id: 'settings', label: 'Settings', icon: '&#x2699;&#xFE0F;', href: '/admin/settings' },
  ];
  const links = items.map(i =>
    `<a href="${i.href}" class="nav-item ${active === i.id ? 'active' : ''}"><span class="nav-icon">${i.icon}</span>${i.label}</a>`
  ).join('');
  return `<nav class="admin-nav">${links}<span class="nav-sep"></span><a href="/" class="nav-item"><span class="nav-icon">&#x1F426;</span>View live</a></nav>`;
}

function breadcrumb(...parts) {
  if (!parts.length) return '';
  const links = parts.map((p, i) => {
    if (i === parts.length - 1) return `<span>${escapeHtml(p.label)}</span>`;
    return `<a href="${p.href}">${escapeHtml(p.label)}</a><span class="sep">/</span>`;
  }).join('');
  return `<div class="breadcrumb">${links}</div>`;
}

function getSiteName() {
  return db.getSetting('site_name') || 'Birdcam Live';
}

const layout = (title, navHtml, body) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} – ${escapeHtml(getSiteName())} Admin</title>
  <link rel="stylesheet" href="/admin/style.css">
</head>
<body class="admin">
  <div class="admin-wrap">
    <header class="admin-header">
      <a href="/admin">${escapeHtml(getSiteName())} Admin</a>
      ${title !== 'Login' && title !== 'Setup' ? '<a href="/admin/logout" class="btn btn-ghost">Logout</a>' : ''}
    </header>
    <main class="admin-main">
      ${navHtml}
      ${body}
    </main>
  </div>
  <script src="/admin/confirm-handler.js"></script>
</body>
</html>`;

// --- Login / Logout / Setup ---

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin');
  const hasUser = db.getDb().prepare('SELECT 1 FROM users LIMIT 1').get();
  if (!hasUser) return res.redirect('/admin/setup');
  res.send(layout('Login', '', `
    <div class="login-box">
      <img src="/logo.png" alt="Birdcam Live" style="display:block;margin:0 auto 1rem;height:6rem;width:auto;">
      <h1>Log in to Birdcam</h1>
      ${req.query.msg ? `<div class="admin-msg">${escapeHtml(req.query.msg)}</div>` : ''}
      <form method="post" action="/admin/login" class="admin-form">
        ${csrfField(req)}
        <label for="login-user">Username</label>
        <input type="text" id="login-user" name="username" required autofocus placeholder="Enter username">
        <label for="login-pw">Password</label>
        <input type="password" id="login-pw" name="password" required placeholder="Enter password">
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" style="flex:1">Log in</button>
        </div>
      </form>
      <div style="text-align:center;margin-top:1rem;">
        <a href="/" class="btn btn-ghost">&#x25B6; Back to live stream</a>
      </div>
    </div>
  `));
});

router.post('/login', verifyCsrf, (req, res) => {
  const { username, password } = req.body || {};
  const user = db.findUserByUsername(username);
  if (!user || !db.verifyPassword(password, user.password_hash)) {
    return res.redirect('/admin/login?msg=Invalid+username+or+password');
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/setup', requireSetup, (req, res) => {
  res.send(layout('Setup', '', `
    <div class="login-box">
      <img src="/logo.png" alt="Birdcam Live" style="display:block;margin:0 auto 1rem;height:6rem;width:auto;">
      <h1>Welcome to Birdcam</h1>
      <p style="text-align:center;color:#718096;margin-bottom:1.5rem;">Create your admin account to get started.</p>
      <form method="post" action="/admin/setup" class="admin-form">
        ${csrfField(req)}
        <label for="setup-user">Username</label>
        <input type="text" id="setup-user" name="username" required autofocus placeholder="Choose a username">
        <label for="setup-pw">Password</label>
        <input type="password" id="setup-pw" name="password" required minlength="6" placeholder="Min. 6 characters">
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" style="flex:1">Create admin account</button>
        </div>
      </form>
    </div>
  `));
});

router.post('/setup', requireSetup, verifyCsrf, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.redirect('/admin/setup');
  }
  db.ensureAdmin(username, password);
  const user = db.findUserByUsername(username);
  req.session.userId = user.id;
  req.session.username = user.username;
  res.redirect('/admin');
});

// --- Dashboard ---

router.get('/', requireLogin, requireNoSetup, (req, res) => {
  const cameras = db.listCameras();
  let cameraList;
  if (cameras.length) {
    const cards = cameras.map((c) => {
      const running = streamManager.isRunning(c.id);
      return `
        <div class="camera-card">
          <div class="camera-card-info">
            <div class="camera-card-name">${escapeHtml(c.display_name)}</div>
            <div class="camera-card-meta">${escapeHtml(c.rtsp_host)}:${c.rtsp_port}${escapeHtml(c.rtsp_path)}</div>
          </div>
          <span class="status ${running ? 'on' : 'off'}"><span class="status-dot"></span>${running ? 'Live' : 'Off'}</span>
          <div class="camera-card-actions">
            <a href="/admin/cameras/${c.id}/edit" class="btn btn-small">Edit</a>
            <form method="post" action="/admin/cameras/${c.id}/delete" style="display:inline" data-confirm="Delete camera &quot;${escapeHtml(c.display_name)}&quot;?">
              ${csrfField(req)}
              <button type="submit" class="btn btn-small btn-danger">Delete</button>
            </form>
          </div>
        </div>`;
    }).join('');
    cameraList = `<div class="camera-cards">${cards}</div>`;
  } else {
    cameraList = `
      <div class="empty-state">
        <div class="empty-state-icon">&#x1F3A5;</div>
        <p class="empty-state-text">No cameras yet. Add your first one!</p>
        <a href="/admin/cameras/new" class="btn btn-primary">Add camera</a>
      </div>`;
  }
  res.send(layout('Dashboard', nav('cameras'), `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
      <h1 style="margin:0">Cameras</h1>
      ${cameras.length ? '<a href="/admin/cameras/new" class="btn btn-primary btn-small">+ Add camera</a>' : ''}
    </div>
    ${cameraList}
    <div style="margin-top:1rem;">
      <button type="button" class="btn btn-small btn-ghost" id="debug-toggle">&#x1F41B; Debug</button>
      <div id="debug-panel" class="debug-panel" style="display:none;"></div>
    </div>
    <script src="/admin/dashboard-debug.js"></script>
  `));
});

// --- Cameras ---

router.get('/cameras/new', requireLogin, (req, res) => {
  const ffmpegOpts = getFfmpegOptsForForm(null);
  res.send(layout('Add camera', nav('cameras'), `
    ${breadcrumb({ label: 'Cameras', href: '/admin' }, { label: 'Add camera' })}
    <h1>Add camera</h1>
    ${req.query.msg ? `<div class="admin-msg">${escapeHtml(req.query.msg)}</div>` : ''}
    <form method="post" action="/admin/cameras" class="admin-form">
      ${csrfField(req)}
      <div class="form-section">
        <p class="form-section-title">Display</p>
        <label for="cam-name">Camera name</label>
        <input type="text" id="cam-name" name="display_name" required placeholder="e.g. Garden bird feeder">
      </div>
      <div class="form-section">
        <p class="form-section-title">RTSP Connection</p>
        <div class="form-row">
          <div>
            <label for="cam-host">Host / IP</label>
            <input type="text" id="cam-host" name="rtsp_host" required placeholder="192.168.1.100">
          </div>
          <div class="form-col-sm">
            <label for="cam-port">Port</label>
            <input type="text" id="cam-port" name="rtsp_port" value="554" placeholder="554">
          </div>
        </div>
        <label for="cam-path">Path</label>
        <input type="text" id="cam-path" name="rtsp_path" placeholder="/stream1">
        <div class="form-row">
          <div>
            <label for="cam-user">Username</label>
            <input type="text" id="cam-user" name="rtsp_username" placeholder="admin" autocomplete="off">
          </div>
          <div>
            <label for="cam-pass">Password</label>
            <input type="password" id="cam-pass" name="rtsp_password" placeholder="password" autocomplete="off">
          </div>
        </div>
      </div>
      ${ffmpegFormSection(ffmpegOpts)}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Add camera</button>
        <a href="/admin" class="btn btn-ghost">Cancel</a>
      </div>
    </form>
  `));
});

router.post('/cameras', requireLogin, verifyCsrf, (req, res) => {
  const { display_name, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password } = req.body || {};
  if (!display_name || !rtsp_host) return res.redirect('/admin/cameras/new');
  const port = parseInt(rtsp_port) || 554;
  const ffmpegOpts = { ...DEFAULT_FFMPEG_OPTIONS, ...ffmpegOptionsFromBody(req.body || {}) };
  try {
    const id = db.createCamera(display_name.trim(), rtsp_host.trim(), port, (rtsp_path || '').trim(), (rtsp_username || '').trim(), (rtsp_password || '').trim(), JSON.stringify(ffmpegOpts));
    const cam = db.getCamera(id);
    streamManager.startStream(id, cam);
    res.redirect('/admin');
  } catch (err) {
    res.redirect('/admin/cameras/new?msg=' + encodeURIComponent(err.message));
  }
});

router.get('/cameras/:id/edit', requireLogin, (req, res) => {
  const c = db.getCamera(Number(req.params.id));
  if (!c) return res.redirect('/admin');
  const hasRtspPw = c.rtsp_password ? true : false;
  const ffmpegOpts = getFfmpegOptsForForm(c);
  res.send(layout('Edit camera', nav('cameras'), `
    ${breadcrumb({ label: 'Cameras', href: '/admin' }, { label: escapeHtml(c.display_name) })}
    <h1>Edit camera</h1>
    ${req.query.msg ? `<div class="admin-msg">${escapeHtml(req.query.msg)}</div>` : ''}
    <form method="post" action="/admin/cameras/${c.id}" class="admin-form">
      ${csrfField(req)}
      <div class="form-section">
        <p class="form-section-title">Display</p>
        <label for="cam-name">Camera name</label>
        <input type="text" id="cam-name" name="display_name" value="${escapeHtml(c.display_name)}" required>
      </div>
      <div class="form-section">
        <p class="form-section-title">RTSP Connection</p>
        <div class="form-row">
          <div>
            <label for="cam-host">Host / IP</label>
            <input type="text" id="cam-host" name="rtsp_host" value="${escapeHtml(c.rtsp_host)}" required>
          </div>
          <div class="form-col-sm">
            <label for="cam-port">Port</label>
            <input type="text" id="cam-port" name="rtsp_port" value="${escapeHtml(String(c.rtsp_port || 554))}">
          </div>
        </div>
        <label for="cam-path">Path</label>
        <input type="text" id="cam-path" name="rtsp_path" value="${escapeHtml(c.rtsp_path)}">
        <div class="form-row">
          <div>
            <label for="cam-user">Username</label>
            <input type="text" id="cam-user" name="rtsp_username" value="${escapeHtml(c.rtsp_username)}" autocomplete="off">
          </div>
          <div>
            <label for="cam-pass">Password</label>
            <input type="password" id="cam-pass" name="rtsp_password" placeholder="${hasRtspPw ? '(unchanged)' : ''}" autocomplete="off">
            <p class="field-hint">${hasRtspPw ? 'Leave blank to keep current password.' : 'No password set.'}</p>
          </div>
        </div>
      </div>
      ${ffmpegFormSection(ffmpegOpts)}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save changes</button>
        <a href="/admin" class="btn btn-ghost">Cancel</a>
      </div>
    </form>
  `));
});

router.post('/cameras/:id', requireLogin, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  const c = db.getCamera(id);
  if (!c) return res.redirect('/admin');
  const { display_name, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password } = req.body || {};
  if (!display_name || !rtsp_host) return res.redirect(`/admin/cameras/${id}/edit`);
  const port = parseInt(rtsp_port) || 554;
  const password = rtsp_password || c.rtsp_password;
  const ffmpegOpts = { ...DEFAULT_FFMPEG_OPTIONS, ...ffmpegOptionsFromBody(req.body || {}) };
  try {
    db.updateCamera(id, display_name.trim(), rtsp_host.trim(), port, (rtsp_path || '').trim(), (rtsp_username || '').trim(), (password || '').trim(), JSON.stringify(ffmpegOpts));
    streamManager.stopStream(id);
    const updated = db.getCamera(id);
    streamManager.startStream(id, updated);
    res.redirect('/admin');
  } catch (err) {
    res.redirect(`/admin/cameras/${id}/edit?msg=` + encodeURIComponent(err.message));
  }
});

router.post('/cameras/:id/delete', requireLogin, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (db.getCamera(id)) {
    streamManager.stopStream(id);
    db.deleteCamera(id);
  }
  res.redirect('/admin');
});

// --- Users ---

router.get('/users', requireLogin, (req, res) => {
  const users = db.listUsers();
  let userContent;
  if (users.length) {
    const rows = users.map((u) => {
      const isSelf = req.session.userId === u.id;
      const canDelete = db.countUsers() > 1 && !isSelf;
      return `
        <tr>
          <td><strong>${escapeHtml(u.username)}</strong>${isSelf ? ' <span style="color:#3182ce;font-size:0.8rem;">(you)</span>' : ''}</td>
          <td>${friendlyDate(u.created_at)}</td>
          <td>
            <a href="/admin/users/${u.id}/edit" class="btn btn-small">Change password</a>
            ${canDelete ? `
            <form method="post" action="/admin/users/${u.id}/delete" style="display:inline" data-confirm="Delete user &quot;${escapeHtml(u.username)}&quot;?">
              ${csrfField(req)}
              <button type="submit" class="btn btn-small btn-danger">Delete</button>
            </form>
            ` : ''}
          </td>
        </tr>`;
    }).join('');
    userContent = `
      <table class="admin-table">
        <thead><tr><th>Username</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } else {
    userContent = `
      <div class="empty-state">
        <div class="empty-state-icon">&#x1F465;</div>
        <p class="empty-state-text">No users found.</p>
      </div>`;
  }
  res.send(layout('Users', nav('users'), `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
      <h1 style="margin:0">Users</h1>
      <a href="/admin/users/new" class="btn btn-primary btn-small">+ Add user</a>
    </div>
    ${userContent}
  `));
});

router.get('/users/new', requireLogin, (req, res) => {
  res.send(layout('Add user', nav('users'), `
    ${breadcrumb({ label: 'Users', href: '/admin/users' }, { label: 'Add user' })}
    <h1>Add user</h1>
    ${req.query.msg ? `<div class="admin-msg">${escapeHtml(req.query.msg)}</div>` : ''}
    <form method="post" action="/admin/users" class="admin-form">
      ${csrfField(req)}
      <label for="new-user">Username</label>
      <input type="text" id="new-user" name="username" required autofocus placeholder="Enter username">
      <label for="new-pw">Password</label>
      <input type="password" id="new-pw" name="password" required minlength="6" placeholder="Min. 6 characters">
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Add user</button>
        <a href="/admin/users" class="btn btn-ghost">Cancel</a>
      </div>
    </form>
  `));
});

router.post('/users', requireLogin, verifyCsrf, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) return res.redirect('/admin/users/new');
  const trimmed = username.trim();
  if (db.findUserByUsername(trimmed)) {
    return res.redirect('/admin/users/new?msg=Username+already+exists');
  }
  db.createUser(trimmed, password);
  res.redirect('/admin/users');
});

router.get('/users/:id/edit', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.getUser(id);
  if (!u) return res.redirect('/admin/users');
  res.send(layout('Change password', nav('users'), `
    ${breadcrumb({ label: 'Users', href: '/admin/users' }, { label: escapeHtml(u.username) })}
    <h1>Change password</h1>
    <p style="color:#718096;margin-bottom:1rem;">Updating password for <strong>${escapeHtml(u.username)}</strong></p>
    <form method="post" action="/admin/users/${id}" class="admin-form">
      ${csrfField(req)}
      <label for="edit-pw">New password</label>
      <input type="password" id="edit-pw" name="password" required minlength="6" placeholder="Min. 6 characters">
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Update password</button>
        <a href="/admin/users" class="btn btn-ghost">Cancel</a>
      </div>
    </form>
  `));
});

router.post('/users/:id', requireLogin, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (!db.getUser(id)) return res.redirect('/admin/users');
  const password = (req.body || {}).password;
  if (!password || password.length < 6) return res.redirect(`/admin/users/${id}/edit`);
  db.updateUserPassword(id, password);
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', requireLogin, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (db.countUsers() <= 1) return res.redirect('/admin/users');
  if (!db.getUser(id)) return res.redirect('/admin/users');
  db.deleteUser(id);
  if (req.session.userId === id) {
    req.session.destroy(() => res.redirect('/admin/login'));
    return;
  }
  res.redirect('/admin/users');
});

// --- Visitors (history graph + unique counts) ---
router.get('/api/visitor-stats', requireLogin, (req, res) => {
  res.json(db.getVisitorStats());
});

router.get('/visitors', requireLogin, (req, res) => {
  res.send(layout('Visitors', nav('visitors'), `
    ${breadcrumb({ href: '/admin/visitors', label: 'Visitors' })}
    <h1>Visitor history</h1>
    <p class="visitors-desc">Unique visitors to the live stream page (cookie-based).</p>

    <div class="visitor-stats-cards">
      <div class="visitor-card">
        <span class="visitor-card-value" id="stat-today">—</span>
        <span class="visitor-card-label">Unique today</span>
      </div>
      <div class="visitor-card">
        <span class="visitor-card-value" id="stat-week">—</span>
        <span class="visitor-card-label">Last 7 days</span>
      </div>
      <div class="visitor-card">
        <span class="visitor-card-value" id="stat-month">—</span>
        <span class="visitor-card-label">Last 30 days</span>
      </div>
    </div>

    <div class="visitor-chart-wrap">
      <h2>Unique visitors per day (last 30 days)</h2>
      <canvas id="visitor-chart" width="800" height="280" role="img" aria-label="Line chart of unique visitors per day"></canvas>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js"></script>
    <script src="/admin/visitors-chart.js"></script>
  `));
});

// --- Snapshots admin ---

router.get('/snapshots', requireLogin, (req, res) => {
  const snaps = db.getAllSnapshots(200);
  const csrfToken = csrfField(req);
  let content;
  if (snaps.length) {
    const cards = snaps.map((s) => {
      const starClass = s.starred ? 'snap-admin-card starred' : 'snap-admin-card';
      const starLabel = s.starred ? 'Unstar' : 'Star';
      const starIcon = s.starred ? '&#x2B50;' : '&#x2606;';
      return `
        <div class="${starClass}" data-id="${s.id}">
          <label class="snap-admin-check-wrap" title="Select">
            <input type="checkbox" class="snap-admin-check" name="ids[]" value="${s.id}">
          </label>
          <a href="/snapshots/${escapeHtml(s.filename)}" target="_blank" class="snap-admin-thumb-link">
            <img src="/snapshots/${escapeHtml(s.filename)}" alt="Snapshot" class="snap-admin-thumb" loading="lazy">
            ${s.starred ? '<span class="snap-admin-starred-badge">&#x2B50; Starred</span>' : ''}
          </a>
          <div class="snap-admin-meta">
            <div class="snap-admin-nick">${escapeHtml(s.nickname)}</div>
            <div class="snap-admin-cam">${escapeHtml(s.camera_name || '—')}</div>
            <div class="snap-admin-time">${escapeHtml(s.created_at)}</div>
          </div>
          <div class="snap-admin-actions">
            <form method="post" action="/admin/snapshots/${s.id}/star" style="display:inline">
              ${csrfToken}
              <input type="hidden" name="starred" value="${s.starred ? '0' : '1'}">
              <button type="submit" class="btn btn-small ${s.starred ? 'btn-ghost' : ''}" title="${starLabel}">${starIcon} ${starLabel}</button>
            </form>
            <form method="post" action="/admin/snapshots/${s.id}/delete" style="display:inline" data-confirm="Delete this snapshot?">
              ${csrfToken}
              <button type="submit" class="btn btn-small btn-danger">Delete</button>
            </form>
          </div>
        </div>`;
    }).join('');
    content = `
      ${req.query.msg ? `<div class="admin-msg admin-msg-ok">${escapeHtml(req.query.msg)}</div>` : ''}
      <form method="post" action="/admin/snapshots/bulk-delete" id="bulk-form">
        ${csrfToken}
        <div class="snap-bulk-bar">
          <label class="snap-bulk-select-all">
            <input type="checkbox" id="snap-select-all"> Select all
          </label>
          <button type="submit" class="btn btn-danger" id="bulk-delete-btn" disabled>&#x1F5D1; Delete selected (<span id="bulk-count">0</span>)</button>
        </div>
        <div class="snap-admin-grid">${cards}</div>
      </form>`;
  } else {
    content = `
      <div class="empty-state">
        <div class="empty-state-icon">&#x1F4F7;</div>
        <p class="empty-state-text">No snapshots yet. Visitors can take snapshots from the live stream.</p>
      </div>`;
  }
  res.send(layout('Snapshots', nav('snapshots'), `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
      <h1 style="margin:0">Snapshots</h1>
    </div>
    <p class="visitors-desc">Star a snapshot to pin it in the strip for all viewers.</p>
    ${content}
    <script src="/admin/snapshots-admin.js"></script>
  `));
});

router.post('/snapshots/:id/star', requireLogin, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  const starred = (req.body || {}).starred === '1';
  db.setSnapshotStarred(id, starred);
  res.redirect('/admin/snapshots?msg=' + (starred ? 'Snapshot+starred' : 'Snapshot+unstarred'));
});

router.post('/snapshots/:id/delete', requireLogin, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  const snap = db.getSnapshot(id);
  if (snap) {
    const base = path.basename(snap.filename);
    if (base !== snap.filename || base.includes('..')) return res.redirect('/admin/snapshots');
    const filePath = path.join(__dirname, '..', 'data', 'snapshots', base);
    try { fs.unlinkSync(filePath); } catch (_) {}
    db.deleteSnapshot(id);
  }
  res.redirect('/admin/snapshots?msg=Snapshot+deleted');
});

router.post('/snapshots/bulk-delete', requireLogin, verifyCsrf, (req, res) => {
  let ids = req.body.ids || req.body['ids[]'] || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(n => n > 0);
  const snapshotDir = path.join(__dirname, '..', 'data', 'snapshots');
  for (const id of ids) {
    const snap = db.getSnapshot(id);
    if (snap) {
      const base = path.basename(snap.filename);
      if (base === snap.filename && !base.includes('..')) {
        try { fs.unlinkSync(path.join(snapshotDir, base)); } catch (_) {}
      }
    }
  }
  db.deleteSnapshots(ids);
  res.redirect('/admin/snapshots?msg=' + encodeURIComponent(`Deleted ${ids.length} snapshot${ids.length !== 1 ? 's' : ''}`));
});

// --- Settings ---

router.get('/settings', requireLogin, (req, res) => {
  const settings = db.getAllSettings();
  const reverseProxy = settings.reverse_proxy === 'true';
  const requireAuth = settings.require_auth_streams === 'true';
  const loginRateWindow = settings.login_rate_window_min || '15';
  const loginRateMax = settings.login_rate_max || '15';
  const setupRateWindow = settings.setup_rate_window_min || '15';
  const setupRateMax = settings.setup_rate_max || '10';
  const chatRateLimit = settings.chat_rate_limit || '5';
  const chatRateWindow = settings.chat_rate_window_ms || '1000';
  const snapRateMax = settings.snapshot_rate_max || '6';
  const snapRateWindow = settings.snapshot_rate_window_sec || '60';
  const apiRateMax = settings.api_rate_max || '100';
  const apiRateWindow = settings.api_rate_window_min || '1';
  const snapStripStarred = settings.snap_strip_starred || '3';
  const snapStripTotal = settings.snap_strip_total || '5';
  const siteName = settings.site_name || 'Birdcam Live';
  res.send(layout('Settings', nav('settings'), `
    <h1>Settings</h1>
    ${req.query.msg ? `<div class="admin-msg admin-msg-ok">${escapeHtml(req.query.msg)}</div>` : ''}
    <form method="post" action="/admin/settings" class="admin-form">
      ${csrfField(req)}
      <fieldset class="settings-group">
        <legend>Site</legend>
        <div>
          <label for="site-name">Site name</label>
          <input type="text" id="site-name" name="site_name" value="${escapeHtml(siteName)}" maxlength="60" style="width:100%;max-width:320px">
        </div>
        <p class="field-hint">Shown in the browser tab, header logo text, and admin panel. Default: Birdcam Live.</p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Network / Proxy</legend>
        <label class="checkbox-label">
          <input type="checkbox" name="reverse_proxy" value="true" ${reverseProxy ? 'checked' : ''}>
          Behind a reverse proxy (nginx, Caddy, Traefik)
        </label>
        <p class="field-hint">
          Enable this if Birdcam is behind nginx or another reverse proxy that handles HTTPS/TLS.
          This sets <code>trust proxy</code>, enables <code>Secure</code> cookies, and trusts
          <code>X-Forwarded-*</code> headers from the proxy.
          <strong>Do NOT enable this if the app is directly exposed to the internet.</strong>
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Stream Access</legend>
        <label class="checkbox-label">
          <input type="checkbox" name="require_auth_streams" value="true" ${requireAuth ? 'checked' : ''}>
          Require login to view camera streams
        </label>
        <p class="field-hint">
          When enabled, the HLS video streams (<code>/hls/*</code>) require an authenticated session.
          When disabled, anyone with the URL can view the streams (public access).
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Login Rate Limiting</legend>
        <div class="form-row">
          <div>
            <label for="login-rate-max">Max attempts</label>
            <input type="number" id="login-rate-max" name="login_rate_max" value="${escapeHtml(loginRateMax)}" min="1" max="1000">
          </div>
          <div>
            <label for="login-rate-window">Window (minutes)</label>
            <input type="number" id="login-rate-window" name="login_rate_window_min" value="${escapeHtml(loginRateWindow)}" min="1" max="1440">
          </div>
        </div>
        <p class="field-hint">
          Maximum number of login attempts per IP address within the time window.
          Default: 15 attempts per 15 minutes.
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Setup Rate Limiting</legend>
        <div class="form-row">
          <div>
            <label for="setup-rate-max">Max attempts</label>
            <input type="number" id="setup-rate-max" name="setup_rate_max" value="${escapeHtml(setupRateMax)}" min="1" max="1000">
          </div>
          <div>
            <label for="setup-rate-window">Window (minutes)</label>
            <input type="number" id="setup-rate-window" name="setup_rate_window_min" value="${escapeHtml(setupRateWindow)}" min="1" max="1440">
          </div>
        </div>
        <p class="field-hint">
          Rate limit for the initial setup page. Default: 10 attempts per 15 minutes.
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Chat Rate Limiting</legend>
        <div class="form-row">
          <div>
            <label for="chat-rate-limit">Max messages</label>
            <input type="number" id="chat-rate-limit" name="chat_rate_limit" value="${escapeHtml(chatRateLimit)}" min="1" max="100">
          </div>
          <div>
            <label for="chat-rate-window">Window (ms)</label>
            <input type="number" id="chat-rate-window" name="chat_rate_window_ms" value="${escapeHtml(chatRateWindow)}" min="100" max="60000">
          </div>
        </div>
        <p class="field-hint">
          Maximum chat messages per user within the time window (WebSocket).
          Default: 5 messages per 1000ms (1 second).
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Snapshot Rate Limiting</legend>
        <div class="form-row">
          <div>
            <label for="snap-rate-max">Max snapshots</label>
            <input type="number" id="snap-rate-max" name="snapshot_rate_max" value="${escapeHtml(snapRateMax)}" min="1" max="100">
          </div>
          <div>
            <label for="snap-rate-window">Window (seconds)</label>
            <input type="number" id="snap-rate-window" name="snapshot_rate_window_sec" value="${escapeHtml(snapRateWindow)}" min="10" max="3600">
          </div>
        </div>
        <p class="field-hint">
          Maximum snapshots per IP within the time window.
          Default: 6 snapshots per 60 seconds.
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Public API Rate Limiting</legend>
        <div class="form-row">
          <div>
            <label for="api-rate-max">Max requests</label>
            <input type="number" id="api-rate-max" name="api_rate_max" value="${escapeHtml(apiRateMax)}" min="1" max="10000">
          </div>
          <div>
            <label for="api-rate-window">Window (minutes)</label>
            <input type="number" id="api-rate-window" name="api_rate_window_min" value="${escapeHtml(apiRateWindow)}" min="1" max="60">
          </div>
        </div>
        <p class="field-hint">
          Maximum requests to public API endpoints (<code>/api/*</code>) per IP within the time window.
          Default: 100 requests per 1 minute.
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Snapshot Strip</legend>
        <div class="form-row">
          <div>
            <label for="snap-strip-starred">Starred snaps to show</label>
            <input type="number" id="snap-strip-starred" name="snap_strip_starred" value="${escapeHtml(snapStripStarred)}" min="0" max="20">
          </div>
          <div>
            <label for="snap-strip-total">Total snaps in strip</label>
            <input type="number" id="snap-strip-total" name="snap_strip_total" value="${escapeHtml(snapStripTotal)}" min="1" max="20">
          </div>
        </div>
        <p class="field-hint">
          The strip always shows the N most recent starred snaps first, then fills the remaining slots with the latest unstarred snaps.
          Viewers can also click "⭐ All stars" to browse all starred snaps.
          Default: 3 starred + up to 5 total.
        </p>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save settings</button>
        <a href="/admin" class="btn btn-ghost">Cancel</a>
      </div>
    </form>

    <fieldset class="settings-group" style="margin-top:1.5rem;">
      <legend>Sessions</legend>
      <p class="field-hint" style="padding-left:0;margin:0 0 0.75rem;">Invalidates all active sessions and forces everyone to log in again. Use this if you suspect a session has been compromised or after changing SSL/proxy settings.</p>
      <form method="post" action="/admin/invalidate-sessions" data-confirm="This will log out all users including yourself. Continue?">
        <input type="hidden" name="_csrf" value="${getCsrfToken(req)}">
        <button type="submit" class="btn btn-danger">Invalidate all sessions</button>
      </form>
    </fieldset>

    <fieldset class="settings-group" style="margin-top:1.5rem;">
      <legend>Debug</legend>
      <div class="debug-build-info">
        <span class="field-hint" style="padding-left:0;margin:0;">Build: <code>${escapeHtml(BUILD_TIME)}</code></span>
      </div>
      <label class="checkbox-label" style="margin-top:0.75rem;">
        <input type="checkbox" id="debug-log-toggle">
        Show live logs
      </label>
      <div id="debug-log-panel" style="display:none;margin-top:0.5rem;">
        <div class="debug-controls" style="margin-bottom:0.5rem;">
          <select id="debug-cam-select" class="debug-select">
            <option value="all">All cameras</option>
            ${db.listCameras().map(c => `<option value="${c.id}">${escapeHtml(c.display_name)} (cam-${c.id})</option>`).join('')}
          </select>
          <label class="debug-toggle"><input type="checkbox" id="debug-auto-scroll" checked> Auto-scroll</label>
          <button type="button" class="btn btn-small" id="debug-clear-log">Clear</button>
          <button type="button" class="btn btn-small btn-ghost" id="debug-detach-log">Detach</button>
        </div>
        <pre id="debug-log-output" class="debug-log"></pre>
      </div>
    </fieldset>

    <!-- Detached floating log bar -->
    <div id="debug-float-bar" style="display:none;position:fixed;bottom:0;left:0;right:0;z-index:200;background:#1a202c;border-top:2px solid #2d3748;">
      <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.75rem;border-bottom:1px solid #2d3748;">
        <select id="debug-float-cam-select" class="debug-select" style="background:#2d3748;color:#e2e8f0;border-color:#4a5568;font-size:0.8rem;padding:0.2rem 0.4rem;"></select>
        <label class="debug-toggle" style="color:#a0aec0;font-size:0.8rem;"><input type="checkbox" id="debug-float-auto-scroll" checked> Auto-scroll</label>
        <button type="button" class="btn btn-small" id="debug-float-clear" style="font-size:0.75rem;padding:0.2rem 0.5rem;">Clear</button>
        <button type="button" class="btn btn-small btn-ghost" id="debug-attach-log" style="font-size:0.75rem;padding:0.2rem 0.5rem;color:#a0aec0;">Attach</button>
        <span style="margin-left:auto;font-size:0.75rem;color:#718096;">Live logs</span>
      </div>
      <pre id="debug-float-log" style="background:#1a202c;color:#68d391;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:0.78rem;padding:0.5rem 0.75rem;margin:0;max-height:35vh;overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.4;"></pre>
    </div>

    <script src="/admin/settings-debug.js"></script>
  `));
});

router.post('/settings', requireLogin, verifyCsrf, (req, res) => {
  db.setSetting('reverse_proxy', req.body.reverse_proxy === 'true' ? 'true' : 'false');
  db.setSetting('require_auth_streams', req.body.require_auth_streams === 'true' ? 'true' : 'false');
  // Rate limit settings (clamp to safe ranges)
  const loginRateMax = Math.max(1, Math.min(1000, parseInt(req.body.login_rate_max) || 15));
  const loginRateWindow = Math.max(1, Math.min(1440, parseInt(req.body.login_rate_window_min) || 15));
  const setupRateMax = Math.max(1, Math.min(1000, parseInt(req.body.setup_rate_max) || 10));
  const setupRateWindow = Math.max(1, Math.min(1440, parseInt(req.body.setup_rate_window_min) || 15));
  const chatRateLimit = Math.max(1, Math.min(100, parseInt(req.body.chat_rate_limit) || 5));
  const chatRateWindow = Math.max(100, Math.min(60000, parseInt(req.body.chat_rate_window_ms) || 1000));
  const snapRateMax = Math.max(1, Math.min(100, parseInt(req.body.snapshot_rate_max) || 6));
  const snapRateWindow = Math.max(10, Math.min(3600, parseInt(req.body.snapshot_rate_window_sec) || 60));
  const snapStripStarred = Math.max(0, Math.min(20, parseInt(req.body.snap_strip_starred) || 3));
  const snapStripTotal = Math.max(1, Math.min(20, parseInt(req.body.snap_strip_total) || 5));
  db.setSetting('login_rate_max', String(loginRateMax));
  db.setSetting('login_rate_window_min', String(loginRateWindow));
  db.setSetting('setup_rate_max', String(setupRateMax));
  db.setSetting('setup_rate_window_min', String(setupRateWindow));
  db.setSetting('chat_rate_limit', String(chatRateLimit));
  db.setSetting('chat_rate_window_ms', String(chatRateWindow));
  db.setSetting('snapshot_rate_max', String(snapRateMax));
  db.setSetting('snapshot_rate_window_sec', String(snapRateWindow));
  const apiRateMax = Math.max(1, Math.min(10000, parseInt(req.body.api_rate_max) || 100));
  const apiRateWindow = Math.max(1, Math.min(60, parseInt(req.body.api_rate_window_min) || 1));
  db.setSetting('api_rate_max', String(apiRateMax));
  db.setSetting('api_rate_window_min', String(apiRateWindow));
  db.setSetting('snap_strip_starred', String(snapStripStarred));
  db.setSetting('snap_strip_total', String(snapStripTotal));
  const siteName = String(req.body.site_name || 'Birdcam Live').trim().slice(0, 60) || 'Birdcam Live';
  db.setSetting('site_name', siteName);
  res.redirect('/admin/settings?msg=Settings+saved');
});

// --- Invalidate all sessions ---
router.post('/invalidate-sessions', requireLogin, verifyCsrf, (req, res) => {
  req.app.rotateSessionSecret();
  req.session.destroy(() => res.redirect('/admin/login?msg=All+sessions+invalidated'));
});

// --- Debug info API (reduced info for security) ---

router.get('/api/debug-info', requireLogin, (req, res) => {
  const cameras = db.listCameras();
  const uptimeSec = process.uptime();
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = Math.floor(uptimeSec % 60);
  res.json({
    uptime: `${h}h ${m}m ${s}s`,
    nodeVersion: process.version,
    memoryMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
    cameras: cameras.map(c => ({
      id: c.id,
      name: c.display_name,
      running: streamManager.isRunning(c.id),
      logLines: streamManager.getLogs(c.id).length,
      streamInfo: streamManager.getStreamInfo(c.id),
    })),
  });
});

// --- Debug log API ---

router.get('/api/logs', requireLogin, (req, res) => {
  res.json(streamManager.getAllLogs());
});

router.get('/api/logs/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  res.json({ id, lines: streamManager.getLogs(id) });
});

// --- Debug page ---

router.get('/debug', requireLogin, (req, res) => {
  const cameras = db.listCameras();
  const options = cameras.map(c =>
    `<option value="${c.id}">${escapeHtml(c.display_name)} (cam-${c.id})</option>`
  ).join('');
  res.send(layout('Debug', nav('cameras'), `
    ${breadcrumb({ label: 'Cameras', href: '/admin' }, { label: 'Debug Logs' })}
    <h1>Debug Logs</h1>
    <div class="debug-controls">
      <select id="cam-select" class="debug-select">
        <option value="all">All cameras</option>
        ${options}
      </select>
      <label class="debug-toggle"><input type="checkbox" id="auto-scroll" checked> Auto-scroll</label>
      <label class="debug-toggle"><input type="checkbox" id="sticky-log"> Sticky log</label>
      <button type="button" class="btn btn-small" id="clear-log">Clear</button>
    </div>
    <pre id="log-output" class="debug-log"></pre>
    <script src="/admin/debug-page.js"></script>
  `));
});

module.exports = router;
