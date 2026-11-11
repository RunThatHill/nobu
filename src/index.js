const {
  Client,
  GatewayIntentBits,
  Collection,
  EmbedBuilder,
  Events: DiscordEvents,
  ActivityType,
  Options,
  REST,
  Routes,
} = require('discord.js');
const { DisTube, DisTubeError, Events: DisTubeEvents } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { SafeYtDlpPlugin } = require('./utils/safeYtDlpPlugin');
const { DirectLinkPlugin } = require('@distube/direct-link');
const { spawnSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const {
  createNowPlayingEmbed,
  createPlayerControls,
} = require('./utils/playerUi');
const { getMemberVoiceChannel } = require('./utils/voiceUtils');
const { OggOpusStream } = require('./utils/oggOpusStream');

// Validate environment variables
const validation = validateConfig();
if (!validation.valid) {
  logger.warn('================================================================');
  logger.warn('WARNING: ' + validation.message);
  logger.warn('Please copy .env.example to .env and configure your bot credentials.');
  logger.warn('Nobu will wait for configuration...');
  logger.warn('================================================================');
}

// Initialize Discord Client with bounded caches to minimize memory footprint
const recentLogs = [];
function addLog(type, msg) {
  const line = `[${new Date().toISOString().substring(11, 19)}] [${type}] ${msg}`;
  recentLogs.push(line);
  if (recentLogs.length > 40) recentLogs.shift();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 10,
    PresenceManager: 0,
    ThreadManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    GuildScheduledEventManager: 0,
    StageInstanceManager: 0,
  }),
});

client.on('debug', (info) => {
  addLog('DEBUG', info);
  logger.info(`[Discord Debug] ${info}`);
});
client.on('warn', (warning) => {
  addLog('WARN', warning);
  logger.warn(`[Discord Warn] ${warning}`);
});
client.on('error', (err) => {
  addLog('ERROR', err.message || String(err));
  logger.error(`[Discord Error]`, err);
});

// Configure DisTube plugins
const plugins = [
  new SpotifyPlugin(
    config.spotify.clientId && config.spotify.clientSecret
      ? {
          api: {
            clientId: config.spotify.clientId,
            clientSecret: config.spotify.clientSecret,
          },
        }
      : {}
  ),
  new SoundCloudPlugin(
    config.soundcloud.clientId
      ? { clientId: config.soundcloud.clientId }
      : {}
  ),
  new DirectLinkPlugin(),
  new SafeYtDlpPlugin({
    update: false,
  }),
];

function binaryHasLibopus(bin) {
  try {
    const check = spawnSync(bin, ['-hide_banner', '-encoders'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    return !check.error && check.status === 0 && (check.stdout || '').includes('libopus');
  } catch (_) {
    return false;
  }
}

/**
 * Prefer lightweight system ffmpeg (e.g., via apt on Linux/Discloud),
 * falling back to ffmpeg-static (Windows / local environments).
 */
function resolveFfmpegInfo() {
  try {
    const sysCheck = spawnSync('ffmpeg', ['-version'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (!sysCheck.error && sysCheck.status === 0) {
      return { path: 'ffmpeg', hasLibopus: binaryHasLibopus('ffmpeg') };
    }
  } catch (_) {}

  try {
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      try {
        fs.chmodSync(ffmpegStatic, 0o755);
      } catch (_) {}
      return { path: ffmpegStatic, hasLibopus: binaryHasLibopus(ffmpegStatic) };
    }
  } catch (_) {}

  return { path: 'ffmpeg', hasLibopus: false };
}

const ffmpegInfo = resolveFfmpegInfo();
const ffmpegPath = ffmpegInfo.path;
logger.info(`Using FFmpeg binary: ${ffmpegPath} (libopus=${ffmpegInfo.hasLibopus})`);

// Initialize DisTube
const distube = new DisTube(client, {
  plugins,
  ffmpeg: {
    path: ffmpegPath,
    args: {
      global: {
        loglevel: 'warning',
        threads: 1,
      },
      input: {
        user_agent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    },
  },
  emitNewSongOnly: true,
  savePreviousSongs: false,
  emitAddSongWhenCreatingQueue: false,
  emitAddListWhenCreatingQueue: false,
  joinNewVoiceChannel: true,
});

// Route DisTube playback through OggOpusStream when FFmpeg supports libopus
// to skip opusscript WASM and JS VolumeTransformer (~20-30 MB RSS reduction).
if (ffmpegInfo.hasLibopus) {
  const queues = distube.queues;
  queues.playSong = async function lowRamPlaySong(queue, emitPlaySong = true) {
    if (!queue) return;
    if (queue.stopped || !queue.songs.length) {
      await queue.stop();
      return;
    }
    try {
      const song = queue.songs[0];
      queues.debug(`[${queue.id}] Getting stream from: ${song}`);
      await queues.handler.attachStreamInfo(song);
      const willPlaySong = song.stream.playFromSource ? song : song.stream.song;
      const stream = willPlaySong?.stream;
      if (!willPlaySong || !stream?.playFromSource || !stream.url) {
        throw new DisTubeError('NO_STREAM_URL', `${song}`);
      }

      if (typeof global.gc === 'function') {
        try {
          global.gc();
        } catch (_) {}
      }

      queues.debug(`[${queue.id}] Creating OggOpusStream for: ${willPlaySong}`);
      const streamOptions = {
        ffmpeg: {
          path: queues.options.ffmpeg.path,
          args: {
            global: { ...queue.ffmpegArgs.global },
            input: { ...queue.ffmpegArgs.input },
            output: { ...queue.ffmpegArgs.output, ...queue.filters.ffmpegArgs },
          },
        },
        seek: willPlaySong.duration ? queue._beginTime : 0,
        volumePercent: queue.volume,
        onVolumeChange: () => {
          setImmediate(() => {
            if (!queue.stopped && queue.songs.length > 0) {
              queue.seek(queue.currentTime || 0).catch(() => {});
            }
          });
        },
      };
      queue._beginTime = 0;

      const dtStream = new OggOpusStream(stream.url, streamOptions);
      dtStream.on('debug', (data) => distube.emit(DisTubeEvents.FFMPEG_DEBUG, `[${queue.id}] ${data}`));
      queues.debug(`[${queue.id}] Started playing: ${willPlaySong}`);
      await queue.voice.play(dtStream);
      if (emitPlaySong) distube.emit(DisTubeEvents.PLAY_SONG, queue, song);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const failedSong = queue.songs.shift();
      try {
        error.name = 'PlayingError';
      } catch (_) {}
      queues.debug(`[${queue.id}] Error while playing: ${error.stack || error.message}`);
      queues.emitError(error, queue, failedSong);
      if (queue.songs.length > 0) {
        await queues.playSong(queue);
      } else {
        await queue.stop();
      }
    }
  };
}

client.distube = distube;
client.commands = new Collection();

// Track recent Now Playing messages and per-guild playback diagnostics
const nowPlayingMessages = new Map();
const playbackDiagnostics = new Map();

function ensurePlaybackDiag(guildId) {
  let diag = playbackDiagnostics.get(guildId);
  if (!diag) {
    diag = {
      songName: null,
      songDuration: 0,
      source: 'unknown',
      startedAt: 0,
      ffmpegLines: [],
      voiceEvents: [],
      lastExit: null,
      audioError: null,
      prematureEndReported: false,
    };
    playbackDiagnostics.set(guildId, diag);
  }
  return diag;
}

function attachVoiceDiagnostics(queue) {
  const voice = queue?.voice;
  if (!voice) return;

  // Raise missed-frame tolerance from default 5 (100ms) to 250 (5s) for HLS/cloud jitter
  if (voice.audioPlayer?.behaviors) {
    voice.audioPlayer.behaviors.maxMissedFrames = 250;
  }

  if (voice.__nobuDiagAttached) return;
  voice.__nobuDiagAttached = true;

  if (voice.audioPlayer) {
    voice.audioPlayer.on('stateChange', (oldState, newState) => {
      const entry = `${oldState.status}->${newState.status}`;
      const diag = ensurePlaybackDiag(queue.id);
      diag.voiceEvents.push(entry);
      if (diag.voiceEvents.length > 10) diag.voiceEvents.shift();
      addLog('VOICE', `[${queue.id}] Player ${entry}`);
    });
    voice.audioPlayer.on('error', (err) => {
      const msg = err?.message || String(err);
      const diag = ensurePlaybackDiag(queue.id);
      diag.audioError = msg;
      addLog('VOICE_ERR', `[${queue.id}] AudioPlayer error: ${msg}`);
      logger.error(`[AudioPlayer Error]`, err);
    });
  }

  if (voice.connection) {
    voice.connection.on('stateChange', (oldState, newState) => {
      addLog('VC', `[${queue.id}] Conn ${oldState.status}->${newState.status}`);
    });
    voice.connection.on('error', (err) => {
      addLog('VC_ERR', `[${queue.id}] Conn error: ${err?.message || err}`);
    });
  }
}

// -------------------------------------------------------------
// 1. Load Slash Commands
// -------------------------------------------------------------
const commandsPath = path.join(__dirname, 'commands');

function loadCommands(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      loadCommands(fullPath);
    } else if (file.endsWith('.js')) {
      const command = require(fullPath);
      if (command.data && command.execute) {
        client.commands.set(command.data.name, command);
        logger.info(`Loaded slash command: /${command.data.name}`);
      }
    }
  }
}

loadCommands(commandsPath);

// -------------------------------------------------------------
// 2. DisTube Audio Events
// -------------------------------------------------------------

// When a queue is initialized, configure voice player resilience & telemetry
distube.on(DisTubeEvents.INIT_QUEUE, (queue) => {
  attachVoiceDiagnostics(queue);
});

// When a song starts playing
distube.on(DisTubeEvents.PLAY_SONG, async (queue, song) => {
  logger.music(`Playing: "${song.name}" in [${queue.voiceChannel?.name || 'Voice'}]`);
  addLog('PLAY', `[${queue.id}] "${song.name}" (${song.duration || 0}s, src=${song.source || 'unknown'})`);

  attachVoiceDiagnostics(queue);

  const diag = ensurePlaybackDiag(queue.id);
  diag.songName = song.name;
  diag.songDuration = song.duration || 0;
  diag.source = song.source || 'unknown';
  diag.startedAt = Date.now();
  diag.audioError = null;
  diag.prematureEndReported = false;

  try {
    const embed = createNowPlayingEmbed(song, queue);
    const components = createPlayerControls(queue);

    // Clean up previous now-playing message if exists
    const previousMsg = nowPlayingMessages.get(queue.id);
    if (previousMsg && typeof previousMsg.delete === 'function') {
      previousMsg.delete().catch(() => {});
    }

    if (queue.textChannel) {
      const msg = await queue.textChannel.send({
        embeds: [embed],
        components,
      });
      // Only track it if the song hasn't already finished prematurely
      if (!diag.prematureEndReported) {
        nowPlayingMessages.set(queue.id, msg);
      }
    }
  } catch (err) {
    logger.error('Error sending now-playing message:', err);
  }
});

// When a single song is added to an existing queue
distube.on(DisTubeEvents.ADD_SONG, (queue, song) => {
  logger.music(`Added to queue: "${song.name}"`);

  if (!queue.textChannel) return;
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle('➕ Added to Queue')
    .setDescription(`[${song.name}](${song.url || ''})`)
    .addFields(
      { name: 'Duration', value: `\`${song.formattedDuration}\``, inline: true },
      { name: 'Position', value: `\`#${queue.songs.length}\``, inline: true },
      { name: 'Requested By', value: `${song.user || 'Unknown'}`, inline: true }
    );

  if (song.thumbnail) {
    embed.setThumbnail(song.thumbnail);
  }

  queue.textChannel.send({ embeds: [embed] }).catch(() => {});
});

// When a playlist is added
distube.on(DisTubeEvents.ADD_LIST, (queue, playlist) => {
  logger.music(`Added playlist: "${playlist.name}" (${playlist.songs.length} tracks)`);

  if (!queue.textChannel) return;
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle('📑 Playlist Added to Queue')
    .setDescription(`[${playlist.name}](${playlist.url || ''})`)
    .addFields(
      { name: 'Tracks Added', value: `\`${playlist.songs.length}\``, inline: true },
      { name: 'Total Duration', value: `\`${playlist.formattedDuration}\``, inline: true },
      { name: 'Requested By', value: `${playlist.user || 'Unknown'}`, inline: true }
    );

  if (playlist.thumbnail) {
    embed.setThumbnail(playlist.thumbnail);
  }

  queue.textChannel.send({ embeds: [embed] }).catch(() => {});
});

// Detect silent/premature stream exits (e.g. OOM SIGKILL or 0-frame EOF)
distube.on(DisTubeEvents.FINISH_SONG, (queue, song) => {
  const diag = playbackDiagnostics.get(queue.id);
  const elapsedSec = diag && diag.startedAt ? (Date.now() - diag.startedAt) / 1000 : 0;
  const voiceSec = queue.voice?.playbackDuration || 0;
  const expectedDur = song?.duration || diag?.songDuration || 0;

  addLog(
    'FINISH_SONG',
    `[${queue.id}] "${song?.name || diag?.songName}" elapsed=${elapsedSec.toFixed(2)}s voice=${voiceSec.toFixed(2)}s/${expectedDur}s`
  );

  if (diag && expectedDur > 10 && elapsedSec < 3.5 && voiceSec < 2) {
    diag.prematureEndReported = true;
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const isSigKill = diag.lastExit && (diag.lastExit.includes('SIGKILL') || diag.lastExit.includes('code=null'));

    logger.warn(
      `Premature stream stop for "${song?.name}": elapsed=${elapsedSec.toFixed(2)}s voice=${voiceSec.toFixed(2)}s RSS=${rssMB}MB exit=${diag.lastExit}`
    );

    if (queue.textChannel) {
      const reasonHint = isSigKill
        ? '**Cause Detected:** FFmpeg was killed by the host OS (`SIGKILL` / Out of Memory). Discloud\'s 100 MB free tier limit is too small for Node.js + FFmpeg audio decoding.'
        : '**Cause:** Audio pipeline ended before sending frames to Discord Voice.';

      const details = [
        `• **Track:** ${song?.name || diag.songName || 'Unknown'} (\`${expectedDur}s\`)`,
        `• **Played:** \`${voiceSec.toFixed(2)}s\` (stopped after \`${elapsedSec.toFixed(2)}s\`)`,
        `• **Host RAM (Node RSS / Heap):** \`${rssMB} MB\` / \`${heapMB} MB\` (plus FFmpeg ~30-45 MB)`,
        `• **FFmpeg Exit:** \`${diag.lastExit || 'unknown'}\``,
        diag.voiceEvents.length ? `• **Voice Player:** \`${diag.voiceEvents.slice(-5).join(' | ')}\`` : null,
        diag.audioError ? `• **Player Error:** \`${diag.audioError}\`` : null,
        diag.ffmpegLines.length
          ? `• **FFmpeg Log:** \`${diag.ffmpegLines.slice(-3).join(' / ').slice(0, 250)}\``
          : null,
      ]
        .filter(Boolean)
        .join('\n');

      const diagEmbed = new EmbedBuilder()
        .setColor(config.errorColor)
        .setTitle('⚠️ Audio Stream Terminated Early')
        .setDescription(`${reasonHint}\n\n${details}`);

      queue.textChannel.send({ embeds: [diagEmbed] }).catch(() => {});
    }
  }
});

// When the queue finishes
distube.on(DisTubeEvents.FINISH, (queue) => {
  logger.music(`Queue finished in [${queue.voiceChannel?.name || 'Voice'}]`);
  const diag = playbackDiagnostics.get(queue.id);

  // If premature failure was just diagnosed, don't delete Now Playing or show misleading "all played"
  if (diag?.prematureEndReported) {
    return;
  }

  // Clean up last now-playing message
  const previousMsg = nowPlayingMessages.get(queue.id);
  if (previousMsg && typeof previousMsg.delete === 'function') {
    previousMsg.delete().catch(() => {});
    nowPlayingMessages.delete(queue.id);
  }

  if (queue.textChannel) {
    const embed = new EmbedBuilder()
      .setColor(config.warningColor)
      .setDescription('🏁 All tracks in the queue have been played. Add more with `/play`!');
    queue.textChannel.send({ embeds: [embed] }).catch(() => {});
  }
});

// When voice channel is empty
distube.on(DisTubeEvents.EMPTY, (queue) => {
  logger.music(`Voice channel empty in [${queue.voiceChannel?.name || 'Voice'}]`);

  if (queue.textChannel) {
    const embed = new EmbedBuilder()
      .setColor(config.warningColor)
      .setDescription(`👋 Voice channel is empty. Nobu will disconnect soon if nobody joins.`);
    queue.textChannel.send({ embeds: [embed] }).catch(() => {});
  }
});

// DisTube error handling
distube.on(DisTubeEvents.ERROR, (error, queue, song) => {
  logger.error('DisTube error occurred:', error);
  addLog('DT_ERR', error?.message || String(error));

  if (queue && queue.textChannel) {
    const embed = new EmbedBuilder()
      .setColor(config.errorColor)
      .setTitle('Playback Error')
      .setDescription(`An error occurred while playing: \`${error.message || 'Stream extraction failed'}\`\n\n*Tip: If YouTube links fail due to datacenter IP blocks, try searching SoundCloud or Spotify instead!*`);
    queue.textChannel.send({ embeds: [embed] }).catch(() => {});
  }
});

// FFMPEG Debug diagnostic capture
distube.on(DisTubeEvents.FFMPEG_DEBUG, (debug) => {
  const str = String(debug || '');
  if (!str.includes('size=')) {
    logger.info(`[FFMPEG Debug] ${str}`);
  }

  const match = /^\[(\d+)\]\s*(.*)$/.exec(str);
  if (match) {
    const guildId = match[1];
    const msg = match[2];
    const diag = ensurePlaybackDiag(guildId);

    if (msg.includes('[process] exit:')) {
      diag.lastExit = msg.replace('[process] exit:', '').trim();
      addLog('FFMPEG', `[${guildId}] ${msg}`);
    } else if (!msg.includes('size=') && !msg.startsWith('[process] spawn:')) {
      diag.ffmpegLines.push(msg);
      if (diag.ffmpegLines.length > 10) diag.ffmpegLines.shift();
      addLog('FFMPEG', `[${guildId}] ${msg.slice(0, 120)}`);
    } else if (msg.startsWith('[process] spawn:')) {
      diag.lastExit = null;
      diag.ffmpegLines = [];
    }
  }
});

// -------------------------------------------------------------
// 3. Discord Client Events & Interactions
// -------------------------------------------------------------

client.once(DiscordEvents.ClientReady, async (c) => {
  logger.success(`=============================================`);
  logger.success(` Nobu Music Bot is ONLINE! Logged in as: ${c.user.tag}`);
  logger.success(` Serving ${c.guilds.cache.size} servers and ${client.commands.size} commands`);
  logger.success(`=============================================`);

  // Set rich Discord presence
  c.user.setPresence({
    activities: [
      {
        name: '/help | /play 🎶',
        type: ActivityType.Listening,
      },
    ],
    status: 'online',
  });

  // Automatically register slash commands with Discord REST API
  try {
    const commandsJson = client.commands.map((cmd) => cmd.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(config.token);

    if (config.guildId) {
      logger.info(`Auto-registering ${commandsJson.length} slash commands to Guild: ${config.guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commandsJson }
      );
      logger.success('Slash commands registered to testing server!');
    } else {
      logger.info(`Auto-registering ${commandsJson.length} global slash commands...`);
      await rest.put(
        Routes.applicationCommands(config.clientId),
        { body: commandsJson }
      );
      logger.success('Global slash commands registered successfully with Discord!');
    }
  } catch (err) {
    logger.warn('Slash command auto-registration notice:', err.message);
  }
});

// Interaction handler (Slash commands & Interactive Buttons)
client.on(DiscordEvents.InteractionCreate, async (interaction) => {
  // A. Slash Command handling
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, client);
    } catch (error) {
      logger.error(`Error executing command /${interaction.commandName}:`, error);
      const replyPayload = {
        content: '❌ There was an error while executing this command!',
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(replyPayload).catch(() => {});
      } else {
        await interaction.reply(replyPayload).catch(() => {});
      }
    }
    return;
  }

  // B. Interactive Player Button handling
  if (interaction.isButton()) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue || !queue.songs || queue.songs.length === 0) {
      return interaction.reply({
        content: '❌ There is no active music playback in this server!',
        ephemeral: true,
      });
    }

    const memberVoice = await getMemberVoiceChannel(interaction);
    if (!memberVoice || memberVoice.id !== queue.voiceChannel?.id) {
      return interaction.reply({
        content: '❌ You must be in the same voice channel as Nobu to use player controls!',
        ephemeral: true,
      });
    }

    const { customId } = interaction;

    try {
      switch (customId) {
        case 'player_pause_resume': {
          const isPaused = typeof queue.isPaused === 'function' ? queue.isPaused() : Boolean(queue.paused);
          if (isPaused) {
            queue.resume();
            await interaction.reply({ content: '▶️ Resumed playback!', ephemeral: true });
          } else {
            queue.pause();
            await interaction.reply({ content: '⏸️ Paused playback!', ephemeral: true });
          }

          // Update now-playing components
          if (queue.songs[0]) {
            const embed = createNowPlayingEmbed(queue.songs[0], queue);
            const components = createPlayerControls(queue);
            await interaction.message.edit({ embeds: [embed], components }).catch(() => {});
          }
          break;
        }

        case 'player_skip': {
          const songName = queue.songs[0]?.name || 'Song';
          if (queue.songs.length <= 1 && !queue.autoplay && queue.repeatMode === 0) {
            await queue.stop();
            await interaction.reply({ content: `⏭️ Skipped **${songName}**. Queue ended.`, ephemeral: true });
          } else {
            await queue.skip();
            await interaction.reply({ content: `⏭️ Skipped **${songName}**!`, ephemeral: true });
          }
          break;
        }

        case 'player_stop': {
          await queue.stop();
          await interaction.reply({ content: `⏹️ Playback stopped by ${interaction.user.toString()}` });
          break;
        }

        case 'player_loop': {
          // Cycle: 0 (Off) -> 1 (Song) -> 2 (Queue) -> 0 (Off)
          const nextMode = (queue.repeatMode + 1) % 3;
          queue.setRepeatMode(nextMode);

          const modeLabels = ['Off ❌', 'Repeat Song 🔂', 'Repeat Queue 🔁'];
          await interaction.reply({
            content: `🔁 Loop mode updated: **${modeLabels[nextMode]}**`,
            ephemeral: true,
          });

          // Refresh buttons with updated loop style
          if (queue.songs[0]) {
            const embed = createNowPlayingEmbed(queue.songs[0], queue);
            const components = createPlayerControls(queue);
            await interaction.message.edit({ embeds: [embed], components }).catch(() => {});
          }
          break;
        }

        case 'player_shuffle': {
          if (queue.songs.length <= 1) {
            return interaction.reply({
              content: '⚠️ Need at least 2 songs in the queue to shuffle!',
              ephemeral: true,
            });
          }
          await queue.shuffle();
          await interaction.reply({
            content: `🔀 Shuffled **${queue.songs.length - 1}** songs in queue!`,
            ephemeral: true,
          });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      logger.error('Button interaction error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ Action failed: ${err.message}`, ephemeral: true }).catch(() => {});
      }
    }
  }
});

// -------------------------------------------------------------
// 4. Classic Message Prefix Fallback (e.g. !play, !skip, !help)
// -------------------------------------------------------------
client.on(DiscordEvents.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  const voiceChannel = await getMemberVoiceChannel(message);

  if (commandName === 'play' || commandName === 'p') {
    if (!voiceChannel) {
      return message.reply('❌ You must be in a voice channel to use Nobu!');
    }
    let query = args.join(' ');
    if (!query) {
      return message.reply('⚠️ Please provide a song name or link! (e.g. `!play lofi beats`)');
    }

    if (!query.startsWith('http://') && !query.startsWith('https://')) {
      const scPlugin = distube.plugins.find((p) => p.constructor.name === 'SoundCloudPlugin');
      if (scPlugin) {
        try {
          const results = await scPlugin.search(query, 'track', 1);
          if (results && results.length > 0 && results[0]?.url) {
            query = results[0].url;
          }
        } catch (_) {}
      }
    }

    try {
      await distube.play(voiceChannel, query, {
        textChannel: message.channel,
        member: message.member,
        message,
      });
      message.react('🎶').catch(() => {});
    } catch (err) {
      message.reply(`❌ Playback error: ${err.message}`);
    }
  } else if (commandName === 'skip' || commandName === 's') {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply('❌ Nothing is playing!');
    try {
      await queue.skip();
      message.react('⏭️').catch(() => {});
    } catch (err) {
      message.reply(`❌ Cannot skip: ${err.message}`);
    }
  } else if (commandName === 'stop') {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply('❌ Nothing is playing!');
    await queue.stop();
    message.react('⏹️').catch(() => {});
  } else if (commandName === 'help' || commandName === 'h') {
    message.reply('Use slash commands (`/help`, `/play`, `/queue`, `/nowplaying`) for the modern interactive Nobu experience!');
  }
});

// -------------------------------------------------------------
// 5. Lightweight Built-in HTTP Health Server (~0 MB extra RAM)
// -------------------------------------------------------------
let loginError = null;
let isConnected = false;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  const mem = process.memoryUsage();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: isConnected ? 'online' : loginError ? 'error' : 'connecting',
      discordConnected: isConnected,
      loginError,
      tokenConfigured: Boolean(config.token && config.token.length > 10),
      tokenLength: config.token ? config.token.length : 0,
      botTag: client.user ? client.user.tag : loginError || 'Connecting...',
      uptimeSeconds: Math.floor(process.uptime()),
      pingMs: client.ws ? Math.round(client.ws.ping) : null,
      guildsCount: client.guilds ? client.guilds.cache.size : 0,
      memoryMB: {
        rss: Number((mem.rss / 1024 / 1024).toFixed(1)),
        heapUsed: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
        heapTotal: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
      },
      ffmpegPath,
      libopus: ffmpegInfo.hasLibopus,
      timestamp: new Date().toISOString(),
      diagnostics: Object.fromEntries(playbackDiagnostics),
      recentLogs,
    })
  );
});

server.listen(config.port, () => {
  logger.info(`Nobu keep-alive HTTP server is listening on port ${config.port}`);
});

// -------------------------------------------------------------
// 6. Login and Graceful Shutdown
// -------------------------------------------------------------
if (config.token) {
  logger.info(`Attempting login with token of length ${config.token.length}...`);
  client.login(config.token)
    .then(() => {
      isConnected = true;
      loginError = null;
    })
    .catch((err) => {
      loginError = err.message || String(err);
      logger.error('Failed to log in to Discord:', err);
    });
} else {
  loginError = 'DISCORD_TOKEN environment variable is missing or empty in Render';
  logger.warn('DISCORD_TOKEN is not set. Nobu web server is running. Set credentials in .env to connect to Discord.');
}

// Graceful shutdown handling
function handleShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down Nobu gracefully...`);
  server.close();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Prevent uncaught errors from crashing the bot
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});
