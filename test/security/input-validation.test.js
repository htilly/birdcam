const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createTestDb, closeTestDb } = require('../helpers/db');

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

function sanitizeChatMessage(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .slice(0, 500);
}

function sanitizeNickname(nickname) {
  if (!nickname) return 'Anonymous';
  return String(nickname)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 30);
}

function validateSnapshotFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.includes('..')) return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (!filename.endsWith('.png')) return false;
  const base = filename.split('/').pop();
  return base === filename;
}

function validateClipFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.includes('..')) return false;
  if (!filename.endsWith('.mp4')) return false;
  return true;
}

function validateImageBuffer(buffer, maxSizeBytes = 5 * 1024 * 1024) {
  if (!Buffer.isBuffer(buffer)) return { valid: false, error: 'Not a buffer' };
  if (buffer.length === 0) return { valid: false, error: 'Empty buffer' };
  if (buffer.length > maxSizeBytes) return { valid: false, error: 'File too large' };
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  if (!buffer.subarray(0, 8).equals(pngHeader)) {
    return { valid: false, error: 'Not a PNG image' };
  }
  return { valid: true };
}

describe('security/input-validation', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('RTSP URL validation', () => {
    it('accepts valid rtsp URLs', () => {
      assert.strictEqual(originalDb.validateRtspUrl('rtsp://192.168.1.1:554/stream'), true);
      assert.strictEqual(originalDb.validateRtspUrl('rtsp://camera.local/live'), true);
      assert.strictEqual(originalDb.validateRtspUrl('rtsp://user:pass@host:554/path'), true);
    });

    it('rejects http URLs', () => {
      assert.strictEqual(originalDb.validateRtspUrl('http://192.168.1.1/stream'), false);
      assert.strictEqual(originalDb.validateRtspUrl('https://camera.local/live'), false);
    });

    it('rejects other protocols', () => {
      assert.strictEqual(originalDb.validateRtspUrl('ftp://server/file'), false);
      assert.strictEqual(originalDb.validateRtspUrl('file:///etc/passwd'), false);
      assert.strictEqual(originalDb.validateRtspUrl('javascript:alert(1)'), false);
    });

    it('rejects malformed URLs', () => {
      assert.strictEqual(originalDb.validateRtspUrl(''), false);
      assert.strictEqual(originalDb.validateRtspUrl('not-a-url'), false);
    });

    it('throws on createCamera with empty host', () => {
      assert.throws(() => {
        originalDb.createCamera('Test', '', 554, '/path', '', '');
      }, /Invalid RTSP URL/);
    });
  });

  describe('chat message sanitization', () => {
    it('escapes HTML tags', () => {
      const input = '<script>alert("xss")</script>';
      const output = sanitizeChatMessage(input);
      assert.ok(!output.includes('<script>'));
      assert.ok(output.includes('&lt;script&gt;'));
    });

    it('escapes ampersands', () => {
      const input = 'Test & more';
      const output = sanitizeChatMessage(input);
      assert.strictEqual(output, 'Test &amp; more');
    });

    it('escapes quotes', () => {
      const input = 'He said "hello"';
      const output = sanitizeChatMessage(input);
      assert.ok(output.includes('&quot;'));
    });

    it('truncates long messages', () => {
      const input = 'x'.repeat(1000);
      const output = sanitizeChatMessage(input);
      assert.strictEqual(output.length, 500);
    });

    it('handles empty input', () => {
      assert.strictEqual(sanitizeChatMessage(''), '');
      assert.strictEqual(sanitizeChatMessage(null), '');
    });

    it('preserves normal text', () => {
      const input = 'Just saw a beautiful blue tit!';
      const output = sanitizeChatMessage(input);
      assert.strictEqual(output, input);
    });
  });

  describe('nickname sanitization', () => {
    it('escapes HTML in nicknames', () => {
      const input = '<b>Admin</b>';
      const output = sanitizeNickname(input);
      assert.ok(!output.includes('<b>'));
    });

    it('truncates long nicknames', () => {
      const input = 'a'.repeat(100);
      const output = sanitizeNickname(input);
      assert.strictEqual(output.length, 30);
    });

    it('returns Anonymous for empty input', () => {
      assert.strictEqual(sanitizeNickname(''), 'Anonymous');
      assert.strictEqual(sanitizeNickname(null), 'Anonymous');
    });

    it('preserves normal nicknames', () => {
      const input = 'BirdWatcher';
      const output = sanitizeNickname(input);
      assert.strictEqual(output, input);
    });
  });

  describe('snapshot filename validation', () => {
    it('accepts valid PNG filenames', () => {
      assert.strictEqual(validateSnapshotFilename('snapshot.png'), true);
      assert.strictEqual(validateSnapshotFilename('snap-001.png'), true);
    });

    it('rejects path traversal attempts', () => {
      assert.strictEqual(validateSnapshotFilename('../etc/passwd'), false);
      assert.strictEqual(validateSnapshotFilename('..\\windows\\system'), false);
      assert.strictEqual(validateSnapshotFilename('subdir/../file.png'), false);
    });

    it('rejects non-PNG files', () => {
      assert.strictEqual(validateSnapshotFilename('image.jpg'), false);
      assert.strictEqual(validateSnapshotFilename('file.txt'), false);
    });

    it('rejects paths with slashes', () => {
      assert.strictEqual(validateSnapshotFilename('/tmp/snap.png'), false);
      assert.strictEqual(validateSnapshotFilename('dir/snap.png'), false);
    });

    it('rejects empty or null', () => {
      assert.strictEqual(validateSnapshotFilename(''), false);
      assert.strictEqual(validateSnapshotFilename(null), false);
    });
  });

  describe('clip filename validation', () => {
    it('accepts valid MP4 filenames', () => {
      assert.strictEqual(validateClipFilename('incident-001.mp4'), true);
      assert.strictEqual(validateClipFilename('/clips/2026/03/incident.mp4'), true);
    });

    it('rejects path traversal', () => {
      assert.strictEqual(validateClipFilename('../../../etc/passwd'), false);
      assert.strictEqual(validateClipFilename('..\\..\\windows\\system'), false);
    });

    it('rejects non-MP4 files', () => {
      assert.strictEqual(validateClipFilename('video.avi'), false);
      assert.strictEqual(validateClipFilename('clip.mov'), false);
    });
  });

  describe('image buffer validation', () => {
    it('accepts valid PNG buffer', () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const buffer = Buffer.concat([pngHeader, Buffer.alloc(100)]);
      const result = validateImageBuffer(buffer);
      assert.strictEqual(result.valid, true);
    });

    it('rejects non-PNG buffer', () => {
      const buffer = Buffer.from('GIF89a');
      const result = validateImageBuffer(buffer);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Not a PNG image');
    });

    it('rejects oversized buffer', () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const buffer = Buffer.concat([pngHeader, Buffer.alloc(6 * 1024 * 1024)]);
      const result = validateImageBuffer(buffer, 5 * 1024 * 1024);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'File too large');
    });

    it('rejects empty buffer', () => {
      const result = validateImageBuffer(Buffer.alloc(0));
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Empty buffer');
    });

    it('rejects non-buffer input', () => {
      const result = validateImageBuffer('not a buffer');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Not a buffer');
    });
  });

  describe('SQL injection prevention', () => {
    it('handles quotes in camera name safely', () => {
      const id = originalDb.createCamera("Test'; DROP TABLE cameras;--", '192.168.1.1', 554, '/live', '', '');
      const cam = originalDb.getCamera(id);
      assert.ok(cam);
      assert.strictEqual(cam.display_name, "Test'; DROP TABLE cameras;--");
      
      const cameras = originalDb.listCameras();
      assert.ok(cameras.length > 0);
    });

    it('handles SQL keywords in username safely', () => {
      const uniqueName = `sql_test_${Date.now()}' OR '1'='1`;
      const id = originalDb.createUser(uniqueName, 'password');
      const user = originalDb.findUserByUsername(uniqueName);
      assert.ok(user);
    });

    it('handles special characters in chat messages safely', () => {
      const id = originalDb.addChatMessage("user", "'; DELETE FROM chat_messages; --", '2026-03-19T10:00:00Z');
      const messages = originalDb.getChatMessages(100);
      assert.ok(messages.length > 0);
    });
  });
});
