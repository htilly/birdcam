(function() {
  const form = document.getElementById('webauthn-login-form');
  const errorDiv = document.getElementById('webauthn-error');
  const usernameInput = document.getElementById('webauthn-username');

  if (!form || !window.SimpleWebAuthnBrowser) return;

  const { startAuthentication } = window.SimpleWebAuthnBrowser;

  function showError(msg) {
    if (errorDiv) {
      errorDiv.textContent = msg;
      errorDiv.style.display = 'block';
    }
  }

  function hideError() {
    if (errorDiv) {
      errorDiv.style.display = 'none';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const username = usernameInput.value.trim();
    if (!username) {
      showError('Please enter your username');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span style="opacity:0.7">Authenticating...</span>';

    try {
      const optionsRes = await fetch('/admin/webauthn/login-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });

      if (!optionsRes.ok) {
        const err = await optionsRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to get authentication options');
      }

      const options = await optionsRes.json();

      let authResult;
      try {
        authResult = await startAuthentication(options);
      } catch (authErr) {
        if (authErr.name === 'NotAllowedError') {
          throw new Error('Authentication cancelled or timed out');
        }
        throw authErr;
      }

      const verifyRes = await fetch('/admin/webauthn/login-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authResult),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || 'Authentication verification failed');
      }

      const verifyResult = await verifyRes.json();
      if (verifyResult.verified) {
        window.location.href = '/admin';
      } else {
        throw new Error('Authentication failed');
      }
    } catch (err) {
      console.error('[webauthn] Login error:', err);
      showError(err.message || 'Authentication failed');
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });
})();
