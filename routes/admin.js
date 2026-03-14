const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();
const db = require('../db');
const streamManager = require('../streamManager');
const { requireLogin, requireSetup, requireNoSetup } = require('../middleware/auth');

const BUILD_TIME = new Date().toISOString();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function friendlyDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'Z');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) { return iso; }
}

// --- Simple CSRF using session-bound tokens ---
function generateCsrfToken(req) {
  const token = crypto.randomBytes(32).toString('hex');
  req.session._csrf = token;
  return token;
}

function csrfField(req) {
  const token = generateCsrfToken(req);
  return `<input type="hidden" name="_csrf" value="${token}">`;
}

function verifyCsrf(req, res, next) {
  const token = (req.body && req.body._csrf) || '';
  if (!req.session._csrf || token !== req.session._csrf) {
    return res.status(403).send(layout('Error', '', `
      <h1>Invalid request</h1>
      <p>Your session may have expired. Please <a href="/admin">go back</a> and try again.</p>
    `));
  }
  delete req.session._csrf;
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

const layout = (title, navHtml, body) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} – Birdcam Admin</title>
  <link rel="stylesheet" href="/admin/style.css">
</head>
<body class="admin">
  <div class="admin-wrap">
    <header class="admin-header">
      <a href="/admin">Birdcam Admin</a>
      ${title !== 'Login' && title !== 'Setup' ? '<a href="/admin/logout" class="btn btn-ghost">Logout</a>' : ''}
    </header>
    <main class="admin-main">
      ${navHtml}
      ${body}
    </main>
  </div>
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
            <form method="post" action="/admin/cameras/${c.id}/delete" style="display:inline" onsubmit="return confirm('Delete camera &quot;${escapeHtml(c.display_name)}&quot;?');">
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
    <script>
    (function() {
      const btn = document.getElementById('debug-toggle');
      const panel = document.getElementById('debug-panel');
      let open = false;
      let polling = null;

      function escH(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
      }

      function fetchDebug() {
        fetch('/admin/api/debug-info').then(r => r.json()).then(info => {
          let html = '<h3>System</h3><table class="admin-table debug-table">';
          html += '<tr><td>Server uptime</td><td>' + escH(info.uptime) + '</td></tr>';
          html += '<tr><td>Node.js</td><td>' + escH(info.nodeVersion) + '</td></tr>';
          html += '<tr><td>Memory (RSS)</td><td>' + escH(info.memoryMB + ' MB') + '</td></tr>';
          html += '</table>';

          html += '<h3>Cameras</h3><table class="admin-table debug-table">';
          html += '<tr><th>ID</th><th>Name</th><th>Status</th><th>Logs</th></tr>';
          for (const cam of info.cameras) {
            html += '<tr><td>' + cam.id + '</td><td>' + escH(cam.name) + '</td>';
            html += '<td><span class="status ' + (cam.running ? 'on' : 'off') + '"><span class="status-dot"></span>' + (cam.running ? 'Live' : 'Off') + '</span></td>';
            html += '<td>' + cam.logLines + '</td></tr>';
            if (cam.streamInfo && cam.streamInfo.length) {
              html += '<tr><td colspan="4"><pre style="margin:0.25rem 0 0.5rem;font-size:0.75rem;background:#1a202c;color:#68d391;padding:0.5rem;border-radius:6px;white-space:pre-wrap;word-break:break-all">' + cam.streamInfo.map(l => escH(l)).join('\\n') + '</pre></td></tr>';
            }
          }
          html += '</table>';
          html += '<p style="margin-top:0.75rem;"><a href="/admin/debug" class="btn btn-small">View FFmpeg Logs</a></p>';
          panel.innerHTML = html;
        }).catch(() => { panel.innerHTML = '<p>Failed to load debug info.</p>'; });
      }

      btn.addEventListener('click', () => {
        open = !open;
        panel.style.display = open ? 'block' : 'none';
        btn.textContent = open ? '\\u{1F41B} Hide Debug' : '\\u{1F41B} Debug';
        if (open) {
          fetchDebug();
          polling = setInterval(fetchDebug, 5000);
        } else if (polling) {
          clearInterval(polling);
          polling = null;
        }
      });
    })();
    </script>
  `));
});

// --- Cameras ---

router.get('/cameras/new', requireLogin, (req, res) => {
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
  try {
    const id = db.createCamera(display_name.trim(), rtsp_host.trim(), port, (rtsp_path || '').trim(), (rtsp_username || '').trim(), (rtsp_password || '').trim());
    const cam = db.getCamera(id);
    streamManager.startStream(id, cam.rtsp_url);
    res.redirect('/admin');
  } catch (err) {
    res.redirect('/admin/cameras/new?msg=' + encodeURIComponent(err.message));
  }
});

router.get('/cameras/:id/edit', requireLogin, (req, res) => {
  const c = db.getCamera(Number(req.params.id));
  if (!c) return res.redirect('/admin');
  const hasRtspPw = c.rtsp_password ? true : false;
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
  try {
    db.updateCamera(id, display_name.trim(), rtsp_host.trim(), port, (rtsp_path || '').trim(), (rtsp_username || '').trim(), (password || '').trim());
    streamManager.stopStream(id);
    const updated = db.getCamera(id);
    streamManager.startStream(id, updated.rtsp_url);
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
            <form method="post" action="/admin/users/${u.id}/delete" style="display:inline" onsubmit="return confirm('Delete user &quot;${escapeHtml(u.username)}&quot;?');">
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
    <script>
(function() {
  function fmt(n) { return n >= 1000000 ? (n/1e6).toFixed(1) + 'M' : n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n); }
  function load() {
    fetch('/admin/api/visitor-stats')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('stat-today').textContent = fmt(data.uniqueToday);
        document.getElementById('stat-week').textContent = fmt(data.uniqueWeek);
        document.getElementById('stat-month').textContent = fmt(data.uniqueMonth);

        var daily = data.daily || [];
        var last30 = [];
        var d = new Date();
        for (var i = 29; i >= 0; i--) {
          var day = new Date(d);
          day.setDate(day.getDate() - i);
          var dateStr = day.toISOString().slice(0, 10);
          var row = daily.find(function(r) { return r.date === dateStr; });
          last30.push({ date: dateStr, count: row ? row.count : 0 });
        }

        var labels = last30.map(function(r) {
          var d = new Date(r.date + 'T12:00:00');
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        });
        var counts = last30.map(function(r) { return r.count; });

        var ctx = document.getElementById('visitor-chart').getContext('2d');
        if (window.visitorChart) window.visitorChart.destroy();
        window.visitorChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'Unique visitors',
              data: counts,
              borderColor: 'rgb(74, 222, 128)',
              backgroundColor: 'rgba(74, 222, 128, 0.15)',
              fill: true,
              tension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: { display: false }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: { precision: 0 }
              }
            }
          }
        });
      })
      .catch(function() {
        document.getElementById('stat-today').textContent = '?';
        document.getElementById('stat-week').textContent = '?';
        document.getElementById('stat-month').textContent = '?';
      });
  }
  load();
})();
    </script>
  `));
});

// --- Snapshots admin ---

router.get('/snapshots', requireLogin, (req, res) => {
  const snaps = db.getAllSnapshots(100);
  let content;
  if (snaps.length) {
    const cards = snaps.map((s) => {
      const starClass = s.starred ? 'snap-admin-card starred' : 'snap-admin-card';
      const starLabel = s.starred ? 'Unstar' : 'Star';
      const starIcon = s.starred ? '&#x2B50;' : '&#x2606;';
      return `
        <div class="${starClass}">
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
              ${csrfField(req)}
              <input type="hidden" name="starred" value="${s.starred ? '0' : '1'}">
              <button type="submit" class="btn btn-small ${s.starred ? 'btn-ghost' : ''}" title="${starLabel}">${starIcon} ${starLabel}</button>
            </form>
            <form method="post" action="/admin/snapshots/${s.id}/delete" style="display:inline" onsubmit="return confirm('Delete this snapshot?');">
              ${csrfField(req)}
              <button type="submit" class="btn btn-small btn-danger">Delete</button>
            </form>
          </div>
        </div>`;
    }).join('');
    content = `
      ${req.query.msg ? `<div class="admin-msg admin-msg-ok">${escapeHtml(req.query.msg)}</div>` : ''}
      <div class="snap-admin-grid">${cards}</div>`;
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
    <p class="visitors-desc">Star a snapshot to pin it above the latest three for all viewers. Only one snapshot can be starred at a time.</p>
    ${content}
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
    const filePath = path.join(__dirname, '..', 'data', 'snapshots', snap.filename);
    try { fs.unlinkSync(filePath); } catch (_) {}
    db.deleteSnapshot(id);
  }
  res.redirect('/admin/snapshots?msg=Snapshot+deleted');
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
  res.send(layout('Settings', nav('settings'), `
    <h1>Settings</h1>
    ${req.query.msg ? `<div class="admin-msg admin-msg-ok">${escapeHtml(req.query.msg)}</div>` : ''}
    <form method="post" action="/admin/settings" class="admin-form">
      ${csrfField(req)}
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
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save settings</button>
        <a href="/admin" class="btn btn-ghost">Cancel</a>
      </div>
    </form>

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

    <script>
    (function() {
      const toggle = document.getElementById('debug-log-toggle');
      const panel = document.getElementById('debug-log-panel');
      const logEl = document.getElementById('debug-log-output');
      const camSelect = document.getElementById('debug-cam-select');
      const autoScroll = document.getElementById('debug-auto-scroll');
      const clearBtn = document.getElementById('debug-clear-log');
      const detachBtn = document.getElementById('debug-detach-log');

      const floatBar = document.getElementById('debug-float-bar');
      const floatLog = document.getElementById('debug-float-log');
      const floatCamSelect = document.getElementById('debug-float-cam-select');
      const floatAutoScroll = document.getElementById('debug-float-auto-scroll');
      const floatClearBtn = document.getElementById('debug-float-clear');
      const attachBtn = document.getElementById('debug-attach-log');

      // Populate float cam select with same options
      floatCamSelect.innerHTML = camSelect.innerHTML;

      let polling = null;
      let detached = false;

      function escLog(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
      }

      function renderLogs(data, cam, target, scrollCheck) {
        let text = '';
        if (cam === 'all') {
          for (const [id, lines] of Object.entries(data)) {
            if (lines.length) {
              text += '=== Camera ' + id + ' ===\\n';
              text += lines.map(l => escLog(l)).join('\\n') + '\\n\\n';
            }
          }
        } else {
          text = (data.lines || []).map(l => escLog(l)).join('\\n');
        }
        target.innerHTML = text || 'No log output yet.';
        if (scrollCheck.checked) target.scrollTop = target.scrollHeight;
      }

      function fetchLogs() {
        const cam = detached ? floatCamSelect.value : camSelect.value;
        const url = cam === 'all' ? '/admin/api/logs' : '/admin/api/logs/' + cam;
        fetch(url).then(r => r.json()).then(data => {
          if (detached) {
            renderLogs(data, cam, floatLog, floatAutoScroll);
          } else {
            renderLogs(data, cam, logEl, autoScroll);
          }
        }).catch(() => {});
      }

      function startPolling() {
        if (polling) clearInterval(polling);
        fetchLogs();
        polling = setInterval(fetchLogs, 3000);
      }

      function stopPolling() {
        if (polling) { clearInterval(polling); polling = null; }
      }

      toggle.addEventListener('change', () => {
        if (toggle.checked) {
          panel.style.display = '';
          startPolling();
        } else {
          panel.style.display = 'none';
          if (!detached) stopPolling();
        }
      });

      detachBtn.addEventListener('click', () => {
        detached = true;
        panel.style.display = 'none';
        floatBar.style.display = '';
        floatCamSelect.value = camSelect.value;
        startPolling();
      });

      attachBtn.addEventListener('click', () => {
        detached = false;
        floatBar.style.display = 'none';
        if (toggle.checked) {
          panel.style.display = '';
          camSelect.value = floatCamSelect.value;
          startPolling();
        } else {
          stopPolling();
        }
      });

      camSelect.addEventListener('change', fetchLogs);
      floatCamSelect.addEventListener('change', fetchLogs);
      clearBtn.addEventListener('click', () => { logEl.innerHTML = ''; });
      floatClearBtn.addEventListener('click', () => { floatLog.innerHTML = ''; });
    })();
    </script>
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
  db.setSetting('login_rate_max', String(loginRateMax));
  db.setSetting('login_rate_window_min', String(loginRateWindow));
  db.setSetting('setup_rate_max', String(setupRateMax));
  db.setSetting('setup_rate_window_min', String(setupRateWindow));
  db.setSetting('chat_rate_limit', String(chatRateLimit));
  db.setSetting('chat_rate_window_ms', String(chatRateWindow));
  db.setSetting('snapshot_rate_max', String(snapRateMax));
  db.setSetting('snapshot_rate_window_sec', String(snapRateWindow));
  res.redirect('/admin/settings?msg=Settings+saved');
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
    <script>
    (function() {
      const logEl = document.getElementById('log-output');
      const camSelect = document.getElementById('cam-select');
      const autoScroll = document.getElementById('auto-scroll');
      const stickyCheck = document.getElementById('sticky-log');
      const clearBtn = document.getElementById('clear-log');
      let polling = null;

      function escLog(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
      }

      function fetchLogs() {
        const cam = camSelect.value;
        const url = cam === 'all' ? '/admin/api/logs' : '/admin/api/logs/' + cam;
        fetch(url).then(r => r.json()).then(data => {
          let text = '';
          if (cam === 'all') {
            for (const [id, lines] of Object.entries(data)) {
              if (lines.length) {
                text += '=== Camera ' + id + ' ===\\n';
                text += lines.map(l => escLog(l)).join('\\n') + '\\n\\n';
              }
            }
          } else {
            text = (data.lines || []).map(l => escLog(l)).join('\\n');
          }
          logEl.innerHTML = text || 'No log output yet.';
          if (autoScroll.checked) logEl.scrollTop = logEl.scrollHeight;
        }).catch(() => {});
      }

      function startPolling() {
        stopPolling();
        fetchLogs();
        polling = setInterval(fetchLogs, 3000);
      }

      function stopPolling() {
        if (polling) { clearInterval(polling); polling = null; }
      }

      camSelect.addEventListener('change', fetchLogs);
      clearBtn.addEventListener('click', () => { logEl.innerHTML = ''; });
      stickyCheck.addEventListener('change', () => {
        logEl.classList.toggle('debug-log-sticky', stickyCheck.checked);
      });

      startPolling();
    })();
    </script>
  `));
});

module.exports = router;
