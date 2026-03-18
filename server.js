require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const db = require('./db');
const streamManager = require('./streamManager');
const adminRoutes = require('./routes/admin');
const recordingsRoutes = require('./routes/recordings');
const { requestIdMiddleware } = require('./middleware/requestId');
const { auditLog } = require('./middleware/audit');

const PORT = process.env.PORT || 3000;
const BUILD_TIME = new Date().toISOString();

// Get Git commit hash if available
let GIT_COMMIT = process.env.GIT_COMMIT || null;

// If not set via env var, try to detect from git (local development)
if (!GIT_COMMIT || GIT_COMMIT === 'unknown') {
  try {
    const { execSync } = require('child_process');
    GIT_COMMIT = execSync('git rev-parse --short HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch (e) {
    // Not in a git repo or git not available
    GIT_COMMIT = null;
  }
}

db.getDb();
db.migrate();
if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
  db.ensureAdmin(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);
}

// Session secret: use env var if set, otherwise persist a generated one in the DB
// so it survives container restarts without requiring manual configuration.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = db.getSetting('session_secret');
  if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    db.setSetting('session_secret', SESSION_SECRET);
    console.log('Generated and persisted SESSION_SECRET to database.');
  }
}

// VAPID keys for Web Push — auto-generate and persist like session secret
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (!VAPID_PUBLIC_KEY) {
  VAPID_PUBLIC_KEY = db.getSetting('vapid_public_key') || '';
  VAPID_PRIVATE_KEY = db.getSetting('vapid_private_key') || '';
  if (!VAPID_PUBLIC_KEY) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    VAPID_PUBLIC_KEY = Buffer.from(ecdh.getPublicKey()).toString('base64url');
    VAPID_PRIVATE_KEY = Buffer.from(ecdh.getPrivateKey()).toString('base64url');
    db.setSetting('vapid_public_key', VAPID_PUBLIC_KEY);
    db.setSetting('vapid_private_key', VAPID_PRIVATE_KEY);
    console.log('Generated and persisted VAPID keys to database.');
  }
}
streamManager.startAll();

const app = express();

// Trust proxy when configured (nginx / reverse proxy)
app.use((req, res, next) => {
  if (db.isReverseProxy()) {
    app.set('trust proxy', 1);
  } else {
    app.set('trust proxy', false);
  }
  next();
});

// Request tracing (security review fix)
app.use(requestIdMiddleware);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
    },
  },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Session configuration — middleware is swappable so secret can be rotated at runtime
function makeSessionMiddleware(secret) {
  return session({
    secret,
    name: 'birdcam.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: db.isReverseProxy(), // secure only when behind HTTPS proxy
    },
  });
}
let _sessionMiddleware = makeSessionMiddleware(SESSION_SECRET);
app.use((req, res, next) => _sessionMiddleware(req, res, next));

// Called by the admin "invalidate sessions" route to rotate the secret
app.rotateSessionSecret = () => {
  const newSecret = crypto.randomBytes(32).toString('hex');
  db.setSetting('session_secret', newSecret);
  _sessionMiddleware = makeSessionMiddleware(newSecret);
};

// Rate limiting — create at startup, refresh in background when settings change
function makeLoginLimiter() {
  const windowMin = parseInt(db.getSetting('login_rate_window_min')) || 15;
  const max = parseInt(db.getSetting('login_rate_max')) || 15;
  return { limiter: rateLimit({ windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: 'Too many login attempts. Please try again later.' }), key: `${windowMin}:${max}` };
}
function makeSetupLimiter() {
  const windowMin = parseInt(db.getSetting('setup_rate_window_min')) || 15;
  const max = parseInt(db.getSetting('setup_rate_max')) || 10;
  return { limiter: rateLimit({ windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false }), key: `${windowMin}:${max}` };
}
function makeApiLimiter() {
  const windowMin = parseInt(db.getSetting('api_rate_window_min')) || 1;
  const max = parseInt(db.getSetting('api_rate_max')) || 100;
  return { limiter: rateLimit({ windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } }), key: `${windowMin}:${max}` };
}
let _loginLimiterState = makeLoginLimiter();
let _setupLimiterState = makeSetupLimiter();
let _apiLimiterState = makeApiLimiter();
setInterval(() => {
  const login = makeLoginLimiter();
  if (login.key !== _loginLimiterState.key) _loginLimiterState = login;
  const setup = makeSetupLimiter();
  if (setup.key !== _setupLimiterState.key) _setupLimiterState = setup;
  const api = makeApiLimiter();
  if (api.key !== _apiLimiterState.key) _apiLimiterState = api;
}, 60_000);
app.use('/admin/login', (req, res, next) => _loginLimiterState.limiter(req, res, next));
app.use('/admin/setup', (req, res, next) => _setupLimiterState.limiter(req, res, next));
app.use('/api', (req, res, next) => _apiLimiterState.limiter(req, res, next));

app.use(express.static(path.join(__dirname, 'public')));

// HLS streams — optionally require auth
app.use('/hls', (req, res, next) => {
  if (db.getSetting('require_auth_streams') === 'true') {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
  }
  next();
}, express.static(streamManager.hlsDir, { maxAge: 0 }));

app.get('/api/cameras', (req, res) => {
  const cameras = db.listCameras().map((c) => ({
    id: c.id,
    display_name: c.display_name,
  }));
  res.json(cameras);
});

// Public API for visitor stats (no auth) — used by public /visitors page
app.get('/api/visitor-stats', (req, res) => {
  res.json(db.getVisitorStats());
});

// Public API for build info (no auth) — used to display build version in UI
app.get('/api/build-info', (req, res) => {
  res.json({
    buildTime: BUILD_TIME,
    gitCommit: GIT_COMMIT
  });
});

// Public visitors stats page (no admin login required) — same look as main page
app.get('/visitors', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'visitors.html'));
});

// Visitor tracking: set cookie if missing, record one visit per request (idempotent per page load)
const VISITOR_COOKIE = 'bird_visitor';
const VISITOR_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
app.get('/api/visit', (req, res) => {
  let id = req.cookies && req.cookies[VISITOR_COOKIE];
  if (!id || typeof id !== 'string' || id.length > 128) {
    id = crypto.randomUUID();
    res.cookie(VISITOR_COOKIE, id, {
      maxAge: VISITOR_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax',
      secure: db.isReverseProxy(),
    });
  }
  db.recordVisit(id);
  res.set('Cache-Control', 'no-store');
  res.status(204).end();
});

app.use('/admin', adminRoutes);
app.use(express.json());
app.use('/api/recordings', recordingsRoutes);

// --- Snapshots (static serving + GET; POST added after wss is created) ---
const snapshotDir = path.join(__dirname, 'data', 'snapshots');
fs.mkdirSync(snapshotDir, { recursive: true });
app.use('/snapshots', express.static(snapshotDir));

// Build the snapshot rate limiter once at startup with current settings.
// Recreating rateLimit() inside a request handler is rejected by express-rate-limit v7+.
// Instead we keep a single instance and swap it out (outside the request cycle) when settings change.
function makeSnapshotLimiter() {
  const max = parseInt(db.getSetting('snapshot_rate_max')) || 6;
  const windowSec = parseInt(db.getSetting('snapshot_rate_window_sec')) || 60;
  return rateLimit({
    windowMs: windowSec * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many snapshots. Please wait a moment.',
  });
}
let _snapshotLimiter = makeSnapshotLimiter();
// Proxy middleware — always calls the current limiter, never creates one inside the handler
const snapshotRateLimitMiddleware = (req, res, next) => _snapshotLimiter(req, res, next);
function refreshSnapshotLimiter() { _snapshotLimiter = makeSnapshotLimiter(); }

function getSnapStripStarred() { return Math.max(0, Math.min(20, parseInt(db.getSetting('snap_strip_starred')) || 3)); }
function getSnapStripTotal() { return Math.max(1, Math.min(20, parseInt(db.getSetting('snap_strip_total')) || 5)); }

function buildSnapshotsPayload() {
  const stripStarred = getSnapStripStarred();
  const stripTotal = getSnapStripTotal();
  const toObj = s => ({
    id: s.id,
    url: `/snapshots/${s.filename}`,
    nickname: s.nickname,
    camera_name: s.camera_name,
    created_at: s.created_at,
    starred: s.starred === 1 || s.starred === true,
  });
  const starredSnaps = stripStarred > 0 ? db.getStarredSnapshots(stripStarred) : [];
  const starredIds = new Set(starredSnaps.map(s => s.id));
  const remaining = stripTotal - starredSnaps.length;
  const latest = remaining > 0 ? db.getLatestSnapshots(stripTotal + starredSnaps.length)
    .filter(s => !starredIds.has(s.id))
    .slice(0, remaining) : [];
  const allStarred = db.getAllStarredSnapshots().map(toObj);
  return {
    starred: starredSnaps.map(toObj),
    latest: latest.map(toObj),
    allStarred,
    config: { stripStarred, stripTotal },
  };
}

app.get('/api/snapshots', (req, res) => {
  res.json(buildSnapshotsPayload());
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.userId) });
});

app.get('/api/config', (req, res) => {
  res.json({ siteName: db.getSetting('site_name') || 'Birdcam Live' });
});

// Expose VAPID public key so the browser can subscribe to Web Push
app.get('/api/motion/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

const server = http.createServer(app);

// --- WebSocket chat with rate limiting ---
const chatMessages = db.getChatMessages(100);
const MAX_CHAT_MESSAGES = 100;
function getChatRateLimit() { return parseInt(db.getSetting('chat_rate_limit')) || 5; }
function getChatRateWindow() { return parseInt(db.getSetting('chat_rate_window_ms')) || 1000; }
function isChatDisabled() { return db.getSetting('chat_disabled') === 'true'; }

function sanitizeChat(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function getClientIp(req) {
  // Support reverse proxy
  if (db.isReverseProxy()) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || req.connection.remoteAddress;
}

function getViewerCount() {
  let n = 0;
  wss.clients.forEach((client) => { if (client.readyState === 1) n++; });
  return n;
}

function broadcastStats() {
  const payload = JSON.stringify({
    type: 'stats',
    viewerCount: getViewerCount(),
    totalChatMessages: chatMessages.length,
  });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Broadcast message deletion to all clients
function broadcastDeleteMessages(ids) {
  const payload = JSON.stringify({ type: 'delete_messages', ids });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Broadcast clear all messages to all clients
function broadcastClearChat() {
  const payload = JSON.stringify({ type: 'clear_chat' });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Reload chat messages from database (after admin operations)
function reloadChatMessages() {
  chatMessages.length = 0;
  chatMessages.push(...db.getChatMessages(100));
}

// Use noServer so both WebSocket servers coexist on the same HTTP server.
// With { server, path }, the first server aborts upgrades for non-matching
// paths before the second server can handle them.
const wss = new WebSocketServer({ noServer: true });
const motionWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress;
  console.log(`[ws-upgrade] ${request.method} ${pathname} from ${ip}`);
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/motion-ws') {
    motionWss.handleUpgrade(request, socket, head, (ws) => {
      motionWss.emit('connection', ws, request);
    });
  } else {
    console.log(`[ws-upgrade] Rejected unknown path: ${pathname}`);
    socket.destroy();
  }
});

// ---------------------------------------------------------------------------
// /motion-ws — shared channel for the motion detector and browser clients
// motion.py connects with ?role=detector; browsers connect without it.
// All traffic flows through port 3000 — no extra ports needed.
// ---------------------------------------------------------------------------
let _motionDetector = null; // the single motion.py detector connection
const motionBrowserClients = new Set();

motionWss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role');
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const origin = req.headers.origin;
  const host = req.headers.host || '';

  const isLocalIp =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1';

  const motionDetectorToken = url.searchParams.get('token') || req.headers['x-motion-token'];

  if (role === 'detector') {
    // --- Motion detector (Python) connecting ---
    const expectedDetectorToken = process.env.MOTION_DETECTOR_TOKEN || '';
    if (expectedDetectorToken) {
      if (!motionDetectorToken || motionDetectorToken !== expectedDetectorToken) {
        console.warn(`[motion-ws] Rejecting detector connection from ip=${ip}: invalid or missing token`);
        try { ws.close(1008, 'unauthorized'); } catch (_) {}
        return;
      }
    } else if (!isLocalIp) {
      console.warn(`[motion-ws] Rejecting detector connection from non-local ip=${ip} (no MOTION_DETECTOR_TOKEN configured)`);
      try { ws.close(1008, 'unauthorized'); } catch (_) {}
      return;
    }

    if (_motionDetector && _motionDetector.readyState === 1) {
      console.log(`[motion-ws] Replacing existing detector connection with new one from ip=${ip}`);
      _motionDetector.close(1000, 'replaced');
    }
    _motionDetector = ws;
    console.log(`[motion-ws] Detector connected ip=${ip} (${motionBrowserClients.size} browser(s) watching)`);

    const msg = JSON.stringify({ type: 'backend_connected' });
    motionBrowserClients.forEach(c => { if (c.readyState === 1) c.send(msg); });

    ws.on('message', (data) => {
      const str = data.toString();
      if (motionBrowserClients.size > 0) {
        motionBrowserClients.forEach(c => { if (c.readyState === 1) c.send(str); });
      }
    });

    ws.on('close', (code, reason) => {
      if (_motionDetector === ws) _motionDetector = null;
      console.log(`[motion-ws] Detector disconnected ip=${ip} code=${code} reason=${reason || 'none'}`);
      const dcMsg = JSON.stringify({ type: 'backend_disconnected' });
      motionBrowserClients.forEach(c => { if (c.readyState === 1) c.send(dcMsg); });
    });

    ws.on('error', (err) => {
      console.error(`[motion-ws] Detector error ip=${ip}: ${err.message}`);
    });
    return;
  }

  // --- Browser client ---
  if (process.env.MOTION_WS_ALLOWED_ORIGIN) {
    // If configured, only accept exact Origin header match.
    if (origin !== process.env.MOTION_WS_ALLOWED_ORIGIN) {
      console.warn(`[motion-ws] Rejecting browser connection from ip=${ip} with origin=${origin}`);
      try { ws.close(1008, 'origin not allowed'); } catch (_) {}
      return;
    }
  } else if (origin) {
    // Default: enforce host match for browser-originated connections.
    try {
      const o = new URL(origin);
      if (o.host !== host) {
        console.warn(`[motion-ws] Rejecting browser connection origin host mismatch ip=${ip} origin=${origin} host=${host}`);
        try { ws.close(1008, 'origin not allowed'); } catch (_) {}
        return;
      }
    } catch (_) {
      console.warn(`[motion-ws] Rejecting browser connection with invalid origin ip=${ip}`);
      try { ws.close(1008, 'Invalid origin'); } catch (_) {}
      return;
    }
  }

  motionBrowserClients.add(ws);
  console.log(`[motion-ws] Browser connected ip=${ip} (total: ${motionBrowserClients.size})`);

  const backendOnline = _motionDetector && _motionDetector.readyState === 1;
  ws.send(JSON.stringify({ type: backendOnline ? 'backend_connected' : 'backend_disconnected' }));

  ws.on('message', (data) => {
    const str = data.toString();
    console.log(`[motion-ws] Browser → detector: ${str.slice(0, 200)}`);
    if (_motionDetector && _motionDetector.readyState === 1) {
      _motionDetector.send(str);
    }
  });

  ws.on('close', (code, reason) => {
    motionBrowserClients.delete(ws);
    console.log(`[motion-ws] Browser disconnected ip=${ip} code=${code} reason=${reason || 'none'} (total: ${motionBrowserClients.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[motion-ws] Browser error ip=${ip}: ${err.message}`);
  });
});

// Keepalive ping for both WebSocket servers — prevents proxy idle timeouts
const WS_PING_INTERVAL = 30_000;
const wsPingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[chat-ws] Terminating unresponsive client ip=${ws._clientIp || '?'}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
  motionBrowserClients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[motion-ws] Terminating unresponsive browser client`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
  if (_motionDetector) {
    if (_motionDetector.isAlive === false) {
      console.log('[motion-ws] Terminating unresponsive detector');
      _motionDetector.terminate();
    } else {
      _motionDetector.isAlive = false;
      _motionDetector.ping();
    }
  }
}, WS_PING_INTERVAL);

wss.on('connection', (ws, req) => {
  const clientIp = getClientIp(req);
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      const host = req.headers.host || '';
      if (o.host !== host) {
        console.log(`[chat-ws] Rejected origin=${origin} host=${host} ip=${clientIp}`);
        ws.close(1008, 'Origin not allowed');
        return;
      }
    } catch (_) {
      console.log(`[chat-ws] Rejected invalid origin ip=${clientIp}`);
      ws.close(1008, 'Invalid origin');
      return;
    }
  }
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws._msgTimestamps = [];
  ws._clientIp = clientIp;
  console.log(`[chat-ws] Connected ip=${clientIp} (total: ${wss.clients.size})`);

  ws.send(JSON.stringify({ type: 'history', messages: chatMessages.slice(-50) }));
  broadcastStats();
  ws.on('close', (code, reason) => {
    console.log(`[chat-ws] Disconnected ip=${clientIp} code=${code} reason=${reason || 'none'} (total: ${wss.clients.size})`);
    broadcastStats();
  });
  ws.on('message', (raw) => {
    try {
      // Rate limiting per connection
      const now = Date.now();
      ws._msgTimestamps = ws._msgTimestamps.filter((t) => now - t < getChatRateWindow());
      if (ws._msgTimestamps.length >= getChatRateLimit()) {
        ws.send(JSON.stringify({ type: 'error', text: 'Slow down! Too many messages.' }));
        return;
      }
      ws._msgTimestamps.push(now);

      const data = JSON.parse(raw.toString());
      if (data.nickname && data.text) {
        if (isChatDisabled()) {
          ws.send(JSON.stringify({ type: 'error', text: 'Chat is temporarily disabled by admin.' }));
          return;
        }

        // Check if IP is banned
        if (db.isIpBanned(ws._clientIp)) {
          ws.send(JSON.stringify({ type: 'error', text: 'You are banned from chat.' }));
          return;
        }
        
        const msg = {
          nickname: sanitizeChat(String(data.nickname).slice(0, 30).trim()),
          text: sanitizeChat(String(data.text).slice(0, 500).trim()),
          time: new Date().toISOString(),
          ip_address: ws._clientIp,
        };
        if (!msg.nickname || !msg.text) return;
        
        const msgId = db.addChatMessage(msg.nickname, msg.text, msg.time, ws._clientIp);
        msg.id = msgId;
        
        chatMessages.push(msg);
        if (chatMessages.length > MAX_CHAT_MESSAGES) chatMessages.shift();
        
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(JSON.stringify({ type: 'message', ...msg }));
        });
        broadcastStats();
      }
    } catch (_) {}
  });
});

// Expose functions for admin routes
app.locals.broadcastDeleteMessages = broadcastDeleteMessages;
app.locals.broadcastClearChat = broadcastClearChat;
app.locals.reloadChatMessages = reloadChatMessages;
app.locals.chatMessages = chatMessages;

// --- Snapshot POST (after wss so we can broadcast) ---
app.post('/api/snapshots', snapshotRateLimitMiddleware, (req, res) => {
  const { image, nickname, cameraName } = req.body || {};
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'No image data' });
  const match = image.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image format' });
  const buf = Buffer.from(match[1], 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image too large' });
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < pngMagic.length || !buf.slice(0, pngMagic.length).equals(pngMagic)) {
    return res.status(400).json({ error: 'Invalid image format' });
  }
  const filename = `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
  fs.writeFileSync(path.join(snapshotDir, filename), buf);
  const nick = String(nickname || 'Guest').slice(0, 30).trim() || 'Guest';
  const cam = String(cameraName || '').slice(0, 60).trim();
  db.addSnapshot(filename, nick, cam);
  const payload = buildSnapshotsPayload();
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'snapshots', ...payload }));
  });
  res.json({ ok: true, url: `/snapshots/${filename}` });
});

function requireSameOriginApi(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      const o = new URL(origin);
      const host = req.get('host') || '';
      if (o.origin !== `${req.protocol}://${host}`) return res.status(403).json({ error: 'Forbidden' });
    } catch (_) { return res.status(403).json({ error: 'Forbidden' }); }
  }
  next();
}

app.post('/api/admin/snapshots/:id/star', requireSameOriginApi, auditLog('api.snapshot.star'), (req, res) => {
  if (!req.session || !req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  const id = Number(req.params.id);
  const starred = (req.body || {}).starred !== false && (req.body || {}).starred !== 'false';
  db.setSnapshotStarred(id, starred);
  const payload = buildSnapshotsPayload();
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'snapshots', ...payload }));
  });
  res.json({ ok: true, starred });
});

app.post('/api/admin/snapshots/:id/delete', requireSameOriginApi, auditLog('api.snapshot.delete'), (req, res) => {
  if (!req.session || !req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  const id = Number(req.params.id);
  const snap = db.getSnapshot(id);
  if (snap) {
    const base = path.basename(snap.filename);
    if (base !== snap.filename || base.includes('..')) return res.status(400).json({ error: 'Invalid snapshot' });
    const filePath = path.join(snapshotDir, base);
    try { fs.unlinkSync(filePath); } catch (_) {}
    db.deleteSnapshot(id);
  }
  const payload = buildSnapshotsPayload();
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'snapshots', ...payload }));
  });
  res.json({ ok: true });
});

// --- Public stats API (after wss so handler can read viewer count and chat) ---
app.get('/api/stats', (req, res) => {
  const cameras = db.listCameras().map((c) => ({
    id: c.id,
    display_name: c.display_name,
    live: streamManager.isRunning(c.id),
  }));
  res.json({
    viewerCount: getViewerCount(),
    totalChatMessages: chatMessages.length,
    streams: cameras,
  });
});

// --- Error Handler (MUST be last middleware, after all routes) ---
app.use((err, req, res, next) => {
  // Log error details for debugging
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    requestId: req.requestId,
    path: req.path,
    method: req.method,
    userId: req.session?.userId
  });

  // Never expose stack traces or internal details in production
  if (process.env.NODE_ENV === 'production') {
    res.status(err.status || 500).json({
      error: 'Internal server error'
    });
  } else {
    // Development: show full error details
    res.status(err.status || 500).json({
      error: err.message,
      stack: err.stack,
      details: err
    });
  }
});

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  clearInterval(wsPingInterval);
  streamManager.stopAll();
  wss.clients.forEach((client) => client.close());
  motionBrowserClients.forEach((client) => client.close());
  if (_motionDetector) _motionDetector.close(1000, 'shutdown');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit if cleanup takes too long
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`Birdcam server at http://localhost:${PORT}`);
  console.log(`Admin at http://localhost:${PORT}/admin`);
});
