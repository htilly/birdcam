(function() {
  var toggle = document.getElementById('debug-log-toggle');
  var panel = document.getElementById('debug-log-panel');
  var logEl = document.getElementById('debug-log-output');
  var camSelect = document.getElementById('debug-cam-select');
  var autoScroll = document.getElementById('debug-auto-scroll');
  var clearBtn = document.getElementById('debug-clear-log');
  var detachBtn = document.getElementById('debug-detach-log');

  var floatBar = document.getElementById('debug-float-bar');
  var floatLog = document.getElementById('debug-float-log');
  var floatCamSelect = document.getElementById('debug-float-cam-select');
  var floatAutoScroll = document.getElementById('debug-float-auto-scroll');
  var floatClearBtn = document.getElementById('debug-float-clear');
  var attachBtn = document.getElementById('debug-attach-log');

  if (floatCamSelect && camSelect) floatCamSelect.innerHTML = camSelect.innerHTML;

  var polling = null;
  var detached = false;

  function escLog(s) {
    var el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  function renderLogs(data, cam, target, scrollCheck) {
    var text = '';
    if (cam === 'all') {
      for (var id in data) {
        if (data.hasOwnProperty(id) && data[id].length) {
          text += '=== Camera ' + id + ' ===\n';
          text += data[id].map(function(l) { return escLog(l); }).join('\n') + '\n\n';
        }
      }
    } else {
      text = (data.lines || []).map(function(l) { return escLog(l); }).join('\n');
    }
    target.innerHTML = text || 'No log output yet.';
    if (scrollCheck.checked) target.scrollTop = target.scrollHeight;
  }

  function fetchLogs() {
    var cam = detached ? floatCamSelect.value : camSelect.value;
    var url = cam === 'all' ? '/admin/api/logs' : '/admin/api/logs/' + cam;
    fetch(url).then(function(r) { return r.json(); }).then(function(data) {
      if (detached) {
        renderLogs(data, cam, floatLog, floatAutoScroll);
      } else {
        renderLogs(data, cam, logEl, autoScroll);
      }
    }).catch(function() {});
  }

  function startPolling() {
    if (polling) clearInterval(polling);
    fetchLogs();
    polling = setInterval(fetchLogs, 3000);
  }

  function stopPolling() {
    if (polling) { clearInterval(polling); polling = null; }
  }

  if (toggle) toggle.addEventListener('change', function() {
    if (toggle.checked) {
      panel.style.display = '';
      startPolling();
    } else {
      panel.style.display = 'none';
      if (!detached) stopPolling();
    }
  });

  if (detachBtn) detachBtn.addEventListener('click', function() {
    detached = true;
    panel.style.display = 'none';
    floatBar.style.display = '';
    floatCamSelect.value = camSelect.value;
    startPolling();
  });

  if (attachBtn) attachBtn.addEventListener('click', function() {
    detached = false;
    floatBar.style.display = 'none';
    if (toggle.checked) {
      panel.style.display = '';
      camSelect.value = floatCamSelect.value;
      startPolling();
    } else {
      stopPolling();
    }
  });

  if (camSelect) camSelect.addEventListener('change', fetchLogs);
  if (floatCamSelect) floatCamSelect.addEventListener('change', fetchLogs);
  if (clearBtn) clearBtn.addEventListener('click', function() { logEl.innerHTML = ''; });
  if (floatClearBtn) floatClearBtn.addEventListener('click', function() { floatLog.innerHTML = ''; });
})();
