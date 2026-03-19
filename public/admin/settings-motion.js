(function () {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/motion-ws';
  const ws = new WebSocket(wsUrl);

  const sensitivityEl = document.getElementById('motion-sensitivity');
  const cooldownEl = document.getElementById('motion-cooldown');
  const cooldownValEl = document.getElementById('motion-cooldown-val');
  const applyBtn = document.getElementById('motion-apply');
  const statusEl = document.getElementById('motion-live-status');

  const MIN_AREA_MAP = { 2: 4000, 3: 1500, 4: 600 };
  const thresholdFromSensitivity = (sens) => Number(sens) >= 4 ? 0.001 : 0.005;

  function setCooldownVal(v) {
    const n = Number(v);
    if (Number.isFinite(n)) cooldownValEl.textContent = n + 's';
  }

  function currentConfigPayload() {
    const sens = Number(sensitivityEl.value);
    const cooldownSec = Number(cooldownEl.value);
    return {
      type: 'config_update',
      min_area: MIN_AREA_MAP[sens] || 1500,
      threshold_fraction: thresholdFromSensitivity(sens),
      cooldown_sec: cooldownSec,
    };
  }

  function sendConfigUpdate() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(currentConfigPayload()));
  }

  ws.addEventListener('open', function () {
    if (statusEl) statusEl.textContent = 'Connected to detector';
  });

  ws.addEventListener('message', function (ev) {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (_) {}
    if (!msg) return;

    if (msg.type === 'status') {
      if (msg.warming_up) {
        if (statusEl) statusEl.textContent = msg.message || 'Warming up...';
      } else if (msg.connected === false) {
        if (statusEl) statusEl.textContent = msg.message || 'Offline';
      } else {
        if (statusEl) statusEl.textContent = msg.message || 'Active';
      }
    }
    if (msg.type === 'config') {
      if (msg.cooldown_sec !== undefined && cooldownEl) {
        cooldownEl.value = Number(msg.cooldown_sec);
        setCooldownVal(cooldownEl.value);
      }
      if (msg.min_area !== undefined && sensitivityEl) {
        const minArea = Number(msg.min_area);
        const candidates = Object.keys(MIN_AREA_MAP).map(s => ({
          sens: Number(s),
          dist: Math.abs(MIN_AREA_MAP[s] - minArea),
        }));
        candidates.sort((a, b) => a.dist - b.dist);
        const best = candidates[0] && Number.isFinite(candidates[0].sens) ? candidates[0].sens : Number(sensitivityEl.value);
        if (best) sensitivityEl.value = String(best);
      }
      if (statusEl) statusEl.textContent = 'Detector config applied';
    }
    if (msg.type === 'backend_connected' && statusEl) {
      statusEl.textContent = 'Detector backend online';
    }
  });

  ws.addEventListener('close', function () {
    if (statusEl) statusEl.textContent = 'Detector connection closed (refresh page to reconnect)';
  });

  ws.addEventListener('error', function () {
    if (statusEl) statusEl.textContent = 'Detector connection error';
  });

  if (applyBtn) {
    applyBtn.addEventListener('click', function () {
      if (statusEl) statusEl.textContent = 'Applying…';
      sendConfigUpdate();
    });
  }
  if (cooldownEl) {
    cooldownEl.addEventListener('input', function () { setCooldownVal(this.value); });
  }
})();
