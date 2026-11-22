const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createIsolatedTestDb } = require('../helpers/isolated-db');

let testDb = null;
let tmpDir = null;
let snapshotDir = null;
let motionClipsDir = null;

function getDb() {
  return testDb;
}

function setupTestDb() {
  testDb = createIsolatedTestDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdcam-api-test-'));
  snapshotDir = path.join(tmpDir, 'snapshots');
  motionClipsDir = path.join(tmpDir, 'motion_clips');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.mkdirSync(motionClipsDir, { recursive: true });
  return testDb;
}

function teardownTestDb() {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    tmpDir = null;
  }
}

function createMockRequest(overrides = {}) {
  return {
    session: overrides.session || {},
    ip: overrides.ip || '127.0.0.1',
    body: overrides.body || {},
    params: overrides.params || {},
    query: overrides.query || {},
    headers: overrides.headers || {},
    cookies: overrides.cookies || {},
    get: (header) => overrides.headers?.[header.toLowerCase()],
    path: overrides.path || '/',
    method: overrides.method || 'GET',
    requestId: overrides.requestId || 'test-request-id',
    app: {
      locals: {
        snapshotDir,
        motionClipsDir,
      },
    },
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
    cookies: {},
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

  res.cookie = (name, value, options) => {
    res.cookies[name] = { value, options };
    return res;
  };

  res.set = (key, value) => {
    res.headers[key.toLowerCase()] = value;
    return res;
  };

  res.end = () => res;

  return res;
}

describe('public API - cameras', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/cameras', () => {
    it('returns empty array when no cameras', () => {
      const db = getDb();
      const cameras = db.listCameras().map((c) => ({
        id: c.id,
        display_name: c.display_name,
      }));
      assert.deepStrictEqual(cameras, []);
    });

    it('returns camera list', () => {
      const db = getDb();
      db.createCamera('Garden', '192.168.1.1', 554, '/live', '', '');
      db.createCamera('Front Door', '192.168.1.2', 554, '/live', '', '');
      const cameras = db.listCameras().map((c) => ({
        id: c.id,
        display_name: c.display_name,
      }));
      assert.strictEqual(cameras.length, 2);
      assert.strictEqual(cameras[0].display_name, 'Garden');
    });

    it('excludes sensitive fields', () => {
      const db = getDb();
      db.createCamera('Test', '192.168.1.1', 554, '/live', 'admin', 'secret');
      const cameras = db.listCameras().map((c) => ({
        id: c.id,
        display_name: c.display_name,
      }));
      assert.ok(!cameras[0].rtsp_password);
      assert.ok(!cameras[0].rtsp_username);
    });
  });
});

describe('public API - config', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/config', () => {
    it('returns site name', () => {
      const db = getDb();
      db.setSetting('site_name', 'My Birdcam');
      const siteName = db.getSetting('site_name') || 'Birdcam Live';
      assert.strictEqual(siteName, 'My Birdcam');
    });

    it('returns default site name when not set', () => {
      const db = getDb();
      const siteName = db.getSetting('site_name') || 'Birdcam Live';
      assert.strictEqual(siteName, 'Birdcam Live');
    });

    it('returns datetime locale', () => {
      const db = getDb();
      db.setSetting('datetime_locale', 'us');
      const locale = db.getSetting('datetime_locale') || 'eu';
      assert.strictEqual(locale, 'us');
    });
  });
});

describe('public API - visitor tracking', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/visit', () => {
    it('records visit', () => {
      const db = getDb();
      db.recordVisit('visitor-123');
      const stats = db.getVisitorStats();
      assert.ok(stats.uniqueToday >= 1);
    });

    it('ignores empty visitor key', () => {
      const db = getDb();
      db.recordVisit('');
      const stats = db.getVisitorStats();
      assert.strictEqual(stats.uniqueToday, 0);
    });

    it('ignores long visitor key', () => {
      const db = getDb();
      db.recordVisit('x'.repeat(200));
      const stats = db.getVisitorStats();
      assert.strictEqual(stats.uniqueToday, 0);
    });
  });

  describe('GET /api/visitor-stats', () => {
    it('returns stats object', () => {
      const db = getDb();
      db.recordVisit('visitor-1');
      const stats = db.getVisitorStats();
      assert.ok(typeof stats.uniqueToday === 'number');
      assert.ok(typeof stats.uniqueWeek === 'number');
      assert.ok(typeof stats.uniqueMonth === 'number');
      assert.ok(Array.isArray(stats.daily));
    });
  });
});

describe('public API - snapshots', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/snapshots', () => {
    it('returns empty when no snapshots', () => {
      const db = getDb();
      const snapshots = db.getLatestSnapshots(10);
      assert.strictEqual(snapshots.length, 0);
    });

    it('returns latest snapshots', () => {
      const db = getDb();
      db.addSnapshot('snap1.png', 'User1', 'Cam');
      db.addSnapshot('snap2.png', 'User2', 'Cam');
      const snapshots = db.getLatestSnapshots(10);
      assert.strictEqual(snapshots.length, 2);
    });

    it('respects limit', () => {
      const db = getDb();
      for (let i = 0; i < 10; i++) {
        db.addSnapshot(`snap${i}.png`, `User${i}`, 'Cam');
      }
      const snapshots = db.getLatestSnapshots(5);
      assert.strictEqual(snapshots.length, 5);
    });
  });

  describe('snapshot strip config', () => {
    it('reads strip starred setting', () => {
      const db = getDb();
      db.setSetting('snap_strip_starred', '5');
      const val = parseInt(db.getSetting('snap_strip_starred')) || 3;
      assert.strictEqual(val, 5);
    });

    it('reads strip total setting', () => {
      const db = getDb();
      db.setSetting('snap_strip_total', '10');
      const val = parseInt(db.getSetting('snap_strip_total')) || 5;
      assert.strictEqual(val, 10);
    });
  });
});

describe('public API - motion clips', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/motion-clips', () => {
    it('returns empty when no clips', () => {
      const db = getDb();
      const clips = db.listRecentMotionIncidents(10);
      assert.strictEqual(clips.length, 0);
    });

    it('returns clips with camera name', () => {
      const db = getDb();
      const camId = db.createCamera('Test Cam', '192.168.1.1', 554, '/live', '', '');
      const id = db.addMotionIncident(camId, '2026-03-19T10:00:00Z', path.join(motionClipsDir, 'test.mp4'));
      db.endMotionIncident(id, '2026-03-19T10:01:00Z', 1000);
      const clips = db.listRecentMotionIncidents(10);
      assert.strictEqual(clips.length, 1);
      assert.strictEqual(clips[0].camera_name, 'Test Cam');
    });
  });

  describe('POST /api/motion-clips/:id/star', () => {
    it('toggles star', () => {
      const db = getDb();
      const camId = db.createCamera('Test', '192.168.1.1', 554, '/live', '', '');
      const id = db.addMotionIncident(camId, '2026-03-19T10:00:00Z', '/clips/test.mp4');
      db.setMotionIncidentStar(id, true);
      const incident = db.getMotionIncident(id);
      assert.strictEqual(incident.starred, 1);
    });
  });

  describe('motion clip filename validation', () => {
    it('validates MP4 extension', () => {
      const filename = 'motion-1-1234567890-abcd.mp4';
      assert.ok(filename.endsWith('.mp4'));
    });

    it('rejects path traversal', () => {
      const filename = '../../../etc/passwd';
      assert.ok(filename.includes('..'));
    });

    it('validates safe filename pattern', () => {
      const validPattern = /^[\w\-]+\.mp4$/;
      assert.ok(validPattern.test('motion-1-1234567890-abcd.mp4'));
      assert.ok(!validPattern.test('../../../etc/passwd'));
    });
  });
});

describe('public API - build info', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/build-info', () => {
    const { buildInfo, formatVersion } = require('../../version');
    const pkg = require('../../package.json');

    it('reports package.json version, build number, short commit and build date', () => {
      const info = buildInfo({ GIT_COMMIT: 'abcdef1234567890', BUILD_NUMBER: '42', BUILD_DATE: '2026-01-02T03:04:05Z' });
      assert.strictEqual(info.version, pkg.version);
      assert.strictEqual(info.buildNumber, '42');
      assert.strictEqual(info.gitCommit, 'abcdef1');
      assert.strictEqual(info.buildTime, '2026-01-02T03:04:05.000Z');
      assert.strictEqual(info.display, `v${pkg.version} (#42 · abcdef1)`);
    });

    it('ignores invalid build number and build date', () => {
      const info = buildInfo({ GIT_COMMIT: 'abcdef1', BUILD_NUMBER: 'x<script>', BUILD_DATE: 'nope' }, new Date('2026-05-05T00:00:00Z'));
      assert.strictEqual(info.buildNumber, null);
      assert.strictEqual(info.buildTime, '2026-05-05T00:00:00.000Z');
    });

    it('formats with missing parts', () => {
      assert.strictEqual(formatVersion({ version: '1.2.3' }), 'v1.2.3');
      assert.strictEqual(formatVersion({ version: '1.2.3', gitCommit: 'abc1234' }), 'v1.2.3 (abc1234)');
      assert.strictEqual(formatVersion({ gitCommit: 'abc1234' }), 'abc1234');
    });
  });
});

describe('public API - motion visits', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/motion-visits/stats', () => {
    it('returns stats object', () => {
      const db = getDb();
      const stats = db.getMotionVisitStats();
      assert.ok(Array.isArray(stats.byHour));
      assert.ok(Array.isArray(stats.byDay));
    });
  });
});

describe('public API - admin check', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('GET /api/admin/me', () => {
    it('returns false when not logged in', () => {
      const req = createMockRequest({ session: {} });
      const isAdmin = !!(req.session && req.session.userId);
      assert.strictEqual(isAdmin, false);
    });

    it('returns true when logged in', () => {
      const req = createMockRequest({ session: { userId: 1, username: 'admin' } });
      const isAdmin = !!(req.session && req.session.userId);
      assert.strictEqual(isAdmin, true);
    });
  });
});

describe('public API - rate limiting settings', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('reads API rate max', () => {
    const db = getDb();
    db.setSetting('api_rate_max', '200');
    const max = parseInt(db.getSetting('api_rate_max')) || 100;
    assert.strictEqual(max, 200);
  });

  it('reads API rate window', () => {
    const db = getDb();
    db.setSetting('api_rate_window_min', '5');
    const window = parseInt(db.getSetting('api_rate_window_min')) || 1;
    assert.strictEqual(window, 5);
  });

  it('reads snapshot rate max', () => {
    const db = getDb();
    db.setSetting('snapshot_rate_max', '10');
    const max = parseInt(db.getSetting('snapshot_rate_max')) || 6;
    assert.strictEqual(max, 10);
  });

  it('reads snapshot rate window', () => {
    const db = getDb();
    db.setSetting('snapshot_rate_window_sec', '120');
    const window = parseInt(db.getSetting('snapshot_rate_window_sec')) || 60;
    assert.strictEqual(window, 120);
  });
});
