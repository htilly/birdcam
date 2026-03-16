const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'birdcam.db');
let db;

function getDb() {
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
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      rtsp_url TEXT NOT NULL,
      rtsp_host TEXT NOT NULL DEFAULT '',
      rtsp_port INTEGER NOT NULL DEFAULT 554,
      rtsp_path TEXT NOT NULL DEFAULT '',
      rtsp_username TEXT NOT NULL DEFAULT '',
      rtsp_password TEXT NOT NULL DEFAULT '',
      ffmpeg_options TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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

  // Ensure settings table exists (for upgrades from older versions)
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (!tables) {
    d.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
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
        time TEXT NOT NULL
      );
      CREATE INDEX idx_chat_messages_id ON chat_messages(id);
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
}

// --- Settings ---
const DEFAULT_SETTINGS = {
  reverse_proxy: 'false',
  require_auth_streams: 'false',
  login_rate_window_min: '15',
  login_rate_max: '15',
  setup_rate_window_min: '15',
  setup_rate_max: '10',
  chat_rate_limit: '5',
  chat_rate_window_ms: '1000',
  snapshot_rate_max: '6',
  snapshot_rate_window_sec: '60',
  api_rate_max: '100',
  api_rate_window_min: '1',
};

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULT_SETTINGS[key] || '');
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const result = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

function isReverseProxy() {
  return getSetting('reverse_proxy') === 'true';
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
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUser(id) {
  return getDb().prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return getDb().prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
}

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) as n FROM users').get().n;
}

function createUser(username, password) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(password, 10);
  const r = getDb().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  return r.lastInsertRowid;
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

function listCameras() {
  return getDb().prepare('SELECT * FROM cameras ORDER BY id').all();
}

function getCamera(id) {
  return getDb().prepare('SELECT * FROM cameras WHERE id = ?').get(id);
}

function createCamera(display_name, host, port, urlPath, username, password, ffmpegOptionsJson = '{}') {
  const d = getDb();
  const rtsp_url = buildRtspUrl(host, port, urlPath, username, password);
  if (!validateRtspUrl(rtsp_url)) {
    throw new Error('Invalid RTSP URL — only rtsp:// URLs are allowed');
  }
  const opts = typeof ffmpegOptionsJson === 'string' ? ffmpegOptionsJson : JSON.stringify(ffmpegOptionsJson || {});
  const r = d.prepare(
    "INSERT INTO cameras (display_name, rtsp_url, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password, ffmpeg_options, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).run(display_name, rtsp_url, host, port, urlPath, username, password, opts);
  return r.lastInsertRowid;
}

function updateCamera(id, display_name, host, port, urlPath, username, password, ffmpegOptionsJson = null) {
  const rtsp_url = buildRtspUrl(host, port, urlPath, username, password);
  if (!validateRtspUrl(rtsp_url)) {
    throw new Error('Invalid RTSP URL — only rtsp:// URLs are allowed');
  }
  const d = getDb();
  if (ffmpegOptionsJson !== null && ffmpegOptionsJson !== undefined) {
    const opts = typeof ffmpegOptionsJson === 'string' ? ffmpegOptionsJson : JSON.stringify(ffmpegOptionsJson || {});
    d.prepare(
      "UPDATE cameras SET display_name = ?, rtsp_url = ?, rtsp_host = ?, rtsp_port = ?, rtsp_path = ?, rtsp_username = ?, rtsp_password = ?, ffmpeg_options = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(display_name, rtsp_url, host, port, urlPath, username, password, opts, id);
  } else {
    d.prepare(
      "UPDATE cameras SET display_name = ?, rtsp_url = ?, rtsp_host = ?, rtsp_port = ?, rtsp_path = ?, rtsp_username = ?, rtsp_password = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(display_name, rtsp_url, host, port, urlPath, username, password, id);
  }
}

function deleteCamera(id) {
  getDb().prepare('DELETE FROM cameras WHERE id = ?').run(id);
}

// --- Snapshots ---
function getSnapshot(id) {
  return getDb().prepare("SELECT * FROM snapshots WHERE id = ?").get(id);
}

function addSnapshot(filename, nickname, cameraName) {
  getDb().prepare("INSERT INTO snapshots (filename, nickname, camera_name) VALUES (?, ?, ?)").run(filename, nickname, cameraName || '');
}

function getLatestSnapshots(limit = 3) {
  return getDb().prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT ?").all(limit);
}

function getAllSnapshots(limit = 50) {
  return getDb().prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT ?").all(limit);
}

function deleteSnapshot(id) {
  return getDb().prepare("DELETE FROM snapshots WHERE id = ?").run(id);
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
  return getDb().prepare("SELECT * FROM snapshots WHERE starred = 1 LIMIT 1").get();
}

function getStarredSnapshots(limit = 3) {
  return getDb().prepare("SELECT * FROM snapshots WHERE starred = 1 ORDER BY id DESC LIMIT ?").all(limit);
}

function getAllStarredSnapshots() {
  return getDb().prepare("SELECT * FROM snapshots WHERE starred = 1 ORDER BY id DESC").all();
}

// --- Chat messages ---
function addChatMessage(nickname, text, time) {
  getDb().prepare('INSERT INTO chat_messages (nickname, text, time) VALUES (?, ?, ?)').run(nickname, text, time);
  // Prune to keep only last 100 messages
  getDb().prepare('DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 100)').run();
}

function getChatMessages(limit = 50) {
  return getDb().prepare('SELECT nickname, text, time FROM chat_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

// --- Visitor stats ---
function recordVisit(visitorKey) {
  if (!visitorKey || String(visitorKey).length > 128) return;
  getDb().prepare('INSERT INTO visits (visitor_key, created_at) VALUES (?, datetime(\'now\'))').run(String(visitorKey));
}

function getVisitorStats() {
  const d = getDb();
  const uniqueToday = d.prepare(`
    SELECT COUNT(DISTINCT visitor_key) as n FROM visits
    WHERE date(created_at, 'localtime') = date('now', 'localtime')
  `).get().n;
  const uniqueWeek = d.prepare(`
    SELECT COUNT(DISTINCT visitor_key) as n FROM visits
    WHERE datetime(created_at) >= datetime('now', '-7 days')
  `).get().n;
  const uniqueMonth = d.prepare(`
    SELECT COUNT(DISTINCT visitor_key) as n FROM visits
    WHERE datetime(created_at) >= datetime('now', '-30 days')
  `).get().n;
  const daily = d.prepare(`
    SELECT date(created_at, 'localtime') as date, COUNT(DISTINCT visitor_key) as count
    FROM visits
    WHERE datetime(created_at) >= datetime('now', '-30 days')
    GROUP BY date(created_at, 'localtime')
    ORDER BY date
  `).all();
  return { uniqueToday, uniqueWeek, uniqueMonth, daily };
}

module.exports = {
  getDb,
  init,
  migrate,
  buildRtspUrl,
  validateRtspUrl,
  ensureAdmin,
  findUserByUsername,
  getUser,
  listUsers,
  countUsers,
  createUser,
  updateUserPassword,
  deleteUser,
  verifyPassword,
  listCameras,
  getCamera,
  createCamera,
  updateCamera,
  deleteCamera,
  getSetting,
  setSetting,
  getAllSettings,
  isReverseProxy,
  recordVisit,
  getVisitorStats,
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
};
