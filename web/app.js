import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getDatabase,
  onValue,
  push,
  ref,
  remove,
  set,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import { DISCORD_CONFIG, FIREBASE_CONFIG } from './firebase-config.js';

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

  let currentUser = null;
  let currentDiscordUser = null;
  let latestState = null;
  let selectedGuildId = localStorage.getItem('nobu_guild_id') || '';
  let unsubState = null;
  let unsubResult = null;
  let unsubSearch = null;
  let unsubPlaylists = null;
  let userPlaylists = {};
  let currentSearchReqId = null;
  let searchTimeoutTimer = null;
  let lastHandledResultId = null;
  let volumeDebounce = null;
  let isDraggingVolume = false;

  // Track / Playlist Modals State
  let trackPendingForSave = null;
  let tracksPendingForNewPlaylist = [];

  // Restore cached Discord user profile
  try {
    const cached = localStorage.getItem('nobu_discord_user');
    if (cached) currentDiscordUser = JSON.parse(cached);
  } catch (_) {}

  // -----------------------------------------------------------------
  // 1. Discord Authentication Handling
  // -----------------------------------------------------------------
  el('discord-signin-btn')?.addEventListener('click', () => {
    const returnUrl = window.location.origin + window.location.pathname;
    const loginUrl = `${DISCORD_CONFIG.railwayApiUrl}/api/auth/discord/login?returnUrl=${encodeURIComponent(returnUrl)}`;
    window.location.href = loginUrl;
  });

  async function checkDiscordAuthHash() {
    if (!window.location.hash) return;

    if (window.location.hash.includes('error=')) {
      const hash = new URLSearchParams(window.location.hash.substring(1));
      const err = hash.get('error');
      history.replaceState(null, '', window.location.pathname);
      if (err) {
        el('auth-error').textContent = decodeURIComponent(err);
        el('auth-error').classList.remove('hidden');
      }
      return;
    }

    if (window.location.hash.includes('custom_token=')) {
      const hash = new URLSearchParams(window.location.hash.substring(1));
      const customToken = hash.get('custom_token');
      const discordId = hash.get('discord_id');
      const username = hash.get('username');
      const globalName = hash.get('global_name');
      const avatarUrl = hash.get('avatar_url');
      const guildsStr = hash.get('guilds');

      // Clear the hash from address bar immediately
      history.replaceState(null, '', window.location.pathname);

      if (discordId) {
        currentDiscordUser = {
          id: discordId,
          username: username || 'Discord User',
          globalName: globalName || username || 'Discord User',
          avatarUrl: avatarUrl || '',
          guilds: (guildsStr || '').split(',').filter(Boolean),
        };
        localStorage.setItem('nobu_discord_user', JSON.stringify(currentDiscordUser));
      }

      if (customToken) {
        try {
          await signInWithCustomToken(auth, customToken);
          showToast(`Welcome, ${currentDiscordUser?.globalName || 'Discord User'}!`);
        } catch (err) {
          console.error('Custom token login failed:', err);
          showToast(`Login failed: ${err.message}`, false);
        }
      }
    }
  }

  checkDiscordAuthHash();

  async function sendCommand(action, payload = {}) {
    if (!currentUser && !currentDiscordUser) return;
    if (!selectedGuildId && action !== 'refresh') {
      showToast('No Discord server selected.', false);
      return;
    }

    try {
      const cmdRef = push(ref(db, 'nobu/commands'));
      await set(cmdRef, {
        action,
        guildId: selectedGuildId || '',
        discordUserId: currentDiscordUser?.id || currentUser?.uid?.replace(/^discord:/, '') || '',
        discordUsername: currentDiscordUser?.globalName || currentDiscordUser?.username || 'Dashboard User',
        userEmail: currentUser?.email || '',
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
    return guilds[selectedGuildId] || null;
  }

  // -----------------------------------------------------------------
  // 2. Playlists Management (Firebase RTDB user-scoped)
  // -----------------------------------------------------------------
  function initPlaylistsListener(discordUserId) {
    if (!discordUserId) return;
    if (unsubPlaylists) unsubPlaylists();

    const playlistsRef = ref(db, `nobu/users/${discordUserId}/playlists`);
    unsubPlaylists = onValue(
      playlistsRef,
      (snapshot) => {
        userPlaylists = snapshot.val() || {};
        renderPlaylists();
      },
      (err) => {
        console.warn('Error reading playlists:', err.message);
      }
    );
  }

  function renderPlaylists() {
    const grid = el('playlists-grid');
    const empty = el('playlists-empty');
    const badge = el('playlist-badge');
    const loading = el('playlists-loading');

    loading.classList.add('hidden');
    grid.innerHTML = '';

    const entries = Object.entries(userPlaylists || {});
    badge.textContent = String(entries.length);

    if (entries.length === 0) {
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');

    entries.forEach(([plId, pl]) => {
      const card = document.createElement('div');
      card.className = 'playlist-card';

      const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
      const firstThumb = tracks.find((t) => t.thumbnail)?.thumbnail;
      const totalDuration = pl.totalDuration
        ? formatTime(pl.totalDuration)
        : formatTime(tracks.reduce((a, t) => a + (Number(t.duration) || 0), 0));

      // Top row: Cover & Details
      const top = document.createElement('div');
      top.className = 'playlist-card-top';

      const cover = document.createElement('div');
      cover.className = 'playlist-cover';
      if (firstThumb) {
        const img = document.createElement('img');
        img.src = firstThumb;
        img.alt = pl.name;
        cover.appendChild(img);
      } else {
        cover.textContent = '🎵';
      }

      const meta = document.createElement('div');
      meta.className = 'playlist-meta';

      const title = document.createElement('h4');
      title.className = 'playlist-title';
      title.textContent = pl.name || 'Untitled Playlist';
      title.title = pl.name || '';

      const desc = document.createElement('p');
      desc.className = 'playlist-desc';
      desc.textContent = pl.description || `${tracks.length} tracks`;

      meta.append(title, desc);
      top.append(cover, meta);

      // Stats row
      const stats = document.createElement('div');
      stats.className = 'playlist-stats';

      const countSpan = document.createElement('span');
      countSpan.textContent = `📑 ${tracks.length} track${tracks.length === 1 ? '' : 's'}`;

      const durSpan = document.createElement('span');
      durSpan.textContent = `⏱️ ${totalDuration}`;

      stats.append(countSpan, durSpan);

      // Actions row
      const actions = document.createElement('div');
      actions.className = 'playlist-actions';

      const playBtn = document.createElement('button');
      playBtn.className = 'btn btn-primary btn-sm';
      playBtn.type = 'button';
      playBtn.textContent = '▶ Play All';
      playBtn.title = 'Queue this entire playlist to your voice channel';
      playBtn.addEventListener('click', () => playPlaylist(pl));

      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn btn-ghost btn-sm';
      viewBtn.type = 'button';
      viewBtn.textContent = '👁 Tracks';
      viewBtn.title = 'View tracks in this playlist';
      viewBtn.addEventListener('click', () => openViewPlaylistModal(pl));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost btn-sm btn-danger-soft';
      delBtn.type = 'button';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete playlist';
      delBtn.addEventListener('click', () => deletePlaylist(plId, pl.name));

      actions.append(playBtn, viewBtn, delBtn);
      card.append(top, stats, actions);
      grid.appendChild(card);
    });
  }

  async function playPlaylist(pl) {
    const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
    if (tracks.length === 0) {
      showToast('This playlist is empty.', false);
      return;
    }
    const voiceChannelId = el('voice-channel-select').value;
    showToast(`Loading playlist "${pl.name}" (${tracks.length} tracks)...`);
    await sendCommand('playPlaylist', {
      playlistId: pl.id,
      playlistName: pl.name,
      tracks,
      voiceChannelId,
      skip: true,
    });
  }

  async function deletePlaylist(plId, name) {
    if (!currentDiscordUser?.id) return;
    if (!confirm(`Are you sure you want to delete the playlist "${name}"?`)) return;

    try {
      await remove(ref(db, `nobu/users/${currentDiscordUser.id}/playlists/${plId}`));
      showToast(`Playlist "${name}" deleted.`);
    } catch (err) {
      showToast(`Failed to delete playlist: ${err.message}`, false);
    }
  }

  function openCreatePlaylistModal(initialTracks = []) {
    tracksPendingForNewPlaylist = initialTracks;
    el('input-playlist-name').value = initialTracks.length > 0 ? `Queue - ${new Date().toLocaleDateString()}` : '';
    el('input-playlist-desc').value = initialTracks.length > 0 ? `Saved from active queue (${initialTracks.length} tracks)` : '';
    el('modal-create-playlist').classList.remove('hidden');
    el('input-playlist-name').focus();
  }

  el('btn-close-create-modal')?.addEventListener('click', () => {
    el('modal-create-playlist').classList.add('hidden');
  });
  el('btn-cancel-create')?.addEventListener('click', () => {
    el('modal-create-playlist').classList.add('hidden');
  });

  el('form-create-playlist')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentDiscordUser?.id) {
      showToast('Please sign in with Discord first.', false);
      return;
    }

    const name = el('input-playlist-name').value.trim();
    const desc = el('input-playlist-desc').value.trim();
    if (!name) return;

    const plId = `pl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const tracks = tracksPendingForNewPlaylist || [];
    const totalDuration = tracks.reduce((a, t) => a + (Number(t.duration) || 0), 0);

    const newPl = {
      id: plId,
      name,
      description: desc,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: currentDiscordUser.id,
      trackCount: tracks.length,
      totalDuration,
      tracks,
    };

    try {
      await set(ref(db, `nobu/users/${currentDiscordUser.id}/playlists/${plId}`), newPl);
      el('modal-create-playlist').classList.add('hidden');
      showToast(`Playlist "${name}" created with ${tracks.length} tracks!`);
    } catch (err) {
      showToast(`Error creating playlist: ${err.message}`, false);
    }
  });

  function saveCurrentQueueAsPlaylist() {
    const guild = getSelectedGuild();
    const queue = guild?.queue;
    if (!queue || !queue.currentSong) {
      showToast('No active music queue to save.', false);
      return;
    }
    const allTracks = [queue.currentSong, ...(queue.upcoming || [])];
    openCreatePlaylistModal(allTracks);
  }

  el('btn-create-playlist')?.addEventListener('click', () => openCreatePlaylistModal([]));
  el('btn-save-queue-from-tab')?.addEventListener('click', saveCurrentQueueAsPlaylist);
  el('btn-save-queue-as-playlist')?.addEventListener('click', saveCurrentQueueAsPlaylist);

  // Add Track to Playlist Modal
  function openSaveTrackModal(track) {
    if (!currentDiscordUser?.id) {
      showToast('Please sign in with Discord first.', false);
      return;
    }
    trackPendingForSave = track;
    const preview = el('modal-target-track');
    preview.innerHTML = `
      <img src="${track.thumbnail || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'%3E%3Ctext y=\'20\' font-size=\'20\'%3E🎵%3C/text%3E%3C/svg%3E'}" alt="" />
      <div class="target-track-info">
        <span class="target-track-title">${track.name || 'Unknown Track'}</span>
        <span class="muted small-text">${track.formattedDuration || ''}</span>
      </div>
    `;

    const list = el('modal-playlists-list');
    list.innerHTML = '';
    const entries = Object.entries(userPlaylists || {});

    if (entries.length === 0) {
      list.innerHTML = `
        <p class="muted small-text">No playlists yet. Create one first!</p>
        <button id="btn-quick-create" class="btn btn-secondary btn-sm" style="margin-top: 8px;">+ Create New Playlist</button>
      `;
      el('btn-quick-create')?.addEventListener('click', () => {
        el('modal-add-to-playlist').classList.add('hidden');
        openCreatePlaylistModal([trackPendingForSave]);
      });
    } else {
      entries.forEach(([plId, pl]) => {
        const item = document.createElement('div');
        item.className = 'modal-playlist-option';
        item.innerHTML = `
          <div>
            <strong>${pl.name}</strong>
            <div class="muted small-text">${(pl.tracks || []).length} tracks</div>
          </div>
          <button class="btn btn-ghost btn-sm">Add</button>
        `;
        item.addEventListener('click', () => addTrackToExistingPlaylist(plId, pl, trackPendingForSave));
        list.appendChild(item);
      });
    }

    el('modal-add-to-playlist').classList.remove('hidden');
  }

  async function addTrackToExistingPlaylist(plId, pl, track) {
    if (!currentDiscordUser?.id || !track) return;
    const tracks = Array.isArray(pl.tracks) ? [...pl.tracks] : [];
    tracks.push(track);

    const totalDuration = tracks.reduce((a, t) => a + (Number(t.duration) || 0), 0);

    try {
      await set(ref(db, `nobu/users/${currentDiscordUser.id}/playlists/${plId}`), {
        ...pl,
        tracks,
        trackCount: tracks.length,
        totalDuration,
        updatedAt: Date.now(),
      });
      el('modal-add-to-playlist').classList.add('hidden');
      showToast(`Added "${track.name}" to "${pl.name}"!`);
    } catch (err) {
      showToast(`Failed to add track: ${err.message}`, false);
    }
  }

  el('btn-close-add-modal')?.addEventListener('click', () => {
    el('modal-add-to-playlist').classList.add('hidden');
  });
  el('btn-cancel-add')?.addEventListener('click', () => {
    el('modal-add-to-playlist').classList.add('hidden');
  });

  // View Playlist Tracks Modal
  function openViewPlaylistModal(pl) {
    el('modal-view-title').textContent = pl.name || 'Playlist';
    const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
    el('modal-view-subtitle').textContent = `${tracks.length} tracks • ${pl.totalDuration ? formatTime(pl.totalDuration) : ''}`;

    const list = el('modal-playlist-tracks');
    list.innerHTML = '';

    if (tracks.length === 0) {
      list.innerHTML = '<li class="muted empty-queue">No tracks in this playlist.</li>';
    } else {
      tracks.forEach((t, idx) => {
        const li = document.createElement('li');
        li.className = 'queue-item';

        const pos = document.createElement('span');
        pos.className = 'queue-pos';
        pos.textContent = String(idx + 1);

        const thumb = document.createElement('img');
        thumb.className = 'queue-thumb';
        thumb.src = t.thumbnail || '';
        thumb.alt = '';

        const info = document.createElement('div');
        info.className = 'queue-info';
        info.innerHTML = `
          <span class="queue-title">${t.name || 'Unknown Track'}</span>
          <span class="queue-sub">${t.formattedDuration || ''} • ${t.source || 'auto'}</span>
        `;

        const actions = document.createElement('div');
        actions.className = 'queue-actions';

        const playBtn = document.createElement('button');
        playBtn.className = 'btn btn-ghost btn-sm';
        playBtn.textContent = 'Play';
        playBtn.addEventListener('click', () => {
          const voiceChannelId = el('voice-channel-select').value;
          showToast(`Playing "${t.name}"`);
          sendCommand('play', { query: t.url || t.name, source: t.source || 'auto', voiceChannelId, skip: true });
        });

        const remBtn = document.createElement('button');
        remBtn.className = 'btn btn-ghost btn-sm';
        remBtn.textContent = '✕';
        remBtn.title = 'Remove track';
        remBtn.addEventListener('click', async () => {
          tracks.splice(idx, 1);
          await set(ref(db, `nobu/users/${currentDiscordUser.id}/playlists/${pl.id}`), {
            ...pl,
            tracks,
            trackCount: tracks.length,
            totalDuration: tracks.reduce((a, item) => a + (Number(item.duration) || 0), 0),
            updatedAt: Date.now(),
          });
          openViewPlaylistModal({ ...pl, tracks });
        });

        actions.append(playBtn, remBtn);
        li.append(pos, thumb, info, actions);
        list.appendChild(li);
      });
    }

    el('btn-play-this-playlist').onclick = () => {
      el('modal-view-playlist').classList.add('hidden');
      playPlaylist(pl);
    };

    el('modal-view-playlist').classList.remove('hidden');
  }

  el('btn-close-view-modal')?.addEventListener('click', () => {
    el('modal-view-playlist').classList.add('hidden');
  });

  // -----------------------------------------------------------------
  // 3. Tab Navigation
  // -----------------------------------------------------------------
  el('tab-btn-player')?.addEventListener('click', () => {
    el('tab-btn-player').classList.add('active');
    el('tab-btn-playlists').classList.remove('active');
    el('panel-player').classList.remove('hidden');
    el('panel-playlists').classList.add('hidden');
  });

  el('tab-btn-playlists')?.addEventListener('click', () => {
    el('tab-btn-playlists').classList.add('active');
    el('tab-btn-player').classList.remove('active');
    el('panel-playlists').classList.remove('hidden');
    el('panel-player').classList.add('hidden');
  });

  // -----------------------------------------------------------------
  // 4. Player & Queue Rendering
  // -----------------------------------------------------------------
  function renderBotHeader() {
    const bot = latestState?.bot;
    const pill = el('bot-status-pill');
    const metrics = el('bot-metrics');
    const avatar = el('bot-avatar');
    const fallback = el('bot-avatar-fallback');

    if (!bot) {
      pill.className = 'status-pill offline';
      pill.textContent = 'Connecting…';
      metrics.textContent = 'Waiting for telemetry…';
      return;
    }

    const isOnline = Boolean(bot.online);
    pill.className = `status-pill ${isOnline ? 'online' : 'offline'}`;
    pill.textContent = isOnline ? 'Online' : 'Offline';

    const mem = bot.memoryRssMB ? `${bot.memoryRssMB} MB RAM` : '';
    const ping = bot.pingMs !== null && bot.pingMs !== undefined ? `${bot.pingMs} ms` : '';
    const up = bot.uptimeSeconds ? `up ${formatUptime(bot.uptimeSeconds)}` : '';
    metrics.textContent = [bot.tag || 'Nobu', ping, mem, up].filter(Boolean).join(' • ');

    if (bot.avatar) {
      avatar.src = bot.avatar;
      avatar.classList.remove('hidden');
      fallback.classList.add('hidden');
    } else {
      avatar.classList.add('hidden');
      fallback.classList.remove('hidden');
    }
  }

  function renderSelectors(guild) {
    const guildSelect = el('guild-select');
    const guilds = latestState?.guilds || {};
    const ids = Object.keys(guilds);

    const prevGuild = guildSelect.value;
    guildSelect.innerHTML = '';
    ids.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = guilds[id].name || id;
      guildSelect.appendChild(opt);
    });
    if (selectedGuildId && ids.includes(selectedGuildId)) {
      guildSelect.value = selectedGuildId;
    } else if (prevGuild && ids.includes(prevGuild)) {
      guildSelect.value = prevGuild;
      selectedGuildId = prevGuild;
    } else if (ids.length > 0) {
      guildSelect.value = ids[0];
      selectedGuildId = ids[0];
    }

    const vcSelect = el('voice-channel-select');
    const currentQueue = guild?.queue || null;
    const voiceChannels = guild?.voiceChannels || [];
    const prevVc = vcSelect.value;
    vcSelect.innerHTML = '';

    voiceChannels.forEach((vc) => {
      const opt = document.createElement('option');
      opt.value = vc.id;
      const count = vc.membersCount > 0 ? ` (${vc.membersCount})` : '';
      opt.textContent = `# ${vc.name}${count}`;
      vcSelect.appendChild(opt);
    });

    if (currentQueue?.voiceChannelId && voiceChannels.some((v) => v.id === currentQueue.voiceChannelId)) {
      vcSelect.value = currentQueue.voiceChannelId;
    } else if (prevVc && voiceChannels.some((v) => v.id === prevVc)) {
      vcSelect.value = prevVc;
    } else if (voiceChannels.length > 0) {
      vcSelect.value = voiceChannels[0].id;
    }
  }

  function renderQueueList(queue) {
    const list = el('queue-list');
    const empty = el('queue-empty');
    const summary = el('queue-summary');
    const clearBtn = el('btn-clear-queue');
    const saveQueueBtn = el('btn-save-queue-as-playlist');

    list.textContent = '';
    const upcoming = queue?.upcoming || [];
    const totalCount = queue?.songsCount || 0;

    if (!queue || totalCount <= 1) {
      summary.textContent = queue ? `1 track playing • ${queue.totalFormattedDuration || '0:00'}` : '0 tracks in queue';
      empty.classList.remove('hidden');
      clearBtn.classList.add('hidden');
      saveQueueBtn.classList.add('hidden');
      return;
    }

    if (upcoming.length >= totalCount - 1) {
      summary.textContent = `${totalCount} tracks total • ${queue.totalFormattedDuration || ''}`;
    } else {
      summary.textContent = `${totalCount} tracks total (${upcoming.length} shown up next) • ${queue.totalFormattedDuration || ''}`;
    }
    empty.classList.add('hidden');
    clearBtn.classList.remove('hidden');
    saveQueueBtn.classList.remove('hidden');

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

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-ghost btn-sm';
      saveBtn.textContent = '★';
      saveBtn.title = 'Save track to playlist';
      saveBtn.addEventListener('click', () => openSaveTrackModal(song));

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

      actions.append(saveBtn, jumpBtn, remBtn);
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

    vcBadge.textContent = queue.voiceChannelName ? `# ${queue.voiceChannelName}` : 'In voice';
    el('idle-state').classList.add('hidden');
    el('active-player').classList.remove('hidden');

    const song = queue.currentSong;
    const titleLink = el('track-title');
    titleLink.textContent = song.name || 'Unknown Title';
    titleLink.href = song.url || '#';

    el('track-artist').textContent = song.source ? `Source: ${song.source.toUpperCase()}` : 'Live audio';
    el('track-requester').textContent = song.requestedBy ? `Requested by ${song.requestedBy}` : '';

    // Wire up save current song button
    el('btn-save-current-track').onclick = () => openSaveTrackModal(song);

    const art = el('track-art');
    const fallback = el('track-art-fallback');
    if (song.thumbnail) {
      art.src = song.thumbnail;
      art.classList.remove('hidden');
      fallback.classList.add('hidden');
    } else {
      art.classList.add('hidden');
      fallback.classList.remove('hidden');
    }

    const currentSec = Math.floor(queue.currentTime || 0);
    const totalSec = Math.floor(queue.duration || 0);
    el('time-current').textContent = formatTime(currentSec);
    el('time-total').textContent = song.formattedDuration || formatTime(totalSec);

    const progressPct = totalSec > 0 ? Math.min(100, Math.max(0, (currentSec / totalSec) * 100)) : 0;
    el('progress-fill').style.width = `${progressPct.toFixed(1)}%`;

    const isPlaying = Boolean(queue.playing);
    el('icon-pause').classList.toggle('hidden', !isPlaying);
    el('icon-play').classList.toggle('hidden', isPlaying);

    const loopModes = ['Off', 'Song 🔂', 'Queue 🔁'];
    el('loop-label').textContent = loopModes[queue.repeatMode] || 'Off';
    el('btn-loop').classList.toggle('active', queue.repeatMode > 0);

    el('autoplay-label').textContent = queue.autoplay ? 'Autoplay On' : 'Autoplay Off';
    el('btn-autoplay').classList.toggle('active', Boolean(queue.autoplay));

    if (!isDraggingVolume) {
      el('volume-slider').value = queue.volume || 50;
      el('volume-value').textContent = `${queue.volume || 50}%`;
    }

    const activeFilters = new Set(queue.filters || []);
    document.querySelectorAll('.filter-chip').forEach((chip) => {
      const f = chip.dataset.filter;
      if (f === 'clear') {
        chip.classList.toggle('active', activeFilters.size === 0);
      } else {
        chip.classList.toggle('active', activeFilters.has(f));
      }
    });

    renderQueueList(queue);
  }

  // -----------------------------------------------------------------
  // 5. Firebase State & Results Listeners
  // -----------------------------------------------------------------
  function attachStateListeners() {
    if (unsubState) unsubState();
    if (unsubResult) unsubResult();
    if (unsubSearch) unsubSearch();

    unsubState = onValue(ref(db, 'nobu/state'), (snapshot) => {
      latestState = snapshot.val();
      renderPlayer();
    });

    unsubResult = onValue(ref(db, 'nobu/lastResult'), (snapshot) => {
      const res = snapshot.val();
      if (!res || !res.at) return;
      if (lastHandledResultId === res.at) return;
      lastHandledResultId = res.at;
      if (res.message) {
        showToast(res.message, Boolean(res.ok));
      }
    });

    unsubSearch = onValue(ref(db, 'nobu/searchResults'), (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      if (currentSearchReqId && data.reqId === currentSearchReqId) {
        if (searchTimeoutTimer) {
          clearTimeout(searchTimeoutTimer);
          searchTimeoutTimer = null;
        }
        renderSearchResults(data.results || [], data.query || '');
      }
    });
  }

  // -----------------------------------------------------------------
  // 6. Search Bar & Dropdown Menu
  // -----------------------------------------------------------------
  function renderSearchResults(tracks, query) {
    const menu = el('search-menu');
    const loading = el('search-loading');
    const empty = el('search-empty');
    const list = el('search-results-list');
    const tag = el('search-query-tag');

    loading.classList.add('hidden');
    tag.textContent = query ? `for "${query}"` : '';
    list.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');

    tracks.forEach((track) => {
      const item = document.createElement('li');
      item.className = 'search-result-item';

      const thumb = document.createElement('img');
      thumb.className = 'search-result-thumb';
      thumb.src = track.thumbnail || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'%3E%3Ctext y=\'20\' font-size=\'20\'%3E🎵%3C/text%3E%3C/svg%3E';
      thumb.alt = '';

      const info = document.createElement('div');
      info.className = 'search-result-info';

      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.textContent = track.name || 'Unknown Track';
      title.title = track.name || '';

      const sub = document.createElement('span');
      sub.className = 'search-result-sub';
      sub.textContent = `${track.formattedDuration || 'Live'} • ${track.source ? track.source.toUpperCase() : 'AUDIO'}`;

      info.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'search-result-actions';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-ghost btn-sm';
      saveBtn.textContent = '★ Save';
      saveBtn.title = 'Save to a playlist';
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSaveTrackModal(track);
      });

      const playNowBtn = document.createElement('button');
      playNowBtn.className = 'btn btn-primary btn-sm';
      playNowBtn.textContent = '▶ Play';
      playNowBtn.addEventListener('click', async () => {
        const voiceChannelId = el('voice-channel-select').value;
        showToast(`Playing "${track.name}"`);
        menu.classList.add('hidden');
        await sendCommand('play', {
          query: track.url,
          source: track.source || 'auto',
          voiceChannelId,
          skip: true,
        });
      });

      const queueBtn = document.createElement('button');
      queueBtn.className = 'btn btn-ghost btn-sm';
      queueBtn.textContent = '+ Queue';
      queueBtn.addEventListener('click', async () => {
        const voiceChannelId = el('voice-channel-select').value;
        showToast(`Added "${track.name}" to queue`);
        queueBtn.textContent = '✓ Added';
        await sendCommand('play', {
          query: track.url,
          source: track.source || 'auto',
          voiceChannelId,
          skip: false,
        });
      });

      actions.append(saveBtn, playNowBtn, queueBtn);
      item.append(thumb, info, actions);
      list.appendChild(item);
    });
  }

  el('play-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const queryInput = el('play-query');
    const query = queryInput.value.trim();
    if (!query) return;

    const source = el('play-source').value;
    const isUrl = /^https?:\/\//i.test(query);

    if (isUrl) {
      const voiceChannelId = el('voice-channel-select').value;
      showToast(`Loading URL: ${query}`);
      queryInput.value = '';
      el('search-clear-btn').classList.add('hidden');
      await sendCommand('play', { query, source, voiceChannelId, skip: false });
      return;
    }

    // Text search query -> open search results dropdown menu
    const menu = el('search-menu');
    const loading = el('search-loading');
    const empty = el('search-empty');
    const list = el('search-results-list');
    const tag = el('search-query-tag');
    const loadingText = el('search-loading-text');

    list.innerHTML = '';
    empty.classList.add('hidden');
    tag.textContent = `for "${query}"`;
    const sourceLabel = source === 'spotify' ? 'Spotify' : source === 'youtube' ? 'YouTube' : 'SoundCloud';
    loadingText.textContent = `Searching tracks on ${sourceLabel}…`;
    loading.classList.remove('hidden');
    menu.classList.remove('hidden');

    currentSearchReqId = `search_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    if (searchTimeoutTimer) clearTimeout(searchTimeoutTimer);
    searchTimeoutTimer = setTimeout(() => {
      loading.classList.add('hidden');
      empty.innerHTML = `<span>Search timed out. Make sure Nobu is running and connected.</span>`;
      empty.classList.remove('hidden');
    }, 14000);

    await sendCommand('search', {
      query,
      source,
      reqId: currentSearchReqId,
    });
  });

  el('btn-close-search')?.addEventListener('click', () => {
    el('search-menu').classList.add('hidden');
  });

  el('search-clear-btn')?.addEventListener('click', () => {
    const input = el('play-query');
    input.value = '';
    el('search-clear-btn').classList.add('hidden');
    el('search-menu').classList.add('hidden');
    input.focus();
  });

  el('play-query')?.addEventListener('input', (e) => {
    el('search-clear-btn').classList.toggle('hidden', !e.target.value);
  });

  // -----------------------------------------------------------------
  // 7. Interactive Controls Event Handlers
  // -----------------------------------------------------------------
  el('guild-select')?.addEventListener('change', (e) => {
    selectedGuildId = e.target.value;
    localStorage.setItem('nobu_guild_id', selectedGuildId);
    renderPlayer();
  });

  el('refresh-btn')?.addEventListener('click', () => {
    showToast('Refreshing status…');
    sendCommand('refresh');
  });

  el('signout-btn')?.addEventListener('click', async () => {
    localStorage.removeItem('nobu_discord_user');
    currentDiscordUser = null;
    await signOut(auth);
    showView('auth');
  });

  el('denied-signout-btn')?.addEventListener('click', async () => {
    localStorage.removeItem('nobu_discord_user');
    currentDiscordUser = null;
    await signOut(auth);
    showView('auth');
  });

  el('btn-play-pause')?.addEventListener('click', () => sendCommand('togglePause'));
  el('btn-skip')?.addEventListener('click', () => sendCommand('skip'));
  el('btn-stop')?.addEventListener('click', () => sendCommand('stop'));
  el('btn-shuffle')?.addEventListener('click', () => sendCommand('shuffle'));
  el('btn-loop')?.addEventListener('click', () => sendCommand('loop'));
  el('btn-autoplay')?.addEventListener('click', () => sendCommand('autoplay'));
  el('btn-clear-queue')?.addEventListener('click', () => sendCommand('clearQueue'));

  el('btn-rewind')?.addEventListener('click', () => {
    const current = latestState?.guilds?.[selectedGuildId]?.queue?.currentTime || 0;
    const target = Math.max(0, current - 10);
    sendCommand('seek', { seconds: target });
  });

  el('volume-slider')?.addEventListener('input', (e) => {
    isDraggingVolume = true;
    const val = Number(e.target.value);
    el('volume-value').textContent = `${val}%`;
    if (volumeDebounce) clearTimeout(volumeDebounce);
    volumeDebounce = setTimeout(() => {
      sendCommand('volume', { volume: val });
      isDraggingVolume = false;
    }, 250);
  });

  el('progress-bar-container')?.addEventListener('click', (e) => {
    const queue = latestState?.guilds?.[selectedGuildId]?.queue;
    if (!queue || !queue.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetSeconds = Math.round(pct * queue.duration);
    sendCommand('seek', { seconds: targetSeconds });
  });

  el('filters-grid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    const filter = btn.dataset.filter;
    if (filter) sendCommand('filter', { filter });
  });

  // -----------------------------------------------------------------
  // 8. Auth State Observer
  // -----------------------------------------------------------------
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
      if (unsubState) unsubState();
      if (unsubPlaylists) unsubPlaylists();
      showView('auth');
      return;
    }

    // Determine Discord identity
    const discordId = currentDiscordUser?.id || user.uid.replace(/^discord:/, '');
    const displayName = currentDiscordUser?.globalName || currentDiscordUser?.username || 'Discord User';
    const avatarUrl = currentDiscordUser?.avatarUrl || '';

    el('user-name').textContent = displayName.startsWith('@') ? displayName : `@${displayName}`;
    const avatarImg = el('user-avatar');
    if (avatarUrl) {
      avatarImg.src = avatarUrl;
      avatarImg.classList.remove('hidden');
    } else {
      avatarImg.classList.add('hidden');
    }

    showView('app');
    attachStateListeners();
    initPlaylistsListener(discordId);
  });
}
