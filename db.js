const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'birdcam.db');
let db;

// --- Prepared statement cache (lazy-initialized after DB is ready) ---
// Avoids re-creating prepared statement objects on every function call.
// better-sqlite3 does internal caching by SQL string, but this eliminates
// the lookup overhead and object allocation on hot paths.
const _stmtCache = {};
let _testDb = null;
function stmt(key, sql) {
  if (!_stmtCache[key]) _stmtCache[key] = getDb().prepare(sql);
  return _stmtCache[key];
}

// --- Cached setting: isReverseProxy (#5) ---
// Avoids hitting SQLite on every HTTP request for trust-proxy check.
let _reverseProxyCache = null;
let _reverseProxyCacheTime = 0;
const REVERSE_PROXY_CACHE_TTL = 30_000; // 30 seconds

function getDb() {
  if (_testDb) return _testDb;
  if (!db) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    init();
  }
  return db;
}

function init() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_webauthn_credentials (
      id TEXT PRIMARY KEY,
      chat_user_id INTEGER NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_type TEXT NOT NULL DEFAULT 'singleDevice',
      backed_up INTEGER NOT NULL DEFAULT 0,
      transports TEXT DEFAULT '[]',
      display_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (chat_user_id) REFERENCES chat_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_webauthn_credentials_user_id ON chat_webauthn_credentials(chat_user_id);
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      rtsp_url TEXT NOT NULL,
      rtsp_host TEXT NOT NULL DEFAULT '',
      rtsp_port INTEGER NOT NULL DEFAULT 554,
      rtsp_path TEXT NOT NULL DEFAULT '',
      rtsp_username TEXT NOT NULL DEFAULT '',
      rtsp_password TEXT NOT NULL DEFAULT '',
      onvif_port INTEGER NOT NULL DEFAULT 8899,
      onvif_username TEXT NOT NULL DEFAULT '',
      onvif_password TEXT NOT NULL DEFAULT '',
      ffmpeg_options TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS motion_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_motion_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_motion_incidents_camera_started_at ON motion_incidents(camera_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_motion_incidents_ended_starred ON motion_incidents(ended_at, starred);
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_type TEXT NOT NULL DEFAULT 'singleDevice',
      backed_up INTEGER NOT NULL DEFAULT 0,
      transports TEXT DEFAULT '[]',
      webauthn_user_id TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);
  `);
}

function migrate() {
  const d = getDb();
  const cols = d.prepare("PRAGMA table_info(cameras)").all().map(c => c.name);
  if (!cols.includes('rtsp_host')) {
    d.exec(`
      ALTER TABLE cameras ADD COLUMN rtsp_host TEXT NOT NULL DEFAULT '';
      ALTER TABLE cameras ADD COLUMN rtsp_port INTEGER NOT NULL DEFAULT 554;
      ALTER TABLE cameras ADD COLUMN rtsp_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE cameras ADD COLUMN rtsp_username TEXT NOT NULL DEFAULT '';
      ALTER TABLE cameras ADD COLUMN rtsp_password TEXT NOT NULL DEFAULT '';
    `);
    const cameras = d.prepare('SELECT id, rtsp_url FROM cameras').all();
    const update = d.prepare('UPDATE cameras SET rtsp_host = ?, rtsp_port = ?, rtsp_path = ?, rtsp_username = ?, rtsp_password = ? WHERE id = ?');
    for (const cam of cameras) {
      try {
        const url = new URL(cam.rtsp_url);
        update.run(url.hostname, parseInt(url.port) || 554, url.pathname + url.search, url.username, url.password, cam.id);
      } catch (_) {}
    }
  }
  // FFmpeg options per camera (JSON)
  const camCols = d.prepare("PRAGMA table_info(cameras)").all().map(c => c.name);
  if (!camCols.includes('ffmpeg_options')) {
    d.exec(`ALTER TABLE cameras ADD COLUMN ffmpeg_options TEXT DEFAULT '{}'`);
  }

  // ONVIF settings per camera
  if (!camCols.includes('onvif_port')) {
    d.exec(`ALTER TABLE cameras ADD COLUMN onvif_port INTEGER NOT NULL DEFAULT 8899`);
  }
  if (!camCols.includes('onvif_username')) {
    d.exec(`ALTER TABLE cameras ADD COLUMN onvif_username TEXT NOT NULL DEFAULT ''`);
  }
  if (!camCols.includes('onvif_password')) {
    d.exec(`ALTER TABLE cameras ADD COLUMN onvif_password TEXT NOT NULL DEFAULT ''`);
  }

  // Time sync scheduling per camera
  if (!camCols.includes('time_sync_enabled')) {
    d.exec(`ALTER TABLE cameras ADD COLUMN time_sync_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!camCols.includes('time_sync_interval_hours')) {
    d.exec(`ALTER TABLE cameras ADD COLUMN time_sync_interval_hours INTEGER NOT NULL DEFAULT 24`);
  }

  // Ensure settings table exists (for upgrades from older versions)
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (!tables) {
    d.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  // Motion incidents (motion clip retention + stars)
  const motionTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='motion_incidents'").get();
  if (!motionTable) {
    d.exec(`
      CREATE TABLE motion_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        last_motion_at TEXT
      );
      CREATE INDEX idx_motion_incidents_camera_started_at ON motion_incidents(camera_id, started_at);
      CREATE INDEX idx_motion_incidents_ended_starred ON motion_incidents(ended_at, starred);
    `);
  }

  // Snapshots
  const snapshotsTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'").get();
  if (!snapshotsTable) {
    d.exec(`
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        nickname TEXT NOT NULL,
        camera_name TEXT NOT NULL DEFAULT '',
        starred INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } else {
    // Add starred column if missing (upgrade from older schema)
    const snapCols = d.prepare("PRAGMA table_info(snapshots)").all().map(c => c.name);
    if (!snapCols.includes('starred')) {
      d.exec(`ALTER TABLE snapshots ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  // Chat message persistence
  const chatTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'").get();
  if (!chatTable) {
    d.exec(`
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL,
        ip_address TEXT
      );
      CREATE INDEX idx_chat_messages_id ON chat_messages(id);
    `);
  } else {
    // Add ip_address column if missing (migration)
    const chatCols = d.prepare("PRAGMA table_info(chat_messages)").all().map(c => c.name);
    if (!chatCols.includes('ip_address')) {
      d.exec(`ALTER TABLE chat_messages ADD COLUMN ip_address TEXT`);
    }
  }

  // Banned IPs table for chat moderation
  const bannedTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='banned_ips'").get();
  if (!bannedTable) {
    d.exec(`
      CREATE TABLE banned_ips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL UNIQUE,
        reason TEXT,
        banned_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_banned_ips_ip ON banned_ips(ip_address);
    `);
  }

  // Visitor tracking for admin stats
  const visitsTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='visits'").get();
  if (!visitsTable) {
    d.exec(`
      CREATE TABLE visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visitor_key TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_visits_created_at ON visits(created_at);
      CREATE INDEX idx_visits_visitor_key ON visits(visitor_key);
    `);
  }

  // Audit log for admin actions (security review fix)
  const auditTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
  if (!auditTable) {
    d.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        request_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX idx_audit_user_id ON audit_log(user_id);
      CREATE INDEX idx_audit_action ON audit_log(action);
    `);
  }

  // Migrate hls_time and hls_list_size to low-latency defaults in stored ffmpeg_options.
  // Cameras created before this change may have hls_time:2, hls_list_size:3 saved in the DB
  // which would override the new DEFAULT_FFMPEG_OPTIONS values.
  const cameras = d.prepare('SELECT id, ffmpeg_options FROM cameras').all();
  const updateOpts = d.prepare('UPDATE cameras SET ffmpeg_options = ? WHERE id = ?');
  for (const cam of cameras) {
    try {
      const opts = cam.ffmpeg_options ? JSON.parse(cam.ffmpeg_options) : {};
      let changed = false;
      if (opts.hls_time === 2)      { opts.hls_time = 1;      changed = true; }
      if (opts.hls_list_size === 3) { opts.hls_list_size = 2; changed = true; }
      if (changed) updateOpts.run(JSON.stringify(opts), cam.id);
    } catch (_) {}
  }

  // WebAuthn credentials table
  const webauthnTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webauthn_credentials'").get();
  if (!webauthnTable) {
    d.exec(`
      CREATE TABLE webauthn_credentials (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        device_type TEXT NOT NULL DEFAULT 'singleDevice',
        backed_up INTEGER NOT NULL DEFAULT 0,
        transports TEXT DEFAULT '[]',
        webauthn_user_id TEXT NOT NULL,
        display_name TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);
    `);
  }

  // Allow NULL password_hash for WebAuthn-only users
  const userCols = d.prepare("PRAGMA table_info(users)").all();
  const pwCol = userCols.find(c => c.name === 'password_hash');
  if (pwCol && pwCol.notnull === 1) {
    d.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO users_new SELECT id, username, password_hash, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  }

  // Chat users table for WebAuthn-based chat identity
  const chatUsersTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_users'").get();
  if (!chatUsersTable) {
    d.exec(`
      CREATE TABLE chat_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT UNIQUE NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // Chat WebAuthn credentials
  const chatWebauthnTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_webauthn_credentials'").get();
  if (!chatWebauthnTable) {
    d.exec(`
      CREATE TABLE chat_webauthn_credentials (
        id TEXT PRIMARY KEY,
        chat_user_id INTEGER NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        device_type TEXT NOT NULL DEFAULT 'singleDevice',
        backed_up INTEGER NOT NULL DEFAULT 0,
        transports TEXT DEFAULT '[]',
        display_name TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT,
        FOREIGN KEY (chat_user_id) REFERENCES chat_users(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_chat_webauthn_credentials_user_id ON chat_webauthn_credentials(chat_user_id);
    `);
  }

  // Add last_used_at column to webauthn_credentials if missing
  const webauthnCols = d.prepare("PRAGMA table_info(webauthn_credentials)").all().map(c => c.name);
  if (webauthnCols.includes('id') && !webauthnCols.includes('last_used_at')) {
    d.exec(`ALTER TABLE webauthn_credentials ADD COLUMN last_used_at TEXT`);
  }

  // Add display_name and last_used_at to chat_webauthn_credentials if missing
  const chatWebauthnCols = d.prepare("PRAGMA table_info(chat_webauthn_credentials)").all().map(c => c.name);
  if (chatWebauthnCols.includes('id')) {
    if (!chatWebauthnCols.includes('display_name')) {
      d.exec(`ALTER TABLE chat_webauthn_credentials ADD COLUMN display_name TEXT DEFAULT ''`);
    }
    if (!chatWebauthnCols.includes('last_used_at')) {
      d.exec(`ALTER TABLE chat_webauthn_credentials ADD COLUMN last_used_at TEXT`);
    }
  }
}

// --- Settings ---
const DEFAULT_SETTINGS = {
  reverse_proxy: 'false',
  require_auth_streams: 'false',
  // Date/time display preferences (admin + public UI)
  // "eu" = 24h, day-month-year; "us" = 12h, month-day-year
  datetime_locale: 'eu',
  login_rate_window_min: '15',
  login_rate_max: '15',
  setup_rate_window_min: '15',
  setup_rate_max: '10',
  chat_rate_limit: '5',
  chat_rate_window_ms: '1000',
  chat_disabled: 'false',
  snapshot_rate_max: '6',
  snapshot_rate_window_sec: '60',
  api_rate_max: '100',
  api_rate_window_min: '1',
  // Motion clip retention (0 disables a constraint)
  motion_clip_max_count: '200',
  motion_clip_max_total_mb: '5000',
};

function getSetting(key) {
  const row = stmt('getSetting', 'SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULT_SETTINGS[key] || '');
}

function setSetting(key, value) {
  stmt('setSetting', 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  // Invalidate reverse proxy cache when any setting changes (#5)
  _reverseProxyCache = null;
}

function getAllSettings() {
  const rows = stmt('getAllSettings', 'SELECT key, value FROM settings').all();
  const result = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// (#5) Cached version — avoids DB hit on every HTTP request.
// Cache is invalidated when any setting is saved via setSetting().
function isReverseProxy() {
  const now = Date.now();
  if (_reverseProxyCache === null || now - _reverseProxyCacheTime > REVERSE_PROXY_CACHE_TTL) {
    _reverseProxyCache = getSetting('reverse_proxy') === 'true';
    _reverseProxyCacheTime = now;
  }
  return _reverseProxyCache;
}

function buildRtspUrl(host, port, urlPath, username, password) {
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  return `rtsp://${auth}${host}:${port}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;
}

function validateRtspUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'rtsp:';
  } catch (_) {
    return false;
  }
}

function ensureAdmin(username, password) {
  const bcrypt = require('bcryptjs');
  const d = getDb();
  const existing = d.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return;
  const hash = bcrypt.hashSync(password, 10);
  d.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
}

function findUserByUsername(username) {
  return stmt('findUserByUsername', 'SELECT * FROM users WHERE username = ?').get(username);
}

function getUser(id) {
  return stmt('getUser', 'SELECT id, username, created_at FROM users WHERE id = ?').get(id);
}

// (#6) Exported for auth middleware to avoid re-preparing per request
function userExists(id) {
  return !!stmt('userExists', 'SELECT id FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return stmt('listUsers', 'SELECT id, username, created_at FROM users ORDER BY id').all();
}

function countUsers() {
  return stmt('countUsers', 'SELECT COUNT(*) as n FROM users').get().n;
}

function createUser(username, password) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(password, 10);
  const r = getDb().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  return r.lastInsertRowid;
}

function createUserWithoutPassword(username) {
  const r = getDb().prepare('INSERT INTO users (username, password_hash) VALUES (?, NULL)').run(username);
  return r.lastInsertRowid;
}

function hasPassword(userId) {
  const row = stmt('hasPassword', 'SELECT password_hash FROM users WHERE id = ?').get(userId);
  return !!(row && row.password_hash);
}

function updateUserPassword(id, newPassword) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(newPassword, 10);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
}

function deleteUser(id) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

function verifyPassword(password, hash) {
  return require('bcryptjs').compareSync(password, hash);
}

// --- WebAuthn Credentials ---
function addWebAuthnCredential(credential) {
  const d = getDb();
  d.prepare(`
    INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports, webauthn_user_id, display_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credential.id,
    credential.user_id,
    credential.public_key,
    credential.counter || 0,
    credential.device_type || 'singleDevice',
    credential.backed_up ? 1 : 0,
    JSON.stringify(credential.transports || []),
    credential.webauthn_user_id,
    credential.display_name || ''
  );
}

function getWebAuthnCredentialsByUserId(userId) {
  const rows = stmt('getWebAuthnCredentialsByUserId', 'SELECT * FROM webauthn_credentials WHERE user_id = ?').all(userId);
  return rows.map(row => ({
    id: row.id,
    user_id: row.user_id,
    public_key: row.public_key,
    counter: row.counter,
    device_type: row.device_type,
    backed_up: !!row.backed_up,
    transports: JSON.parse(row.transports || '[]'),
    webauthn_user_id: row.webauthn_user_id,
    display_name: row.display_name,
    created_at: row.created_at,
    last_used_at: row.last_used_at
  }));
}

function getWebAuthnCredentialById(credentialId) {
  const row = stmt('getWebAuthnCredentialById', 'SELECT * FROM webauthn_credentials WHERE id = ?').get(credentialId);
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    public_key: row.public_key,
    counter: row.counter,
    device_type: row.device_type,
    backed_up: !!row.backed_up,
    transports: JSON.parse(row.transports || '[]'),
    webauthn_user_id: row.webauthn_user_id,
    display_name: row.display_name,
    created_at: row.created_at,
    last_used_at: row.last_used_at
  };
}

function updateWebAuthnCredentialCounter(credentialId, newCounter) {
  getDb().prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime(\'now\') WHERE id = ?').run(newCounter, credentialId);
}

function updateWebAuthnCredentialDisplayName(credentialId, displayName) {
  stmt('updateWebAuthnCredentialDisplayName', 'UPDATE webauthn_credentials SET display_name = ? WHERE id = ?').run(displayName, credentialId);
}

function deleteWebAuthnCredential(credentialId) {
  stmt('deleteWebAuthnCredential', 'DELETE FROM webauthn_credentials WHERE id = ?').run(credentialId);
}

function countWebAuthnCredentialsByUserId(userId) {
  return stmt('countWebAuthnCredentialsByUserId', 'SELECT COUNT(*) as n FROM webauthn_credentials WHERE user_id = ?').get(userId).n;
}

// --- Chat Users (WebAuthn-based identity) ---
function createChatUser(nickname) {
  const r = getDb().prepare('INSERT INTO chat_users (nickname) VALUES (?)').run(nickname);
  return r.lastInsertRowid;
}

function getChatUser(id) {
  return stmt('getChatUser', 'SELECT * FROM chat_users WHERE id = ?').get(id);
}

function getChatUserByNickname(nickname) {
  return stmt('getChatUserByNickname', 'SELECT * FROM chat_users WHERE nickname = ?').get(nickname);
}

function addChatWebAuthnCredential(credential) {
  const d = getDb();
  d.prepare(`
    INSERT INTO chat_webauthn_credentials (id, chat_user_id, public_key, counter, device_type, backed_up, transports, display_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credential.id,
    credential.chat_user_id,
    credential.public_key,
    credential.counter || 0,
    credential.device_type || 'singleDevice',
    credential.backed_up ? 1 : 0,
    JSON.stringify(credential.transports || []),
    credential.display_name || ''
  );
}

function getChatWebAuthnCredentialById(credentialId) {
  const row = stmt('getChatWebAuthnCredentialById', 'SELECT * FROM chat_webauthn_credentials WHERE id = ?').get(credentialId);
  if (!row) return null;
  return {
    id: row.id,
    chat_user_id: row.chat_user_id,
    public_key: row.public_key,
    counter: row.counter,
    device_type: row.device_type,
    backed_up: !!row.backed_up,
    transports: JSON.parse(row.transports || '[]'),
    display_name: row.display_name,
    created_at: row.created_at,
    last_used_at: row.last_used_at
  };
}

function updateChatWebAuthnCredentialCounter(credentialId, newCounter) {
  getDb().prepare('UPDATE chat_webauthn_credentials SET counter = ?, last_used_at = datetime(\'now\') WHERE id = ?').run(newCounter, credentialId);
}

function updateChatWebAuthnCredentialDisplayName(credentialId, displayName) {
  stmt('updateChatWebAuthnCredentialDisplayName', 'UPDATE chat_webauthn_credentials SET display_name = ? WHERE id = ?').run(displayName, credentialId);
}

function listCameras() {
  return stmt('listCameras', 'SELECT * FROM cameras ORDER BY id').all();
}

function getCamera(id) {
  return stmt('getCamera', 'SELECT * FROM cameras WHERE id = ?').get(id);
}

function getOnvifCredentials(camera) {
  if (!camera) return { username: '', password: '', port: 8899 };
  return {
    username: camera.onvif_username || camera.rtsp_username || 'admin',
    password: camera.onvif_password || camera.rtsp_password || '',
    port: camera.onvif_port || 8899,
  };
}

function createCamera(display_name, host, port, urlPath, username, password, ffmpegOptionsJson = '{}', onvifPort = 8899, onvifUsername = '', onvifPassword = '') {
  const d = getDb();
  const rtsp_url = buildRtspUrl(host, port, urlPath, username, password);
  if (!validateRtspUrl(rtsp_url)) {
    throw new Error('Invalid RTSP URL — only rtsp:// URLs are allowed');
  }
  const opts = typeof ffmpegOptionsJson === 'string' ? ffmpegOptionsJson : JSON.stringify(ffmpegOptionsJson || {});
  const r = d.prepare(
    "INSERT INTO cameras (display_name, rtsp_url, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password, onvif_port, onvif_username, onvif_password, ffmpeg_options, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).run(display_name, rtsp_url, host, port, urlPath, username, password, onvifPort || 8899, onvifUsername || '', onvifPassword || '', opts);
  return r.lastInsertRowid;
}

function updateCamera(id, display_name, host, port, urlPath, username, password, ffmpegOptionsJson = null, onvifPort = null, onvifUsername = null, onvifPassword = null, timeSyncEnabled = null, timeSyncIntervalHours = null) {
  const rtsp_url = buildRtspUrl(host, port, urlPath, username, password);
  if (!validateRtspUrl(rtsp_url)) {
    throw new Error('Invalid RTSP URL — only rtsp:// URLs are allowed');
  }
  const d = getDb();
  const cam = getCamera(id);
  const enabled = timeSyncEnabled !== null ? (timeSyncEnabled ? 1 : 0) : (cam.time_sync_enabled || 0);
  const interval = timeSyncIntervalHours !== null ? timeSyncIntervalHours : (cam.time_sync_interval_hours || 24);
  if (ffmpegOptionsJson !== null && ffmpegOptionsJson !== undefined) {
    const opts = typeof ffmpegOptionsJson === 'string' ? ffmpegOptionsJson : JSON.stringify(ffmpegOptionsJson || {});
    d.prepare(
      "UPDATE cameras SET display_name = ?, rtsp_url = ?, rtsp_host = ?, rtsp_port = ?, rtsp_path = ?, rtsp_username = ?, rtsp_password = ?, onvif_port = ?, onvif_username = ?, onvif_password = ?, ffmpeg_options = ?, time_sync_enabled = ?, time_sync_interval_hours = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(display_name, rtsp_url, host, port, urlPath, username, password, onvifPort || 8899, onvifUsername || '', onvifPassword || '', opts, enabled, interval, id);
  } else {
    d.prepare(
      "UPDATE cameras SET display_name = ?, rtsp_url = ?, rtsp_host = ?, rtsp_port = ?, rtsp_path = ?, rtsp_username = ?, rtsp_password = ?, onvif_port = ?, onvif_username = ?, onvif_password = ?, time_sync_enabled = ?, time_sync_interval_hours = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(display_name, rtsp_url, host, port, urlPath, username, password, onvifPort || 8899, onvifUsername || '', onvifPassword || '', enabled, interval, id);
  }
}

function deleteCamera(id) {
  getDb().prepare('DELETE FROM cameras WHERE id = ?').run(id);
}

function getCamerasWithTimeSyncEnabled() {
  return getDb().prepare('SELECT * FROM cameras WHERE time_sync_enabled = 1').all();
}

// --- Snapshots ---
function getSnapshot(id) {
  return stmt('getSnapshot', "SELECT * FROM snapshots WHERE id = ?").get(id);
}

function addSnapshot(filename, nickname, cameraName) {
  stmt('addSnapshot', "INSERT INTO snapshots (filename, nickname, camera_name) VALUES (?, ?, ?)").run(filename, nickname, cameraName || '');
}

function getLatestSnapshots(limit = 3) {
  return stmt('getLatestSnapshots', "SELECT * FROM snapshots ORDER BY id DESC LIMIT ?").all(limit);
}

function getAllSnapshots(limit = 50) {
  return stmt('getAllSnapshots', "SELECT * FROM snapshots ORDER BY id DESC LIMIT ?").all(limit);
}

function deleteSnapshot(id) {
  return stmt('deleteSnapshot', "DELETE FROM snapshots WHERE id = ?").run(id);
}

function deleteSnapshots(ids) {
  if (!ids || !ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`).run(...ids);
}

function setSnapshotStarred(id, starred) {
  // Only one snapshot can be starred at a time
  const d = getDb();
  if (starred) {
    d.prepare("UPDATE snapshots SET starred = 0").run();
    d.prepare("UPDATE snapshots SET starred = 1 WHERE id = ?").run(id);
  } else {
    d.prepare("UPDATE snapshots SET starred = 0 WHERE id = ?").run(id);
  }
}

function getStarredSnapshot() {
  return stmt('getStarredSnapshot', "SELECT * FROM snapshots WHERE starred = 1 LIMIT 1").get();
}

function getStarredSnapshots(limit = 3) {
  return stmt('getStarredSnapshots', "SELECT * FROM snapshots WHERE starred = 1 ORDER BY id DESC LIMIT ?").all(limit);
}

function getAllStarredSnapshots() {
  return stmt('getAllStarredSnapshots', "SELECT * FROM snapshots WHERE starred = 1 ORDER BY id DESC").all();
}

// --- Chat messages ---
let _chatInsertCount = 0;
const CHAT_PRUNE_EVERY = 10; // (#4) Only prune DB every Nth insert, not every one

function addChatMessage(nickname, text, time, ipAddress = null) {
  const result = stmt('addChatMessage', 'INSERT INTO chat_messages (nickname, text, time, ip_address) VALUES (?, ?, ?, ?)').run(nickname, text, time, ipAddress);
  // (#4) Prune to keep only last 100 messages — but only every Nth insert
  // to avoid running the expensive subquery on every single chat message.
  _chatInsertCount++;
  if (_chatInsertCount >= CHAT_PRUNE_EVERY) {
    _chatInsertCount = 0;
    stmt('pruneChatMessages', 'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 100)').run();
  }
  return result.lastInsertRowid;
}

function getChatMessages(limit = 50) {
  return stmt('getChatMessages', 'SELECT id, nickname, text, time, ip_address FROM chat_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

function deleteChatMessage(id) {
  return stmt('deleteChatMessage', 'DELETE FROM chat_messages WHERE id = ?').run(id);
}

function deleteChatMessages(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`).run(...ids);
}

function clearAllChatMessages() {
  return getDb().prepare('DELETE FROM chat_messages').run();
}

// --- IP Bans ---
function addBan(ipAddress, reason = null, bannedBy = null) {
  try {
    stmt('addBan', 'INSERT OR REPLACE INTO banned_ips (ip_address, reason, banned_by) VALUES (?, ?, ?)').run(ipAddress, reason, bannedBy);
    return true;
  } catch (_) {
    return false;
  }
}

function removeBan(ipAddress) {
  return stmt('removeBan', 'DELETE FROM banned_ips WHERE ip_address = ?').run(ipAddress);
}

function isIpBanned(ipAddress) {
  const row = stmt('isIpBanned', 'SELECT 1 FROM banned_ips WHERE ip_address = ?').get(ipAddress);
  return !!row;
}

function listBans() {
  return stmt('listBans', 'SELECT * FROM banned_ips ORDER BY created_at DESC').all();
}

// --- Visitor stats ---
let _visitInsertCount = 0;
const VISIT_PRUNE_EVERY = 50; // (#1) Prune visits older than 90 days periodically

function recordVisit(visitorKey) {
  if (!visitorKey || String(visitorKey).length > 128) return;
  stmt('recordVisit', "INSERT INTO visits (visitor_key, created_at) VALUES (?, datetime('now'))").run(String(visitorKey));
  // (#1) Periodically prune old visits to prevent unbounded table growth
  _visitInsertCount++;
  if (_visitInsertCount >= VISIT_PRUNE_EVERY) {
    _visitInsertCount = 0;
    stmt('pruneVisits', "DELETE FROM visits WHERE datetime(created_at) < datetime('now', '-90 days')").run();
  }
}

function getVisitorStats() {
  const uniqueToday = stmt('visitorStatsToday', `
    SELECT COUNT(DISTINCT visitor_key) as n FROM visits
    WHERE date(created_at, 'localtime') = date('now', 'localtime')
  `).get().n;
  const uniqueWeek = stmt('visitorStatsWeek', `
    SELECT COUNT(DISTINCT visitor_key) as n FROM visits
    WHERE datetime(created_at) >= datetime('now', '-7 days')
  `).get().n;
  const uniqueMonth = stmt('visitorStatsMonth', `
    SELECT COUNT(DISTINCT visitor_key) as n FROM visits
    WHERE datetime(created_at) >= datetime('now', '-30 days')
  `).get().n;
  const daily = stmt('visitorStatsDaily', `
    SELECT date(created_at, 'localtime') as date, COUNT(DISTINCT visitor_key) as count
    FROM visits
    WHERE datetime(created_at) >= datetime('now', '-30 days')
    GROUP BY date(created_at, 'localtime')
    ORDER BY date
  `).all();
  return { uniqueToday, uniqueWeek, uniqueMonth, daily };
}

// --- Motion incidents (motion clips) ---
function addMotionIncident(cameraId, startedAtIso, filePath) {
  const r = stmt('addMotionIncident',
    'INSERT INTO motion_incidents (camera_id, started_at, file_path) VALUES (?, ?, ?)'
  ).run(cameraId, startedAtIso, filePath);
  return r.lastInsertRowid;
}

function updateMotionIncidentLastMotion(id, lastMotionAtIso) {
  stmt('updateMotionIncidentLastMotion', 'UPDATE motion_incidents SET last_motion_at = ? WHERE id = ?').run(lastMotionAtIso, id);
}

function endMotionIncident(id, endedAtIso, sizeBytes) {
  stmt('endMotionIncident',
    'UPDATE motion_incidents SET ended_at = ?, size_bytes = ? WHERE id = ?'
  ).run(endedAtIso, sizeBytes || 0, id);
}

function setMotionIncidentStar(id, starred) {
  stmt('setMotionIncidentStar',
    'UPDATE motion_incidents SET starred = ? WHERE id = ?'
  ).run(starred ? 1 : 0, id);
  const row = stmt('getMotionIncidentStar', 'SELECT id, starred FROM motion_incidents WHERE id = ?').get(id);
  return row || null;
}

function getMotionIncident(id) {
  return stmt('getMotionIncident', 'SELECT * FROM motion_incidents WHERE id = ?').get(id);
}

function getUnstarredMotionIncidentTotals() {
  const row = stmt('getUnstarredMotionIncidentTotals', `
    SELECT
      COUNT(*) as n,
      COALESCE(SUM(size_bytes), 0) as bytes
    FROM motion_incidents
    WHERE ended_at IS NOT NULL AND starred = 0
  `).get();
  return { count: row.n, bytes: row.bytes };
}

function getOldestUnstarredMotionIncidents(limit = 1) {
  return stmt('getOldestUnstarredMotionIncidents', `
    SELECT id, file_path, size_bytes
    FROM motion_incidents
    WHERE ended_at IS NOT NULL AND starred = 0
    ORDER BY started_at ASC
    LIMIT ?
  `).all(limit);
}

function deleteMotionIncident(id) {
  stmt('deleteMotionIncident', 'DELETE FROM motion_incidents WHERE id = ?').run(id);
}

// (#10) Batch deletion for retention enforcement — deletes multiple incidents in one query
function deleteMotionIncidents(ids) {
  if (!ids || !ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`DELETE FROM motion_incidents WHERE id IN (${placeholders})`).run(...ids);
}

function listRecentMotionIncidents(limit = 30) {
  return stmt('listRecentMotionIncidents', `
    SELECT
      mi.*,
      c.display_name as camera_name
    FROM motion_incidents mi
    LEFT JOIN cameras c ON c.id = mi.camera_id
    ORDER BY mi.starred DESC, mi.started_at DESC
    LIMIT ?
  `).all(limit);
}

// Recordings listing for a given camera + calendar date (localtime).
// Used by the public "Recordings" search UI.
function listMotionIncidentsForDate(cameraId, yyyymmdd) {
  if (!cameraId || !yyyymmdd) return [];
  return stmt('listMotionIncidentsForDate', `
    SELECT
      id,
      camera_id,
      started_at,
      ended_at,
      file_path,
      size_bytes
    FROM motion_incidents
    WHERE
      camera_id = ?
      AND ended_at IS NOT NULL
      AND date(started_at, 'localtime') = ?
    ORDER BY started_at ASC
  `).all(cameraId, yyyymmdd);
}

// --- Motion visit stats (for chart) ---
function getMotionVisitStats() {
  const byHour = stmt('motionVisitsByHour', `
    SELECT strftime('%Y-%m-%dT%H', started_at) as hour, COUNT(*) as count
    FROM motion_incidents
    WHERE ended_at IS NOT NULL
      AND datetime(started_at) >= datetime('now', '-24 hours')
    GROUP BY strftime('%Y-%m-%dT%H', started_at)
    ORDER BY hour
  `).all();
  const byDay = stmt('motionVisitsByDay', `
    SELECT date(started_at, 'localtime') as date, COUNT(*) as count
    FROM motion_incidents
    WHERE ended_at IS NOT NULL
      AND datetime(started_at) >= datetime('now', '-7 days')
    GROUP BY date(started_at, 'localtime')
    ORDER BY date
  `).all();
  return { byHour, byDay };
}

// Recent ended visits for the event log (server-side list)
function listRecentVisits(limit = 50) {
  return stmt('listRecentVisits', `
    SELECT
      mi.id,
      mi.started_at,
      mi.ended_at,
      mi.starred,
      c.display_name as camera_name
    FROM motion_incidents mi
    LEFT JOIN cameras c ON c.id = mi.camera_id
    WHERE mi.ended_at IS NOT NULL
    ORDER BY mi.started_at DESC
    LIMIT ?
  `).all(limit);
}

function getLastVisitTime() {
  const row = stmt('getLastVisitTime', `
    SELECT ended_at FROM motion_incidents
    WHERE ended_at IS NOT NULL
    ORDER BY ended_at DESC LIMIT 1
  `).get();
  return row ? row.ended_at : null;
}

// --- Clear stats ---
function clearVisitorHistory() {
  getDb().prepare('DELETE FROM visits').run();
}

function clearMotionRecordings() {
  // Returns all file_path values before deleting so caller can remove files from disk
  const rows = getDb().prepare('SELECT file_path FROM motion_incidents').all();
  getDb().prepare('DELETE FROM motion_incidents').run();
  return rows.map(r => r.file_path).filter(Boolean);
}

// --- Audit Log ---
function addAuditLog(userId, username, action, details, ipAddress, requestId) {
  stmt('addAuditLog',
    'INSERT INTO audit_log (user_id, username, action, details, ip_address, request_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, details || null, ipAddress || null, requestId || null);
}

function getAuditLogs(limit = 100) {
  return stmt('getAuditLogs', 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  getDb,
  _stmtCache,
  _setTestDb: (db) => { _testDb = db; },
  _resetTestDb: () => { _testDb = null; },
  init,
  migrate,
  buildRtspUrl,
  validateRtspUrl,
  ensureAdmin,
  findUserByUsername,
  getUser,
  userExists,
  listUsers,
  countUsers,
  createUser,
  updateUserPassword,
  deleteUser,
  verifyPassword,
  listCameras,
  getCamera,
  getOnvifCredentials,
  createCamera,
  updateCamera,
  deleteCamera,
  getCamerasWithTimeSyncEnabled,
  getSetting,
  setSetting,
  getAllSettings,
  isReverseProxy,
  recordVisit,
  getVisitorStats,
  addMotionIncident,
  updateMotionIncidentLastMotion,
  endMotionIncident,
  setMotionIncidentStar,
  getMotionIncident,
  getUnstarredMotionIncidentTotals,
  getOldestUnstarredMotionIncidents,
  deleteMotionIncident,
  deleteMotionIncidents,
  listRecentMotionIncidents,
  listMotionIncidentsForDate,
  listRecentVisits,
  getLastVisitTime,
  getSnapshot,
  addSnapshot,
  getLatestSnapshots,
  getAllSnapshots,
  deleteSnapshot,
  deleteSnapshots,
  getStarredSnapshots,
  getAllStarredSnapshots,
  setSnapshotStarred,
  getStarredSnapshot,
  addChatMessage,
  getChatMessages,
  deleteChatMessage,
  deleteChatMessages,
  clearAllChatMessages,
  addBan,
  removeBan,
  isIpBanned,
  listBans,
  getMotionVisitStats,
  clearVisitorHistory,
  clearMotionRecordings,
  addAuditLog,
  getAuditLogs,
  addWebAuthnCredential,
  getWebAuthnCredentialsByUserId,
  getWebAuthnCredentialById,
  updateWebAuthnCredentialCounter,
  updateWebAuthnCredentialDisplayName,
  deleteWebAuthnCredential,
  countWebAuthnCredentialsByUserId,
  createUserWithoutPassword,
  hasPassword,
  createChatUser,
  getChatUser,
  getChatUserByNickname,
  addChatWebAuthnCredential,
  getChatWebAuthnCredentialById,
  updateChatWebAuthnCredentialCounter,
  updateChatWebAuthnCredentialDisplayName,
};
