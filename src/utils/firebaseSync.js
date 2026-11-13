const crypto = require('crypto');
const https = require('https');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { config } = require('../config');
const logger = require('./logger');
const { resolvePlayQuery } = require('./soundcloudUtils');

function httpsRequest(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      urlString,
      { method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            text,
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

const ALLOWED_FILTERS = new Set([
  'clear',
  'bassboost',
  'nightcore',
  '3d',
  'echo',
  'karaoke',
  'vaporwave',
  'flanger',
]);

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function serializeSong(song) {
  if (!song) return null;
  const requester =
    song.user?.displayName ||
    song.user?.username ||
    song.user?.tag ||
    (typeof song.user === 'string' ? song.user : null) ||
    'Dashboard';

  return {
    name: song.name || 'Unknown Track',
    url: song.url || '',
    thumbnail: song.thumbnail || '',
    duration: Number(song.duration) || 0,
    formattedDuration: song.formattedDuration || (song.duration ? `${song.duration}s` : 'Live'),
    source: song.source || 'unknown',
    requestedBy: requester,
  };
}

/**
 * Lightweight, zero-dependency Firebase Realtime Database sync & command bridge.
 * Uses Node's built-in fetch + crypto so Nobu stays well under Discloud's 100 MB RAM cap.
 */
function createFirebaseSync({ client, distube, scPlugin, ytPlugin }) {
  const fb = config.firebase || {};
  const dbUrl = fb.databaseUrl;
  const hasServiceAccount = Boolean(fb.clientEmail && fb.privateKey);
  const hasSecret = Boolean(fb.dbSecret);
  const enabled = Boolean(dbUrl && (hasServiceAccount || hasSecret));

  let stopped = false;
  let started = false;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let syncTimer = null;
  let heartbeatTimer = null;
  let streamAbort = null;
  let reconnectTimer = null;
  let streamRefreshTimer = null;
  let syncInFlight = false;
  let syncQueued = false;
  let reconnectDelayMs = 2000;
  const processingIds = new Set();

  function isEnabled() {
    return enabled;
  }

  async function getAuthQueryParam() {
    if (hasServiceAccount) {
      const token = await getServiceAccountAccessToken();
      return `access_token=${encodeURIComponent(token)}`;
    }
    if (hasSecret) {
      return `auth=${encodeURIComponent(fb.dbSecret)}`;
    }
    throw new Error('Firebase credentials are not configured.');
  }

  async function getServiceAccountAccessToken() {
    const nowSec = Math.floor(Date.now() / 1000);
    if (accessToken && tokenExpiresAt - 300 > nowSec) {
      return accessToken;
    }

    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64UrlEncode(
      JSON.stringify({
        iss: fb.clientEmail,
        scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
        aud: 'https://oauth2.googleapis.com/token',
        exp: nowSec + 3600,
        iat: nowSec,
      })
    );
    const signingInput = `${header}.${claims}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = base64UrlEncode(signer.sign(fb.privateKey));
    const jwt = `${signingInput}.${signature}`;

    const res = await httpsRequest('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
      timeoutMs: 10000,
    });

    if (!res.ok) {
      throw new Error(`Google OAuth token error (${res.status}): ${res.text.slice(0, 200)}`);
    }

    const data = JSON.parse(res.text);
    accessToken = data.access_token;
    tokenExpiresAt = nowSec + (Number(data.expires_in) || 3600);
    return accessToken;
  }

  async function rtdbRequest(method, nodePath, body) {
    const authParam = await getAuthQueryParam();
    const cleanPath = nodePath.startsWith('/') ? nodePath : `/${nodePath}`;
    const url = `${dbUrl}${cleanPath}.json?${authParam}`;
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload !== null) {
      headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    const res = await httpsRequest(url, {
      method,
      headers,
      body: payload,
      timeoutMs: 10000,
    });
    if (!res.ok) {
      throw new Error(`RTDB ${method} ${cleanPath} failed (${res.status}): ${res.text.slice(0, 160)}`);
    }
    if (method === 'DELETE' || res.status === 204 || !res.text) return null;
    try {
      return JSON.parse(res.text);
    } catch (_) {
      return null;
    }
  }

  function buildGuildState(guild) {
    const voiceChannels = [];
    for (const ch of guild.channels.cache.values()) {
      if (
        ch &&
        (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) &&
        ch.id !== guild.afkChannelId &&
        ch.joinable
      ) {
        voiceChannels.push({
          id: ch.id,
          name: ch.name,
          membersCount: ch.members ? ch.members.filter((m) => !m.user?.bot).size : 0,
        });
      }
    }
    voiceChannels.sort((a, b) => b.membersCount - a.membersCount || a.name.localeCompare(b.name));

    const queue = distube.getQueue(guild.id);
    let queueState = null;

    if (queue && queue.songs && queue.songs.length > 0) {
      const isPaused = typeof queue.isPaused === 'function' ? queue.isPaused() : Boolean(queue.paused);
      const currentSong = queue.songs[0];

      queueState = {
        playing: !isPaused,
        paused: isPaused,
        currentTime: Math.floor(queue.currentTime || 0),
        formattedCurrentTime: queue.formattedCurrentTime || '00:00',
        duration: Number(currentSong?.duration) || 0,
        formattedDuration: currentSong?.formattedDuration || 'Live',
        volume: queue.volume,
        repeatMode: queue.repeatMode || 0,
        autoplay: Boolean(queue.autoplay),
        filters: [...(queue.filters?.names || [])],
        voiceChannelId: queue.voiceChannel?.id || null,
        voiceChannelName: queue.voiceChannel?.name || null,
        songsCount: queue.songs.length,
        totalFormattedDuration: queue.formattedDuration || '00:00',
        currentSong: serializeSong(currentSong),
        upcoming: queue.songs.slice(1, 201).map((song, idx) => ({
          index: idx + 1,
          ...serializeSong(song),
        })),
      };
    }

    return {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 128 }) || null,
      voiceChannels: voiceChannels.slice(0, 15),
      queue: queueState,
    };
  }

  function buildStateSnapshot() {
    const mem = process.memoryUsage();
    const guilds = {};
    let hasActiveQueue = false;

    for (const guild of client.guilds.cache.values()) {
      const state = buildGuildState(guild);
      if (state.queue) hasActiveQueue = true;
      guilds[guild.id] = state;
    }

    return {
      hasActiveQueue,
      payload: {
        bot: {
          online: client.isReady(),
          tag: client.user?.tag || 'Connecting...',
          avatar: client.user?.displayAvatarURL({ size: 128 }) || null,
          uptimeSeconds: Math.floor(process.uptime()),
          pingMs: client.ws ? Math.round(client.ws.ping) : null,
          memoryRssMB: Number((mem.rss / 1024 / 1024).toFixed(1)),
          updatedAt: Date.now(),
        },
        guilds,
      },
    };
  }

  async function syncNow() {
    if (!enabled || stopped || !client.isReady()) return;
    if (syncInFlight) {
      syncQueued = true;
      return;
    }
    syncInFlight = true;
    try {
      const { payload } = buildStateSnapshot();
      await rtdbRequest('PUT', '/nobu/state', payload);
    } catch (err) {
      logger.warn(`[FirebaseSync] State sync failed: ${err.message}`);
    } finally {
      syncInFlight = false;
      if (syncQueued) {
        syncQueued = false;
        scheduleSync(150);
      }
    }
  }

  function scheduleSync(delayMs = 250) {
    if (!enabled || stopped) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncNow();
    }, delayMs);
  }

  function scheduleHeartbeat() {
    if (!enabled || stopped) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const hasActiveQueue = distube.queues && distube.queues.size > 0;
    const intervalMs = hasActiveQueue ? 10000 : 45000;
    heartbeatTimer = setTimeout(async () => {
      await syncNow();
      scheduleHeartbeat();
    }, intervalMs);
  }

  function findVoiceChannelForPlay(guild, requestedChannelId) {
    if (requestedChannelId) {
      const ch = guild.channels.cache.get(requestedChannelId);
      if (ch && ch.isVoiceBased() && ch.joinable) return ch;
    }

    const activeQueue = distube.getQueue(guild.id);
    if (activeQueue?.voiceChannel) return activeQueue.voiceChannel;

    const populated = guild.channels.cache.find(
      (ch) =>
        ch &&
        (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) &&
        ch.id !== guild.afkChannelId &&
        ch.joinable &&
        ch.members.some((m) => !m.user?.bot)
    );
    if (populated) return populated;

    return guild.channels.cache.find(
      (ch) =>
        ch &&
        (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) &&
        ch.id !== guild.afkChannelId &&
        ch.joinable
    );
  }

  function findSendableTextChannel(guild, queue) {
    if (queue?.textChannel) return queue.textChannel;
    const me = guild.members.me;
    return guild.channels.cache.find((ch) => {
      if (!ch || ch.type !== ChannelType.GuildText) return false;
      if (!me) return true;
      const perms = ch.permissionsFor(me);
      return Boolean(perms?.has(PermissionFlagsBits.SendMessages) && perms?.has(PermissionFlagsBits.ViewChannel));
    });
  }

  async function publishCommandResult(cmdId, action, ok, message, guildId) {
    try {
      await rtdbRequest('PUT', '/nobu/lastResult', {
        id: cmdId,
        action,
        ok,
        message,
        guildId: guildId || null,
        at: Date.now(),
      });
    } catch (err) {
      logger.warn(`[FirebaseSync] Failed writing command result: ${err.message}`);
    }
  }

  async function executeAction(cmd) {
    const action = String(cmd.action || '').trim();
    const guildId = String(cmd.guildId || '').trim();

    if (action === 'refresh') {
      return { ok: true, message: 'Refreshed playback state' };
    }

    if (action === 'search') {
      const rawQuery = String(cmd.query || '').trim();
      const reqId = String(cmd.reqId || '').trim();
      const source = String(cmd.source || 'auto').toLowerCase();
      if (!rawQuery) {
        return { ok: false, message: 'Please enter a search query.' };
      }

      let results = [];
      try {
        if (source === 'youtube' && ytPlugin && typeof ytPlugin.searchYouTube === 'function') {
          results = await ytPlugin.searchYouTube(rawQuery, 8);
        } else if (scPlugin) {
          const rawResults = await scPlugin.search(rawQuery, 'track', 8);
          if (Array.isArray(rawResults)) {
            results = rawResults
              .filter((r) => r && r.url && !r.url.includes('/cbcs/'))
              .map((r) => ({
                name: r.name || 'Unknown Track',
                url: r.url,
                duration: Number(r.duration) || 0,
                formattedDuration: r.formattedDuration || (r.duration ? `${Math.round(r.duration)}s` : 'Live'),
                thumbnail: r.thumbnail || '',
                uploader: r.uploader?.name || 'SoundCloud',
                source: 'soundcloud',
              }));
          }
        }

        // If primary search returned no results, try YouTube fallback
        if (results.length === 0 && source !== 'youtube' && ytPlugin && typeof ytPlugin.searchYouTube === 'function') {
          results = await ytPlugin.searchYouTube(rawQuery, 8);
        }
      } catch (searchErr) {
        logger.warn(`[FirebaseSync] Search error: ${searchErr.message}`);
        if (results.length === 0 && ytPlugin && typeof ytPlugin.searchYouTube === 'function') {
          try {
            results = await ytPlugin.searchYouTube(rawQuery, 8);
          } catch (_) {}
        }
      }

      await rtdbRequest('PUT', '/nobu/searchResults', {
        reqId,
        query: rawQuery,
        results,
        at: Date.now(),
      });

      return { ok: true, message: `Found ${results.length} results for "${rawQuery}"` };
    }

    if (!guildId || !client.guilds.cache.has(guildId)) {
      return { ok: false, message: 'Please select an authorized Discord server.' };
    }

    const guild = client.guilds.cache.get(guildId);

    // Security Guild Membership Verification:
    // If command was sent by a Discord user, ensure they are an active member of this server!
    if (cmd.discordUserId) {
      const isMember =
        guild.members.cache.has(cmd.discordUserId) ||
        Boolean(await guild.members.fetch(cmd.discordUserId).catch(() => null));

      if (!isMember) {
        logger.warn(
          `[Security] Blocked unauthorized command "${action}" from Discord user ${cmd.discordUserId} (${cmd.discordUsername || 'unknown'}) on server ${guild.id}`
        );
        return {
          ok: false,
          message: 'Access Denied: You must be a member of this server to manage music playback.',
        };
      }
    }

    const queue = distube.getQueue(guild.id);

    if (action === 'play') {
      const rawQuery = String(cmd.query || '').trim();
      if (!rawQuery) {
        return { ok: false, message: 'Please enter a song name or URL.' };
      }

      const voiceChannel = findVoiceChannelForPlay(guild, cmd.voiceChannelId);
      if (!voiceChannel) {
        return { ok: false, message: 'No joinable voice channel found in this server.' };
      }

      const source = String(cmd.source || 'auto');
      const query = await resolvePlayQuery(scPlugin, rawQuery, source);
      const textChannel = findSendableTextChannel(guild, queue);
      const member = cmd.discordUserId ? (guild.members.cache.get(cmd.discordUserId) || await guild.members.fetch(cmd.discordUserId).catch(() => null)) : undefined;

      const playOpts = { textChannel, member };
      if (cmd.skip === true) {
        playOpts.skip = true;
      }

      await distube.play(voiceChannel, query, playOpts);
      return { ok: true, message: `${cmd.skip ? 'Playing' : 'Queued'} "${rawQuery}" in #${voiceChannel.name}` };
    }

    if (action === 'playPlaylist') {
      const tracks = Array.isArray(cmd.tracks) ? cmd.tracks : [];
      if (tracks.length === 0) {
        return { ok: false, message: 'This playlist has no tracks to play.' };
      }

      const voiceChannel = findVoiceChannelForPlay(guild, cmd.voiceChannelId);
      if (!voiceChannel) {
        return { ok: false, message: 'No joinable voice channel found in this server.' };
      }

      const textChannel = findSendableTextChannel(guild, queue);
      const member = cmd.discordUserId ? (guild.members.cache.get(cmd.discordUserId) || await guild.members.fetch(cmd.discordUserId).catch(() => null)) : undefined;

      // Start playing the first track immediately
      const first = tracks[0];
      const firstQuery = await resolvePlayQuery(scPlugin, first.url || first.name, first.source || 'auto');
      await distube.play(voiceChannel, firstQuery, {
        textChannel,
        skip: Boolean(cmd.skip),
        member,
      });

      // Queue the remaining tracks asynchronously
      if (tracks.length > 1) {
        (async () => {
          for (let i = 1; i < tracks.length; i++) {
            try {
              const t = tracks[i];
              const q = await resolvePlayQuery(scPlugin, t.url || t.name, t.source || 'auto');
              await distube.play(voiceChannel, q, { textChannel, skip: false, member });
            } catch (err) {
              logger.warn(`[FirebaseSync] Error queueing playlist track #${i + 1}: ${err.message}`);
            }
          }
        })().catch(() => {});
      }

      return {
        ok: true,
        message: `Queued playlist "${cmd.playlistName || 'Playlist'}" (${tracks.length} tracks) in #${voiceChannel.name}`,
      };
    }

    if (!queue || !queue.songs || queue.songs.length === 0) {
      return { ok: false, message: 'Nothing is currently playing in this server.' };
    }

    switch (action) {
      case 'pause': {
        const isPaused = typeof queue.isPaused === 'function' ? queue.isPaused() : Boolean(queue.paused);
        if (!isPaused) queue.pause();
        return { ok: true, message: 'Paused playback' };
      }

      case 'resume': {
        const isPaused = typeof queue.isPaused === 'function' ? queue.isPaused() : Boolean(queue.paused);
        if (isPaused) queue.resume();
        return { ok: true, message: 'Resumed playback' };
      }

      case 'togglePause': {
        const isPaused = typeof queue.isPaused === 'function' ? queue.isPaused() : Boolean(queue.paused);
        if (isPaused) {
          queue.resume();
          return { ok: true, message: 'Resumed playback' };
        }
        queue.pause();
        return { ok: true, message: 'Paused playback' };
      }

      case 'skip': {
        const name = queue.songs[0]?.name || 'track';
        if (queue.songs.length <= 1 && !queue.autoplay && queue.repeatMode === 0) {
          await queue.stop();
          return { ok: true, message: `Skipped "${name}" (queue ended)` };
        }
        await queue.skip();
        return { ok: true, message: `Skipped "${name}"` };
      }

      case 'stop': {
        await queue.stop();
        return { ok: true, message: 'Stopped playback and cleared queue' };
      }

      case 'volume': {
        const vol = Math.max(1, Math.min(100, Math.round(Number(cmd.volume) || 50)));
        queue.setVolume(vol);
        return { ok: true, message: `Volume set to ${vol}%` };
      }

      case 'loop': {
        const nextMode =
          cmd.mode === 0 || cmd.mode === 1 || cmd.mode === 2
            ? cmd.mode
            : (queue.repeatMode + 1) % 3;
        const applied = queue.setRepeatMode(nextMode);
        const labels = ['Loop Off', 'Loop Song', 'Loop Queue'];
        return { ok: true, message: labels[applied] || 'Loop updated' };
      }

      case 'shuffle': {
        if (queue.songs.length <= 1) {
          return { ok: false, message: 'Need at least 2 songs in queue to shuffle.' };
        }
        await queue.shuffle();
        return { ok: true, message: `Shuffled ${queue.songs.length - 1} upcoming tracks` };
      }

      case 'autoplay': {
        const enabledAuto = queue.toggleAutoplay();
        return { ok: true, message: `Autoplay ${enabledAuto ? 'enabled' : 'disabled'}` };
      }

      case 'seek': {
        const target = Math.max(0, Math.floor(Number(cmd.seconds) || 0));
        const maxDur = Number(queue.songs[0]?.duration) || 0;
        if (maxDur > 0 && target > maxDur) {
          return { ok: false, message: 'Seek position exceeds track duration.' };
        }
        await queue.seek(target);
        return { ok: true, message: `Jumped to ${target}s` };
      }

      case 'filter': {
        const effect = String(cmd.effect || '').trim().toLowerCase();
        if (!ALLOWED_FILTERS.has(effect)) {
          return { ok: false, message: `Unknown filter: ${effect}` };
        }
        if (effect === 'clear') {
          queue.filters.clear();
          return { ok: true, message: 'Cleared all audio filters' };
        }
        if (queue.filters.has(effect)) {
          queue.filters.remove(effect);
          return { ok: true, message: `Removed filter: ${effect}` };
        }
        queue.filters.add(effect);
        return { ok: true, message: `Applied filter: ${effect}` };
      }

      case 'remove': {
        const idx = Math.floor(Number(cmd.index));
        if (!Number.isFinite(idx) || idx < 1 || idx >= queue.songs.length) {
          return { ok: false, message: 'Invalid queue item index.' };
        }
        const [removed] = queue.songs.splice(idx, 1);
        return { ok: true, message: `Removed "${removed?.name || 'track'}" from queue` };
      }

      case 'jump': {
        const idx = Math.floor(Number(cmd.index));
        if (!Number.isFinite(idx) || idx < 1 || idx >= queue.songs.length) {
          return { ok: false, message: 'Invalid queue item index.' };
        }
        const targetSong = queue.songs[idx];
        await queue.jump(idx);
        return { ok: true, message: `Jumped to "${targetSong?.name || 'track'}"` };
      }

      case 'clearQueue': {
        if (queue.songs.length <= 1) {
          return { ok: false, message: 'No upcoming songs to clear.' };
        }
        const count = queue.songs.length - 1;
        queue.songs.splice(1);
        return { ok: true, message: `Cleared ${count} upcoming track(s)` };
      }

      default:
        return { ok: false, message: `Unsupported action: ${action}` };
    }
  }

  async function processCommand(cmdId, cmd) {
    if (!cmdId || processingIds.has(cmdId)) return;
    processingIds.add(cmdId);

    try {
      if (!cmd || typeof cmd !== 'object' || !cmd.action) {
        await rtdbRequest('DELETE', `/nobu/commands/${cmdId}`).catch(() => {});
        return;
      }

      const ageMs = cmd.createdAt ? Date.now() - Number(cmd.createdAt) : 0;
      if (ageMs > 120000) {
        await rtdbRequest('DELETE', `/nobu/commands/${cmdId}`).catch(() => {});
        return;
      }

      // Authorize command: Allow all Discord-authenticated users, or legacy Google allowlist
      const isDiscordAuth = Boolean(cmd.discordUserId);
      if (!isDiscordAuth && fb.allowedEmails.length > 0) {
        const email = String(cmd.userEmail || '').trim().toLowerCase();
        if (!email || !fb.allowedEmails.includes(email)) {
          logger.warn(`[FirebaseSync] Rejected command "${cmd.action}" from unauthorized email: ${email || 'none'}`);
          await publishCommandResult(cmdId, cmd.action, false, 'Unauthorized account.', cmd.guildId);
          await rtdbRequest('DELETE', `/nobu/commands/${cmdId}`).catch(() => {});
          return;
        }
      }

      let result;
      try {
        result = await executeAction(cmd);
      } catch (err) {
        logger.error(`[FirebaseSync] Command "${cmd.action}" failed:`, err);
        result = { ok: false, message: err?.message || 'Command execution failed.' };
      }

      await rtdbRequest('DELETE', `/nobu/commands/${cmdId}`).catch(() => {});
      await publishCommandResult(cmdId, cmd.action, result.ok, result.message, cmd.guildId);
      scheduleSync(150);
    } finally {
      processingIds.delete(cmdId);
    }
  }

  function handleSseEvent(eventType, rawData) {
    if (!rawData || eventType === 'keep-alive') return;
    if (eventType === 'cancel' || eventType === 'auth_revoked') {
      accessToken = null;
      tokenExpiresAt = 0;
      if (streamAbort) streamAbort.abort();
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch (_) {
      return;
    }

    if (!parsed || parsed.data === null || parsed.data === undefined) return;
    const ssePath = String(parsed.path || '/');

    if (ssePath === '/' && typeof parsed.data === 'object') {
      for (const [cmdId, cmd] of Object.entries(parsed.data)) {
        processCommand(cmdId, cmd);
      }
      return;
    }

    const match = /^\/([^/]+)$/.exec(ssePath);
    if (match) {
      processCommand(match[1], parsed.data);
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const waitMs = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectCommandStream();
    }, waitMs);
  }

  async function connectCommandStream() {
    if (!enabled || stopped) return;
    if (streamAbort) {
      streamAbort.abort();
      streamAbort = null;
    }
    if (streamRefreshTimer) {
      clearTimeout(streamRefreshTimer);
      streamRefreshTimer = null;
    }

    const controller = new AbortController();
    streamAbort = controller;

    // Refresh SSE connection before Google's 60-minute OAuth token expires
    streamRefreshTimer = setTimeout(() => {
      if (streamAbort === controller) {
        controller.abort();
      }
    }, 45 * 60 * 1000);

    try {
      const authParam = await getAuthQueryParam();
      const url = `${dbUrl}/nobu/commands.json?${authParam}`;
      await new Promise((resolve, reject) => {
        const req = https.get(
          url,
          { headers: { Accept: 'text/event-stream' } },
          (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                reject(new Error(`SSE connect failed (${res.statusCode}): ${body.slice(0, 160)}`));
              });
              return;
            }

            reconnectDelayMs = 2000;
            logger.info('[FirebaseSync] Connected to Firebase RTDB command stream.');

            let buffer = '';
            let currentEvent = 'message';
            let currentDataLines = [];

            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              if (stopped || controller.signal.aborted) {
                req.destroy();
                return;
              }
              buffer += chunk;
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line === '') {
                  if (currentDataLines.length > 0) {
                    handleSseEvent(currentEvent, currentDataLines.join('\n'));
                    currentEvent = 'message';
                    currentDataLines = [];
                  }
                } else if (line.startsWith('event:')) {
                  currentEvent = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  currentDataLines.push(line.slice(5).trim());
                }
              }
            });

            res.on('end', resolve);
            res.on('error', reject);
          }
        );

        const onAbort = () => {
          req.destroy();
          resolve();
        };
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener('abort', onAbort, { once: true });
        req.on('error', (err) => {
          if (controller.signal.aborted || stopped) resolve();
          else reject(err);
        });
      });
    } catch (err) {
      if (!stopped && err?.name !== 'AbortError') {
        logger.warn(`[FirebaseSync] Command stream disconnected: ${err.message}`);
      }
    } finally {
      if (streamRefreshTimer) {
        clearTimeout(streamRefreshTimer);
        streamRefreshTimer = null;
      }
      if (streamAbort === controller) {
        streamAbort = null;
      }
      if (!stopped) {
        scheduleReconnect();
      }
    }
  }

  function start() {
    if (!enabled) {
      logger.info('[FirebaseSync] Disabled (FIREBASE_DATABASE_URL / credentials not set).');
      return;
    }
    if (started) return;
    started = true;
    stopped = false;

    logger.info(`[FirebaseSync] Starting sync to ${dbUrl}`);
    syncNow();
    scheduleHeartbeat();
    connectCommandStream();
  }

  function stop() {
    stopped = true;
    if (syncTimer) clearTimeout(syncTimer);
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (streamRefreshTimer) clearTimeout(streamRefreshTimer);
    if (streamAbort) streamAbort.abort();
  }

  return {
    isEnabled,
    start,
    stop,
    syncNow,
    scheduleSync,
  };
}

module.exports = {
  createFirebaseSync,
};
