(function() {
  var btn = document.getElementById('debug-toggle');
  var panel = document.getElementById('debug-panel');
  var open = false;
  var polling = null;

  function escH(s) {
    var el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  function fetchDebug() {
    fetch('/admin/api/debug-info').then(function(r) { return r.json(); }).then(function(info) {
      var html = '<h3>System</h3><table class="admin-table debug-table">';
      html += '<tr><td>Server uptime</td><td>' + escH(info.uptime) + '</td></tr>';
      html += '<tr><td>Node.js</td><td>' + escH(info.nodeVersion) + '</td></tr>';
      html += '<tr><td>Memory (RSS)</td><td>' + escH(info.memoryMB + ' MB') + '</td></tr>';
      html += '</table>';
      html += '<h3>Cameras</h3><table class="admin-table debug-table">';
      html += '<tr><th>ID</th><th>Name</th><th>Status</th><th>Logs</th></tr>';
      for (var i = 0; i < info.cameras.length; i++) {
        var cam = info.cameras[i];
        html += '<tr><td>' + cam.id + '</td><td>' + escH(cam.name) + '</td>';
        html += '<td><span class="status ' + (cam.running ? 'on' : 'off') + '"><span class="status-dot"></span>' + (cam.running ? 'Live' : 'Off') + '</span></td>';
        html += '<td>' + cam.logLines + '</td></tr>';
        if (cam.streamInfo && cam.streamInfo.length) {
          html += '<tr><td colspan="4"><pre style="margin:0.25rem 0 0.5rem;font-size:0.75rem;background:#1a202c;color:#68d391;padding:0.5rem;border-radius:6px;white-space:pre-wrap;word-break:break-all">' + cam.streamInfo.map(function(l) { return escH(l); }).join('\n') + '</pre></td></tr>';
        }
      }
      html += '</table>';
      html += '<p style="margin-top:0.75rem;"><a href="/admin/debug" class="btn btn-small">View FFmpeg Logs</a></p>';
      panel.innerHTML = html;
    }).catch(function() { panel.innerHTML = '<p>Failed to load debug info.</p>'; });
  }

  btn.addEventListener('click', function() {
    open = !open;
    panel.style.display = open ? 'block' : 'none';
    btn.textContent = open ? '\u{1F41B} Hide Debug' : '\u{1F41B} Debug';
    if (open) {
      fetchDebug();
      polling = setInterval(fetchDebug, 5000);
    } else if (polling) {
      clearInterval(polling);
      polling = null;
    }
  });
})();
