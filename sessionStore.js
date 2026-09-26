const session = require('express-session');
const db = require('./db');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * express-session store backed by the app's SQLite database.
 * Replaces the default MemoryStore, which never evicts expired sessions
 * (unbounded memory growth) and loses every login on restart.
 */
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    `);
    this._pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this._pruneTimer.unref();
  }

  _expires(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    if (exp) return new Date(exp).getTime();
    const maxAge = sess && sess.cookie && sess.cookie.originalMaxAge;
    return Date.now() + (maxAge || DEFAULT_TTL_MS);
  }

  get(sid, cb) {
    try {
      const row = db.getDb().prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      db.getDb()
        .prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), this._expires(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      db.getDb().prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this._expires(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      db.getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  clear(cb = () => {}) {
    try {
      db.getDb().prepare('DELETE FROM sessions').run();
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  prune() {
    try {
      db.getDb().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    } catch (err) {
      console.error('[session] Prune failed:', err.message);
    }
  }
}

module.exports = SqliteSessionStore;
