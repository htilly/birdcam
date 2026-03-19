(function() {
  function fmt(n) {
    return n >= 1000000 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function load() {
    fetch('/api/visitor-stats')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('stat-today').textContent = fmt(data.uniqueToday);
        document.getElementById('stat-week').textContent = fmt(data.uniqueWeek);
        document.getElementById('stat-month').textContent = fmt(data.uniqueMonth);

        var daily = data.daily || [];
        var last30 = [];
        var d = new Date();
        for (var i = 29; i >= 0; i--) {
          var day = new Date(d);
          day.setDate(day.getDate() - i);
          var dateStr = day.toISOString().slice(0, 10);
          var row = daily.find(function(r) { return r.date === dateStr; });
          last30.push({ date: dateStr, count: row ? row.count : 0 });
        }

        var labels = last30.map(function(r) {
          var d = new Date(r.date + 'T12:00:00');
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        });
        var counts = last30.map(function(r) { return r.count; });

        var ctx = document.getElementById('visitor-chart').getContext('2d');
        if (window.visitorChart) window.visitorChart.destroy();
        window.visitorChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'Unique visitors',
              data: counts,
              borderColor: 'rgb(74, 222, 128)',
              backgroundColor: 'rgba(74, 222, 128, 0.15)',
              fill: true,
              tension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: { legend: { display: false } },
            scales: {
              y: { beginAtZero: true, ticks: { precision: 0 } }
            }
          }
        });
      })
      .catch(function() {
        document.getElementById('stat-today').textContent = '?';
        document.getElementById('stat-week').textContent = '?';
        document.getElementById('stat-month').textContent = '?';
      });
  }

  function loadBirdStats() {
    fetch('/api/motion-visits/stats')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // Today's bird visits — sum byHour entries where the date part matches today
        var todayStr = new Date().toISOString().slice(0, 10);
        var birdsToday = (data.byHour || []).reduce(function(acc, r) {
          return acc + (r.hour && r.hour.slice(0, 10) === todayStr ? r.count : 0);
        }, 0);
        var birdsWeek = (data.byDay || []).reduce(function(acc, r) {
          return acc + r.count;
        }, 0);

        var todayEl = document.getElementById('stat-birds-today');
        var weekEl  = document.getElementById('stat-birds-week');
        if (todayEl) todayEl.textContent = fmt(birdsToday);
        if (weekEl)  weekEl.textContent  = fmt(birdsWeek);

        // Build 7-day slots
        var daySlots = [];
        var now = new Date();
        for (var i = 6; i >= 0; i--) {
          var d = new Date(now);
          d.setDate(d.getDate() - i);
          var key   = d.toISOString().slice(0, 10);
          var label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          daySlots.push({ key: key, label: label });
        }
        var byDayMap = {};
        (data.byDay || []).forEach(function(r) { byDayMap[r.date] = r.count; });
        var labels = daySlots.map(function(s) { return s.label; });
        var counts = daySlots.map(function(s) { return byDayMap[s.key] || 0; });

        var birdCtx = document.getElementById('bird-visit-chart');
        if (!birdCtx) return;
        if (window.birdVisitChart) window.birdVisitChart.destroy();
        window.birdVisitChart = new Chart(birdCtx.getContext('2d'), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'Bird visits',
              data: counts,
              borderColor: 'rgb(251, 146, 60)',
              backgroundColor: 'rgba(251, 146, 60, 0.15)',
              fill: true,
              tension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 6,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          },
        });
      })
      .catch(function() {
        var todayEl = document.getElementById('stat-birds-today');
        var weekEl  = document.getElementById('stat-birds-week');
        if (todayEl) todayEl.textContent = '?';
        if (weekEl)  weekEl.textContent  = '?';
      });
  }

  load();
  loadBirdStats();

  fetch('/api/build-info').then(function(r) { return r.json(); }).then(function(data) {
    var buildEl = document.getElementById('build-number');
    if (buildEl) {
      // Prefer git commit hash (production) over date version (local dev)
      if (data.gitCommit) {
        buildEl.textContent = 'v' + data.gitCommit;
      } else if (data.buildTime) {
        var d = new Date(data.buildTime);
        d.setHours(d.getHours() + 1);
        var formatted = d.toISOString().slice(0, 10).replace(/-/g, '') +
                        d.toISOString().slice(11, 16).replace(':', '');
        buildEl.textContent = 'v' + formatted;
      }
    }
  }).catch(function() {});
})();
