(function() {
  const registerBtn = document.getElementById('register-passkey-btn');
  const statusDiv = document.getElementById('webauthn-register-status');

  if (!registerBtn || !window.SimpleWebAuthnBrowser) return;

  const { startRegistration } = window.SimpleWebAuthnBrowser;

  function showStatus(msg, isError = false) {
    if (statusDiv) {
      statusDiv.innerHTML = `<div class="admin-msg" style="background:${isError ? '#fed7d7;color:#c53030' : '#c6f6d5;color:#276749'}">${msg}</div>`;
      statusDiv.style.display = 'block';
    }
  }

  registerBtn.addEventListener('click', async () => {
    registerBtn.disabled = true;
    registerBtn.innerHTML = '<span style="opacity:0.7">Registering...</span>';
    showStatus('Preparing registration...');

    try {
      const optionsRes = await fetch('/admin/webauthn/register-options');
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

      const verifyRes = await fetch('/admin/webauthn/register-verify', {
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
        showStatus('Security key registered successfully! Reloading...');
        setTimeout(() => window.location.reload(), 1000);
      } else {
        throw new Error('Registration failed');
      }
    } catch (err) {
      console.error('[webauthn] Registration error:', err);
      showStatus(err.message || 'Registration failed', true);
      registerBtn.disabled = false;
      registerBtn.innerHTML = '<span style="margin-right:0.5rem;">&#x1F511;</span> Register new Security Key';
    }
  });
})();
