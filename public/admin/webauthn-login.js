(function() {
  const passwordlessBtn = document.getElementById('webauthn-passwordless-btn');
  const errorDiv = document.getElementById('webauthn-error');

  if (!window.SimpleWebAuthnBrowser) return;

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

  async function doPasswordlessLogin() {
    hideError();
    const btn = passwordlessBtn;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span style="opacity:0.7">Authenticating...</span>';

    try {
      const optionsRes = await fetch('/admin/webauthn/passwordless-options');

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
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  if (passwordlessBtn) {
    passwordlessBtn.addEventListener('click', doPasswordlessLogin);
  }
})();
