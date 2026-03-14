require('dotenv').config();
const crypto = require('crypto');
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

const PORT = process.env.PORT || 3000;

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

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      mediaSrc: ["'self'", "blob:"],
    },
  },
}));

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session configuration
app.use(session({
  secret: SESSION_SECRET,
  name: 'birdcam.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD && db.isReverseProxy(), // secure only when behind HTTPS proxy
  },
}));

// Rate limiting for login (reads settings from DB, recreates limiter when config changes)
let _loginLimiter = null;
let _loginLimiterKey = '';
function getLoginLimiter() {
  const windowMin = parseInt(db.getSetting('login_rate_window_min')) || 15;
  const max = parseInt(db.getSetting('login_rate_max')) || 15;
  const key = `${windowMin}:${max}`;
  if (_loginLimiter && _loginLimiterKey === key) return _loginLimiter;
  _loginLimiterKey = key;
  _loginLimiter = rateLimit({
    windowMs: windowMin * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many login attempts. Please try again later.',
  });
  return _loginLimiter;
}
app.use('/admin/login', (req, res, next) => getLoginLimiter()(req, res, next));

// Rate limiting for setup (reads settings from DB)
let _setupLimiter = null;
let _setupLimiterKey = '';
function getSetupLimiter() {
  const windowMin = parseInt(db.getSetting('setup_rate_window_min')) || 15;
  const max = parseInt(db.getSetting('setup_rate_max')) || 10;
  const key = `${windowMin}:${max}`;
  if (_setupLimiter && _setupLimiterKey === key) return _setupLimiter;
  _setupLimiterKey = key;
  _setupLimiter = rateLimit({
    windowMs: windowMin * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
  });
  return _setupLimiter;
}
app.use('/admin/setup', (req, res, next) => getSetupLimiter()(req, res, next));

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

app.use('/admin', adminRoutes);
app.use(express.json());
app.use('/api/recordings', recordingsRoutes);

const server = http.createServer(app);

// --- WebSocket chat with rate limiting ---
const chatMessages = [];
const MAX_CHAT_MESSAGES = 100;
function getChatRateLimit() { return parseInt(db.getSetting('chat_rate_limit')) || 5; }
function getChatRateWindow() { return parseInt(db.getSetting('chat_rate_window_ms')) || 1000; }

function sanitizeChat(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
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

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws._msgTimestamps = [];

  ws.send(JSON.stringify({ type: 'history', messages: chatMessages.slice(-50) }));
  broadcastStats();
  ws.on('close', () => broadcastStats());
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
        const msg = {
          nickname: sanitizeChat(String(data.nickname).slice(0, 30).trim()),
          text: sanitizeChat(String(data.text).slice(0, 500).trim()),
          time: new Date().toISOString(),
        };
        if (!msg.nickname || !msg.text) return;
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

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  streamManager.stopAll();
  wss.clients.forEach((client) => client.close());
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
