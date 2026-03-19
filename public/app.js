(function () {
  const NICKNAME_KEY = 'birdcam_nickname';
  const LAST_VISIT_KEY = 'birdcam_last_visit';
  const STATS_POLL_INTERVAL = 8000;

  let UI_LOCALE = { locale: undefined, hour12: undefined };

  function parseDbDate(iso) {
    if (!iso) return null;
    if (iso.endsWith('Z') || iso.includes('T')) return new Date(iso);
    return new Date(iso + 'Z');
  }

  function formatDateShort(d) {
    return d.toLocaleDateString(
      UI_LOCALE.locale ? [UI_LOCALE.locale] : [],
      { month: 'short', day: 'numeric' }
    );
  }

  function formatTimeShort(d) {
    return d.toLocaleTimeString(
      UI_LOCALE.locale ? [UI_LOCALE.locale] : [],
      { hour: '2-digit', minute: '2-digit', hour12: UI_LOCALE.hour12 }
    );
  }

  function formatDateTimeFull(d) {
    return d.toLocaleString(
      UI_LOCALE.locale ? [UI_LOCALE.locale] : [],
      { dateStyle: 'medium', timeStyle: 'short', hour12: UI_LOCALE.hour12 }
    );
  }

  // Apply configurable site name + date/time locale
  fetch('/api/config').then(r => r.json()).then(cfg => {
    const name = cfg.siteName || 'Birdcam Live';
    document.title = name;
    const logoText = document.querySelector('.logo');
    if (logoText) {
      // Replace text node (last child) only, keep the <img>
      for (let node of logoText.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          node.textContent = ' ' + name;
          break;
        }
      }
    }
    if (cfg && cfg.locale) {
      UI_LOCALE.locale = cfg.locale;
      UI_LOCALE.hour12 = typeof cfg.hour12 === 'boolean' ? cfg.hour12 : undefined;
    }
  }).catch(() => {});

  // Fetch and display build number
  fetch('/api/build-info').then(r => r.json()).then(data => {
    const buildEl = document.getElementById('build-number');
    if (buildEl) {
      // Prefer git commit hash (production) over date version (local dev)
      if (data.gitCommit) {
        buildEl.textContent = 'v' + data.gitCommit;
      } else if (data.buildTime) {
        const d = new Date(data.buildTime);
        d.setHours(d.getHours() + 1); // Add 1 hour for CET/CEST
        const formatted = d.toISOString().slice(0, 10).replace(/-/g, '') +
                          d.toISOString().slice(11, 16).replace(':', '');
        buildEl.textContent = 'v' + formatted;
      }
    }
  }).catch(() => {});

  const video = document.getElementById('video');
  const videoWrap = document.querySelector('.video-wrap');
  const videoOverlay = document.getElementById('video-overlay');
  const cameraTabs = document.getElementById('camera-tabs');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const nicknameInput = document.getElementById('nickname');
  const chatSend = document.getElementById('chat-send');

  let hls = null;
  let ws = null;
  let cameras = [];
  let selectedCameraId = null;
  let isPlaybackMode = false;
  let playbackCameraId = null;
  let playbackCountdownTimer = null;
  let currentPlayButton = null;

  const livePill = document.getElementById('live-pill');
  const playbackTimestamp = document.getElementById('playback-timestamp');
  const playbackTimestampText = document.getElementById('playback-timestamp-text');
  const playbackEndingOverlay = document.getElementById('playback-ending-overlay');
  const playbackEndingText = document.getElementById('playback-ending-text');

  const motionStatusPill = document.getElementById('motion-status-pill');
  const motionStatusDot = document.getElementById('motion-status-dot');
  const motionStatusText = document.getElementById('motion-status-text');

  function enterPlaybackMode(timestamp, cameraId) {
    isPlaybackMode = true;
    playbackCameraId = cameraId || selectedCameraId;
    if (livePill) {
      livePill.className = 'playback-pill';
      livePill.innerHTML = '<img src="playback.png" alt=""> Playback';
    }
    if (videoWrap) {
      videoWrap.classList.add('playback-mode');
    }
    if (playbackTimestamp && playbackTimestampText) {
      playbackTimestampText.textContent = timestamp;
      playbackTimestamp.classList.remove('hidden');
    }
    if (playbackEndingOverlay) {
      playbackEndingOverlay.classList.add('hidden');
    }
  }

  function exitPlaybackMode() {
    isPlaybackMode = false;
    if (playbackCountdownTimer) {
      clearInterval(playbackCountdownTimer);
      playbackCountdownTimer = null;
    }
    if (videoWrap) {
      videoWrap.classList.remove('playback-mode');
    }
    if (livePill) {
      livePill.className = 'live-pill';
      livePill.innerHTML = 'Live';
    }
    if (playbackTimestamp) {
      playbackTimestamp.classList.add('hidden');
    }
    if (playbackEndingOverlay) {
      playbackEndingOverlay.classList.add('hidden');
    }
    video.onended = null;
    if (currentPlayButton) {
      restorePlayButton(currentPlayButton);
      currentPlayButton = null;
    }
  }

  function setPlayButtonState(btn, label, disabled) {
    if (!btn) return;

    const isRecChip = btn.classList && btn.classList.contains('rec-chip');
    if (!isRecChip) {
      btn.textContent = label;
      btn.disabled = !!disabled;
      return;
    }

    btn.disabled = !!disabled;
    btn.classList.add('rec-chip--state-active');

    let stateEl = btn.querySelector('.rec-chip-state');
    if (!stateEl) {
      stateEl = document.createElement('span');
      stateEl.className = 'rec-chip-state';
      btn.appendChild(stateEl);
    }
    stateEl.textContent = label;
  }

  function restorePlayButton(btn) {
    if (!btn) return;

    const isRecChip = btn.classList && btn.classList.contains('rec-chip');
    if (!isRecChip) {
      btn.textContent = '▶ Play';
      btn.disabled = false;
      return;
    }

    btn.disabled = false;
    btn.classList.remove('rec-chip--state-active');
    const stateEl = btn.querySelector('.rec-chip-state');
    if (stateEl) stateEl.remove();
  }

  function handlePlaybackEnd() {
    if (!isPlaybackMode) return;
    if (playbackEndingOverlay && playbackEndingText) {
      playbackEndingOverlay.classList.remove('hidden');
      let countdown = 5;
      playbackEndingText.textContent = `Returning to live in ${countdown}...`;
      playbackCountdownTimer = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
          clearInterval(playbackCountdownTimer);
          playbackCountdownTimer = null;
          exitPlaybackMode();
          if (playbackCameraId) {
            selectCamera(playbackCameraId);
          }
        } else {
          playbackEndingText.textContent = `Returning to live in ${countdown}...`;
        }
      }, 1000);
    } else {
      exitPlaybackMode();
      if (playbackCameraId) {
        selectCamera(playbackCameraId);
      }
    }
  }

  function loadCameras() {
    fetch('/api/cameras')
      .then((r) => r.json())
      .then((list) => {
        cameras = list;
        renderTabs();
        if (recCamera) populateRecCameras();
        if (cameras.length && !selectedCameraId) selectCamera(cameras[0].id);
        if (!cameras.length) {
          selectedCameraId = null;
          destroyHls();
          videoOverlay.classList.remove('hidden');
          videoOverlay.querySelector('p').textContent = 'No cameras yet. Add one in Admin.';
        }
      })
      .catch(() => {
        cameras = [];
        renderTabs();
      });
  }

  function renderTabs() {
    cameraTabs.innerHTML = '';
    cameraTabs.style.display = cameras.length > 1 ? '' : 'none';
    cameras.forEach((cam) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.role = 'tab';
      tab.setAttribute('data-cam-id', cam.id);
      tab.setAttribute('aria-selected', selectedCameraId === cam.id ? 'true' : 'false');
      tab.textContent = cam.display_name;
      tab.addEventListener('click', () => selectCamera(cam.id));
      cameraTabs.appendChild(tab);
    });
  }

  function selectCamera(id) {
    exitPlaybackMode();
    selectedCameraId = id;
    cameraTabs.querySelectorAll('[role="tab"]').forEach((tab) => {
      tab.setAttribute('aria-selected', tab.getAttribute('data-cam-id') === String(id) ? 'true' : 'false');
    });

    const src = `/hls/cam-${id}.m3u8`;
    if (Hls.isSupported()) {
      destroyHls();
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        maxBufferLength: 4,
        maxMaxBufferLength: 8,
      });
      hls.attachMedia(video);
      let manifestRetries = 0;
      const maxManifestRetries = 5;
      function tryLoadSource() {
        hls.loadSource(src);
      }
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        manifestRetries = 0;
        videoOverlay.classList.add('hidden');
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          const code = data.response?.code;
          const isManifestNotReady = (code === 404 || code === 503) && data.type === Hls.ErrorTypes.NETWORK_ERROR;
          if (isManifestNotReady && manifestRetries < maxManifestRetries) {
            manifestRetries += 1;
            setTimeout(tryLoadSource, 3000);
            return;
          }
          videoOverlay.classList.remove('hidden');
          videoOverlay.querySelector('p').textContent = 'Stream not available. Try another camera.';
        }
      });
      tryLoadSource();
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      videoOverlay.classList.add('hidden');
    } else {
      videoOverlay.classList.remove('hidden');
      videoOverlay.querySelector('p').textContent = 'HLS not supported in this browser.';
    }
    renderTabs();
  }

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.src = '';
  }

  loadCameras();
  setInterval(loadCameras, 15000);

  // Record visit for admin stats (cookie-based unique visitors)
  fetch('/api/visit', { credentials: 'include' }).catch(function () {});

  const seenMsgKeys = new Set();
  function msgKey(m) { return m.nickname + '|' + m.time + '|' + m.text; }

  function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/ws');
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'history' && Array.isArray(data.messages)) {
          data.messages.forEach((m) => {
            const k = msgKey(m);
            if (!seenMsgKeys.has(k)) { seenMsgKeys.add(k); appendMessage(m); }
          });
        } else if (data.type === 'message' && data.nickname && data.text) {
          const k = msgKey(data);
          if (!seenMsgKeys.has(k)) { seenMsgKeys.add(k); appendMessage(data); }
        } else if (data.type === 'error' && data.text) {
          const oldPlaceholder = chatInput.placeholder;
          chatInput.placeholder = data.text;
          setTimeout(() => {
            chatInput.placeholder = oldPlaceholder || 'Type a message...';
          }, 3000);
        } else if (data.type === 'stats') {
          updateStatsFromPayload(data);
        } else if (data.type === 'snapshots') {
          renderSnapshots(data);
        } else if (data.type === 'delete_messages' && Array.isArray(data.ids)) {
          // Remove deleted messages from chat
          data.ids.forEach(id => {
            const el = chatMessages.querySelector(`[data-msg-id="${id}"]`);
            if (el) el.remove();
          });
        } else if (data.type === 'clear_chat') {
          // Clear all messages
          chatMessages.innerHTML = '';
          seenMsgKeys.clear();
        }
      } catch (_) {}
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }

  // Palette of friendly colors for chat nicknames
  const NICK_COLORS = [
    '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
    '#3498db','#9b59b6','#e91e63','#00bcd4','#8bc34a',
    '#ff5722','#607d8b','#795548','#009688','#673ab7',
  ];

  function nickColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
    return NICK_COLORS[Math.abs(h) % NICK_COLORS.length];
  }

  function myNickname() {
    return (nicknameInput.value || 'Guest').trim() || 'Guest';
  }

  function appendMessage(m) {
    const isMine = m.nickname === myNickname();
    const color = nickColor(m.nickname);
    const initial = m.nickname.charAt(0).toUpperCase();
    const time = m.time
      ? new Date(m.time).toLocaleTimeString(
          UI_LOCALE.locale ? [UI_LOCALE.locale] : [],
          { hour: '2-digit', minute: '2-digit', hour12: UI_LOCALE.hour12 }
        )
      : '';

    const row = document.createElement('div');
    row.className = 'chat-msg-row' + (isMine ? ' chat-msg-row--mine' : '');
    if (m.id) row.setAttribute('data-msg-id', m.id);

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.textContent = initial;
    avatar.style.background = color;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble' + (isMine ? ' chat-bubble--mine' : '');
    if (!isMine) bubble.style.borderColor = color;

    bubble.innerHTML =
      (!isMine ? `<div class="chat-bubble-name" style="color:${color}">${escapeHtml(m.nickname)}</div>` : '') +
      `<div class="chat-bubble-text">${escapeHtml(m.text)}</div>` +
      `<div class="chat-bubble-time">${time}</div>`;

    if (isMine) {
      row.appendChild(bubble);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(bubble);
    }

    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(s) {
    const el = document.createElement('span');
    el.textContent = s == null ? '' : String(s);
    return el.innerHTML;
  }

  // --- Fullscreen button ---
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  fullscreenBtn.addEventListener('click', () => {
    const el = videoWrap;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen(); // Safari/iOS
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS fallback
  });
  // Hide/show button based on fullscreen state
  document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.style.display = document.fullscreenElement ? 'none' : '';
  });
  document.addEventListener('webkitfullscreenchange', () => {
    fullscreenBtn.style.display = document.webkitFullscreenElement ? 'none' : '';
  });

  // --- Emoji picker ---
  const emojiBtn = document.getElementById('emoji-btn');
  const emojiPicker = document.getElementById('emoji-picker');

  const EMOJI_CATEGORIES = [
    { label: '😊 Smileys', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','☺️','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
    { label: '👋 People', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','💋','🫦','👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇','🤦','🤷'] },
    { label: '🐦 Birds & Animals', emojis: ['🐦','🐧','🦆','🦅','🦉','🦚','🦜','🐣','🐥','🐤','🐔','🦃','🦤','🦢','🦩','🕊️','🐓','🦈','🐬','🐳','🐋','🦭','🦦','🦥','🐨','🐼','🦁','🐯','🐻','🦊','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🕷️','🦂','🐢','🦎','🐍','🦕','🦖','🦎','🐸','🐊','🦏','🦛','🐘','🦒','🦓','🦬','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐇','🐁','🐀','🦔','🐾'] },
    { label: '🌸 Nature', emojis: ['🌸','🌺','🌻','🌹','🌷','💐','🌼','🌾','🍀','🌿','☘️','🍃','🍂','🍁','🌱','🌲','🌳','🌴','🌵','🎋','🎍','🍄','🪸','🌊','🌬️','🌀','🌈','⚡','❄️','🔥','💧','🌙','🌛','🌜','🌝','☀️','🌤️','⛅','🌦️','🌧️','⛈️','🌩️','🌨️','🌫️','🌪️','🌈','⭐','🌟','💫','✨','☄️','🪐','🌍','🌎','🌏','🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'] },
    { label: '🍕 Food', emojis: ['🍕','🍔','🍟','🌭','🌮','🌯','🥙','🧆','🥚','🍳','🥘','🍲','🫕','🥗','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🧃','🥤','🧋','🍶','🍾','🍷','🍸','🍹','🍺','🍻','🥂','🥃','🫗','🥤','🧊','🥢','🍽️','🍴','🥄'] },
    { label: '⚽ Sports', emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🥍','🏑','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','🤺','🤾','⛹️','🤻','🏊','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎵','🎶','🎹','🥁','🪘','🎷','🎺','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🕹️'] },
    { label: '✈️ Travel', emojis: ['✈️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚌','🚍','🚎','🚐','🚑','🚒','🚓','🚔','🚕','🚖','🚗','🚘','🚙','🛻','🚚','🚛','🚜','🏎️','🏍️','🛵','🛺','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🏛️','🏗️','🧱','🏘️','🏚️','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋'] },
    { label: '💡 Objects', emojis: ['💡','🔦','🕯️','🪔','🧯','🛢️','💰','💵','💴','💶','💷','💸','💳','🪙','💎','⚖️','🧰','🔧','🪛','🔩','⚙️','🗜️','🔗','⛓️','🧲','🔫','💣','🪃','🏹','🛡️','🔪','🗡️','⚔️','🪚','🔨','🪓','⛏️','🗝️','🔑','🪝','🧲','🪜','🧲','📦','📫','📪','📬','📭','📮','📯','📜','📃','📄','📑','🗒️','🗓️','📆','📅','📇','📈','📉','📊','📋','📌','📍','📎','🖇️','📏','📐','✂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐','🔑','🗝️','🔨','🪓','⛏️','🔧','🔩'] },
    { label: '❤️ Hearts & Symbols', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🔕'] },
  ];

  const emojiPickerEl = document.getElementById('emoji-picker');

  // Build picker UI
  emojiPickerEl.innerHTML = '';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'emoji-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '🔍 Search emoji...';
  searchInput.className = 'emoji-search';
  searchWrap.appendChild(searchInput);
  emojiPickerEl.appendChild(searchWrap);

  const tabBar = document.createElement('div');
  tabBar.className = 'emoji-tab-bar';
  EMOJI_CATEGORIES.forEach((cat, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'emoji-tab' + (i === 0 ? ' active' : '');
    tab.textContent = cat.emojis[0];
    tab.title = cat.label;
    tab.addEventListener('click', () => {
      tabBar.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderCategory(cat.emojis);
      searchInput.value = '';
    });
    tabBar.appendChild(tab);
  });
  emojiPickerEl.appendChild(tabBar);

  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  emojiPickerEl.appendChild(grid);

  function renderCategory(emojis) {
    grid.innerHTML = '';
    emojis.forEach(em => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = em;
      btn.addEventListener('click', () => {
        chatInput.value += em;
        chatInput.focus();
        emojiPickerEl.classList.add('hidden');
      });
      grid.appendChild(btn);
    });
  }

  // Search across all emojis by category name
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { renderCategory(EMOJI_CATEGORIES[0].emojis); return; }
    // Match categories whose label contains the query, collect their emojis
    const results = EMOJI_CATEGORIES
      .filter(c => c.label.toLowerCase().includes(q))
      .flatMap(c => c.emojis);
    // Also include direct emoji character matches (user pasted an emoji)
    const charMatches = EMOJI_CATEGORIES.flatMap(c => c.emojis).filter(em => em.includes(q));
    const combined = [...new Set([...results, ...charMatches])];
    renderCategory(combined.length ? combined : []);
  });

  renderCategory(EMOJI_CATEGORIES[0].emojis);

  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPickerEl.classList.toggle('hidden');
    if (!emojiPickerEl.classList.contains('hidden')) searchInput.focus();
  });
  document.addEventListener('click', () => emojiPickerEl.classList.add('hidden'));
  emojiPickerEl.addEventListener('click', (e) => e.stopPropagation());

  // --- Snapshots ---
  const snapBtn = document.getElementById('snap-btn');
  const snapStrip = document.getElementById('snapshot-strip');
  const snapLightbox = document.getElementById('snap-lightbox');
  const snapLightboxImg = document.getElementById('snap-lightbox-img');
  const snapLightboxCaption = document.getElementById('snap-lightbox-caption');
  const snapLightboxClose = document.getElementById('snap-lightbox-close');
  const snapLightboxStar = document.getElementById('snap-lightbox-star');
  const snapLightboxDelete = document.getElementById('snap-lightbox-delete');
  const snapLightboxBg = snapLightbox.querySelector('.snap-lightbox-bg');
  const starsModal = document.getElementById('stars-modal');
  const starsModalGrid = document.getElementById('stars-modal-grid');
  const starsModalClose = document.getElementById('stars-modal-close');
  const starsModalBg = starsModal.querySelector('.stars-modal-bg');
  let isAdmin = false;
  let lightboxSnap = null;
  let allStarredSnaps = [];
  const adminMePromise = fetch('/api/admin/me').then(r => r.json()).then(d => { isAdmin = !!d.isAdmin; }).catch(() => {});

  // Recent recordings preview strip (last N clips, with stars)
  const recStrip = document.getElementById('rec-strip');

  function makeSnapThumb(s, onClick) {
    const thumb = document.createElement('div');
    thumb.className = 'snap-thumb' + (s.starred ? ' snap-thumb--starred' : '');
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = 'Snapshot by ' + s.nickname;
    if (s.starred) {
      const badge = document.createElement('span');
      badge.className = 'snap-star-badge';
      badge.textContent = '\u2B50';
      thumb.appendChild(badge);
    }
    const cap = document.createElement('div');
    cap.className = 'snap-thumb-caption';
    const d = parseDbDate(s.created_at);
    const dateStr = d ? formatDateShort(d) : '';
    const timeStr = d ? formatTimeShort(d) : '';
    cap.textContent = s.nickname + ' \u00B7 ' + dateStr;
    cap.title = timeStr;
    thumb.appendChild(img);
    thumb.appendChild(cap);
    thumb.addEventListener('click', onClick);
    return thumb;
  }

  function renderSnapshots(data) {
    snapStrip.innerHTML = '';
    const starred = data.starred || [];
    const latest = data.latest || [];
    allStarredSnaps = data.allStarred || [];
    if (!starred.length && !latest.length) return;

    starred.forEach(s => snapStrip.appendChild(makeSnapThumb(s, () => openLightbox(s))));
    latest.forEach(s => snapStrip.appendChild(makeSnapThumb(s, () => openLightbox(s))));

    if (allStarredSnaps.length > 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'snap-all-stars-btn';
      btn.textContent = '\u2B50 All stars';
      btn.addEventListener('click', openStarsModal);
      snapStrip.appendChild(btn);
    }
  }

  function openLightbox(s) {
    lightboxSnap = s;
    snapLightboxImg.src = s.url;
    const d = parseDbDate(s.created_at);
    const t = d ? formatDateTimeFull(d) : '';
    snapLightboxCaption.textContent = '\uD83D\uDCF7 ' + s.nickname + (s.camera_name ? ' \u00B7 ' + s.camera_name : '') + ' \u00B7 ' + t;
    if (isAdmin && s.id) {
      snapLightboxStar.textContent = s.starred ? '\u2605 Unstar' : '\u2B50 Star';
      snapLightboxStar.classList.remove('hidden');
      snapLightboxDelete.classList.remove('hidden');
    } else {
      snapLightboxStar.classList.add('hidden');
      snapLightboxDelete.classList.add('hidden');
    }
    snapLightbox.classList.remove('hidden');
  }

  function closeLightbox() { snapLightbox.classList.add('hidden'); lightboxSnap = null; }
  snapLightboxClose.addEventListener('click', closeLightbox);
  snapLightboxBg.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); closeStarsModal(); } });

  snapLightboxStar.addEventListener('click', () => {
    if (!lightboxSnap || !lightboxSnap.id) return;
    const newStarred = !lightboxSnap.starred;
    fetch(`/api/admin/snapshots/${lightboxSnap.id}/star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: newStarred }),
    }).then(r => r.json()).then(d => {
      if (d.ok) {
        lightboxSnap.starred = d.starred;
        snapLightboxStar.textContent = d.starred ? '\u2605 Unstar' : '\u2B50 Star';
      }
    }).catch(() => {});
  });

  snapLightboxDelete.addEventListener('click', () => {
    if (!lightboxSnap || !lightboxSnap.id) return;
    if (!confirm('Delete this snapshot?')) return;
    fetch(`/api/admin/snapshots/${lightboxSnap.id}/delete`, { method: 'POST' })
      .then(r => r.json()).then(d => { if (d.ok) closeLightbox(); }).catch(() => {});
  });

  function openStarsModal() {
    starsModalGrid.innerHTML = '';
    allStarredSnaps.forEach(s => {
      starsModalGrid.appendChild(makeSnapThumb(s, () => { closeStarsModal(); openLightbox(s); }));
    });
    starsModal.classList.remove('hidden');
  }
  function closeStarsModal() { starsModal.classList.add('hidden'); }
  starsModalClose.addEventListener('click', closeStarsModal);
  starsModalBg.addEventListener('click', closeStarsModal);

  // Load initial snapshots
  fetch('/api/snapshots').then(r => r.json()).then(d => renderSnapshots(d)).catch(() => {});

  // Handle snapshots pushed over WS
  // (hooked into the existing ws.onmessage handler)

  snapBtn.addEventListener('click', () => {
    if (!video.videoWidth) return;
    const nick = myNickname();
    const camName = cameras.find(c => c.id === selectedCameraId)?.display_name || '';

    // Draw frame onto canvas with watermark
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    // Watermark bar at bottom
    const barH = Math.max(28, Math.round(canvas.height * 0.055));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, canvas.height - barH, canvas.width, barH);
    const fontSize = Math.max(12, Math.round(barH * 0.6));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    const timeStr = new Date().toLocaleString(
      UI_LOCALE.locale ? [UI_LOCALE.locale] : [],
      { dateStyle: 'short', timeStyle: 'short', hour12: UI_LOCALE.hour12 }
    );
    ctx.fillText('📷 ' + nick + (camName ? ' · ' + camName : '') + '  ' + timeStr, 10, canvas.height - barH / 2);

    // Flash effect
    snapBtn.classList.add('flash');
    setTimeout(() => snapBtn.classList.remove('flash'), 200);

    const image = canvas.toDataURL('image/png');
    fetch('/api/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, nickname: nick, cameraName: camName }),
    }).then(r => r.json()).then(data => {
      if (data.error) console.warn('Snapshot error:', data.error);
    }).catch(() => {});
  });

  chatSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

  function sendMessage() {
    const text = (chatInput.value || '').trim();
    const nickname = (nicknameInput.value || 'Guest').trim() || 'Guest';
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ nickname, text }));
    chatInput.value = '';
    try {
      localStorage.setItem(NICKNAME_KEY, nickname);
    } catch (_) {}
  }

  try {
    const saved = localStorage.getItem(NICKNAME_KEY);
    if (saved) nicknameInput.value = saved;
  } catch (_) {}

  connectWs();

  // --- Stats strip ---
  const statsStreamsList = document.getElementById('stats-streams-list');
  const statViewersValue = document.getElementById('stat-viewers-value');
  const statMessagesValue = document.getElementById('stat-messages-value');
  const statLastVisitValue = document.getElementById('stat-last-visit-value');
  let statsState = { viewerCount: null, totalChatMessages: null, streams: [] };

  function formatLastVisit(isoString) {
    if (!isoString) return 'First time here?';
    const then = new Date(isoString);
    const now = new Date();
    const sameDay = then.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const wasYesterday = then.toDateString() === yesterday.toDateString();

    const locale = UI_LOCALE.locale || undefined;
    const hour12 = UI_LOCALE.hour12;

    const timeStr = then.toLocaleTimeString(
      locale ? [locale] : [],
      { hour: '2-digit', minute: '2-digit', hour12 }
    );

    if (sameDay) return 'Your last visit: Today at ' + timeStr;
    if (wasYesterday) return 'Your last visit: Yesterday at ' + timeStr;

    // EU: YYYY-MM-DD  HH:MM, US: locale medium date + time
    if (locale === 'sv-SE') {
      const y = then.getFullYear();
      const m = String(then.getMonth() + 1).padStart(2, '0');
      const d = String(then.getDate()).padStart(2, '0');
      return 'Your last visit: ' + `${y}-${m}-${d}` + ' ' + timeStr;
    }

    return 'Your last visit: ' + then.toLocaleDateString(locale || undefined) + ' at ' + timeStr;
  }

  function updateLastVisit() {
    const last = (function () { try { return localStorage.getItem(LAST_VISIT_KEY); } catch (_) { return null; } })();
    statLastVisitValue.textContent = formatLastVisit(last);
    try {
      localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    } catch (_) {}
  }

  function bump(el) {
    if (!el) return;
    el.classList.remove('stat-bump');
    el.offsetHeight;
    el.classList.add('stat-bump');
    setTimeout(function () { el.classList.remove('stat-bump'); }, 400);
  }

  function renderStats() {
    const s = statsState;
    if (s.streams && s.streams.length) {
      statsStreamsList.innerHTML = s.streams.map((st) =>
        st.live
          ? '<span class="stream-pill stream-pill-live">' + escapeHtml(st.display_name) + '</span>'
          : '<span class="stream-pill stream-pill-off">' + escapeHtml(st.display_name) + '</span>'
      ).join(' ');
    } else if (s.streams && s.streams.length === 0) {
      statsStreamsList.textContent = '—';
    }
    if (s.viewerCount !== null) {
      const prev = statViewersValue.textContent;
      statViewersValue.textContent = s.viewerCount;
      if (prev !== '' && prev !== '—' && Number(prev) !== s.viewerCount) bump(statViewersValue);
    }
    if (s.totalChatMessages !== null) {
      const prev = statMessagesValue.textContent;
      statMessagesValue.textContent = s.totalChatMessages;
      if (prev !== '' && prev !== '—' && Number(prev) !== s.totalChatMessages) bump(statMessagesValue);
    }
  }

  function updateStatsFromPayload(data) {
    if (data.viewerCount !== undefined) statsState.viewerCount = data.viewerCount;
    if (data.totalChatMessages !== undefined) statsState.totalChatMessages = data.totalChatMessages;
    renderStats();
  }

  function fetchStats() {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((data) => {
        statsState = {
          viewerCount: data.viewerCount,
          totalChatMessages: data.totalChatMessages,
          streams: data.streams || [],
        };
        renderStats();
      })
      .catch(() => {});
  }

  updateLastVisit();
  fetchStats();
  loadRecentClips();
  setInterval(fetchStats, STATS_POLL_INTERVAL);

  // --- Recordings panel ---
  const recToggle = document.getElementById('rec-toggle');
  const recPanel = document.getElementById('recordings-panel');
  const recDate = document.getElementById('rec-date');
  const recCamera = document.getElementById('rec-camera');
  const recSearch = document.getElementById('rec-search');
  const recList = document.getElementById('rec-list');
  let currentPlaybackKey = null;

  // Default date to today
  if (recDate) recDate.value = new Date().toISOString().slice(0, 10);

  function populateRecCameras() {
    recCamera.innerHTML = cameras.map((c) => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
  }

  if (recToggle) recToggle.addEventListener('click', () => {
    const isOpen = !recPanel.classList.contains('hidden');
    recPanel.classList.toggle('hidden', isOpen);
    recToggle.classList.toggle('active', !isOpen);
    if (!isOpen) populateRecCameras();
  });

  if (recSearch) recSearch.addEventListener('click', () => {
    const camId = recCamera.value;
    const date = recDate.value;
    if (!camId || !date) return;
    recList.innerHTML = '<p class="rec-empty">Searching…</p>';
    fetch(`/api/recordings/${camId}?date=${date}`)
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok && data && data.error) { recList.innerHTML = `<p class="rec-error">${escapeHtml(data.error)}</p>`; return; }
        if (data.error) { recList.innerHTML = `<p class="rec-error">${escapeHtml(data.error)}</p>`; return; }
        if (!data.clips || !data.clips.length) { recList.innerHTML = '<p class="rec-empty">No recordings found for this date.</p>'; return; }
        recList.innerHTML = '';
        data.clips.forEach((clip) => {
          const div = document.createElement('div');
          div.className = 'rec-clip';
          const dur = clip.durationSec >= 60
            ? `${Math.floor(clip.durationSec / 60)}m ${clip.durationSec % 60}s`
            : `${clip.durationSec}s`;
          div.innerHTML = `
            <div class="rec-clip-info">
              <span class="rec-time">${escapeHtml(clip.startTime.slice(11, 19))}</span>
              <span class="rec-dur">${dur}</span>
              <span class="rec-size">${clip.sizeMB} MB</span>
            </div>
            <button class="btn-play-clip" data-start="${escapeHtml(clip.startTime)}" data-end="${escapeHtml(clip.endTime)}" data-cam="${camId}"${clip.filename ? ' data-filename="' + escapeHtml(clip.filename) + '"' : ''}>▶ Play</button>
          `;
          recList.appendChild(div);
        });
        recList.querySelectorAll('.btn-play-clip').forEach((btn) => {
          btn.addEventListener('click', () => playClip(btn.dataset.cam, btn.dataset.start, btn.dataset.end, btn, btn.dataset.filename));
        });
      })
      .catch(() => { recList.innerHTML = '<p class="rec-error">Failed to fetch recordings.</p>'; });
  });

  function playClip(camId, startTime, endTime, btn, filename, timestamp) {
    if (currentPlayButton && currentPlayButton !== btn) {
      restorePlayButton(currentPlayButton);
    }
    currentPlayButton = btn;
    setPlayButtonState(btn, '⏳ Loading…', true);
    if (currentPlaybackKey) {
      fetch(`/api/recordings/stream/${currentPlaybackKey}`, { method: 'DELETE' }).catch(() => {});
      currentPlaybackKey = null;
    }
    const displayTimestamp = timestamp || (startTime ? formatDateTimeFull(parseDbDate(startTime)) : 'Recording');
    if (filename) {
      destroyHls();
      video.src = '/clips/' + encodeURIComponent(filename);
      videoOverlay.classList.add('hidden');
      video.onloadeddata = () => {
        enterPlaybackMode(displayTimestamp, camId);
        setPlayButtonState(btn, '▶ Playing', false);
      };
      video.onerror = () => {
        videoOverlay.classList.remove('hidden');
        videoOverlay.querySelector('p').textContent = 'Playback error.';
        restorePlayButton(btn);
      };
      video.onended = handlePlaybackEnd;
      video.load();
      return;
    }
    fetch(`/api/recordings/${camId}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime, endTime }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setPlayButtonState(btn, '✗ Error', false); return; }
        currentPlaybackKey = data.key;
        destroyHls();
        videoOverlay.classList.add('hidden');
        if (Hls.isSupported()) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            liveSyncDurationCount: 1,
            liveMaxLatencyDurationCount: 3,
            maxBufferLength: 4,
            maxMaxBufferLength: 8,
          });
          hls.loadSource(data.hlsUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            videoOverlay.classList.add('hidden');
            enterPlaybackMode(displayTimestamp, camId);
          });
          hls.on(Hls.Events.ERROR, (_, d) => {
            if (d.fatal) {
              videoOverlay.classList.remove('hidden');
              videoOverlay.querySelector('p').textContent = 'Playback error.';
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = data.hlsUrl;
          enterPlaybackMode(displayTimestamp, camId);
        }
        video.onended = handlePlaybackEnd;
        setPlayButtonState(btn, '▶ Playing', false);
      })
      .catch(() => { setPlayButtonState(btn, '✗ Error', false); });
  }

  // --- Recent recordings strip logic ---
  function renderRecentClips(clips) {
    if (!recStrip) return;
    recStrip.innerHTML = '';
    if (!clips || !clips.length) return;
    clips.slice(0, 10).forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rec-chip';
      const start = parseDbDate(c.started_at);
      const end = parseDbDate(c.ended_at);
      const durSec = start && end ? Math.round((end - start) / 1000) : null;
      const dateStr = start ? formatDateShort(start) : '—';
      const timeStr = start ? formatTimeShort(start) : '';
      const durStr = durSec != null ? `${durSec}s` : '';

      const timeEl = document.createElement('span');
      timeEl.className = 'rec-chip-time';
      timeEl.textContent = dateStr;
      if (timeStr) timeEl.title = timeStr;

      const metaEl = document.createElement('span');
      metaEl.className = 'rec-chip-meta';
      metaEl.textContent = durStr;

      const starEl = document.createElement('span');
      starEl.className = 'rec-chip-star' + (c.starred ? ' rec-chip-star-on' : '');
      starEl.textContent = '★';
      starEl.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleClipStar(c.id, starEl);
      });

      btn.appendChild(timeEl);
      if (durStr) btn.appendChild(metaEl);
      btn.appendChild(starEl);

      btn.addEventListener('click', () => {
        if (!c.filename) return;
        const timestamp = start ? formatDateTimeFull(start) : 'Recording';
        playClip(selectedCameraId, null, null, btn, c.filename, timestamp);
      });

      recStrip.appendChild(btn);
    });
  }

  function loadRecentClips() {
    if (!recStrip) return;
    fetch('/api/motion-clips?limit=10')
      .then((r) => r.json())
      .then((clips) => renderRecentClips(clips))
      .catch(() => {});
  }

  function toggleClipStar(id, starEl) {
    fetch(`/api/motion-clips/${id}/star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data || typeof data.starred === 'undefined') return;
        if (data.starred) {
          starEl.classList.add('rec-chip-star-on');
        } else {
          starEl.classList.remove('rec-chip-star-on');
        }
      })
      .catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Motion status indicator
  // ---------------------------------------------------------------------------
  function setMotionStatus(state, text) {
    if (motionStatusText) motionStatusText.textContent = text;
    if (motionStatusDot) motionStatusDot.className = 'motion-status-dot ' + state;
    if (motionStatusPill) motionStatusPill.className = 'motion-status-pill ' + state;
  }

  let motionWs = null;
  function connectMotionWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    motionWs = new WebSocket(protocol + '//' + location.host + '/motion-ws');
    motionWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'status') {
          if (msg.warming_up) {
            setMotionStatus('warming', 'Motion: ' + (msg.message || 'Warming up...'));
          } else if (msg.connected === false) {
            setMotionStatus('disconnected', 'Motion: ' + (msg.message || 'Offline'));
          } else {
            setMotionStatus('connected', 'Motion: ' + (msg.message || 'Active'));
          }
        } else if (msg.type === 'backend_connected') {
          setMotionStatus('connected', 'Motion: Online');
        } else if (msg.type === 'backend_disconnected') {
          setMotionStatus('offline', 'Motion: Detector offline');
        }
      } catch (_) {}
    };
    motionWs.onclose = () => {
      setMotionStatus('offline', 'Motion: Disconnected');
      setTimeout(connectMotionWs, 5000);
    };
    motionWs.onerror = () => {
      setMotionStatus('offline', 'Motion: Error');
    };
  }
  connectMotionWs();
})();
