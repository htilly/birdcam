const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const db = require('../../db');

// Uses the real db.js schema (init + migrate) rather than the test helper schema,
// which does not include the WebAuthn tables.
describe('db WebAuthn credential cleanup', { concurrency: false }, () => {
  let raw;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdcam-webauthn-'));
    raw = new Database(path.join(tmpDir, 'test.db'));
    db._setTestDb(raw);
    for (const key in db._stmtCache) delete db._stmtCache[key];
    db.init();
    db.migrate();
  });

  afterEach(() => {
    db._resetTestDb();
    for (const key in db._stmtCache) delete db._stmtCache[key];
    raw.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function addCredential(id, userId) {
    db.addWebAuthnCredential({
      id,
      user_id: userId,
      public_key: Buffer.from('pk'),
      webauthn_user_id: `wu-${userId}`,
    });
  }

  it('deleteUser removes the user\'s security keys (FK cascade)', () => {
    const keep = db.createUserWithoutPassword('keep');
    const gone = db.createUserWithoutPassword('gone');
    addCredential('cred-keep', keep);
    addCredential('cred-gone', gone);

    db.deleteUser(gone);

    assert.strictEqual(db.getUser(gone), undefined);
    assert.strictEqual(db.getWebAuthnCredentialById('cred-gone'), null);
    assert.ok(db.getWebAuthnCredentialById('cred-keep'));
  });
});
