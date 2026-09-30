const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const db = require('../../db');

// Regression guard for the hls_time bug: migrate() used to rewrite stored
// ffmpeg_options (hls_time 2 -> 1, hls_list_size 3 -> 2) on every startup, so a
// value an admin set in the admin UI was silently reverted on the next restart.
//
// One DB for the whole file on purpose: db.js caches prepared statements against
// whichever handle was live when they were first prepared, so swapping the handle
// per-test would leave the cache pointing at a closed database.

let raw;

before(() => {
  raw = new Database(':memory:');
  db._setTestDb(raw);
  db.init(); // creates schema + runs migrate()
});

after(() => {
  db._resetTestDb();
  raw.close();
});

const makeCamera = (opts) =>
  db.createCamera('Cam', '192.168.1.50', 554, '/stream1', 'admin', 'pw', JSON.stringify(opts));

const storedOpts = (id) => JSON.parse(db.getCamera(id).ffmpeg_options);

describe('migrate() and stored per-camera ffmpeg_options', () => {
  it('keeps hls_time: 2 across a restart (the reported bug)', () => {
    const id = makeCamera({ hls_time: 2, video_codec: 'copy' });
    assert.strictEqual(storedOpts(id).hls_time, 2);

    db.migrate(); // simulate a container restart
    assert.strictEqual(storedOpts(id).hls_time, 2, 'hls_time must survive a restart');
  });

  it('keeps hls_time: 2 across many restarts', () => {
    const id = makeCamera({ hls_time: 2 });
    for (let i = 0; i < 5; i++) db.migrate();
    assert.strictEqual(storedOpts(id).hls_time, 2);
  });

  it('keeps hls_list_size: 3 across a restart', () => {
    const id = makeCamera({ hls_list_size: 3 });
    db.migrate();
    assert.strictEqual(storedOpts(id).hls_list_size, 3);
  });

  it('still honours a deliberate low-latency hls_time: 1', () => {
    const id = makeCamera({ hls_time: 1 });
    db.migrate();
    assert.strictEqual(storedOpts(id).hls_time, 1);
  });

  it('leaves every other stored option untouched', () => {
    const opts = {
      hls_time: 2, hls_list_size: 6, video_codec: 'copy',
      preset: 'veryfast', crf: 28, g: 16, input_fps: 8,
    };
    const id = makeCamera(opts);
    db.migrate();
    assert.deepStrictEqual(storedOpts(id), opts);
  });

  it('does not corrupt a camera with empty ffmpeg_options', () => {
    const id = makeCamera({});
    db.migrate();
    assert.deepStrictEqual(storedOpts(id), {});
  });
});
