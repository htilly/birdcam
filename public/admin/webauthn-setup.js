(function() {
  const form = document.getElementById('webauthn-setup-form');
  const statusDiv = document.getElementById('webauthn-setup-status');
  const usernameInput = document.getElementById('setup-user-webauthn');

  if (!form || !window.SimpleWebAuthnBrowser) return;

  const { startRegistration } = window.SimpleWebAuthnBrowser;

  function showStatus(msg, isError = false) {
    if (statusDiv) {
      statusDiv.innerHTML = `<div style="background:${isError ? '#fed7d7;color:#c53030' : '#c6f6d5;color:#276749'}">${msg}</div>`;
      statusDiv.style.display = 'block';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = usernameInput.value.trim();
    if (!username) {
      showStatus('Please enter a username', true);
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span style="opacity:0.7">Registering...</span>';
    showStatus('Preparing registration...');

    try {
      const optionsRes = await fetch(`/admin/webauthn/setup-options?username=${encodeURIComponent(username)}`);
      if (!optionsRes.ok) {
        const err = await optionsRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to get registration options');
      }

      const options = await optionsRes.json();
      showStatus('Please interact with your security key...');

      let regResult;
      try {
        regResult = await startRegistration(options);
      } catch (regErr) {
        if (regErr.name === 'NotAllowedError') {
          throw new Error('Registration cancelled or timed out');
        }
        throw regErr;
      }

      showStatus('Verifying registration...');

      const verifyRes = await fetch('/admin/webauthn/setup-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regResult),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || 'Registration verification failed');
      }

      const verifyResult = await verifyRes.json();
      if (verifyResult.verified) {
        showStatus('Security key registered! Redirecting...');
        setTimeout(() => { window.location.href = '/admin'; }, 1000);
      } else {
        throw new Error('Registration failed');
      }
    } catch (err) {
      console.error('[webauthn] Setup error:', err);
      showStatus(err.message || 'Registration failed', true);
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });
})();
