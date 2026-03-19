const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createTestDb, closeTestDb } = require('../../helpers/db');
const { createMockRequest, createMockResponse } = require('../../helpers/app');

const originalDb = require('../../db');
const { auditLog } = require('../../middleware/audit');

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

describe('middleware/audit.auditLog', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('logs audit entry with user info', () => {
    const db = originalDb.getDb();
    const userResult = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('testuser', 'hash');

    const req = createMockRequest({
      session: { userId: userResult.lastInsertRowid, username: 'testuser' },
      method: 'POST',
      path: '/admin/cameras',
      params: { id: '1' },
      body: { display_name: 'Test Camera' },
      ip: '192.168.1.100',
      requestId: 'req-test-123',
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = auditLog('camera.create');
    middleware(req, res, next);

    assert.strictEqual(nextCalled, true);

    const logs = originalDb.getAuditLogs(10);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].user_id, userResult.lastInsertRowid);
    assert.strictEqual(logs[0].username, 'testuser');
    assert.strictEqual(logs[0].action, 'camera.create');
    assert.strictEqual(logs[0].ip_address, '192.168.1.100');
    assert.strictEqual(logs[0].request_id, 'req-test-123');
  });

  it('logs audit entry without user for unauthenticated actions', () => {
    const req = createMockRequest({
      session: {},
      method: 'POST',
      path: '/admin/login',
      params: {},
      body: { username: 'test', password: 'test123' },
      ip: '192.168.1.100',
      requestId: 'req-test-123',
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = auditLog('auth.login.failed');
    middleware(req, res, next);

    assert.strictEqual(nextCalled, true);

    const logs = originalDb.getAuditLogs(10);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].user_id, null);
    assert.strictEqual(logs[0].username, null);
  });

  it('redacts password in login action', () => {
    const req = createMockRequest({
      session: {},
      method: 'POST',
      path: '/admin/login',
      params: {},
      body: { username: 'test', password: 'secret123' },
      ip: '192.168.1.100',
      requestId: 'req-test-123',
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = auditLog('auth.login');
    middleware(req, res, next);

    const logs = originalDb.getAuditLogs(10);
    const details = JSON.parse(logs[0].details);
    assert.strictEqual(details.body, '[REDACTED]');
  });

  it('redacts password in setup action', () => {
    const req = createMockRequest({
      session: {},
      method: 'POST',
      path: '/admin/setup',
      params: {},
      body: { username: 'admin', password: 'newpassword' },
      ip: '192.168.1.100',
      requestId: 'req-test-123',
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = auditLog('auth.setup');
    middleware(req, res, next);

    const logs = originalDb.getAuditLogs(10);
    const details = JSON.parse(logs[0].details);
    assert.strictEqual(details.body, '[REDACTED]');
  });

  it('redacts body for actions containing password', () => {
    const req = createMockRequest({
      session: { userId: 1, username: 'admin' },
      method: 'POST',
      path: '/admin/users/1',
      params: { id: '1' },
      body: { password: 'newpass123' },
      ip: '192.168.1.100',
      requestId: 'req-test-123',
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = auditLog('user.update_password');
    middleware(req, res, next);

    const logs = originalDb.getAuditLogs(10);
    const details = JSON.parse(logs[0].details);
    assert.strictEqual(details.body, '[REDACTED]');
  });

  it('includes request details in log', () => {
    const req = createMockRequest({
      session: { userId: 1, username: 'admin' },
      method: 'DELETE',
      path: '/admin/cameras/5',
      params: { id: '5' },
      body: {},
      ip: '192.168.1.100',
      requestId: 'req-test-123',
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = auditLog('camera.delete');
    middleware(req, res, next);

    const logs = originalDb.getAuditLogs(10);
    const details = JSON.parse(logs[0].details);
    assert.strictEqual(details.method, 'DELETE');
    assert.strictEqual(details.path, '/admin/cameras/5');
    assert.deepStrictEqual(details.params, { id: '5' });
  });

  it('does not block request on audit failure', () => {
    const req = createMockRequest({
      session: { userId: 1, username: 'admin' },
      method: 'POST',
      path: '/test',
      params: {},
      body: {},
      ip: '192.168.1.100',
      requestId: 'req-test-123',
    });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    const middleware = auditLog('test.action');
    
    originalDb.addAuditLog = () => { throw new Error('DB error'); };
    
    middleware(req, res, next);

    assert.strictEqual(nextCalled, true);
  });
});
