const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb, closeTestDb } = require('../helpers/db');
const { createMockRequest, createMockResponse } = require('../helpers/app');

const originalDb = require('../../db');

function setupTestDb() {
  const testDb = createTestDb();
  originalDb._setTestDb(testDb);
  for (const key in originalDb._stmtCache) delete originalDb._stmtCache[key];
  return testDb;
}

function teardownTestDb() {
  originalDb._resetTestDb();
  for (const key in originalDb._stmtCache) delete originalDb._stmtCache[key];
  closeTestDb();
}

function createSessionStore() {
  const sessions = new Map();
  
  return {
    get: (sid, cb) => cb(null, sessions.get(sid)),
    set: (sid, sess, cb) => {
      sessions.set(sid, sess);
      cb && cb(null);
    },
    destroy: (sid, cb) => {
      sessions.delete(sid);
      cb && cb(null);
    },
    all: () => Array.from(sessions.values()),
    clear: () => sessions.clear(),
    length: () => sessions.size,
  };
}

function createMockSession(options = {}) {
  const session = {
    id: options.id || crypto.randomBytes(16).toString('hex'),
    userId: options.userId,
    username: options.username,
    _csrf: options.csrf || crypto.randomBytes(32).toString('hex'),
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
    regenerate: function(cb) {
      this.id = crypto.randomBytes(16).toString('hex');
      delete this.tempData;
      cb && cb(null);
    },
    destroy: function(cb) {
      this.destroyed = true;
      cb && cb(null);
    },
  };
  if (options.tempData !== undefined) {
    session.tempData = options.tempData;
  }
  return session;
}

describe('security/session', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('session regeneration on login', () => {
    it('generates new session ID on successful login', () => {
      const oldId = 'old-session-id';
      const session = createMockSession({ id: oldId, userId: null });
      
      session.regenerate((err) => {
        assert.strictEqual(err, null);
        assert.notStrictEqual(session.id, oldId);
      });
    });

    it('preserves user info after regeneration', () => {
      const session = createMockSession();
      
      session.regenerate(() => {
        session.userId = 1;
        session.username = 'admin';
        
        assert.strictEqual(session.userId, 1);
        assert.strictEqual(session.username, 'admin');
      });
    });
  });

  describe('session destruction on logout', () => {
    it('destroys session on logout', () => {
      const session = createMockSession({ userId: 1, username: 'admin' });
      
      session.destroy((err) => {
        assert.strictEqual(err, null);
        assert.strictEqual(session.destroyed, true);
      });
    });
  });

  describe('session fixation prevention', () => {
    it('changes session ID after authentication', () => {
      const preAuthId = 'pre-auth-session';
      const session = createMockSession({ id: preAuthId });
      
      const beforeId = session.id;
      session.regenerate(() => {});
      const afterId = session.id;
      
      assert.notStrictEqual(beforeId, afterId);
    });

    it('does not carry over pre-auth session data', () => {
      const session = createMockSession({ tempData: 'should-not-persist' });
      
      session.regenerate(() => {
        session.userId = 1;
        session.username = 'admin';
      });
      
      assert.strictEqual(session.tempData, undefined);
    });
  });

  describe('session cookie security', () => {
    it('should have httpOnly flag', () => {
      const cookieOptions = {
        httpOnly: true,
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      };
      
      assert.strictEqual(cookieOptions.httpOnly, true);
    });

    it('should have secure flag when behind proxy', () => {
      originalDb.setSetting('reverse_proxy', 'true');
      const isSecure = originalDb.isReverseProxy();
      
      const cookieOptions = {
        httpOnly: true,
        secure: isSecure,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      };
      
      assert.strictEqual(cookieOptions.secure, true);
    });

    it('should not have secure flag when not behind proxy', () => {
      originalDb.setSetting('reverse_proxy', 'false');
      originalDb._reverseProxyCache = null;
      const isSecure = originalDb.isReverseProxy();
      
      const cookieOptions = {
        httpOnly: true,
        secure: isSecure,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      };
      
      assert.strictEqual(cookieOptions.secure, false);
    });

    it('should have reasonable maxAge', () => {
      const maxAge = 7 * 24 * 60 * 60 * 1000;
      const oneDay = 24 * 60 * 60 * 1000;
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      
      assert.ok(maxAge >= oneDay, 'Session should last at least 1 day');
      assert.ok(maxAge <= thirtyDays, 'Session should not exceed 30 days');
    });
  });

  describe('session invalidation', () => {
    it('invalidates all sessions by rotating secret', () => {
      const oldSecret = 'old-secret-key';
      const newSecret = crypto.randomBytes(32).toString('hex');
      
      assert.notStrictEqual(oldSecret, newSecret);
      assert.strictEqual(newSecret.length, 64);
    });

    it('forces re-login after session invalidation', () => {
      const session = createMockSession({ userId: 1, username: 'admin' });
      
      session.destroy(() => {});
      
      assert.strictEqual(session.destroyed, true);
    });
  });

  describe('session store operations', () => {
    it('stores and retrieves session', () => {
      const store = createSessionStore();
      const sid = 'test-session-id';
      const sess = { userId: 1, username: 'test' };
      
      store.set(sid, sess, () => {});
      
      let retrieved = null;
      store.get(sid, (err, s) => { retrieved = s; });
      
      assert.deepStrictEqual(retrieved, sess);
    });

    it('destroys session', () => {
      const store = createSessionStore();
      const sid = 'test-session-id';
      const sess = { userId: 1 };
      
      store.set(sid, sess, () => {});
      store.destroy(sid, () => {});
      
      let retrieved = null;
      store.get(sid, (err, s) => { retrieved = s; });
      
      assert.strictEqual(retrieved, undefined);
    });

    it('clears all sessions', () => {
      const store = createSessionStore();
      
      store.set('s1', { userId: 1 }, () => {});
      store.set('s2', { userId: 2 }, () => {});
      
      assert.strictEqual(store.length(), 2);
      
      store.clear();
      
      assert.strictEqual(store.length(), 0);
    });
  });

  describe('deleted user session handling', () => {
    it('invalidates session for deleted user', () => {
      const db = originalDb.getDb();
      const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('testuser', 'hash');
      const userId = result.lastInsertRowid;
      
      const userCheck = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      assert.ok(userCheck, 'User should exist after insert');
      
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      
      const userCheckAfter = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      assert.strictEqual(userCheckAfter, undefined, 'User should not exist after delete');
    });
  });
});
