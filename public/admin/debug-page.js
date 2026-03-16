(function() {
  var logEl = document.getElementById('log-output');
  var camSelect = document.getElementById('cam-select');
  var autoScroll = document.getElementById('auto-scroll');
  var stickyCheck = document.getElementById('sticky-log');
  var clearBtn = document.getElementById('clear-log');
  var polling = null;

  function escLog(s) {
    var el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  function fetchLogs() {
    var cam = camSelect.value;
    var url = cam === 'all' ? '/admin/api/logs' : '/admin/api/logs/' + cam;
    fetch(url).then(function(r) { return r.json(); }).then(function(data) {
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
      logEl.innerHTML = text || 'No log output yet.';
      if (autoScroll.checked) logEl.scrollTop = logEl.scrollHeight;
    }).catch(function() {});
  }

  function startPolling() {
    stopPolling();
    fetchLogs();
    polling = setInterval(fetchLogs, 3000);
  }

  function stopPolling() {
    if (polling) { clearInterval(polling); polling = null; }
  }

  if (camSelect) camSelect.addEventListener('change', fetchLogs);
  if (clearBtn) clearBtn.addEventListener('click', function() { logEl.innerHTML = ''; });
  if (stickyCheck) stickyCheck.addEventListener('change', function() {
    logEl.classList.toggle('debug-log-sticky', stickyCheck.checked);
  });

  startPolling();
})();
