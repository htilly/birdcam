const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

function createTestApp(options = {}) {
  const app = express();
  const testDb = options.db || require('./db').getTestDb();

  app.set('view engine', 'ejs');
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
  app.use(express.static(path.join(__dirname, '../../public')));

  const sessionSecret = options.sessionSecret || crypto.randomBytes(32).toString('hex');
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }));

  app.locals.db = testDb;
  app.locals.sessionSecret = sessionSecret;

  return app;
}

function createAuthenticatedSession(app, userId, username) {
  return new Promise((resolve, reject) => {
    const sessionStore = app.get('sessionStore');
    if (!sessionStore) {
      reject(new Error('No session store configured'));
      return;
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    const sessionData = {
      cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
      userId,
      username,
    };

    sessionStore.set(sessionId, sessionData, (err) => {
      if (err) reject(err);
      else resolve(sessionId);
    });
  });
}

function injectDbModule(testDb) {
  const db = require('../../db');
  const originalGetDb = db.getDb;
  db.getDb = () => testDb;
  return () => { db.getDb = originalGetDb; };
}

function createMockRequest(overrides = {}) {
  return {
    session: overrides.session || {},
    ip: overrides.ip || '127.0.0.1',
    body: overrides.body || {},
    params: overrides.params || {},
    query: overrides.query || {},
    headers: overrides.headers || {},
    get: (header) => overrides.headers?.[header.toLowerCase()],
    path: overrides.path || '/',
    method: overrides.method || 'GET',
    requestId: overrides.requestId || 'test-request-id',
    ...overrides,
  };
}

function createMockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirected: false,
    redirectUrl: null,
  };

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (data) => {
    res.body = data;
    res.headers['content-type'] = 'application/json';
    return res;
  };

  res.send = (data) => {
    res.body = data;
    return res;
  };

  res.redirect = (url) => {
    res.redirected = true;
    res.redirectUrl = url;
    res.statusCode = 302;
    return res;
  };

  res.setHeader = (key, value) => {
    res.headers[key.toLowerCase()] = value;
    return res;
  };

  res.destroy = () => res;

  return res;
}

module.exports = {
  createTestApp,
  createAuthenticatedSession,
  injectDbModule,
  createMockRequest,
  createMockResponse,
};
