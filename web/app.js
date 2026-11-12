import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getDatabase,
  onValue,
  push,
  ref,
  set,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import { ALLOWED_EMAILS, FIREBASE_CONFIG } from './firebase-config.js';

const el = (id) => document.getElementById(id);

const views = {
  setup: el('setup-view'),
  auth: el('auth-view'),
  denied: el('denied-view'),
  app: el('app-view'),
};

function showView(name) {
  Object.entries(views).forEach(([key, node]) => {
    node.classList.toggle('hidden', key !== name);
  });
}

function isConfigPlaceholder() {
  const values = Object.values(FIREBASE_CONFIG || {});
  return (
    !FIREBASE_CONFIG?.apiKey ||
    !FIREBASE_CONFIG?.databaseURL ||
    values.some((v) => typeof v === 'string' && v.includes('YOUR_'))
  );
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function formatUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

let toastTimer = null;
function showToast(message, ok = true) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.remove('hidden', 'ok', 'err');
  toast.classList.add(ok ? 'ok' : 'err');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

if (isConfigPlaceholder()) {
  showView('setup');
} else {
  const app = initializeApp(FIREBASE_CONFIG);
  const auth = getAuth(app);
  const db = getDatabase(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const normalizedAllowlist = (ALLOWED_EMAILS || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);

  let currentUser = null;
  let latestState = null;
  let selectedGuildId = localStorage.getItem('nobu_guild_id') || '';
  let unsubState = null;
  let unsubResult = null;
  let unsubSearch = null;
  let currentSearchReqId = null;
  let searchTimeoutTimer = null;
  let lastHandledResultId = null;
  let volumeDebounce = null;
  let isDraggingVolume = false;

  async function sendCommand(action, payload = {}) {
    if (!currentUser) return;
    if (!selectedGuildId && action !== 'refresh') {
      showToast('No Discord server available yet.', false);
      return;
    }

    try {
      const cmdRef = push(ref(db, 'nobu/commands'));
      await set(cmdRef, {
        action,
        guildId: selectedGuildId || '',
        userEmail: currentUser.email,
        createdAt: Date.now(),
        ...payload,
      });
    } catch (err) {
      showToast(`Command failed: ${err.message}`, false);
    }
  }

  function getSelectedGuild() {
    const guilds = latestState?.guilds || {};
    const ids = Object.keys(guilds);
    if (ids.length === 0) return null;
    if (!selectedGuildId || !guilds[selectedGuildId]) {
      selectedGuildId = ids.find((id) => guilds[id]?.queue) || ids[0];
      localStorage.setItem('nobu_guild_id', selectedGuildId);
    }
    return guilds[selectedGuildId];
  }

  function renderBotHeader() {
    const bot = latestState?.bot;
    const statusPill = el('bot-status-pill');
    const metrics = el('bot-metrics');

    if (!bot) {
      statusPill.textContent = 'Waiting for bot…';
      statusPill.className = 'status-pill offline';
      metrics.textContent = 'Start Nobu with Firebase credentials in .env';
      return;
    }

    const ageSec = bot.updatedAt ? Math.floor((Date.now() - bot.updatedAt) / 1000) : 999;
    const isFresh = Boolean(bot.online) && ageSec < 120;

    statusPill.textContent = isFresh ? 'Online' : 'Stale / Offline';
    statusPill.className = `status-pill ${isFresh ? 'online' : 'offline'}`;
    if (bot.avatar) {
      const avatarImg = el('bot-avatar');
      avatarImg.src = bot.avatar;
      avatarImg.classList.remove('hidden');
      el('bot-avatar-fallback').classList.add('hidden');
    }

    const pingText = bot.pingMs != null ? `${bot.pingMs} ms` : '—';
    const memText = bot.memoryRssMB != null ? `${bot.memoryRssMB} MB RAM` : '';
    const upText = bot.uptimeSeconds != null ? `up ${formatUptime(bot.uptimeSeconds)}` : '';
    metrics.textContent = [bot.tag, pingText, memText, upText].filter(Boolean).join(' • ');
  }

  function renderSelectors(guild) {
    const guilds = latestState?.guilds || {};
    const guildSelect = el('guild-select');
    guildSelect.textContent = '';

    const entries = Object.values(guilds);
    if (entries.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No servers';
      guildSelect.appendChild(opt);
    } else {
      entries.forEach((g) => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.queue ? `🔊 ${g.name}` : g.name;
        if (guild && g.id === guild.id) opt.selected = true;
        guildSelect.appendChild(opt);
      });
    }

    const vcSelect = el('voice-channel-select');
    const prevVc = vcSelect.value;
    vcSelect.textContent = '';

    const channels = guild?.voiceChannels || [];
    if (channels.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Auto voice channel';
      vcSelect.appendChild(opt);
    } else {
      channels.forEach((ch) => {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = ch.membersCount > 0 ? `# ${ch.name} (${ch.membersCount})` : `# ${ch.name}`;
        vcSelect.appendChild(opt);
      });
      if (guild?.queue?.voiceChannelId) {
        vcSelect.value = guild.queue.voiceChannelId;
      } else if (prevVc && channels.some((c) => c.id === prevVc)) {
        vcSelect.value = prevVc;
      }
    }
  }

  function getInterpolatedTime(queue) {
    if (!queue) return 0;
    let current = Number(queue.currentTime) || 0;
    if (!queue.paused && latestState?.bot?.updatedAt) {
      const elapsed = Math.max(0, (Date.now() - latestState.bot.updatedAt) / 1000);
      current += elapsed;
    }
    if (queue.duration > 0) {
      current = Math.min(current, queue.duration);
    }
    return Math.floor(current);
  }

  function renderProgress(queue) {
    if (!queue || !queue.currentSong) return;
    const duration = Number(queue.duration) || 0;
    const current = getInterpolatedTime(queue);
    el('time-current').textContent = formatTime(current);
    el('time-total').textContent = duration > 0 ? formatTime(duration) : (queue.formattedDuration || 'Live');
    const pct = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 100;
    el('progress-fill').style.width = `${pct}%`;
  }

  function renderQueueList(queue) {
    const list = el('queue-list');
    const empty = el('queue-empty');
    const summary = el('queue-summary');
    const clearBtn = el('btn-clear-queue');

    list.textContent = '';
    const upcoming = queue?.upcoming || [];
    const totalCount = queue?.songsCount || 0;

    if (!queue || totalCount <= 1) {
      summary.textContent = queue ? `1 track playing • ${queue.totalFormattedDuration || '0:00'}` : '0 tracks in queue';
      empty.classList.remove('hidden');
      clearBtn.classList.add('hidden');
      return;
    }

    summary.textContent = `${totalCount} tracks total (${upcoming.length} shown up next) • ${queue.totalFormattedDuration || ''}`;
    empty.classList.add('hidden');
    clearBtn.classList.remove('hidden');

    upcoming.forEach((song) => {
      const li = document.createElement('li');
      li.className = 'queue-item';

      const pos = document.createElement('span');
      pos.className = 'queue-pos';
      pos.textContent = String(song.index);

      const thumb = document.createElement('img');
      thumb.className = 'queue-thumb';
      thumb.alt = '';
      if (song.thumbnail) {
        thumb.src = song.thumbnail;
      }

      const info = document.createElement('div');
      info.className = 'queue-info';

      const title = document.createElement('span');
      title.className = 'queue-title';
      title.textContent = song.name || 'Unknown Track';
      title.title = song.name || '';

      const sub = document.createElement('span');
      sub.className = 'queue-sub';
      sub.textContent = `${song.formattedDuration || 'Live'} • ${song.requestedBy || 'Discord'}`;

      info.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'queue-actions';

      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'btn btn-ghost btn-sm';
      jumpBtn.textContent = 'Play';
      jumpBtn.title = 'Jump to this track';
      jumpBtn.addEventListener('click', () => sendCommand('jump', { index: song.index }));

      const remBtn = document.createElement('button');
      remBtn.type = 'button';
      remBtn.className = 'btn btn-ghost btn-sm';
      remBtn.textContent = '✕';
      remBtn.title = 'Remove from queue';
      remBtn.addEventListener('click', () => sendCommand('remove', { index: song.index }));

      actions.append(jumpBtn, remBtn);
      li.append(pos, thumb, info, actions);
      list.appendChild(li);
    });
  }

  function renderPlayer() {
    renderBotHeader();
    const guild = getSelectedGuild();
    renderSelectors(guild);

    const queue = guild?.queue || null;
    const vcBadge = el('vc-badge');

    if (!queue || !queue.currentSong) {
      vcBadge.textContent = 'Not in voice';
      el('idle-state').classList.remove('hidden');
      el('active-player').classList.add('hidden');
      renderQueueList(null);
      return;
    }

    vcBadge.textContent = queue.voiceChannelName ? `🔊 #${queue.voiceChannelName}` : 'In voice';
    el('idle-state').classList.add('hidden');
    el('active-player').classList.remove('hidden');

    const song = queue.currentSong;
    const art = el('track-art');
    const artFallback = el('track-art-fallback');
    if (song.thumbnail) {
      art.src = song.thumbnail;
      art.classList.remove('hidden');
      artFallback.classList.add('hidden');
    } else {
      art.classList.add('hidden');
      artFallback.classList.remove('hidden');
    }

    el('track-source').textContent = song.source || 'audio';
    const stateBadge = el('playback-state-badge');
    stateBadge.textContent = queue.paused ? 'Paused' : 'Playing';
    stateBadge.classList.toggle('paused', Boolean(queue.paused));

    const titleEl = el('track-title');
    titleEl.textContent = song.name || 'Unknown Track';
    if (song.url) {
      titleEl.href = song.url;
    } else {
      titleEl.removeAttribute('href');
    }
    el('track-requester').textContent = `Requested by ${song.requestedBy || 'Discord'}`;

    el('icon-pause').classList.toggle('hidden', Boolean(queue.paused));
    el('icon-play').classList.toggle('hidden', !queue.paused);

    const loopLabels = ['Off', 'Song', 'Queue'];
    el('loop-label').textContent = loopLabels[queue.repeatMode] || 'Off';
    el('btn-loop').classList.toggle('active', Number(queue.repeatMode) > 0);
    el('btn-autoplay').classList.toggle('active', Boolean(queue.autoplay));

    if (!isDraggingVolume) {
      const vol = Number(queue.volume) || 50;
      el('volume-slider').value = String(vol);
      el('volume-value').textContent = `${vol}%`;
    }

    const activeFilters = new Set(queue.filters || []);
    document.querySelectorAll('.filter-chip').forEach((btn) => {
      const f = btn.dataset.filter;
      btn.classList.toggle('active', f !== 'clear' && activeFilters.has(f));
    });

    renderProgress(queue);
    renderQueueList(queue);
  }

  function startRealtimeSubscriptions() {
    stopRealtimeSubscriptions();

    unsubState = onValue(
      ref(db, 'nobu/state'),
      (snap) => {
        latestState = snap.val();
        renderPlayer();
      },
      (err) => {
        if (err?.code === 'PERMISSION_DENIED') {
          el('denied-message').textContent =
            `Signed in as ${currentUser?.email}, which is not permitted by database.rules.json.`;
          showView('denied');
        } else {
          showToast(`Database error: ${err.message}`, false);
        }
      }
    );

    unsubResult = onValue(
      ref(db, 'nobu/lastResult'),
      (snap) => {
        const res = snap.val();
        if (!res || !res.id || res.id === lastHandledResultId) return;
        if (res.at && Date.now() - res.at > 15000) return;
        lastHandledResultId = res.id;
        showToast(res.message || res.action, Boolean(res.ok));
      },
      () => {}
    );

    unsubSearch = onValue(
      ref(db, 'nobu/searchResults'),
      (snap) => {
        const data = snap.val();
        if (!data || !data.reqId) return;
        if (currentSearchReqId && data.reqId === currentSearchReqId) {
          handleSearchResults(data);
        }
      },
      () => {}
    );
  }

  function stopRealtimeSubscriptions() {
    if (unsubState) {
      unsubState();
      unsubState = null;
    }
    if (unsubResult) {
      unsubResult();
      unsubResult = null;
    }
    if (unsubSearch) {
      unsubSearch();
      unsubSearch = null;
    }
  }

  // Smooth local progress bar tick
  setInterval(() => {
    const guild = getSelectedGuild();
    if (guild?.queue && !guild.queue.paused) {
      renderProgress(guild.queue);
    }
  }, 1000);

  // Auth handlers
  el('google-signin-btn').addEventListener('click', async () => {
    el('auth-error').classList.add('hidden');
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (err?.code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, provider);
        return;
      }
      el('auth-error').textContent = err.message || 'Sign-in failed.';
      el('auth-error').classList.remove('hidden');
    }
  });

  const handleSignOut = async () => {
    stopRealtimeSubscriptions();
    await signOut(auth);
  };
  el('signout-btn').addEventListener('click', handleSignOut);
  el('denied-signout-btn').addEventListener('click', handleSignOut);

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (!user) {
      stopRealtimeSubscriptions();
      showView('auth');
      return;
    }

    const email = String(user.email || '').toLowerCase();
    if (normalizedAllowlist.length > 0 && !normalizedAllowlist.includes(email)) {
      el('denied-message').textContent = `Signed in as ${user.email}, which is not in ALLOWED_EMAILS.`;
      showView('denied');
      return;
    }

    el('user-email').textContent = user.email || user.displayName || 'Signed in';
    if (user.photoURL) {
      el('user-avatar').src = user.photoURL;
      el('user-avatar').classList.remove('hidden');
    } else {
      el('user-avatar').classList.add('hidden');
    }

    showView('app');
    startRealtimeSubscriptions();
  });

  // Search Menu Handlers
  function closeSearchMenu() {
    el('search-menu').classList.add('hidden');
    el('search-loading').classList.add('hidden');
    el('search-empty').classList.add('hidden');
    el('search-results-list').textContent = '';
    currentSearchReqId = null;
    if (searchTimeoutTimer) {
      clearTimeout(searchTimeoutTimer);
      searchTimeoutTimer = null;
    }
  }

  function handleSearchResults(data) {
    if (searchTimeoutTimer) {
      clearTimeout(searchTimeoutTimer);
      searchTimeoutTimer = null;
    }

    el('search-loading').classList.add('hidden');
    const list = el('search-results-list');
    list.textContent = '';

    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) {
      el('search-empty').classList.remove('hidden');
      return;
    }

    el('search-empty').classList.add('hidden');

    results.forEach((track) => {
      const li = document.createElement('li');
      li.className = 'search-result-item';

      if (track.thumbnail) {
        const img = document.createElement('img');
        img.className = 'search-result-thumb';
        img.src = track.thumbnail;
        img.alt = '';
        li.appendChild(img);
      } else {
        const fallback = document.createElement('div');
        fallback.className = 'search-result-thumb-fallback';
        fallback.textContent = '🎶';
        li.appendChild(fallback);
      }

      const info = document.createElement('div');
      info.className = 'search-result-info';

      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.textContent = track.name;
      title.title = track.name;

      const sub = document.createElement('span');
      sub.className = 'search-result-sub';
      sub.textContent = `${track.formattedDuration} • ${track.uploader || 'SoundCloud'}`;

      info.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'search-result-actions';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'btn btn-search-play';
      playBtn.textContent = '▶ Play Now';
      playBtn.title = 'Play this song immediately';
      playBtn.addEventListener('click', async () => {
        const voiceChannelId = el('voice-channel-select').value;
        showToast(`Playing "${track.name}" now…`);
        await sendCommand('play', {
          query: track.url,
          source: 'soundcloud',
          voiceChannelId,
          skip: true,
        });
        closeSearchMenu();
      });

      const queueBtn = document.createElement('button');
      queueBtn.type = 'button';
      queueBtn.className = 'btn btn-search-queue';
      queueBtn.textContent = '➕ Add to Queue';
      queueBtn.title = 'Add this song to upcoming queue';
      queueBtn.addEventListener('click', async () => {
        const voiceChannelId = el('voice-channel-select').value;
        showToast(`Added "${track.name}" to queue`);
        await sendCommand('play', {
          query: track.url,
          source: 'soundcloud',
          voiceChannelId,
          skip: false,
        });
        queueBtn.textContent = '✓ Queued';
        setTimeout(() => {
          queueBtn.textContent = '➕ Add to Queue';
        }, 2000);
      });

      actions.append(playBtn, queueBtn);
      li.append(info, actions);
      list.appendChild(li);
    });
  }

  // UI Control Handlers
  el('guild-select').addEventListener('change', (e) => {
    selectedGuildId = e.target.value;
    localStorage.setItem('nobu_guild_id', selectedGuildId);
    renderPlayer();
  });

  el('refresh-btn').addEventListener('click', () => {
    sendCommand('refresh');
    showToast('Requested fresh state from Nobu…');
  });

  const queryInput = el('play-query');
  const clearQueryBtn = el('search-clear-btn');
  const submitBtnLabel = el('submit-btn-label');

  queryInput.addEventListener('input', () => {
    const val = queryInput.value.trim();
    clearQueryBtn.classList.toggle('hidden', !val);
    const isUrl = val.startsWith('http://') || val.startsWith('https://');
    submitBtnLabel.textContent = isUrl ? 'Play / Queue URL' : 'Search Tracks';
  });

  clearQueryBtn.addEventListener('click', () => {
    queryInput.value = '';
    clearQueryBtn.classList.add('hidden');
    submitBtnLabel.textContent = 'Search Tracks';
    queryInput.focus();
  });

  el('btn-close-search').addEventListener('click', closeSearchMenu);

  el('play-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = queryInput.value.trim();
    if (!query) return;

    const source = el('play-source').value;
    const voiceChannelId = el('voice-channel-select').value;
    const isUrl = query.startsWith('http://') || query.startsWith('https://');

    if (isUrl) {
      showToast(`Queuing link…`);
      await sendCommand('play', { query, source, voiceChannelId, skip: false });
      queryInput.value = '';
      clearQueryBtn.classList.add('hidden');
      closeSearchMenu();
      return;
    }

    // Open Search Menu
    el('search-menu').classList.remove('hidden');
    el('search-query-tag').textContent = `for "${query}"`;
    el('search-loading').classList.remove('hidden');
    el('search-empty').classList.add('hidden');
    el('search-results-list').textContent = '';

    const reqId = 'sr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    currentSearchReqId = reqId;

    if (searchTimeoutTimer) clearTimeout(searchTimeoutTimer);
    searchTimeoutTimer = setTimeout(() => {
      if (currentSearchReqId === reqId) {
        el('search-loading').classList.add('hidden');
        el('search-empty').textContent = 'Search timed out. Make sure Nobu is running and connected.';
        el('search-empty').classList.remove('hidden');
      }
    }, 12000);

    showToast(`Searching SoundCloud for "${query}"…`);
    await sendCommand('search', { query, source, reqId });
  });

  // Close search menu when clicking outside
  document.addEventListener('click', (e) => {
    const searchMenu = el('search-menu');
    const playBar = document.querySelector('.play-bar');
    if (!searchMenu.classList.contains('hidden') && !playBar.contains(e.target)) {
      closeSearchMenu();
    }
  });

  el('btn-play-pause').addEventListener('click', () => sendCommand('togglePause'));
  el('btn-skip').addEventListener('click', () => sendCommand('skip'));
  el('btn-stop').addEventListener('click', () => sendCommand('stop'));
  el('btn-shuffle').addEventListener('click', () => sendCommand('shuffle'));
  el('btn-loop').addEventListener('click', () => sendCommand('loop'));
  el('btn-autoplay').addEventListener('click', () => sendCommand('autoplay'));
  el('btn-clear-queue').addEventListener('click', () => sendCommand('clearQueue'));

  el('btn-rewind').addEventListener('click', () => {
    const queue = getSelectedGuild()?.queue;
    if (!queue) return;
    const target = Math.max(0, getInterpolatedTime(queue) - 10);
    sendCommand('seek', { seconds: target });
  });

  el('progress-bar').addEventListener('click', (e) => {
    const queue = getSelectedGuild()?.queue;
    if (!queue || !queue.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const seconds = Math.round(ratio * queue.duration);
    sendCommand('seek', { seconds });
  });

  const volumeSlider = el('volume-slider');
  volumeSlider.addEventListener('input', () => {
    isDraggingVolume = true;
    el('volume-value').textContent = `${volumeSlider.value}%`;
    if (volumeDebounce) clearTimeout(volumeDebounce);
    volumeDebounce = setTimeout(() => {
      isDraggingVolume = false;
      sendCommand('volume', { volume: Number(volumeSlider.value) });
    }, 220);
  });
  volumeSlider.addEventListener('change', () => {
    isDraggingVolume = false;
  });

  el('filters-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    sendCommand('filter', { effect: btn.dataset.filter });
  });
}
