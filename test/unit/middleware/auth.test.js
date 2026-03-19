const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createTestDb, closeTestDb } = require('../../helpers/db');
const { createMockRequest, createMockResponse } = require('../../helpers/app');

const originalDb = require('../../db');
const { requireLogin, requireSetup, requireNoSetup } = require('../../middleware/auth');

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

describe('middleware/auth.requireLogin', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('redirects to login when no session', () => {
    const req = createMockRequest({ session: {} });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireLogin(req, res, next);

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.redirected, true);
    assert.strictEqual(res.redirectUrl, '/admin/login');
  });

  it('redirects to login when session has no userId', () => {
    const req = createMockRequest({ session: { username: 'test' } });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireLogin(req, res, next);

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.redirected, true);
    assert.strictEqual(res.redirectUrl, '/admin/login');
  });

  it('calls next when session has valid userId', () => {
    const db = originalDb.getDb();
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('testuser', 'hash');
    
    const req = createMockRequest({ 
      session: { userId: result.lastInsertRowid, username: 'testuser' } 
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireLogin(req, res, next);

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.redirected, false);
  });

  it('invalidates session when user does not exist', () => {
    const req = createMockRequest({ 
      session: { userId: 99999, username: 'deleted' } 
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireLogin(req, res, next);

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.redirected, true);
    assert.strictEqual(res.redirectUrl, '/admin/login?msg=Session+invalid');
  });

  it('destroys session for deleted user', () => {
    const req = createMockRequest({ 
      session: { 
        userId: 99999, 
        username: 'deleted',
        destroy: function() { this.destroyed = true; }
      } 
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireLogin(req, res, next);

    assert.strictEqual(req.session.destroyed, true);
  });
});

describe('middleware/auth.requireSetup', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('calls next when no users exist', () => {
    const req = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireSetup(req, res, next);

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.redirected, false);
  });

  it('redirects to admin when users exist', () => {
    const db = originalDb.getDb();
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', 'hash');

    const req = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireSetup(req, res, next);

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.redirected, true);
    assert.strictEqual(res.redirectUrl, '/admin');
  });
});

describe('middleware/auth.requireNoSetup', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('calls next when users exist', () => {
    const db = originalDb.getDb();
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', 'hash');

    const req = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireNoSetup(req, res, next);

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.redirected, false);
  });

  it('redirects to setup when no users exist', () => {
    const req = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireNoSetup(req, res, next);

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.redirected, true);
    assert.strictEqual(res.redirectUrl, '/admin/setup');
  });
});
