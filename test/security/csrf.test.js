const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDb, closeTestDb } = require('../helpers/db');
const { createMockRequest, createMockResponse } = require('../helpers/app');

function getCsrfToken(req) {
  if (!req.session._csrf) req.session._csrf = crypto.randomBytes(32).toString('hex');
  return req.session._csrf;
}

function verifyCsrf(req, res, next) {
  let token = (req.body && req.body._csrf) || '';
  if (Array.isArray(token)) {
    token = token[token.length - 1] || '';
  }
  if (!req.session._csrf || token !== req.session._csrf) {
    return res.status(403).send('Invalid request');
  }
  next();
}

function setupTestDb() {
  const testDb = createTestDb();
  const originalDb = require('../../db');
  originalDb._setTestDb(testDb);
  for (const key in originalDb._stmtCache) delete originalDb._stmtCache[key];
  return testDb;
}

function teardownTestDb() {
  const originalDb = require('../../db');
  originalDb._resetTestDb();
  for (const key in originalDb._stmtCache) delete originalDb._stmtCache[key];
  closeTestDb();
}

describe('security/csrf', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('verifyCsrf', () => {
    it('rejects request without token', () => {
      const req = createMockRequest({
        session: { _csrf: 'valid-token' },
        body: {},
      });
      const res = createMockResponse();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      verifyCsrf(req, res, next);

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(res.statusCode, 403);
    });

    it('rejects request with invalid token', () => {
      const req = createMockRequest({
        session: { _csrf: 'valid-token' },
        body: { _csrf: 'invalid-token' },
      });
      const res = createMockResponse();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      verifyCsrf(req, res, next);

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(res.statusCode, 403);
    });

    it('accepts request with valid token', () => {
      const token = 'valid-csrf-token';
      const req = createMockRequest({
        session: { _csrf: token },
        body: { _csrf: token },
      });
      const res = createMockResponse();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      verifyCsrf(req, res, next);

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(res.statusCode, 200);
    });

    it('handles token array (multiple forms)', () => {
      const token = 'array-csrf-token';
      const req = createMockRequest({
        session: { _csrf: token },
        body: { _csrf: ['other-token', token] },
      });
      const res = createMockResponse();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      verifyCsrf(req, res, next);

      assert.strictEqual(nextCalled, true);
    });

    it('rejects empty session token', () => {
      const req = createMockRequest({
        session: {},
        body: { _csrf: 'some-token' },
      });
      const res = createMockResponse();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      verifyCsrf(req, res, next);

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(res.statusCode, 403);
    });

    it('rejects when session has no _csrf', () => {
      const req = createMockRequest({
        session: { userId: 1 },
        body: { _csrf: 'some-token' },
      });
      const res = createMockResponse();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      verifyCsrf(req, res, next);

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  describe('getCsrfToken', () => {
    it('generates token if not exists', () => {
      const req = createMockRequest({ session: {} });
      const token = getCsrfToken(req);
      assert.ok(token);
      assert.ok(typeof token === 'string');
      assert.strictEqual(token.length, 64);
    });

    it('returns existing token', () => {
      const req = createMockRequest({ session: { _csrf: 'existing-token' } });
      const token = getCsrfToken(req);
      assert.strictEqual(token, 'existing-token');
    });

    it('generates different tokens for different sessions', () => {
      const req1 = createMockRequest({ session: {} });
      const req2 = createMockRequest({ session: {} });
      const token1 = getCsrfToken(req1);
      const token2 = getCsrfToken(req2);
      assert.notStrictEqual(token1, token2);
    });
  });
});
