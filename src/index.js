const {
  Client,
  GatewayIntentBits,
  Collection,
  EmbedBuilder,
  Events: DiscordEvents,
  ActivityType,
  REST,
  Routes,
} = require('discord.js');
const { DisTube, Events: DisTubeEvents } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { DirectLinkPlugin } = require('@distube/direct-link');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const {
  createNowPlayingEmbed,
  createPlayerControls,
} = require('./utils/playerUi');
const { getMemberVoiceChannel } = require('./utils/voiceUtils');

// Validate environment variables
const validation = validateConfig();
if (!validation.valid) {
  logger.warn('================================================================');
  logger.warn('WARNING: ' + validation.message);
  logger.warn('Please copy .env.example to .env and configure your bot credentials.');
  logger.warn('Nobu will wait for configuration...');
  logger.warn('================================================================');
}

// Initialize Discord Client
const recentLogs = [];
function addLog(type, msg) {
  const line = `[${new Date().toISOString().substring(11, 19)}] [${type}] ${msg}`;
  recentLogs.push(line);
  if (recentLogs.length > 25) recentLogs.shift();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
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
  new YtDlpPlugin({
    update: true,
  }),
];

// Initialize DisTube
const distube = new DisTube(client, {
  plugins,
  emitNewSongOnly: true,
  emitAddSongWhenCreatingQueue: false,
  emitAddListWhenCreatingQueue: false,
  joinNewVoiceChannel: true,
});

client.distube = distube;
client.commands = new Collection();

// Track recent Now Playing messages per guild to keep channel clean
const nowPlayingMessages = new Map();

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

// When a song starts playing
distube.on(DisTubeEvents.PLAY_SONG, async (queue, song) => {
  logger.music(`Playing: "${song.name}" in [${queue.voiceChannel?.name || 'Voice'}]`);

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
      nowPlayingMessages.set(queue.id, msg);
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

// When the queue finishes
distube.on(DisTubeEvents.FINISH, (queue) => {
  logger.music(`Queue finished in [${queue.voiceChannel?.name || 'Voice'}]`);

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

  if (queue && queue.textChannel) {
    const embed = new EmbedBuilder()
      .setColor(config.errorColor)
      .setTitle('Playback Error')
      .setDescription(`An error occurred while playing: \`${error.message || 'Stream extraction failed'}\`\n\n*Tip: If YouTube links fail due to datacenter IP blocks, try searching SoundCloud or Spotify instead!*`);
    queue.textChannel.send({ embeds: [embed] }).catch(() => {});
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
    const query = args.join(' ');
    if (!query) {
      return message.reply('⚠️ Please provide a song name or link! (e.g. `!play lofi beats`)');
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
// 5. Lightweight Express Web Server for 24/7 Free Hosting
// -------------------------------------------------------------
let loginError = null;
let isConnected = false;

const app = express();

app.get('/', (req, res) => {
  res.json({
    status: isConnected ? 'online' : (loginError ? 'error' : 'connecting'),
    discordConnected: isConnected,
    loginError: loginError,
    tokenConfigured: Boolean(config.token && config.token.length > 10),
    tokenLength: config.token ? config.token.length : 0,
    botTag: client.user ? client.user.tag : (loginError || 'Connecting...'),
    uptimeSeconds: Math.floor(process.uptime()),
    pingMs: client.ws ? Math.round(client.ws.ping) : null,
    guildsCount: client.guilds ? client.guilds.cache.size : 0,
    timestamp: new Date().toISOString(),
    recentLogs,
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = app.listen(config.port, () => {
  logger.info(`Nobu keep-alive web server is listening on port ${config.port}`);
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
