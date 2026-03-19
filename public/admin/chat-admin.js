(function() {
  const selectAll = document.getElementById('select-all');
  const checkboxes = document.querySelectorAll('.msg-select');
  const bulkBtn = document.getElementById('bulk-delete-btn');
  const bulkIds = document.getElementById('bulk-delete-ids');
  const rows = document.querySelectorAll('tr[data-id]');
  const selectUserNickname = document.getElementById('select-user-nickname');
  const selectUserBtn = document.getElementById('select-user-btn');
  const clearSelectionBtn = document.getElementById('clear-selection-btn');
  const selectUserInlineButtons = document.querySelectorAll('.select-user-btn');

  function updateBulkBtn() {
    const selected = Array.from(checkboxes).filter(c => c.checked).map(c => c.value);
    bulkBtn.disabled = selected.length === 0;
    bulkIds.value = selected.join(',');

    if (selectAll) {
      const checkedCount = Array.from(checkboxes).filter(c => c.checked).length;
      selectAll.checked = checkedCount > 0 && checkedCount === checkboxes.length;
      selectAll.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
    }
  }

  function selectMessagesByNickname(nickname) {
    if (!nickname) return;
    rows.forEach((row) => {
      const cb = row.querySelector('.msg-select');
      if (!cb) return;
      cb.checked = row.getAttribute('data-nickname') === nickname;
    });
    updateBulkBtn();
  }

  if (selectAll) {
    selectAll.addEventListener('change', function() {
      checkboxes.forEach(c => c.checked = this.checked);
      updateBulkBtn();
    });
  }

  if (selectUserBtn) {
    selectUserBtn.addEventListener('click', function() {
      selectMessagesByNickname(selectUserNickname.value);
    });
  }

  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener('click', function() {
      checkboxes.forEach(c => c.checked = false);
      updateBulkBtn();
    });
  }

  selectUserInlineButtons.forEach(btn => {
    btn.addEventListener('click', function() {
      const nickname = this.getAttribute('data-nickname');
      if (selectUserNickname) selectUserNickname.value = nickname;
      selectMessagesByNickname(nickname);
    });
  });

  checkboxes.forEach(c => c.addEventListener('change', updateBulkBtn));
})();
