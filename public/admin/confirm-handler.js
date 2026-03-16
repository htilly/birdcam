document.addEventListener('submit', function(e) {
  var msg = e.target.dataset.confirm;
  if (msg && !confirm(msg)) {
    e.preventDefault();
  }
});
