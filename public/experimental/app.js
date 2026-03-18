/**
 * Birdcam Motion Lab — Experimental Frontend
 *
 * Connects to /motion-ws (relayed through the Node server to motion.py),
 * receives motion events with bounding box data, and renders them as a
 * canvas overlay on the existing HLS stream.
 *
 * Features:
 *  - Canvas bounding boxes with configurable color/opacity
 *  - Bouncing box animation mode
 *  - Motion heatmap accumulation
 *  - Web Push subscribe/unsubscribe
 *  - Motion event log
 *  - FPS counter
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------
  const video        = document.getElementById('video');
  const canvas       = document.getElementById('overlay');
  const ctx          = canvas.getContext('2d');
  const statusDot    = document.getElementById('status-dot');
  const statusText   = document.getElementById('status-text');
  const statusPill   = document.getElementById('status-pill');
  const motionBanner = document.getElementById('motion-banner');
  const eventLog     = document.getElementById('event-log');
  const clearLogBtn  = document.getElementById('clear-log-btn');
  const videoLoading = document.getElementById('video-loading');
  const pushBtn      = document.getElementById('push-btn');
  const pushStatus   = document.getElementById('push-status');

  // Controls
  const toggleBoxes       = document.getElementById('toggle-boxes');
  const toggleBounce      = document.getElementById('toggle-bounce');
  const toggleHeatmap     = document.getElementById('toggle-heatmap');
  const toggleLabels      = document.getElementById('toggle-labels');
  const colorSwatches     = document.getElementById('color-swatches');
  const opacitySlider     = document.getElementById('opacity');
  const opacityVal        = document.getElementById('opacity-val');

  // Stats
  const statEvents  = document.getElementById('stat-events');
  const statRegions = document.getElementById('stat-regions');
  const statFps     = document.getElementById('stat-fps');
  const statLast    = document.getElementById('stat-last');
  const statMotion24h = document.getElementById('stat-motion-24h');
  const statMotion7d  = document.getElementById('stat-motion-7d');

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let ws = null;
  let wsReconnectTimer = null;
  let hlsInstance = null;
  let vapidPublicKey = '';

  let boxColor    = '#00ff88';
  let boxOpacity  = 0.70;
  let showBoxes   = true;
  let showBounce  = false;
  let showHeatmap = false;
  let showLabels  = true;

  // Bouncing animation state per box
  // { id, x, y, w, h, vx, vy, ttl, area }
  let bouncingBoxes = [];
  let animFrameId   = null;

  // Heatmap accumulation canvas (persistent, blended into main canvas)
  const heatCanvas = document.createElement('canvas');
  const heatCtx    = heatCanvas.getContext('2d');

  // Stats tracking
  let eventCount = 0;
  let frameCount = 0;
  let lastFpsTime = performance.now();
  let fpsDisplay  = 0;

  // Rolling motion stats (persisted locally so refresh keeps history)
  //
  // Backend currently streams live motion frames only; we keep a lightweight,
  // bucketed history in the browser to support "last 24h" and "last 7d".
  const MOTION_HISTORY_KEY = 'birdcam_motion_buckets_v1_5m';
  const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
  const WINDOW_7D_MS  = 7 * 24 * 60 * 60 * 1000;
  const BUCKET_MS = 5 * 60 * 1000; // 5 minutes
  const BUCKETS_7D = Math.floor(WINDOW_7D_MS / BUCKET_MS); // expected 2016

  let motionBucketCounts = new Array(BUCKETS_7D).fill(0);
  let motionBucketTimes  = new Array(BUCKETS_7D).fill(0); // bucket start epoch ms
  let persistTimer = null;
  let lastRollingStatsUpdateMs = 0;

  function bucketKeyFromMs(tMs) {
    return Math.floor(tMs / BUCKET_MS) * BUCKET_MS;
  }

  function getBucketIndex(bucketKeyMs) {
    // Ring buffer index for the 7-day window.
    return (Math.floor(bucketKeyMs / BUCKET_MS) % BUCKETS_7D + BUCKETS_7D) % BUCKETS_7D;
  }

  function persistMotionHistory() {
    try {
      localStorage.setItem(
        MOTION_HISTORY_KEY,
        JSON.stringify({ counts: motionBucketCounts, times: motionBucketTimes })
      );
    } catch (_) {
      // Ignore storage/quota errors; rolling stats will still work until refresh.
    }
  }

  function schedulePersistMotionHistory() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistMotionHistory();
    }, 750);
  }

  function loadMotionHistory() {
    try {
      const raw = localStorage.getItem(MOTION_HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.counts) || !Array.isArray(parsed.times)) return;

      // Rehydrate arrays (keep fixed sizes).
      const counts = parsed.counts;
      const times = parsed.times;

      motionBucketCounts = new Array(BUCKETS_7D).fill(0);
      motionBucketTimes  = new Array(BUCKETS_7D).fill(0);

      const nowMs = Date.now();
      const cutoff7d = nowMs - WINDOW_7D_MS;

      for (let i = 0; i < BUCKETS_7D; i++) {
        const bt = Number(times[i]);
        if (!Number.isFinite(bt) || bt < cutoff7d) continue;

        const c = Number(counts[i]);
        if (!Number.isFinite(c) || c <= 0) continue;

        motionBucketTimes[i] = bt;
        motionBucketCounts[i] = Math.floor(c);
      }
    } catch (_) {
      // Start fresh on any parse/storage failure.
      motionBucketCounts = new Array(BUCKETS_7D).fill(0);
      motionBucketTimes  = new Array(BUCKETS_7D).fill(0);
    }
  }

  function recordMotionTimestamp(tMs) {
    const bucketKey = bucketKeyFromMs(tMs);
    const idx = getBucketIndex(bucketKey);

    if (motionBucketTimes[idx] !== bucketKey) {
      // Reuse ring slot for a new bucket key.
      motionBucketTimes[idx] = bucketKey;
      motionBucketCounts[idx] = 0;
    }

    motionBucketCounts[idx] += 1;
  }

  function updateRollingMotionStats(nowMs) {
    if (!statMotion24h || !statMotion7d) return;
    if (nowMs - lastRollingStatsUpdateMs < 1000) return; // throttle UI updates
    lastRollingStatsUpdateMs = nowMs;

    const cutoff7d = nowMs - WINDOW_7D_MS;
    const cutoff24h = nowMs - WINDOW_24H_MS;

    let sum7d = 0;
    let sum24h = 0;

    // Fixed-size scan: 7d history = 2016 buckets @ 5min.
    for (let i = 0; i < BUCKETS_7D; i++) {
      const bt = motionBucketTimes[i];
      if (!bt) continue;

      const c = motionBucketCounts[i] || 0;
      if (bt >= cutoff24h) {
        sum24h += c;
        sum7d += c;
      } else if (bt >= cutoff7d) {
        sum7d += c;
      }
    }

    statMotion24h.textContent = String(sum24h);
    statMotion7d.textContent  = String(sum7d);
  }

  // Motion banner auto-hide timer
  let bannerTimer = null;

  // ---------------------------------------------------------------------------
  // Resize canvas to match video
  // ---------------------------------------------------------------------------
  function syncCanvasSize() {
    const rect = video.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width  = rect.width  || video.videoWidth  || 640;
      canvas.height = rect.height || video.videoHeight || 480;
      heatCanvas.width  = canvas.width;
      heatCanvas.height = canvas.height;
    }
  }

  const resizeObserver = new ResizeObserver(syncCanvasSize);
  resizeObserver.observe(video);
  video.addEventListener('loadedmetadata', syncCanvasSize);

  // ---------------------------------------------------------------------------
  // HLS stream — load first active camera
  // ---------------------------------------------------------------------------
  function loadStream() {
    fetch('/api/cameras')
      .then(r => r.json())
      .then(cameras => {
        if (!cameras || cameras.length === 0) {
          videoLoading.innerHTML = '<p>No cameras configured. Add one in <a href="/admin">Admin</a>.</p>';
          return;
        }
        const cam = cameras[0];
        const src = `/hls/cam-${cam.id}.m3u8`;
        startHls(src);
      })
      .catch(() => {
        videoLoading.innerHTML = '<p>Could not load camera list.</p>';
      });
  }

  function startHls(src) {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 });
      hlsInstance.loadSource(src);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        videoLoading.classList.add('hidden');
      });
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          videoLoading.classList.remove('hidden');
          videoLoading.innerHTML = '<p>Stream unavailable.</p>';
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = src;
      video.addEventListener('loadedmetadata', () => {
        video.play().catch(() => {});
        videoLoading.classList.add('hidden');
      }, { once: true });
    } else {
      videoLoading.innerHTML = '<p>HLS not supported in this browser.</p>';
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection to /motion-ws
  // ---------------------------------------------------------------------------
  function connectWs() {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url   = `${proto}//${location.host}/motion-ws`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      setStatus('connected', 'Backend connected');
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMotionMessage(msg);
    });

    ws.addEventListener('close', () => {
      setStatus('disconnected', 'Reconnecting…');
      wsReconnectTimer = setTimeout(connectWs, 4000);
    });

    ws.addEventListener('error', () => {
      setStatus('disconnected', 'Connection error');
    });
  }

  function sendWs(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------
  function handleMotionMessage(msg) {
    switch (msg.type) {

      case 'motion':
        frameCount++;
        updateFps();
        handleMotionEvent(msg);
        break;

      case 'status':
        if (msg.connected === false) {
          setStatus('disconnected', msg.message || 'Camera offline');
        } else {
          setStatus('connected', msg.message || 'Camera connected');
        }
        break;

      case 'config':
        applyRemoteConfig(msg);
        break;

      case 'backend_connected':
        setStatus('connected', 'Motion backend online');
        break;

      case 'backend_disconnected':
        setStatus('offline', 'Motion detector offline');
        break;

      case 'subscribed':
        pushStatus.textContent = 'Notifications enabled.';
        pushBtn.textContent = 'Disable notifications';
        pushBtn.dataset.state = 'subscribed';
        break;

      case 'unsubscribed':
        pushStatus.textContent = 'Notifications disabled.';
        pushBtn.textContent = 'Enable notifications';
        pushBtn.dataset.state = 'unsubscribed';
        break;

      case 'pong':
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Motion event handling
  // ---------------------------------------------------------------------------
  function handleMotionEvent(msg) {
    const { detected, boxes, frame_w, frame_h, timestamp } = msg;

    // Update regions stat
    statRegions.textContent = boxes ? boxes.length : '0';

    if (detected && boxes && boxes.length > 0) {
      eventCount++;
      statEvents.textContent = eventCount;
      const tMs = Date.parse(timestamp);
      if (Number.isFinite(tMs)) {
        statLast.textContent = formatTime(new Date(tMs));

        recordMotionTimestamp(tMs);
        updateRollingMotionStats(Date.now());
        schedulePersistMotionHistory();
      } else {
        statLast.textContent = '—';
      }

      // Show banner
      showMotionBanner();

      // Log entry
      addLogEntry(boxes, timestamp);

      // Render overlay
      renderOverlay(boxes, frame_w, frame_h);

      // Bounce mode — inject new bouncing boxes
      if (showBounce) {
        spawnBouncingBoxes(boxes, frame_w, frame_h);
      }

      // Heatmap accumulation
      if (showHeatmap) {
        accumulateHeat(boxes, frame_w, frame_h);
      }
    } else {
      // No motion — clear overlay (fade out)
      fadeOverlay();
    }
  }

  // ---------------------------------------------------------------------------
  // Canvas overlay rendering
  // ---------------------------------------------------------------------------
  function renderOverlay(boxes, frameW, frameH) {
    syncCanvasSize();
    if (!showBoxes && !showHeatmap) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw heatmap layer first (under boxes)
    if (showHeatmap) {
      ctx.globalAlpha = 0.4;
      ctx.drawImage(heatCanvas, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1.0;
    }

    if (!showBoxes) return;

    const scaleX = canvas.width  / (frameW || canvas.width);
    const scaleY = canvas.height / (frameH || canvas.height);

    boxes.forEach((box, i) => {
      const x = box.x * scaleX;
      const y = box.y * scaleY;
      const w = box.w * scaleX;
      const h = box.h * scaleY;

      drawBox(ctx, x, y, w, h, i);
    });
  }

  function drawBox(context, x, y, w, h, index) {
    const alpha = boxOpacity;
    const color = boxColor;

    // Filled rect with low opacity
    context.globalAlpha = alpha * 0.15;
    context.fillStyle = color;
    context.fillRect(x, y, w, h);

    // Bright border
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.strokeRect(x, y, w, h);

    // Corner accents (L-shaped corners for a camera HUD look)
    const cs = Math.min(w * 0.2, h * 0.2, 16); // corner size
    context.lineWidth = 3;
    context.globalAlpha = 1.0;
    // Top-left
    context.beginPath(); context.moveTo(x, y + cs); context.lineTo(x, y); context.lineTo(x + cs, y); context.stroke();
    // Top-right
    context.beginPath(); context.moveTo(x + w - cs, y); context.lineTo(x + w, y); context.lineTo(x + w, y + cs); context.stroke();
    // Bottom-left
    context.beginPath(); context.moveTo(x, y + h - cs); context.lineTo(x, y + h); context.lineTo(x + cs, y + h); context.stroke();
    // Bottom-right
    context.beginPath(); context.moveTo(x + w - cs, y + h); context.lineTo(x + w, y + h); context.lineTo(x + w, y + h - cs); context.stroke();

    // Label
    if (showLabels) {
      const label = `#${index + 1}`;
      context.globalAlpha = 0.85;
      context.font = 'bold 11px "SF Mono", monospace';
      const tw = context.measureText(label).width;
      context.fillStyle = color;
      context.fillRect(x, y - 16, tw + 8, 16);
      context.globalAlpha = 1.0;
      context.fillStyle = '#000';
      context.fillText(label, x + 4, y - 4);
    }

    context.globalAlpha = 1.0;
  }

  let fadeTimer = null;
  function fadeOverlay() {
    if (fadeTimer) return;
    fadeTimer = setTimeout(() => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (showHeatmap) {
        ctx.globalAlpha = 0.4;
        ctx.drawImage(heatCanvas, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1.0;
      }
      fadeTimer = null;
    }, 800);
  }

  // ---------------------------------------------------------------------------
  // Bouncing boxes animation
  // ---------------------------------------------------------------------------
  function spawnBouncingBoxes(boxes, frameW, frameH) {
    syncCanvasSize();
    const scaleX = canvas.width  / (frameW || canvas.width);
    const scaleY = canvas.height / (frameH || canvas.height);

    boxes.forEach(box => {
      bouncingBoxes.push({
        x:   box.x * scaleX,
        y:   box.y * scaleY,
        w:   box.w * scaleX,
        h:   box.h * scaleY,
        vx:  (Math.random() * 2 - 1) * 3,
        vy:  (Math.random() * 2 - 1) * 3,
        ttl: 120, // frames
        area: box.area,
      });
    });

    if (!animFrameId) animateBounce();
  }

  function animateBounce() {
    if (!showBounce || bouncingBoxes.length === 0) {
      animFrameId = null;
      return;
    }

    // Don't clear — draw on top of normal overlay
    bouncingBoxes = bouncingBoxes.filter(b => b.ttl > 0);

    bouncingBoxes.forEach(b => {
      b.x += b.vx;
      b.y += b.vy;
      b.ttl--;

      // Bounce off edges
      if (b.x < 0)                      { b.x = 0; b.vx = Math.abs(b.vx); }
      if (b.x + b.w > canvas.width)     { b.x = canvas.width - b.w; b.vx = -Math.abs(b.vx); }
      if (b.y < 0)                       { b.y = 0; b.vy = Math.abs(b.vy); }
      if (b.y + b.h > canvas.height)    { b.y = canvas.height - b.h; b.vy = -Math.abs(b.vy); }

      const alpha = (b.ttl / 120) * 0.7;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
    });

    animFrameId = requestAnimationFrame(animateBounce);
  }

  // ---------------------------------------------------------------------------
  // Heatmap accumulation
  // ---------------------------------------------------------------------------
  function accumulateHeat(boxes, frameW, frameH) {
    const scaleX = canvas.width  / (frameW || canvas.width);
    const scaleY = canvas.height / (frameH || canvas.height);

    // Slowly fade existing heat
    heatCtx.globalAlpha = 0.02;
    heatCtx.fillStyle = '#000';
    heatCtx.fillRect(0, 0, heatCanvas.width, heatCanvas.height);
    heatCtx.globalAlpha = 1.0;

    boxes.forEach(box => {
      const x = box.x * scaleX;
      const y = box.y * scaleY;
      const w = box.w * scaleX;
      const h = box.h * scaleY;

      // Radial gradient for heat glow
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r  = Math.max(w, h) / 2;
      const grad = heatCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0,   'rgba(255, 60, 0, 0.6)');
      grad.addColorStop(0.5, 'rgba(255, 160, 0, 0.3)');
      grad.addColorStop(1,   'rgba(255, 220, 0, 0)');

      heatCtx.globalCompositeOperation = 'lighter';
      heatCtx.fillStyle = grad;
      heatCtx.fillRect(x, y, w, h);
      heatCtx.globalCompositeOperation = 'source-over';
    });
  }

  // ---------------------------------------------------------------------------
  // Motion banner
  // ---------------------------------------------------------------------------
  function showMotionBanner() {
    motionBanner.classList.remove('hidden');
    motionBanner.classList.add('active');
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      motionBanner.classList.remove('active');
      setTimeout(() => motionBanner.classList.add('hidden'), 400);
    }, 2500);
  }

  // ---------------------------------------------------------------------------
  // Event log
  // ---------------------------------------------------------------------------
  function addLogEntry(boxes, timestamp) {
    const empty = eventLog.querySelector('.event-empty');
    if (empty) empty.remove();

    const li = document.createElement('li');
    li.className = 'event-item new';
    const t = new Date(timestamp);
    li.innerHTML = `
      <span class="event-time">${formatTime(t)}</span>
      <span class="event-desc">${boxes.length} region${boxes.length !== 1 ? 's' : ''}</span>
    `;
    eventLog.prepend(li);

    // Remove 'new' class after animation
    requestAnimationFrame(() => requestAnimationFrame(() => li.classList.remove('new')));

    // Limit log to 50 entries
    const items = eventLog.querySelectorAll('.event-item');
    if (items.length > 50) items[items.length - 1].remove();
  }

  clearLogBtn.addEventListener('click', () => {
    eventLog.innerHTML = '<li class="event-empty">No motion detected yet.</li>';
    eventCount = 0;
    statEvents.textContent = '0';
    statLast.textContent = '—';

    motionBucketCounts = new Array(BUCKETS_7D).fill(0);
    motionBucketTimes  = new Array(BUCKETS_7D).fill(0);
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    lastRollingStatsUpdateMs = 0;
    try { localStorage.removeItem(MOTION_HISTORY_KEY); } catch (_) {}
    updateRollingMotionStats(Date.now());
  });

  // ---------------------------------------------------------------------------
  // FPS counter
  // ---------------------------------------------------------------------------
  function updateFps() {
    const now = performance.now();
    const elapsed = now - lastFpsTime;
    if (elapsed >= 2000) {
      fpsDisplay = Math.round((frameCount / elapsed) * 1000);
      statFps.textContent = fpsDisplay;
      frameCount = 0;
      lastFpsTime = now;
    }
  }

  // ---------------------------------------------------------------------------
  // Status indicator
  // ---------------------------------------------------------------------------
  function setStatus(state, text) {
    statusText.textContent = text;
    statusDot.className = 'status-dot ' + state;
    statusPill.className = 'status-pill ' + state;
  }

  // ---------------------------------------------------------------------------
  // Detector config updates (moved to Admin)
  // ---------------------------------------------------------------------------
  function applyRemoteConfig(_) {
    // Intentionally no-op: Detection controls are now only available in Admin.
  }

  // ---------------------------------------------------------------------------
  // Overlay controls
  // ---------------------------------------------------------------------------
  toggleBoxes.addEventListener('change', () => { showBoxes = toggleBoxes.checked; });
  toggleBounce.addEventListener('change', () => {
    showBounce = toggleBounce.checked;
    if (!showBounce) { bouncingBoxes = []; }
  });
  toggleHeatmap.addEventListener('change', () => {
    showHeatmap = toggleHeatmap.checked;
    if (!showHeatmap) { heatCtx.clearRect(0, 0, heatCanvas.width, heatCanvas.height); }
  });
  toggleLabels.addEventListener('change', () => { showLabels = toggleLabels.checked; });

  // Color swatches
  colorSwatches.querySelectorAll('.swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      colorSwatches.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      boxColor = btn.dataset.color;
    });
  });

  // Opacity slider
  opacitySlider.addEventListener('input', () => {
    boxOpacity = parseInt(opacitySlider.value, 10) / 100;
    opacityVal.textContent = opacitySlider.value + '%';
  });

  // ---------------------------------------------------------------------------
  // Web Push
  // ---------------------------------------------------------------------------
  async function initPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      pushBtn.disabled = true;
      pushStatus.textContent = 'Push not supported in this browser.';
      return;
    }

    // Fetch VAPID public key from API
    try {
      const res = await fetch('/api/motion/vapid-public-key');
      if (res.ok) {
        const data = await res.json();
        vapidPublicKey = data.publicKey || '';
      }
    } catch (_) {}

    // Register service worker
    try {
      await navigator.serviceWorker.register('/experimental/sw.js', { scope: '/experimental/' });
    } catch (e) {
      pushStatus.textContent = 'Service worker registration failed.';
      return;
    }

    // Check existing subscription
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      pushBtn.textContent = 'Disable notifications';
      pushBtn.dataset.state = 'subscribed';
      pushStatus.textContent = 'Notifications are enabled.';
    } else if (!vapidPublicKey) {
      // Without a VAPID public key we cannot subscribe (unsubscribe still works if there was an existing sub).
      pushBtn.disabled = true;
      pushBtn.textContent = 'Enable notifications';
      pushBtn.dataset.state = 'unsubscribed';
      pushStatus.textContent = 'Notifications are not available: missing VAPID public key.';
    }

    pushBtn.addEventListener('click', handlePushToggle);
  }

  async function handlePushToggle() {
    const reg = await navigator.serviceWorker.ready;
    const state = pushBtn.dataset.state;

    if (state === 'subscribed') {
      // Unsubscribe
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        sendWs({ type: 'unsubscribe', endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      pushBtn.textContent = 'Enable notifications';
      pushBtn.dataset.state = 'unsubscribed';
      pushStatus.textContent = 'Notifications disabled.';
      return;
    }

    if (!vapidPublicKey) {
      pushBtn.disabled = true;
      pushBtn.textContent = 'Enable notifications';
      pushBtn.dataset.state = 'unsubscribed';
      pushStatus.textContent = 'Notifications are not available: missing VAPID public key.';
      return;
    }

    // Request permission
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      pushStatus.textContent = 'Permission denied.';
      return;
    }

    // Subscribe
    try {
      const appKey = vapidPublicKey
        ? urlBase64ToUint8Array(vapidPublicKey)
        : undefined;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        ...(appKey ? { applicationServerKey: appKey } : {}),
      });

      // Send subscription to backend via WS
      sendWs({ type: 'subscribe', subscription: sub.toJSON() });

    } catch (e) {
      pushStatus.textContent = 'Failed to subscribe: ' + e.message;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  let didInit = false;
  function init() {
    if (didInit) return;
    didInit = true;
    setStatus('connecting', 'Connecting…');
    lastRollingStatsUpdateMs = 0;
    loadMotionHistory();
    updateRollingMotionStats(Date.now());
    loadStream();
    connectWs();
    initPush();
  }

  // Add VAPID key endpoint to Node server — note: if not found we just skip push
  // The endpoint /api/motion/vapid-public-key is added by the Node server bridge.

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

})();
