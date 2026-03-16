(function() {
  var checkboxes = document.querySelectorAll('.snap-admin-check');
  var selectAll = document.getElementById('snap-select-all');
  var bulkBtn = document.getElementById('bulk-delete-btn');
  var countEl = document.getElementById('bulk-count');
  var bulkForm = document.getElementById('bulk-form');

  function updateBulk() {
    var n = document.querySelectorAll('.snap-admin-check:checked').length;
    if (countEl) countEl.textContent = n;
    if (bulkBtn) bulkBtn.disabled = n === 0;
  }

  if (selectAll) {
    selectAll.addEventListener('change', function() {
      checkboxes.forEach(function(c) { c.checked = selectAll.checked; });
      updateBulk();
    });
  }

  checkboxes.forEach(function(c) {
    c.addEventListener('change', function() {
      if (!c.checked && selectAll) selectAll.checked = false;
      updateBulk();
    });
  });

  if (bulkForm) {
    bulkForm.addEventListener('submit', function(e) {
      var n = document.querySelectorAll('.snap-admin-check:checked').length;
      if (n === 0 || !confirm('Delete ' + n + ' snapshot' + (n > 1 ? 's' : '') + '? This cannot be undone.')) {
        e.preventDefault();
      }
    });
  }
})();
