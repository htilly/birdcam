(function () {
  const NICKNAME_KEY = 'birdcam_nickname';
  const LAST_VISIT_KEY = 'birdcam_last_visit';
  const STATS_POLL_INTERVAL = 8000;

  const video = document.getElementById('video');
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

  function loadCameras() {
    fetch('/api/cameras')
      .then((r) => r.json())
      .then((list) => {
        cameras = list;
        renderTabs();
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
    selectedCameraId = id;
    cameraTabs.querySelectorAll('[role="tab"]').forEach((tab) => {
      tab.setAttribute('aria-selected', tab.getAttribute('data-cam-id') === String(id) ? 'true' : 'false');
    });

    const src = `/hls/cam-${id}.m3u8`;
    if (Hls.isSupported()) {
      destroyHls();
      hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => videoOverlay.classList.add('hidden'));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          videoOverlay.classList.remove('hidden');
          videoOverlay.querySelector('p').textContent = 'Stream not available. Try another camera.';
        }
      });
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

  function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/ws');
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'history' && Array.isArray(data.messages)) {
          data.messages.forEach((m) => appendMessage(m));
        } else if (data.type === 'message' && data.nickname && data.text) {
          appendMessage(data);
        } else if (data.type === 'stats') {
          updateStatsFromPayload(data);
        } else if (data.type === 'snapshots') {
          renderSnapshots(data);
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
    const time = m.time ? new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    const row = document.createElement('div');
    row.className = 'chat-msg-row' + (isMine ? ' chat-msg-row--mine' : '');

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

  // --- Stream info panel ---
  const infoBtn = document.getElementById('info-btn');
  const infoPanel = document.getElementById('info-panel');

  infoBtn.addEventListener('click', () => {
    const isHidden = infoPanel.classList.toggle('hidden');
    if (!isHidden) updateInfoPanel();
  });

  function updateInfoPanel() {
    const lines = [];
    if (video.videoWidth && video.videoHeight) {
      lines.push('Resolution: ' + video.videoWidth + 'x' + video.videoHeight);
    }
    if (!isNaN(video.duration) && isFinite(video.duration)) {
      lines.push('Buffer: ' + video.duration.toFixed(1) + 's');
    }
    if (video.currentTime) {
      lines.push('Position: ' + video.currentTime.toFixed(1) + 's');
    }
    if (hls) {
      const level = hls.levels && hls.levels[hls.currentLevel];
      if (level) {
        if (level.codecSet) lines.push('Codecs: ' + level.codecSet);
        else if (level.attrs && level.attrs.CODECS) lines.push('Codecs: ' + level.attrs.CODECS);
        if (level.bitrate) lines.push('Bitrate: ' + (level.bitrate / 1000).toFixed(0) + ' kbps');
        if (level.width && level.height) lines.push('Level: ' + level.width + 'x' + level.height);
      }
      if (hls.latency != null) lines.push('Latency: ' + hls.latency.toFixed(1) + 's');
      lines.push('Dropped frames: ' + (video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().droppedVideoFrames : 'N/A'));
    } else if (video.src) {
      lines.push('Native HLS (Safari)');
      if (video.getVideoPlaybackQuality) {
        const q = video.getVideoPlaybackQuality();
        lines.push('Dropped frames: ' + q.droppedVideoFrames);
      }
    }
    if (!lines.length) lines.push('No stream active');
    infoPanel.textContent = lines.join('\n');
  }

  // Refresh info panel if open
  setInterval(() => {
    if (!infoPanel.classList.contains('hidden')) updateInfoPanel();
  }, 2000);

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

  // Search across all emojis
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (!q) { renderCategory(EMOJI_CATEGORIES[0].emojis); return; }
    const all = EMOJI_CATEGORIES.flatMap(c => c.emojis);
    // Simple filter: match by codepoint string or just show all that contain query chars
    const results = all.filter(em => em.includes(q));
    renderCategory(results.length ? results : all.slice(0, 60));
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
  fetch('/api/admin/me').then(r => r.json()).then(d => { isAdmin = !!d.isAdmin; }).catch(() => {});

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
    const t = new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    cap.textContent = s.nickname + ' \u00B7 ' + t;
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
    const t = new Date(s.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
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
    const timeStr = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
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
    const timeStr = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return 'Your last visit: Today at ' + timeStr;
    if (wasYesterday) return 'Your last visit: Yesterday at ' + timeStr;
    return 'Your last visit: ' + then.toLocaleDateString() + ' at ' + timeStr;
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
  recDate.value = new Date().toISOString().slice(0, 10);

  function populateRecCameras() {
    recCamera.innerHTML = cameras.map((c) => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
  }

  recToggle.addEventListener('click', () => {
    const isOpen = !recPanel.classList.contains('hidden');
    recPanel.classList.toggle('hidden', isOpen);
    recToggle.classList.toggle('active', !isOpen);
    if (!isOpen) populateRecCameras();
  });

  recSearch.addEventListener('click', () => {
    const camId = recCamera.value;
    const date = recDate.value;
    if (!camId || !date) return;
    recList.innerHTML = '<p class="rec-empty">Searching…</p>';
    fetch(`/api/recordings/${camId}?date=${date}`)
      .then((r) => r.json())
      .then((data) => {
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
            <button class="btn-play-clip" data-start="${escapeHtml(clip.startTime)}" data-end="${escapeHtml(clip.endTime)}" data-cam="${camId}">▶ Play</button>
          `;
          recList.appendChild(div);
        });
        recList.querySelectorAll('.btn-play-clip').forEach((btn) => {
          btn.addEventListener('click', () => playClip(btn.dataset.cam, btn.dataset.start, btn.dataset.end, btn));
        });
      })
      .catch(() => { recList.innerHTML = '<p class="rec-error">Failed to fetch recordings.</p>'; });
  });

  function playClip(camId, startTime, endTime, btn) {
    btn.textContent = '⏳ Loading…';
    btn.disabled = true;
    // Stop previous playback session
    if (currentPlaybackKey) {
      fetch(`/api/recordings/stream/${currentPlaybackKey}`, { method: 'DELETE' }).catch(() => {});
      currentPlaybackKey = null;
    }
    fetch(`/api/recordings/${camId}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime, endTime }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { btn.textContent = '✗ Error'; btn.disabled = false; return; }
        currentPlaybackKey = data.key;
        // Load the playback HLS stream into the main video player
        destroyHls();
        videoOverlay.classList.add('hidden');
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true });
          hls.loadSource(data.hlsUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => { videoOverlay.classList.add('hidden'); });
          hls.on(Hls.Events.ERROR, (_, d) => {
            if (d.fatal) { videoOverlay.classList.remove('hidden'); videoOverlay.querySelector('p').textContent = 'Playback error.'; }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = data.hlsUrl;
        }
        btn.textContent = '▶ Playing';
        btn.disabled = false;
      })
      .catch(() => { btn.textContent = '✗ Error'; btn.disabled = false; });
  }
})();
