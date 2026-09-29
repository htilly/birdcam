const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_FFMPEG_OPTIONS,
  parseFfmpegOptions,
  buildFfmpegArgs,
  getMotionFps,
} = require('../streamManager');

describe('streamManager.parseFfmpegOptions', () => {
  it('returns defaults when camera has no ffmpeg_options', () => {
    const opts = parseFfmpegOptions({});
    assert.strictEqual(opts.rtsp_transport, 'tcp');
    assert.strictEqual(opts.video_codec, 'libx264');
    assert.strictEqual(opts.preset, 'veryfast');
  });

  it('returns defaults when ffmpeg_options is null', () => {
    const opts = parseFfmpegOptions({ ffmpeg_options: null });
    assert.strictEqual(opts.rtsp_transport, 'tcp');
  });

  it('merges parsed JSON over defaults', () => {
    const opts = parseFfmpegOptions({
      ffmpeg_options: JSON.stringify({ rtsp_transport: 'udp', crf: 23 }),
    });
    assert.strictEqual(opts.rtsp_transport, 'udp');
    assert.strictEqual(opts.crf, 23);
    assert.strictEqual(opts.preset, 'veryfast');
  });

  it('falls back to defaults on invalid JSON', () => {
    const opts = parseFfmpegOptions({ ffmpeg_options: 'not json' });
    assert.strictEqual(opts.rtsp_transport, 'tcp');
  });
});

describe('streamManager.buildFfmpegArgs', () => {
  const rtspUrl = 'rtsp://192.168.1.1:554/stream1';
  const outBase = '/tmp/hls/cam-1';

  it('includes -i and rtsp URL and output m3u8', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {});
    assert.ok(args.includes('-i'));
    assert.strictEqual(args[args.indexOf('-i') + 1], rtspUrl);
    assert.ok(args.some((a) => a.endsWith('.m3u8')));
  });

  it('uses default video codec libx264 and preset', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {});
    assert.ok(args.includes('-c:v'));
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('-preset'));
    assert.ok(args.includes('veryfast'));
  });

  it('uses -c:v copy when video_codec is copy', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { video_codec: 'copy' });
    const copyIdx = args.indexOf('-c:v');
    assert.ok(copyIdx >= 0);
    assert.strictEqual(args[copyIdx + 1], 'copy');
    assert.ok(!args.includes('ultrafast'));
  });

  it('uses -an when audio_codec is none', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { audio_codec: 'none' });
    assert.ok(args.includes('-an'));
  });

  it('applies custom options', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {
      rtsp_transport: 'udp',
      hls_time: 4,
    });
    assert.ok(args.includes('-rtsp_transport'));
    assert.strictEqual(args[args.indexOf('-rtsp_transport') + 1], 'udp');
    assert.ok(args.includes('-hls_time'));
    assert.strictEqual(args[args.indexOf('-hls_time') + 1], '4');
  });

  it('includes hls_segment_filename with outBase', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {});
    assert.ok(args.includes('-hls_segment_filename'));
    const idx = args.indexOf('-hls_segment_filename');
    assert.ok(args[idx + 1].startsWith(outBase));
    assert.ok(args[idx + 1].includes('%03d.ts'));
  });
});


describe('streamManager.getMotionFps', () => {
  it('matches the camera rate rather than exceeding it', () => {
    assert.strictEqual(getMotionFps({ input_fps: 8 }), 8);
  });

  it('never exceeds the camera rate even when asked to', () => {
    assert.strictEqual(getMotionFps({ input_fps: 8, motion_fps: 25 }), 8);
  });

  it('allows a lower rate than the camera', () => {
    assert.strictEqual(getMotionFps({ input_fps: 8, motion_fps: 4 }), 4);
  });

  it('falls back to the default when input_fps is unknown', () => {
    assert.strictEqual(getMotionFps({}), 10);
    assert.strictEqual(getMotionFps({ input_fps: 0 }), 10);
    assert.strictEqual(getMotionFps({ input_fps: 'nonsense' }), 10);
  });
});

describe('streamManager.buildFfmpegArgs motion frame output', () => {
  const rtspUrl = 'rtsp://192.168.1.1:554/stream1';
  const outBase = '/tmp/hls/cam-1';

  const motionRate = (args) => {
    // the motion output is the trailing rawvideo section ending in pipe:1
    const tail = args.slice(args.lastIndexOf('-f', args.indexOf('pipe:1')));
    return tail[tail.indexOf('-r') + 1];
  };

  it('feeds motion frames at the camera rate, not a padded one', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { input_fps: 8 }, true);
    assert.ok(args.includes('pipe:1'));
    assert.strictEqual(motionRate(args), '8');
  });

  it('still emits 320x180 gray frames', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { input_fps: 8 }, true);
    assert.ok(args.includes('gray'));
    assert.ok(args.includes('320x180'));
  });

  it('omits the motion output entirely when not requested', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { input_fps: 8 }, false);
    assert.ok(!args.includes('pipe:1'));
  });
});
