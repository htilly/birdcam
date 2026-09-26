const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

function createIsolatedTestDb() {
  const db = new Database(':memory:');
  
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE cameras (
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
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      nickname TEXT NOT NULL,
      camera_name TEXT NOT NULL DEFAULT '',
      starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      text TEXT NOT NULL,
      time TEXT NOT NULL,
      ip_address TEXT
    );
    CREATE INDEX idx_chat_messages_id ON chat_messages(id);
    CREATE TABLE banned_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address TEXT NOT NULL UNIQUE,
      reason TEXT,
      banned_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_banned_ips_ip ON banned_ips(ip_address);
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_key TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_visits_created_at ON visits(created_at);
    CREATE INDEX idx_visits_visitor_key ON visits(visitor_key);
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

  const stmtCache = {};
  function stmt(key, sql) {
    if (!stmtCache[key]) stmtCache[key] = db.prepare(sql);
    return stmtCache[key];
  }

  return {
    db,
    stmt,
    
    buildRtspUrl(host, port, urlPath, username, password) {
      const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
      return `rtsp://${auth}${host}:${port}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;
    },
    
    validateRtspUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'rtsp:';
      } catch (_) {
        return false;
      }
    },
    
    ensureAdmin(username, password) {
      const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
      if (existing) return;
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    },
    
    findUserByUsername(username) {
      return stmt('findUserByUsername', 'SELECT * FROM users WHERE username = ?').get(username);
    },
    
    getUser(id) {
      return stmt('getUser', 'SELECT id, username, created_at FROM users WHERE id = ?').get(id);
    },
    
    userExists(id) {
      return !!stmt('userExists', 'SELECT id FROM users WHERE id = ?').get(id);
    },
    
    listUsers() {
      return stmt('listUsers', 'SELECT id, username, created_at FROM users ORDER BY id').all();
    },
    
    countUsers() {
      return stmt('countUsers', 'SELECT COUNT(*) as n FROM users').get().n;
    },
    
    createUser(username, password) {
      const hash = bcrypt.hashSync(password, 10);
      const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
      return r.lastInsertRowid;
    },
    
    updateUserPassword(id, newPassword) {
      const hash = bcrypt.hashSync(newPassword, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    },
    
    deleteUser(id) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },
    
    verifyPassword(password, hash) {
      return bcrypt.compareSync(password, hash);
    },
    
    listCameras() {
      return stmt('listCameras', 'SELECT * FROM cameras ORDER BY id').all();
    },
    
    getCamera(id) {
      return stmt('getCamera', 'SELECT * FROM cameras WHERE id = ?').get(id);
    },
    
    createCamera(display_name, host, port, urlPath, username, password, ffmpegOptionsJson = '{}', onvifPort = 8899, onvifUsername = '', onvifPassword = '') {
      const rtsp_url = this.buildRtspUrl(host, port, urlPath, username, password);
      if (!this.validateRtspUrl(rtsp_url)) {
        throw new Error('Invalid RTSP URL — only rtsp:// URLs are allowed');
      }
      const opts = typeof ffmpegOptionsJson === 'string' ? ffmpegOptionsJson : JSON.stringify(ffmpegOptionsJson || {});
      const r = db.prepare(
        "INSERT INTO cameras (display_name, rtsp_url, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password, onvif_port, onvif_username, onvif_password, ffmpeg_options, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
      ).run(display_name, rtsp_url, host, port, urlPath, username, password, onvifPort || 8899, onvifUsername || '', onvifPassword || '', opts);
      return r.lastInsertRowid;
    },
    
    updateCamera(id, display_name, host, port, urlPath, username, password, ffmpegOptionsJson = null, onvifPort = null, onvifUsername = null, onvifPassword = null) {
      const rtsp_url = this.buildRtspUrl(host, port, urlPath, username, password);
      if (!this.validateRtspUrl(rtsp_url)) {
        throw new Error('Invalid RTSP URL — only rtsp:// URLs are allowed');
      }
      const cam = this.getCamera(id);
      const finalOnvifPort = onvifPort !== null ? onvifPort : (cam.onvif_port || 8899);
      const finalOnvifUsername = onvifUsername !== null ? onvifUsername : (cam.onvif_username || '');
      const finalOnvifPassword = onvifPassword !== null ? onvifPassword : (cam.onvif_password || '');
      
      if (ffmpegOptionsJson !== null && ffmpegOptionsJson !== undefined) {
        const opts = typeof ffmpegOptionsJson === 'string' ? ffmpegOptionsJson : JSON.stringify(ffmpegOptionsJson || {});
        db.prepare(
          "UPDATE cameras SET display_name = ?, rtsp_url = ?, rtsp_host = ?, rtsp_port = ?, rtsp_path = ?, rtsp_username = ?, rtsp_password = ?, onvif_port = ?, onvif_username = ?, onvif_password = ?, ffmpeg_options = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(display_name, rtsp_url, host, port, urlPath, username, password, finalOnvifPort, finalOnvifUsername, finalOnvifPassword, opts, id);
      } else {
        db.prepare(
          "UPDATE cameras SET display_name = ?, rtsp_url = ?, rtsp_host = ?, rtsp_port = ?, rtsp_path = ?, rtsp_username = ?, rtsp_password = ?, onvif_port = ?, onvif_username = ?, onvif_password = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(display_name, rtsp_url, host, port, urlPath, username, password, finalOnvifPort, finalOnvifUsername, finalOnvifPassword, id);
      }
    },
    
    getOnvifCredentials(camera) {
      if (!camera) return { username: '', password: '', port: 8899 };
      return {
        username: camera.onvif_username || camera.rtsp_username || 'admin',
        password: camera.onvif_password || camera.rtsp_password || '',
        port: camera.onvif_port || 8899,
      };
    },
    
    deleteCamera(id) {
      db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    },
    
    getSetting(key) {
      const row = stmt('getSetting', 'SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : '';
    },
    
    setSetting(key, value) {
      stmt('setSetting', 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    },
    
    getAllSettings() {
      const rows = stmt('getAllSettings', 'SELECT key, value FROM settings').all();
      const result = {};
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    },
    
    addChatMessage(nickname, text, time, ipAddress = null) {
      const result = stmt('addChatMessage', 'INSERT INTO chat_messages (nickname, text, time, ip_address) VALUES (?, ?, ?, ?)').run(nickname, text, time, ipAddress);
      return result.lastInsertRowid;
    },
    
    getChatMessages(limit = 50) {
      return stmt('getChatMessages', 'SELECT id, nickname, text, time, ip_address FROM chat_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
    },
    
    deleteChatMessage(id) {
      return stmt('deleteChatMessage', 'DELETE FROM chat_messages WHERE id = ?').run(id);
    },
    
    deleteChatMessages(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`).run(...ids);
    },
    
    clearAllChatMessages() {
      return db.prepare('DELETE FROM chat_messages').run();
    },
    
    addBan(ipAddress, reason = null, bannedBy = null) {
      try {
        stmt('addBan', 'INSERT OR REPLACE INTO banned_ips (ip_address, reason, banned_by) VALUES (?, ?, ?)').run(ipAddress, reason, bannedBy);
        return true;
      } catch (_) {
        return false;
      }
    },
    
    removeBan(ipAddress) {
      return stmt('removeBan', 'DELETE FROM banned_ips WHERE ip_address = ?').run(ipAddress);
    },
    
    isIpBanned(ipAddress) {
      const row = stmt('isIpBanned', 'SELECT 1 FROM banned_ips WHERE ip_address = ?').get(ipAddress);
      return !!row;
    },
    
    listBans() {
      return stmt('listBans', 'SELECT * FROM banned_ips ORDER BY created_at DESC').all();
    },
    
    getSnapshot(id) {
      return stmt('getSnapshot', "SELECT * FROM snapshots WHERE id = ?").get(id);
    },
    
    addSnapshot(filename, nickname, cameraName) {
      stmt('addSnapshot', "INSERT INTO snapshots (filename, nickname, camera_name) VALUES (?, ?, ?)").run(filename, nickname, cameraName || '');
    },
    
    getLatestSnapshots(limit = 3) {
      return stmt('getLatestSnapshots', "SELECT * FROM snapshots ORDER BY id DESC LIMIT ?").all(limit);
    },
    
    getAllSnapshots(limit = 50) {
      return stmt('getAllSnapshots', "SELECT * FROM snapshots ORDER BY id DESC LIMIT ?").all(limit);
    },
    
    deleteSnapshot(id) {
      return stmt('deleteSnapshot', "DELETE FROM snapshots WHERE id = ?").run(id);
    },
    
    deleteSnapshots(ids) {
      if (!ids || !ids.length) return;
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`).run(...ids);
    },
    
    setSnapshotStarred(id, starred) {
      if (starred) {
        db.prepare("UPDATE snapshots SET starred = 0").run();
        db.prepare("UPDATE snapshots SET starred = 1 WHERE id = ?").run(id);
      } else {
        db.prepare("UPDATE snapshots SET starred = 0 WHERE id = ?").run(id);
      }
    },
    
    getStarredSnapshot() {
      return stmt('getStarredSnapshot', "SELECT * FROM snapshots WHERE starred = 1 LIMIT 1").get();
    },
    
    addMotionIncident(cameraId, startedAtIso, filePath) {
      const r = stmt('addMotionIncident',
        'INSERT INTO motion_incidents (camera_id, started_at, file_path) VALUES (?, ?, ?)'
      ).run(cameraId, startedAtIso, filePath);
      return r.lastInsertRowid;
    },
    
    updateMotionIncidentLastMotion(id, lastMotionAtIso) {
      stmt('updateMotionIncidentLastMotion', 'UPDATE motion_incidents SET last_motion_at = ? WHERE id = ?').run(lastMotionAtIso, id);
    },
    
    endMotionIncident(id, endedAtIso, sizeBytes) {
      stmt('endMotionIncident',
        'UPDATE motion_incidents SET ended_at = ?, size_bytes = ? WHERE id = ?'
      ).run(endedAtIso, sizeBytes || 0, id);
    },
    
    setMotionIncidentStar(id, starred) {
      stmt('setMotionIncidentStar',
        'UPDATE motion_incidents SET starred = ? WHERE id = ?'
      ).run(starred ? 1 : 0, id);
      const row = stmt('getMotionIncidentStar', 'SELECT id, starred FROM motion_incidents WHERE id = ?').get(id);
      return row || null;
    },
    
    getMotionIncident(id) {
      return stmt('getMotionIncident', 'SELECT * FROM motion_incidents WHERE id = ?').get(id);
    },
    
    getUnstarredMotionIncidentTotals() {
      const row = stmt('getUnstarredMotionIncidentTotals', `
        SELECT
          COUNT(*) as n,
          COALESCE(SUM(size_bytes), 0) as bytes
        FROM motion_incidents
        WHERE ended_at IS NOT NULL AND starred = 0
      `).get();
      return { count: row.n, bytes: row.bytes };
    },
    
    getOldestUnstarredMotionIncidents(limit = 1) {
      return stmt('getOldestUnstarredMotionIncidents', `
        SELECT id, file_path, size_bytes
        FROM motion_incidents
        WHERE ended_at IS NOT NULL AND starred = 0
        ORDER BY started_at ASC
        LIMIT ?
      `).all(limit);
    },
    
    deleteMotionIncident(id) {
      stmt('deleteMotionIncident', 'DELETE FROM motion_incidents WHERE id = ?').run(id);
    },
    
    deleteMotionIncidents(ids) {
      if (!ids || !ids.length) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM motion_incidents WHERE id IN (${placeholders})`).run(...ids);
    },
    
    listRecentMotionIncidents(limit = 30) {
      return stmt('listRecentMotionIncidents', `
        SELECT
          mi.*,
          c.display_name as camera_name
        FROM motion_incidents mi
        LEFT JOIN cameras c ON c.id = mi.camera_id
        ORDER BY mi.started_at DESC
        LIMIT ?
      `).all(limit);
    },
    
    listMotionIncidentsForDate(cameraId, yyyymmdd) {
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
    },
    
    recordVisit(visitorKey) {
      if (!visitorKey || String(visitorKey).length > 128) return;
      stmt('recordVisit', "INSERT INTO visits (visitor_key, created_at) VALUES (?, datetime('now'))").run(String(visitorKey));
    },
    
    getVisitorStats() {
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
    },
    
    clearVisitorHistory() {
      db.prepare('DELETE FROM visits').run();
    },
    
    addAuditLog(userId, username, action, details, ipAddress, requestId) {
      stmt('addAuditLog',
        'INSERT INTO audit_log (user_id, username, action, details, ip_address, request_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userId, username, action, details || null, ipAddress || null, requestId || null);
    },
    
    getAuditLogs(limit = 100) {
      return stmt('getAuditLogs', 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    },
    
    clearMotionRecordings() {
      const rows = db.prepare('SELECT file_path FROM motion_incidents').all();
      db.prepare('DELETE FROM motion_incidents').run();
      return rows.map(r => r.file_path).filter(Boolean);
    },
    
    getMotionVisitStats() {
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
    },
    
    listRecentVisits(limit = 50) {
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
    },
    
    getLastVisitTime() {
      const row = stmt('getLastVisitTime', `
        SELECT ended_at FROM motion_incidents
        WHERE ended_at IS NOT NULL
        ORDER BY ended_at DESC LIMIT 1
      `).get();
      return row ? row.ended_at : null;
    },
    
    close() {
      db.close();
    }
  };
}

module.exports = { createIsolatedTestDb };
