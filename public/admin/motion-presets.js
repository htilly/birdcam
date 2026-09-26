(function() {
  var presets = {
    'very-sensitive': { min_area: 500, threshold: 0.002, blur_kernel: 11, cooldown: 5 },
    'sensitive': { min_area: 1000, threshold: 0.003, blur_kernel: 15, cooldown: 4 },
    'balanced': { min_area: 1500, threshold: 0.005, blur_kernel: 21, cooldown: 3 },
    'less-sensitive': { min_area: 3000, threshold: 0.01, blur_kernel: 31, cooldown: 2 }
  };

  var presetSelect = document.getElementById('motion-preset');
  var minArea = document.getElementById('motion-min-area');
  var threshold = document.getElementById('motion-threshold');
  var blur = document.getElementById('motion-blur');
  var cooldown = document.getElementById('motion-cooldown');

  if (!presetSelect) return;

  function updatePresetFromFields() {
    var vals = {
      min_area: minArea.value ? parseInt(minArea.value) : null,
      threshold: threshold.value ? parseFloat(threshold.value) : null,
      blur_kernel: blur.value ? parseInt(blur.value) : null,
      cooldown: cooldown.value ? parseInt(cooldown.value) : null
    };
    var matched = '';
    for (var name in presets) {
      var p = presets[name];
      if (vals.min_area === p.min_area && vals.threshold === p.threshold && vals.blur_kernel === p.blur_kernel && vals.cooldown === p.cooldown) {
        matched = name;
        break;
      }
    }
    presetSelect.value = matched;
  }

  presetSelect.addEventListener('change', function() {
    var p = presets[this.value];
    if (p) {
      minArea.value = p.min_area;
      threshold.value = p.threshold;
      blur.value = p.blur_kernel;
      cooldown.value = p.cooldown;
    }
  });

  minArea.addEventListener('input', updatePresetFromFields);
  threshold.addEventListener('input', updatePresetFromFields);
  blur.addEventListener('input', updatePresetFromFields);
  cooldown.addEventListener('input', updatePresetFromFields);

  updatePresetFromFields();
})();
