(function() {
  const webauthnBtn = document.getElementById('chat-webauthn-btn');
  const nicknameInput = document.getElementById('nickname');
  const statusDiv = document.getElementById('chat-webauthn-status');

  if (!window.SimpleWebAuthnBrowser) return;

  const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

  function showStatus(msg, isError = false) {
    if (statusDiv) {
      statusDiv.textContent = msg;
      statusDiv.className = 'chat-webauthn-status' + (isError ? ' error' : '');
      statusDiv.classList.remove('hidden');
      setTimeout(() => statusDiv.classList.add('hidden'), 3000);
    }
  }

  async function doWebAuthn() {
    const nickname = nicknameInput.value.trim();

    if (!nickname) {
      // Try to login with existing key
      try {
        webauthnBtn.disabled = true;
        webauthnBtn.textContent = '...';

        const optionsRes = await fetch('/api/chat/webauthn/login-options');
        if (!optionsRes.ok) throw new Error('Failed to get options');

        const options = await optionsRes.json();
        const authResult = await startAuthentication(options);

        const verifyRes = await fetch('/api/chat/webauthn/login-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(authResult),
        });

        if (!verifyRes.ok) {
          const err = await verifyRes.json().catch(() => ({}));
          throw new Error(err.error || 'Login failed');
        }

        const result = await verifyRes.json();
        if (result.verified && result.nickname) {
          nicknameInput.value = result.nickname;
          localStorage.setItem('birdcam_nickname', result.nickname);
          showStatus('Logged in as ' + result.nickname);
        }
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          showStatus('Cancelled or timed out', true);
        } else {
          showStatus('No key found. Enter a name to register.', true);
        }
      } finally {
        webauthnBtn.disabled = false;
        webauthnBtn.innerHTML = '&#x1F511;';
      }
      return;
    }

    // Register new key
    try {
      webauthnBtn.disabled = true;
      webauthnBtn.textContent = '...';

      const optionsRes = await fetch('/api/chat/webauthn/register-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });

      if (!optionsRes.ok) {
        const err = await optionsRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to get options');
      }

      const options = await optionsRes.json();
      const regResult = await startRegistration(options);

      const verifyRes = await fetch('/api/chat/webauthn/register-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regResult),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || 'Registration failed');
      }

      const result = await verifyRes.json();
      if (result.verified) {
        showStatus('Key registered! Click the key icon to login next time.');
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showStatus('Cancelled or timed out', true);
      } else {
        showStatus(err.message || 'Registration failed', true);
      }
    } finally {
      webauthnBtn.disabled = false;
      webauthnBtn.innerHTML = '&#x1F511;';
    }
  }

  if (webauthnBtn) {
    webauthnBtn.addEventListener('click', doWebAuthn);
  }
})();
