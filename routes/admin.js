const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();
const db = require('../db');
const streamManager = require('../streamManager');
const { requireLogin, requireSetup, requireNoSetup } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { DEFAULT_FFMPEG_OPTIONS } = streamManager;
const { withSession } = require('../xmeye');

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
  if (body.ffmpeg_keyint_min != null) o.keyint_min = body.ffmpeg_keyint_min === '' ? DEFAULT_FFMPEG_OPTIONS.keyint_min : Number(body.ffmpeg_keyint_min) || 16;
  if (body.ffmpeg_force_key_frames != null) o.force_key_frames = body.ffmpeg_force_key_frames;
  if (body.ffmpeg_input_fps != null) o.input_fps = body.ffmpeg_input_fps === '' ? DEFAULT_FFMPEG_OPTIONS.input_fps : (Number(body.ffmpeg_input_fps) === 0 ? 0 : Number(body.ffmpeg_input_fps) || DEFAULT_FFMPEG_OPTIONS.input_fps);
  if (body.ffmpeg_scale_vf != null) o.scale_vf = body.ffmpeg_scale_vf === '' ? DEFAULT_FFMPEG_OPTIONS.scale_vf : body.ffmpeg_scale_vf;
  if (body.ffmpeg_color_range != null) o.color_range = body.ffmpeg_color_range === '' ? DEFAULT_FFMPEG_OPTIONS.color_range : body.ffmpeg_color_range;
  if (body.ffmpeg_audio_codec != null) o.audio_codec = body.ffmpeg_audio_codec;
  if (body.ffmpeg_audio_channels != null) o.audio_channels = body.ffmpeg_audio_channels === '' ? 1 : Number(body.ffmpeg_audio_channels) || 1;
  if (body.ffmpeg_audio_sample_rate != null) o.audio_sample_rate = body.ffmpeg_audio_sample_rate === '' ? 44100 : Number(body.ffmpeg_audio_sample_rate) || 44100;
  if (body.ffmpeg_hls_time != null) o.hls_time = body.ffmpeg_hls_time === '' ? DEFAULT_FFMPEG_OPTIONS.hls_time : Number(body.ffmpeg_hls_time) || 2;
  if (body.ffmpeg_hls_list_size != null) o.hls_list_size = body.ffmpeg_hls_list_size === '' ? DEFAULT_FFMPEG_OPTIONS.hls_list_size : Number(body.ffmpeg_hls_list_size) || 6;
  if (body.ffmpeg_hls_flags != null) o.hls_flags = body.ffmpeg_hls_flags;
  if (body.ffmpeg_fps_mode != null) o.fps_mode = body.ffmpeg_fps_mode;
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
            <input type="text" id="ffmpeg-fflags" name="ffmpeg_fflags" value="${v('fflags')}" placeholder="genpts+discardcorrupt">
          </div>
          <div>
            <label for="ffmpeg-input-fps">Input FPS (-r)</label>
            <input type="number" id="ffmpeg-input-fps" name="ffmpeg_input_fps" value="${v('input_fps')}" min="0" placeholder="8" title="0 = use camera default">
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
          <div>
            <label for="ffmpeg-fps-mode">Frame rate mode</label>
            <select id="ffmpeg-fps-mode" name="ffmpeg_fps_mode">
              <option value="vfr" ${opts.fps_mode === 'vfr' ? 'selected' : ''}>vfr (variable — recommended)</option>
              <option value="cfr" ${opts.fps_mode === 'cfr' ? 'selected' : ''}>cfr (constant)</option>
              <option value="passthrough" ${opts.fps_mode === 'passthrough' ? 'selected' : ''}>passthrough</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div style="flex:1;">
            <label for="ffmpeg-scale-vf">Scale filter (-vf)</label>
            <input type="text" id="ffmpeg-scale-vf" name="ffmpeg_scale_vf" value="${v('scale_vf')}" placeholder="scale=in_range=full:out_range=tv" style="width:100%;">
          </div>
          <div>
            <label for="ffmpeg-color-range">Color range</label>
            <input type="text" id="ffmpeg-color-range" name="ffmpeg_color_range" value="${v('color_range')}" placeholder="tv">
          </div>
        </div>
        <div class="form-row">
          <div>
            <label for="ffmpeg-g">GOP size (keyframe interval)</label>
            <input type="number" id="ffmpeg-g" name="ffmpeg_g" value="${v('g')}" min="1" placeholder="16">
          </div>
          <div>
            <label for="ffmpeg-keyint-min">Keyint min</label>
            <input type="number" id="ffmpeg-keyint-min" name="ffmpeg_keyint_min" value="${v('keyint_min')}" min="1" placeholder="16">
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
            <input type="text" id="ffmpeg-hls-flags" name="ffmpeg_hls_flags" value="${v('hls_flags')}" placeholder="delete_segments">
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

function getDateLocale() {
  const setting = db.getSetting('datetime_locale') || 'eu';
  return setting === 'us' ? 'en-US' : 'sv-SE';
}

function friendlyDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'Z');
    const locale = getDateLocale();
    if (locale === 'sv-SE') {
      // EU style: YYYY-MM-DD for consistency
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    // US style: e.g. "Sep 23, 2026"
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
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
    { id: 'motion-clips', label: 'Motion Clips', icon: '&#x1F3AC;', href: '/admin/motion-clips' },
    { id: 'visitors', label: 'Visitors', icon: '&#x1F4CA;', href: '/admin/visitors' },
    { id: 'users', label: 'Users', icon: '&#x1F465;', href: '/admin/users' },
    { id: 'chat', label: 'Chat', icon: '&#x1F4AC;', href: '/admin/chat' },
    { id: 'settings', label: 'Settings', icon: '&#x2699;&#xFE0F;', href: '/admin/settings' },
    { id: 'audit', label: 'Audit Log', icon: '&#x1F4DC;', href: '/admin/audit' },
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
      <img src="/admin.png" alt="Birdcam Admin" class="admin-login-icon">
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
    // Log failed login attempt
    db.addAuditLog(null, username || 'unknown', 'auth.login.failed', 'Path: /login', req.ip, req.requestId);
    return res.redirect('/admin/login?msg=Invalid+username+or+password');
  }

  // Regenerate session ID to prevent fixation (security review fix)
  req.session.regenerate((err) => {
    if (err) {
      console.error('Session regeneration failed:', err);
      return res.redirect('/admin/login?msg=Server+error');
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    // Log successful login with authenticated user
    db.addAuditLog(user.id, user.username, 'auth.login', 'Path: /login', req.ip, req.requestId);
    res.redirect('/admin');
  });
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

  // Regenerate session ID to prevent fixation (security review fix)
  req.session.regenerate((err) => {
    if (err) {
      console.error('Session regeneration failed:', err);
      return res.redirect('/admin/setup?msg=Server+error');
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    // Log setup with authenticated user
    db.addAuditLog(user.id, user.username, 'auth.setup', 'Path: /setup', req.ip, req.requestId);
    res.redirect('/admin');
  });
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

router.post('/cameras', requireLogin, verifyCsrf, auditLog('camera.create'), async (req, res) => {
  const { display_name, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password } = req.body || {};
  if (!display_name || !rtsp_host) return res.redirect('/admin/cameras/new');
  const port = parseInt(rtsp_port) || 554;
  const ffmpegOpts = { ...DEFAULT_FFMPEG_OPTIONS, ...ffmpegOptionsFromBody(req.body || {}) };
  try {
    const id = db.createCamera(display_name.trim(), rtsp_host.trim(), port, (rtsp_path || '').trim(), (rtsp_username || '').trim(), (rtsp_password || '').trim(), JSON.stringify(ffmpegOpts));
    const cam = db.getCamera(id);
    await streamManager.startStream(id, cam);
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
      <div class="form-section">
        <p class="form-section-title">Camera Time Sync</p>
        <p class="field-hint" style="margin-bottom:0.5rem;">Sync the camera's internal clock with this server's time. Uses XMEye protocol on port 34567.</p>
        <form method="post" action="/admin/cameras/${c.id}/sync-time" style="display:inline">
          ${csrfField(req)}
          <button type="submit" class="btn btn-small">Sync camera time</button>
        </form>
      </div>
      ${ffmpegFormSection(ffmpegOpts)}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save changes</button>
        <a href="/admin" class="btn btn-ghost">Cancel</a>
      </div>
    </form>
  `));
});

router.post('/cameras/:id', requireLogin, verifyCsrf, auditLog('camera.update'), async (req, res) => {
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
    await streamManager.stopStream(id);
    const updated = db.getCamera(id);
    await streamManager.startStream(id, updated);
    res.redirect('/admin');
  } catch (err) {
    res.redirect(`/admin/cameras/${id}/edit?msg=` + encodeURIComponent(err.message));
  }
});

router.post('/cameras/:id/delete', requireLogin, verifyCsrf, auditLog('camera.delete'), async (req, res) => {
  const id = Number(req.params.id);
  if (db.getCamera(id)) {
    await streamManager.stopStream(id);
    db.deleteCamera(id);
  }
  res.redirect('/admin');
});

router.post('/cameras/:id/sync-time', requireLogin, verifyCsrf, auditLog('camera.sync_time'), async (req, res) => {
  const id = Number(req.params.id);
  const c = db.getCamera(id);
  if (!c) return res.redirect('/admin');
  try {
    const host = c.rtsp_host;
    const port = 34567;
    const username = c.rtsp_username || 'admin';
    const password = c.rtsp_password || '';
    await withSession(host, port, username, password, async (session) => {
      await session.syncTime();
    });
    res.redirect(`/admin/cameras/${id}/edit?msg=` + encodeURIComponent('Camera time synced successfully'));
  } catch (err) {
    console.error('Time sync failed:', err.message);
    res.redirect(`/admin/cameras/${id}/edit?msg=` + encodeURIComponent('Time sync failed: ' + err.message));
  }
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

router.post('/users', requireLogin, verifyCsrf, auditLog('user.create'), (req, res) => {
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

router.post('/users/:id', requireLogin, verifyCsrf, auditLog('user.update'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.getUser(id)) return res.redirect('/admin/users');
  const password = (req.body || {}).password;
  if (!password || password.length < 6) return res.redirect(`/admin/users/${id}/edit`);
  db.updateUserPassword(id, password);
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', requireLogin, verifyCsrf, auditLog('user.delete'), (req, res) => {
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

router.post('/snapshots/:id/star', requireLogin, verifyCsrf, auditLog('snapshot.star'), (req, res) => {
  const id = Number(req.params.id);
  const starred = (req.body || {}).starred === '1';
  db.setSnapshotStarred(id, starred);
  res.redirect('/admin/snapshots?msg=' + (starred ? 'Snapshot+starred' : 'Snapshot+unstarred'));
});

router.post('/snapshots/:id/delete', requireLogin, verifyCsrf, auditLog('snapshot.delete'), (req, res) => {
  const id = Number(req.params.id);
  const snap = db.getSnapshot(id);
  if (snap) {
    const base = path.basename(snap.filename);
    if (base !== snap.filename || base.includes('..')) return res.redirect('/admin/snapshots');
    // (#22) Use shared snapshotDir from app.locals instead of fragile __dirname/../data/snapshots
    const snapDir = req.app.locals.snapshotDir || path.join(__dirname, '..', 'data', 'snapshots');
    const filePath = path.join(snapDir, base);
    try { fs.unlinkSync(filePath); } catch (_) {}
    db.deleteSnapshot(id);
  }
  res.redirect('/admin/snapshots?msg=Snapshot+deleted');
});

router.post('/snapshots/bulk-delete', requireLogin, verifyCsrf, auditLog('snapshot.bulk-delete'), (req, res) => {
  let ids = req.body.ids || req.body['ids[]'] || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(n => n > 0);
  // (#22) Use shared snapshotDir from app.locals
  const snapDir = req.app.locals.snapshotDir || path.join(__dirname, '..', 'data', 'snapshots');
  for (const id of ids) {
    const snap = db.getSnapshot(id);
    if (snap) {
      const base = path.basename(snap.filename);
      if (base === snap.filename && !base.includes('..')) {
        try { fs.unlinkSync(path.join(snapDir, base)); } catch (_) {}
      }
    }
  }
  db.deleteSnapshots(ids);
  res.redirect('/admin/snapshots?msg=' + encodeURIComponent(`Deleted ${ids.length} snapshot${ids.length !== 1 ? 's' : ''}`));
});

// --- Motion Clips (motion incident recordings) ---
router.get('/motion-clips', requireLogin, (req, res) => {
  const clips = db.listRecentMotionIncidents(200);
  const totals = db.getUnstarredMotionIncidentTotals();
  const totalMb = totals.bytes / (1024 * 1024);
  const csrfToken = csrfField(req);

  let content;
  if (clips.length) {
    const cards = clips.map((c) => {
      const isStarred = !!c.starred;
      const starLabel = isStarred ? 'Unstar' : 'Star';
      const starIcon = isStarred ? '&#x2B50;' : '&#x2606;';
      const started = c.started_at || '';
      const ended = c.ended_at || '';
      const mb = (c.size_bytes / (1024 * 1024));
      const mbStr = Number.isFinite(mb) ? mb.toFixed(1) : '0.0';
      const fileName = c.file_path ? path.basename(c.file_path) : '';
      return `
        <div class="snap-admin-card ${isStarred ? 'starred' : ''}" data-id="${c.id}">
          <label class="snap-admin-check-wrap" title="Select">
            <input type="checkbox" class="snap-admin-check" name="ids[]" value="${c.id}">
          </label>
          <div class="snap-admin-thumb-link snap-admin-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--bg-alt);font-size:2rem;">
            &#x1F3AC;
            ${isStarred ? '<span class="snap-admin-starred-badge">&#x2B50; Starred</span>' : ''}
          </div>
          <div class="snap-admin-meta">
            <div class="snap-admin-nick">${started ? started.slice(0, 10) : '—'}</div>
            <div class="snap-admin-cam">${escapeHtml(c.camera_name || '—')}</div>
            <div class="snap-admin-time">${started ? started.slice(11, 19) : '—'} → ${ended ? ended.slice(11, 19) : '...'} (${mbStr} MB)</div>
          </div>
          <div class="snap-admin-actions">
            <form method="post" action="/admin/motion-clips/${c.id}/star" style="display:inline">
              ${csrfToken}
              <input type="hidden" name="starred" value="${isStarred ? '0' : '1'}">
              <button type="submit" class="btn btn-small ${isStarred ? 'btn-ghost' : ''}" title="${starLabel}">${starIcon} ${starLabel}</button>
            </form>
            <form method="post" action="/admin/motion-clips/${c.id}/delete" style="display:inline" data-confirm="Delete this clip?">
              ${csrfToken}
              <button type="submit" class="btn btn-small btn-danger">Delete</button>
            </form>
          </div>
        </div>`;
    }).join('');
    content = `
      ${req.query.msg ? `<div class="admin-msg admin-msg-ok">${escapeHtml(req.query.msg)}</div>` : ''}
      <div class="visitor-stats-cards" style="grid-template-columns: repeat(3, minmax(0, 1fr));margin-bottom:1rem;">
        <div class="visitor-card">
          <span class="visitor-card-value">${escapeHtml(String(totals.count))}</span>
          <span class="visitor-card-label">Unstarred clips</span>
        </div>
        <div class="visitor-card">
          <span class="visitor-card-value">${escapeHtml(totalMb.toFixed(1))} MB</span>
          <span class="visitor-card-label">Unstarred total size</span>
        </div>
        <div class="visitor-card">
          <span class="visitor-card-value">${escapeHtml(String(clips.length))}</span>
          <span class="visitor-card-label">Total clips</span>
        </div>
      </div>
      <form method="post" action="/admin/motion-clips/bulk-delete" id="bulk-form">
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
        <div class="empty-state-icon">&#x1F3AC;</div>
        <p class="empty-state-text">No motion clips yet. Clips are recorded when motion is detected.</p>
      </div>`;
  }

  res.send(layout('Motion Clips', nav('motion-clips'), `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
      <h1 style="margin:0">Motion Clips</h1>
    </div>
    <p class="visitors-desc">Auto-cleanup keeps <strong>unstarred</strong> clips within the limits set in <a href="/admin/settings">Settings</a>. Star a clip to prevent auto-deletion.</p>
    ${content}
    <script src="/admin/motion-clips-admin.js"></script>
  `));
});

router.post('/motion-clips/:id/star', requireLogin, verifyCsrf, auditLog('motion_clips.star'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.redirect('/admin/motion-clips');
  const incident = db.getMotionIncident(id);
  if (!incident) return res.redirect('/admin/motion-clips');

  const starred = String(req.body.starred) === '1';
  db.setMotionIncidentStar(id, starred);
  res.redirect('/admin/motion-clips?msg=' + (starred ? 'Clip+starred' : 'Clip+unstarred'));
});

router.post('/motion-clips/:id/delete', requireLogin, verifyCsrf, auditLog('motion_clips.delete'), (req, res) => {
  const id = Number(req.params.id);
  const incident = db.getMotionIncident(id);
  if (incident) {
    const clipsDir = req.app.locals.motionClipsDir || path.join(__dirname, '..', 'data', 'motion_clips');
    if (incident.file_path) {
      const base = path.basename(incident.file_path);
      if (base === incident.file_path || !base.includes('..')) {
        try { fs.unlinkSync(path.join(clipsDir, base)); } catch (_) {}
      }
    }
    db.deleteMotionIncident(id);
  }
  res.redirect('/admin/motion-clips?msg=Clip+deleted');
});

router.post('/motion-clips/bulk-delete', requireLogin, verifyCsrf, auditLog('motion_clips.bulk-delete'), (req, res) => {
  let ids = req.body.ids || req.body['ids[]'] || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(n => n > 0);
  const clipsDir = req.app.locals.motionClipsDir || path.join(__dirname, '..', 'data', 'motion_clips');
  for (const id of ids) {
    const incident = db.getMotionIncident(id);
    if (incident && incident.file_path) {
      const base = path.basename(incident.file_path);
      if (base === incident.file_path || !base.includes('..')) {
        try { fs.unlinkSync(path.join(clipsDir, base)); } catch (_) {}
      }
    }
  }
  db.deleteMotionIncidents(ids);
  res.redirect('/admin/motion-clips?msg=' + encodeURIComponent(`Deleted ${ids.length} clip${ids.length !== 1 ? 's' : ''}`));
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
  const motionClipMaxCount = settings.motion_clip_max_count !== undefined ? settings.motion_clip_max_count : '200';
  const motionClipMaxTotalMb = settings.motion_clip_max_total_mb !== undefined ? settings.motion_clip_max_total_mb : '5000';
  const siteName = settings.site_name || 'Birdcam Live';
  const datetimeLocale = settings.datetime_locale || 'eu';
  res.send(layout('Settings', nav('settings'), `
    ${breadcrumb({ label: 'Settings', href: '/admin/settings' })}
    <div style="display:flex;flex-direction:column;gap:0.35rem;margin-bottom:1.25rem;">
      <h1 style="margin:0;">Settings</h1>
      <p style="margin:0;color:#718096;font-size:0.95rem;max-width:44rem;">
        Tune how Birdcam behaves – from site identity and access control to rate limits, snapshot strip behaviour and motion clip retention.
      </p>
      ${req.query.msg ? `<div class="admin-msg admin-msg-ok" style="margin-top:0.5rem;">${escapeHtml(req.query.msg)}</div>` : ''}
    </div>
    <form method="post" action="/admin/settings" class="admin-form">
      ${csrfField(req)}
      <fieldset class="settings-group">
        <legend>Site identity</legend>
        <div>
          <label for="site-name">Site name</label>
          <input type="text" id="site-name" name="site_name" value="${escapeHtml(siteName)}" maxlength="60" style="width:100%;max-width:320px">
        </div>
        <p class="field-hint">Shown in the tab title and in headers on the live and admin pages. Default: Birdcam Live.</p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Time & Date</legend>
        <div>
          <label for="datetime-locale">Display format</label>
          <select id="datetime-locale" name="datetime_locale">
            <option value="eu" ${datetimeLocale === 'eu' ? 'selected' : ''}>EU – 24-hour, YYYY-MM-DD (e.g. 2026-09-23)</option>
            <option value="us" ${datetimeLocale === 'us' ? 'selected' : ''}>US – 12-hour, local date (e.g. Sep 23, 2026)</option>
          </select>
        </div>
        <p class="field-hint">
          Controls how dates and times are shown in the admin UI and parts of the public UI.
          EU: dates like <code>2026-09-23</code> and 24-hour clocks (e.g. <code>14:37</code>).
          US: localized dates like <code>Sep 23, 2026</code> and 12-hour clocks (e.g. <code>2:37 PM</code>).
        </p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Network & proxy</legend>
        <label class="checkbox-label">
          <input type="checkbox" name="reverse_proxy" value="true" ${reverseProxy ? 'checked' : ''}>
          Behind a reverse proxy (nginx, Caddy, Traefik)
        </label>
        <p class="field-hint">Turn on when Birdcam runs behind nginx/Caddy/Traefik (HTTPS at the proxy). The app will trust the proxy and use <code>X-Forwarded-*</code> and secure cookies. <strong>Leave off if the app is reached directly from the internet.</strong></p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Stream Access</legend>
        <label class="checkbox-label">
          <input type="checkbox" name="require_auth_streams" value="true" ${requireAuth ? 'checked' : ''}>
          Require login to view camera streams
        </label>
        <p class="field-hint">If on, <code>/hls/*</code> streams require login. If off, streams are public (handy for kiosks or embedding).</p>
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
        <p class="field-hint">Login attempts per IP in the time window. Default: 15 per 15 min.</p>
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
        <p class="field-hint">Limits tries on the first-time setup page. Default: 10 per 15 min.</p>
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
        <p class="field-hint">Chat messages per user in the window. Default: 5 per second.</p>
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
        <p class="field-hint">Snapshots per IP in the window. Default: 6 per 60 s.</p>
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
        <p class="field-hint">API requests per IP in the window. Default: 100 per minute.</p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Snapshot strip</legend>
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
        <p class="field-hint">Strip shows N starred snaps first, then latest unstarred. "All stars" lists all starred. Default: 3 starred, 5 total.</p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Motion clip retention</legend>
        <div class="form-row">
          <div>
            <label for="motion-clip-max-count">Max clips to keep (unstarred)</label>
            <input type="number" id="motion-clip-max-count" name="motion_clip_max_count" value="${escapeHtml(motionClipMaxCount)}" min="0" max="100000">
          </div>
          <div>
            <label for="motion-clip-max-total-mb">Max total size (MB, unstarred)</label>
            <input type="number" id="motion-clip-max-total-mb" name="motion_clip_max_total_mb" value="${escapeHtml(motionClipMaxTotalMb)}" min="0" max="1000000">
          </div>
        </div>
        <p class="field-hint">Old unstarred clips are pruned after each incident until under both limits. Use <code>0</code> to turn off a limit.</p>
      </fieldset>
      <fieldset class="settings-group">
        <legend>Motion detection (live)</legend>
        <p class="field-hint" style="margin-top:0;">Applied immediately; controls which motion is recorded as clips.</p>
        <div class="form-row" style="align-items:flex-end;">
          <div>
            <label for="motion-sensitivity">Sensitivity</label>
            <select id="motion-sensitivity">
              <option value="2">Low</option>
              <option value="3" selected>Medium</option>
              <option value="4">High</option>
            </select>
          </div>
          <div style="min-width:240px;">
            <label for="motion-cooldown">Notification cooldown</label>
            <input type="range" id="motion-cooldown" min="5" max="120" value="30" step="5" style="width:100%;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:0.25rem;">
              <span class="field-hint" style="margin:0;padding:0;opacity:0.85;">5s</span>
              <span class="field-hint" id="motion-cooldown-val" style="margin:0;padding:0;opacity:0.95;font-weight:700;">30s</span>
              <span class="field-hint" style="margin:0;padding:0;opacity:0.85;">2 min</span>
            </div>
          </div>
        </div>
        <div style="margin-top:0.75rem;">
          <button type="button" class="btn btn-small btn-primary" id="motion-apply">Apply to detector</button>
          <span class="field-hint" id="motion-live-status" style="margin-left:0.75rem;">Connecting to detector…</span>
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save settings</button>
        <a href="/admin" class="btn btn-ghost">Cancel</a>
      </div>
    </form>

    <fieldset class="settings-group" style="margin-top:1.5rem;">
      <legend>Sessions</legend>
      <p class="field-hint" style="padding-left:0;margin:0 0 0.75rem;">Logs out everyone (including you). Use after a suspected compromise or when changing SSL/proxy.</p>
      <form method="post" action="/admin/invalidate-sessions" data-confirm="This will log out all users including yourself. Continue?">
        <input type="hidden" name="_csrf" value="${getCsrfToken(req)}">
        <button type="submit" class="btn btn-danger">Invalidate all sessions</button>
      </form>
    </fieldset>

    <fieldset class="settings-group settings-danger-zone" style="margin-top:1.5rem;">
      <legend>&#9888; Danger Zone</legend>
      <p class="field-hint" style="padding-left:0;margin:0 0 1rem;">Permanent; cannot be undone.</p>

      <div class="danger-zone-row">
        <div class="danger-zone-desc">
          <strong>Clear visitor history</strong>
          <span class="field-hint" style="padding-left:0;display:block;margin-top:0.2rem;">Removes human visitor stats (cookie-based). Visitors page resets; bird recordings are unchanged.</span>
        </div>
        <form method="post" action="/admin/reset-visitor-stats" data-confirm="This will permanently delete all human visitor history. Continue?">
          <input type="hidden" name="_csrf" value="${getCsrfToken(req)}">
          <button type="submit" class="btn btn-danger">Clear visitor history</button>
        </form>
      </div>

      <div class="danger-zone-row" style="margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(220,38,38,0.15);">
        <div class="danger-zone-desc">
          <strong>Clear bird visit recordings</strong>
          <span class="field-hint" style="padding-left:0;display:block;margin-top:0.2rem;">Removes all motion clips from the DB and deletes MP4s (including starred). Resets bird stats. Human visitor data is unchanged.</span>
        </div>
        <form method="post" action="/admin/reset-motion-stats" data-confirm="This will permanently delete all bird visit recordings and their video files, including starred clips. Continue?">
          <input type="hidden" name="_csrf" value="${getCsrfToken(req)}">
          <button type="submit" class="btn btn-danger">Clear bird visit recordings</button>
        </form>
      </div>
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
    <script src="/admin/settings-motion.js"></script>
  `));
});

router.post('/settings', requireLogin, verifyCsrf, auditLog('settings.update'), (req, res) => {
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
  const motionClipMaxCountRaw = parseInt(req.body.motion_clip_max_count, 10);
  const motionClipMaxTotalMbRaw = parseInt(req.body.motion_clip_max_total_mb, 10);
  const motionClipMaxCount = Number.isFinite(motionClipMaxCountRaw)
    ? Math.max(0, Math.min(100000, motionClipMaxCountRaw))
    : 200;
  const motionClipMaxTotalMb = Number.isFinite(motionClipMaxTotalMbRaw)
    ? Math.max(0, Math.min(1000000, motionClipMaxTotalMbRaw))
    : 5000;
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
  db.setSetting('motion_clip_max_count', String(motionClipMaxCount));
  db.setSetting('motion_clip_max_total_mb', String(motionClipMaxTotalMb));
  const siteName = String(req.body.site_name || 'Birdcam Live').trim().slice(0, 60) || 'Birdcam Live';
  db.setSetting('site_name', siteName);
   const datetimeLocale = req.body.datetime_locale === 'us' ? 'us' : 'eu';
   db.setSetting('datetime_locale', datetimeLocale);
  res.redirect('/admin/settings?msg=Settings+saved');
});

// --- Invalidate all sessions ---
router.post('/invalidate-sessions', requireLogin, verifyCsrf, auditLog('sessions.invalidate'), (req, res) => {
  req.app.rotateSessionSecret();
  req.session.destroy(() => res.redirect('/admin/login?msg=All+sessions+invalidated'));
});

// --- Danger Zone: reset stats ---
router.post('/reset-visitor-stats', requireLogin, verifyCsrf, auditLog('stats.reset_visitors'), (req, res) => {
  db.clearVisitorHistory();
  res.redirect('/admin/settings?msg=Visitor+history+cleared');
});

router.post('/reset-motion-stats', requireLogin, verifyCsrf, auditLog('stats.reset_motion'), (req, res) => {
  const filePaths = db.clearMotionRecordings();
  // Best-effort delete MP4 files from disk
  filePaths.forEach(fp => { try { fs.unlinkSync(fp); } catch (_) {} });
  res.redirect('/admin/settings?msg=Motion+recordings+cleared');
});

// --- Audit Log ---

router.get('/audit', requireLogin, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = db.getAuditLogs(Math.min(limit, 500)); // Max 500 entries

  const logRows = logs.map(log => {
    const timestamp = new Date(log.timestamp).toLocaleString(getDateLocale(), {
      hour12: db.getSetting('datetime_locale') === 'us',
    });
    const user = log.username ? escapeHtml(log.username) : '<em>unauthenticated</em>';
    const actionClass = log.action.includes('delete') ? 'audit-action-danger' :
                        log.action.includes('create') || log.action.includes('login') ? 'audit-action-success' :
                        'audit-action-info';

    let detailsHtml = '';
    if (log.details) {
      try {
        const details = JSON.parse(log.details);
        const detailItems = [];
        if (details.path) detailItems.push(`Path: ${escapeHtml(details.path)}`);
        if (details.params && Object.keys(details.params).length > 0) {
          detailItems.push(`Params: ${escapeHtml(JSON.stringify(details.params))}`);
        }
        if (details.body && details.body !== '[REDACTED]') {
          const bodyPreview = JSON.stringify(details.body).substring(0, 100);
          detailItems.push(`Body: ${escapeHtml(bodyPreview)}${bodyPreview.length >= 100 ? '...' : ''}`);
        }
        detailsHtml = detailItems.join(' | ');
      } catch (e) {
        detailsHtml = escapeHtml(log.details.substring(0, 100));
      }
    }

    return `
      <tr>
        <td style="white-space:nowrap;">${timestamp}</td>
        <td>${user}</td>
        <td><span class="badge ${actionClass}">${escapeHtml(log.action)}</span></td>
        <td style="font-size:0.9em;color:#666;max-width:400px;overflow:hidden;text-overflow:ellipsis;">${detailsHtml}</td>
        <td style="font-family:monospace;font-size:0.85em;color:#999;">${escapeHtml(log.ip_address || '-')}</td>
        <td style="font-family:monospace;font-size:0.75em;color:#999;">${escapeHtml(log.request_id || '-').substring(0, 8)}</td>
      </tr>
    `;
  }).join('');

  res.send(layout('Audit Log', nav('audit'), `
    <h1>Audit Log</h1>
    <p style="color:#666;margin-bottom:1rem;">Security events and admin actions. Showing last ${logs.length} entries.</p>

    <style>
      .audit-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
      .audit-table th { text-align: left; padding: 0.75rem 0.5rem; border-bottom: 2px solid #e2e8f0; background: #f7fafc; font-weight: 600; }
      .audit-table td { padding: 0.75rem 0.5rem; border-bottom: 1px solid #e2e8f0; }
      .audit-table tr:hover { background: #f7fafc; }
      .badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.85em; font-weight: 500; white-space: nowrap; }
      .audit-action-success { background: #d1fae5; color: #065f46; }
      .audit-action-danger { background: #fee2e2; color: #991b1b; }
      .audit-action-info { background: #dbeafe; color: #1e40af; }
    </style>

    ${logs.length > 0 ? `
      <table class="audit-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>User</th>
            <th>Action</th>
            <th>Details</th>
            <th>IP Address</th>
            <th>Request ID</th>
          </tr>
        </thead>
        <tbody>
          ${logRows}
        </tbody>
      </table>
      <div style="margin-top:1rem;text-align:center;color:#999;font-size:0.9em;">
        ${logs.length >= limit ? `Showing ${limit} most recent entries. ` : ''}
        <a href="/admin/audit?limit=500" style="color:#3b82f6;">Show more</a>
      </div>
    ` : `
      <div class="empty-state">
        <span class="empty-state-icon">&#x1F4DC;</span>
        <p class="empty-state-text">No audit log entries yet.</p>
      </div>
    `}
  `));
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

// --- Chat Moderation ---

router.get('/chat', requireLogin, (req, res) => {
  const messages = db.getChatMessages(100);
  const bans = db.listBans();
  const msg = req.query.msg || '';
  const chatDisabled = db.getSetting('chat_disabled') === 'true';
  const nicknames = Array.from(new Set(messages.map(m => m.nickname))).sort((a, b) => a.localeCompare(b));
  
  const messageRows = messages.map(m => `
    <tr data-id="${m.id}" data-nickname="${escapeHtml(m.nickname)}">
      <td><input type="checkbox" class="msg-select" value="${m.id}"></td>
      <td>${m.id}</td>
      <td>${escapeHtml(m.nickname)}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.text)}</td>
      <td style="font-size:0.85em;color:#999;">${new Date(m.time).toLocaleString(getDateLocale(), { hour12: db.getSetting('datetime_locale') === 'us' })}</td>
      <td style="font-family:monospace;font-size:0.85em;">${escapeHtml(m.ip_address || '-')}</td>
      <td class="actions-cell">
        <form method="post" action="/admin/chat/messages/${m.id}/delete" style="display:inline;">
          ${csrfField(req)}
          <button type="submit" class="btn btn-small btn-danger" title="Delete message">&#x1F5D1;</button>
        </form>
        <button type="button" class="btn btn-small btn-ghost select-user-btn" data-nickname="${escapeHtml(m.nickname)}" title="Select all messages from this user">Select user</button>
        ${m.ip_address ? `
          <form method="post" action="/admin/chat/ban" style="display:inline;">
            ${csrfField(req)}
            <input type="hidden" name="ip_address" value="${escapeHtml(m.ip_address)}">
            <input type="hidden" name="reason" value="Banned from message #${m.id}">
            <button type="submit" class="btn btn-small btn-warning" title="Ban IP">&#x1F6AB;</button>
          </form>
        ` : ''}
      </td>
    </tr>
  `).join('');

  const banRows = bans.map(b => `
    <tr>
      <td style="font-family:monospace;">${escapeHtml(b.ip_address)}</td>
      <td>${escapeHtml(b.reason || '-')}</td>
      <td>${escapeHtml(b.banned_by || '-')}</td>
      <td style="font-size:0.85em;color:#999;">${new Date(b.created_at).toLocaleString(getDateLocale(), { hour12: db.getSetting('datetime_locale') === 'us' })}</td>
      <td class="actions-cell">
        <form method="post" action="/admin/chat/unban" style="display:inline;">
          ${csrfField(req)}
          <input type="hidden" name="ip_address" value="${escapeHtml(b.ip_address)}">
          <button type="submit" class="btn btn-small btn-primary" title="Unban">Unban</button>
        </form>
      </td>
    </tr>
  `).join('');

  res.send(layout('Chat Moderation', nav('chat'), `
    <h1>Chat Moderation</h1>
    ${msg ? `<div class="alert alert-info">${escapeHtml(msg)}</div>` : ''}

    <div class="card" style="margin-bottom:2rem;">
      <h2>Chat Posting</h2>
      <p style="color:#666;margin-bottom:1rem;">Current status: <strong>${chatDisabled ? 'Disabled' : 'Enabled'}</strong></p>
      <form method="post" action="/admin/chat/toggle" style="display:inline;">
        ${csrfField(req)}
        <input type="hidden" name="chat_disabled" value="${chatDisabled ? 'false' : 'true'}">
        <button type="submit" class="btn ${chatDisabled ? 'btn-primary' : 'btn-warning'}">${chatDisabled ? 'Enable New Messages' : 'Temporarily Disable New Messages'}</button>
      </form>
    </div>
    
    <div class="card" style="margin-bottom:2rem;">
      <h2>Banned IPs (${bans.length})</h2>
      <form method="post" action="/admin/chat/ban" class="admin-form" style="margin-bottom:1rem;display:flex;gap:0.5rem;align-items:flex-end;">
        ${csrfField(req)}
        <div style="flex:1;">
          <label for="ban-ip">IP Address</label>
          <input type="text" id="ban-ip" name="ip_address" required placeholder="e.g. 192.168.1.100">
        </div>
        <div style="flex:2;">
          <label for="ban-reason">Reason (optional)</label>
          <input type="text" id="ban-reason" name="reason" placeholder="Reason for ban">
        </div>
        <button type="submit" class="btn btn-warning">Ban IP</button>
      </form>
      ${bans.length > 0 ? `
        <table class="admin-table">
          <thead>
            <tr>
              <th>IP Address</th>
              <th>Reason</th>
              <th>Banned By</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${banRows}</tbody>
        </table>
      ` : '<p style="color:#999;">No banned IPs.</p>'}
    </div>

    <div class="card">
      <h2>Chat Messages (${messages.length})</h2>
      <div style="margin-bottom:1rem;display:flex;gap:0.5rem;">
        <form method="post" action="/admin/chat/messages/bulk-delete" id="bulk-delete-form">
          ${csrfField(req)}
          <input type="hidden" name="ids" id="bulk-delete-ids">
          <button type="submit" class="btn btn-danger" id="bulk-delete-btn" disabled>Delete Selected</button>
        </form>
        <form method="post" action="/admin/chat/clear" onsubmit="return confirm('Are you sure you want to delete ALL chat messages?');">
          ${csrfField(req)}
          <button type="submit" class="btn btn-danger">Clear All Messages</button>
        </form>
      </div>
      <div style="margin-bottom:1rem;display:flex;gap:0.5rem;align-items:flex-end;">
        <div>
          <label for="select-user-nickname">Select messages from user</label>
          <select id="select-user-nickname">
            <option value="">Choose user...</option>
            ${nicknames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="btn btn-small btn-ghost" id="select-user-btn">Select User Messages</button>
        <button type="button" class="btn btn-small btn-ghost" id="clear-selection-btn">Clear Selection</button>
      </div>
      ${messages.length > 0 ? `
        <table class="admin-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="select-all"></th>
              <th>ID</th>
              <th>Nickname</th>
              <th>Message</th>
              <th>Time</th>
              <th>IP</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${messageRows}</tbody>
        </table>
      ` : '<p style="color:#999;">No chat messages.</p>'}
    </div>

    <script src="/admin/chat-admin.js"></script>
  `));
});

router.post('/chat/messages/:id/delete', requireLogin, verifyCsrf, auditLog('chat.message.delete'), (req, res) => {
  const id = Number(req.params.id);
  db.deleteChatMessage(id);
  
  // Update in-memory cache and broadcast
  if (req.app.locals.reloadChatMessages) req.app.locals.reloadChatMessages();
  if (req.app.locals.broadcastDeleteMessages) req.app.locals.broadcastDeleteMessages([id]);
  
  res.redirect('/admin/chat?msg=Message+deleted');
});

router.post('/chat/messages/bulk-delete', requireLogin, verifyCsrf, auditLog('chat.messages.bulk-delete'), (req, res) => {
  const idsStr = req.body.ids || '';
  const ids = idsStr.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
  
  if (ids.length > 0) {
    db.deleteChatMessages(ids);
    if (req.app.locals.reloadChatMessages) req.app.locals.reloadChatMessages();
    if (req.app.locals.broadcastDeleteMessages) req.app.locals.broadcastDeleteMessages(ids);
  }
  
  res.redirect('/admin/chat?msg=' + encodeURIComponent(`${ids.length} message(s) deleted`));
});

router.post('/chat/clear', requireLogin, verifyCsrf, auditLog('chat.clear'), (req, res) => {
  db.clearAllChatMessages();
  if (req.app.locals.reloadChatMessages) req.app.locals.reloadChatMessages();
  if (req.app.locals.broadcastClearChat) req.app.locals.broadcastClearChat();
  
  res.redirect('/admin/chat?msg=All+messages+cleared');
});

router.post('/chat/toggle', requireLogin, verifyCsrf, auditLog('chat.toggle'), (req, res) => {
  const disablePosting = req.body.chat_disabled === 'true';
  db.setSetting('chat_disabled', disablePosting ? 'true' : 'false');
  res.redirect('/admin/chat?msg=' + encodeURIComponent(disablePosting
    ? 'New chat messages temporarily disabled'
    : 'New chat messages enabled'));
});

router.post('/chat/ban', requireLogin, verifyCsrf, auditLog('chat.ban'), (req, res) => {
  const ipAddress = String(req.body.ip_address || '').trim();
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  
  if (!ipAddress) {
    return res.redirect('/admin/chat?msg=IP+address+required');
  }
  
  db.addBan(ipAddress, reason || null, req.session.username);
  res.redirect('/admin/chat?msg=' + encodeURIComponent(`IP ${ipAddress} banned`));
});

router.post('/chat/unban', requireLogin, verifyCsrf, auditLog('chat.unban'), (req, res) => {
  const ipAddress = String(req.body.ip_address || '').trim();
  
  if (!ipAddress) {
    return res.redirect('/admin/chat?msg=IP+address+required');
  }
  
  db.removeBan(ipAddress);
  res.redirect('/admin/chat?msg=' + encodeURIComponent(`IP ${ipAddress} unbanned`));
});

module.exports = router;
