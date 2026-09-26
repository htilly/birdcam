const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_FFMPEG_OPTIONS,
  parseFfmpegOptions,
  buildFfmpegArgs,
  validateCustomFfmpegOptions,
} = require('../../streamManager');

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

  it('handles empty object ffmpeg_options', () => {
    const opts = parseFfmpegOptions({ ffmpeg_options: '{}' });
    assert.strictEqual(opts.rtsp_transport, 'tcp');
    assert.strictEqual(opts.crf, 28);
  });

  it('preserves all default values', () => {
    const opts = parseFfmpegOptions({});
    assert.strictEqual(opts.rtsp_transport, 'tcp');
    assert.strictEqual(opts.use_wallclock_as_timestamps, 1);
    assert.strictEqual(opts.input_fps, 8);
    assert.strictEqual(opts.video_codec, 'libx264');
    assert.strictEqual(opts.preset, 'veryfast');
    assert.strictEqual(opts.tune, 'zerolatency');
    assert.strictEqual(opts.crf, 28);
    assert.strictEqual(opts.hls_time, 2);
    assert.strictEqual(opts.hls_list_size, 6);
  });

  it('overrides nested options', () => {
    const opts = parseFfmpegOptions({
      ffmpeg_options: JSON.stringify({
        video_codec: 'copy',
        audio_codec: 'none',
        hls_time: 1,
      }),
    });
    assert.strictEqual(opts.video_codec, 'copy');
    assert.strictEqual(opts.audio_codec, 'none');
    assert.strictEqual(opts.hls_time, 1);
    assert.strictEqual(opts.preset, 'veryfast');
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

  it('includes an RTSP socket timeout (-timeout on FFmpeg 5+, -stimeout on 4.x)', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {});
    const idx = args.findIndex((a) => a === '-timeout' || a === '-stimeout');
    assert.ok(idx !== -1, 'expected -timeout or -stimeout');
    assert.strictEqual(args[idx + 1], '5000000');
    assert.ok(idx < args.indexOf('-i'), 'timeout must be an input option (before -i)');
  });

  it('includes rtsp_transport option', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {});
    assert.ok(args.includes('-rtsp_transport'));
  });

  it('uses custom rtsp_transport', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { rtsp_transport: 'udp' });
    const idx = args.indexOf('-rtsp_transport');
    assert.strictEqual(args[idx + 1], 'udp');
  });

  it('includes hls_flags', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {});
    assert.ok(args.includes('-hls_flags'));
  });

  it('includes crf when not copy', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { crf: 25 });
    assert.ok(args.includes('-crf'));
    const idx = args.indexOf('-crf');
    assert.strictEqual(args[idx + 1], '25');
  });

  it('excludes crf when video_codec is copy', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { video_codec: 'copy', crf: 25 });
    assert.ok(!args.includes('-crf'));
  });

  it('includes g and keyint_min', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { g: 30, keyint_min: 15 });
    assert.ok(args.includes('-g'));
    assert.ok(args.includes('-keyint_min'));
  });

  it('includes audio codec when specified', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { audio_codec: 'aac' });
    assert.ok(args.includes('-c:a'));
    const idx = args.indexOf('-c:a');
    assert.strictEqual(args[idx + 1], 'aac');
  });

  it('includes audio channels and sample rate', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { 
      audio_codec: 'aac', 
      audio_channels: 2, 
      audio_sample_rate: 48000 
    });
    assert.ok(args.includes('-ac'));
    assert.ok(args.includes('-ar'));
  });

  it('includes extra input args', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { 
      extra_input_args: '-analyzeduration 1M -probesize 1M' 
    });
    assert.ok(args.includes('-analyzeduration'));
    assert.ok(args.includes('-probesize'));
  });

  it('includes extra output args', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { 
      extra_output_args: '-metadata title=test' 
    });
    assert.ok(args.includes('-metadata'));
  });

  it('includes motion frame output when enabled', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {}, true);
    assert.ok(args.includes('-f'));
    assert.ok(args.includes('rawvideo'));
    assert.ok(args.includes('-pix_fmt'));
    assert.ok(args.includes('bgr24'));
    assert.ok(args.includes('pipe:1'));
  });

  it('excludes motion frame output when disabled', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {}, false);
    assert.ok(!args.includes('pipe:1'));
  });

  it('includes scale filter when specified', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { 
      scale_vf: 'scale=1280:720' 
    });
    assert.ok(args.includes('-vf'));
  });

  it('includes color_range when specified', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { color_range: 'tv' });
    assert.ok(args.includes('-color_range'));
  });

  it('includes force_key_frames when specified', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, { 
      force_key_frames: 'expr:gte(t,n_forced*2)' 
    });
    assert.ok(args.includes('-force_key_frames'));
  });

  it('uses correct output path', () => {
    const args = buildFfmpegArgs(rtspUrl, outBase, {});
    const lastIdx = args.length - 1;
    assert.strictEqual(args[lastIdx], `${outBase}.m3u8`);
  });
});

describe('streamManager.DEFAULT_FFMPEG_OPTIONS', () => {
  it('has all expected default keys', () => {
    assert.ok(DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('rtsp_transport'));
    assert.ok(DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('video_codec'));
    assert.ok(DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('preset'));
    assert.ok(DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('crf'));
    assert.ok(DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('hls_time'));
    assert.ok(DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('hls_list_size'));
    assert.ok(DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('audio_codec'));
  });

  it('has sensible default values', () => {
    assert.strictEqual(DEFAULT_FFMPEG_OPTIONS.rtsp_transport, 'tcp');
    assert.strictEqual(DEFAULT_FFMPEG_OPTIONS.video_codec, 'libx264');
    assert.strictEqual(DEFAULT_FFMPEG_OPTIONS.preset, 'veryfast');
    assert.strictEqual(DEFAULT_FFMPEG_OPTIONS.tune, 'zerolatency');
    assert.strictEqual(DEFAULT_FFMPEG_OPTIONS.crf, 28);
    assert.strictEqual(DEFAULT_FFMPEG_OPTIONS.hls_time, 2);
    assert.strictEqual(DEFAULT_FFMPEG_OPTIONS.hls_list_size, 6);
  });

  it('has no http-only reconnect options', () => {
    assert.ok(!DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('reconnect'));
    assert.ok(!DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('reconnect_streamed'));
    assert.ok(!DEFAULT_FFMPEG_OPTIONS.hasOwnProperty('reconnect_delay_max'));
  });
});

describe('streamManager.validateCustomFfmpegOptions', () => {
  it('accepts defaults', () => {
    const r = validateCustomFfmpegOptions(DEFAULT_FFMPEG_OPTIONS);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.scaleVf, DEFAULT_FFMPEG_OPTIONS.scale_vf);
    assert.deepStrictEqual(r.extraInputArgs, []);
    assert.deepStrictEqual(r.extraOutputArgs, []);
  });

  it('accepts allowlisted extra args with safe values', () => {
    const r = validateCustomFfmpegOptions({
      extra_input_args: '-analyzeduration 1M -probesize 1M -err_detect ignore_err',
      extra_output_args: '-maxrate 2M -bufsize 4M -tag:v hvc1 -start_number -1',
    });
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.extraInputArgs, ['-analyzeduration', '1M', '-probesize', '1M', '-err_detect', 'ignore_err']);
    assert.deepStrictEqual(r.extraOutputArgs, ['-maxrate', '2M', '-bufsize', '4M', '-tag:v', 'hvc1', '-start_number', '-1']);
  });

  it('rejects extra output that overwrites a file', () => {
    const r = validateCustomFfmpegOptions({ extra_output_args: '-f data -y /app/public/app.js' });
    assert.ok(r.errors.length > 0);
    assert.deepStrictEqual(r.extraOutputArgs, []);
  });

  it('rejects options not on the allowlist', () => {
    for (const bad of ['-i foo', '-filter_complex movie=x', '-x264-params stats=server.js', '-map 0', '-y']) {
      const r = validateCustomFfmpegOptions({ extra_input_args: bad });
      assert.ok(r.errors.length > 0, bad);
      assert.deepStrictEqual(r.extraInputArgs, [], bad);
    }
  });

  it('rejects bare values and missing values', () => {
    assert.ok(validateCustomFfmpegOptions({ extra_output_args: 'out.mp4' }).errors.length > 0);
    assert.ok(validateCustomFfmpegOptions({ extra_output_args: '-threads' }).errors.length > 0);
  });

  it('rejects values containing path separators or option-like values', () => {
    assert.ok(validateCustomFfmpegOptions({ extra_output_args: '-metadata title=a/b' }).errors.length > 0);
    assert.ok(validateCustomFfmpegOptions({ extra_output_args: '-metadata title=a\\b' }).errors.length > 0);
    const r = validateCustomFfmpegOptions({ extra_output_args: '-threads -y -bufsize 1M' });
    assert.ok(r.errors.length > 0);
    // the valid pair after the invalid one is still recognized
    assert.deepStrictEqual(r.extraOutputArgs, ['-bufsize', '1M']);
  });

  it('accepts simple scale filter chains', () => {
    for (const vf of ['scale=1280:720', 'scale=in_range=full:out_range=tv', 'fps=10,format=yuv420p', 'hflip,vflip', 'transpose=1', 'crop=640:480:0:0']) {
      const r = validateCustomFfmpegOptions({ scale_vf: vf });
      assert.deepStrictEqual(r.errors, [], vf);
      assert.strictEqual(r.scaleVf, vf);
    }
  });

  it('rejects dangerous scale filters', () => {
    for (const vf of ['movie=/etc/passwd', 'amovie=x.wav', 'scale=1:1,movie=a', 'scale=1:1;[in]null', '[in]scale=1:1', 'crop=iw/2:ih', 'drawtext=textfile=x']) {
      const r = validateCustomFfmpegOptions({ scale_vf: vf });
      assert.ok(r.errors.length > 0, vf);
      assert.strictEqual(r.scaleVf, '', vf);
    }
  });
});

describe('streamManager.buildFfmpegArgs custom option sanitizing', () => {
  const rtspUrl = 'rtsp://example.com/stream';
  const outBase = '/tmp/hls/cam1';

  it('drops unsafe extra args and scale filter', (t) => {
    t.mock.method(console, 'warn', () => {});
    const args = buildFfmpegArgs(rtspUrl, outBase, {
      extra_input_args: '-probesize 1M -f data',
      extra_output_args: '-f data -y /app/public/app.js',
      scale_vf: 'movie=/etc/passwd',
    });
    assert.ok(args.includes('-probesize'));
    assert.ok(!args.includes('/app/public/app.js'));
    assert.ok(!args.includes('data'));
    assert.ok(!args.includes('-y'));
    assert.ok(!args.includes('-vf'));
    assert.ok(console.warn.mock.callCount() > 0);
    assert.strictEqual(args[args.length - 1], `${outBase}.m3u8`);
  });
});
