const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { config } = require('../config');

/**
 * Creates a visual ASCII progress bar
 */
function createProgressBar(currentSeconds, totalSeconds, length = 15) {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) {
    return '🔴 LIVE STREAM';
  }
  const progress = Math.min(Math.max(currentSeconds / totalSeconds, 0), 1);
  const filled = Math.round(length * progress);
  const empty = length - filled;

  const bar = '▬'.repeat(Math.max(0, filled - 1)) + '🔘' + '▬'.repeat(Math.max(0, empty));
  return bar;
}

/**
 * Generates the "Now Playing" Rich Embed
 */
function createNowPlayingEmbed(song, queue) {
  const currentSeconds = queue.currentTime || 0;
  const totalSeconds = song.duration || 0;
  const progressBar = createProgressBar(currentSeconds, totalSeconds);

  const loopModes = ['Off ❌', 'Repeat Song 🔂', 'Repeat Queue 🔁'];
  const loopStatus = loopModes[queue.repeatMode] || 'Off ❌';

  const activeFilters = queue.filters.names.length > 0
    ? queue.filters.names.join(', ')
    : 'None';

  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setAuthor({
      name: '🎵 Now Playing on Nobu',
      iconURL: 'https://cdn.discordapp.com/emojis/853635604803452948.webp?size=96&quality=lossless',
    })
    .setTitle(song.name ? (song.name.length > 250 ? song.name.substring(0, 247) + '...' : song.name) : 'Unknown Title')
    .setURL(song.url || null)
    .addFields(
      {
        name: '⏱️ Progress',
        value: `\`${queue.formattedCurrentTime || '00:00'}\` ${progressBar} \`${song.formattedDuration || 'Live'}\``,
        inline: false,
      },
      {
        name: '👤 Requested By',
        value: `${song.user || 'Unknown User'}`,
        inline: true,
      },
      {
        name: '🔊 Volume',
        value: `\`${queue.volume}%\``,
        inline: true,
      },
      {
        name: '🔁 Loop',
        value: `\`${loopStatus}\``,
        inline: true,
      },
      {
        name: '🎛️ Filter',
        value: `\`${activeFilters}\``,
        inline: true,
      },
      {
        name: '📻 Autoplay',
        value: queue.autoplay ? '`Enabled ✅`' : '`Disabled ❌`',
        inline: true,
      },
      {
        name: '📑 In Queue',
        value: `\`${queue.songs.length} song${queue.songs.length === 1 ? '' : 's'}\``,
        inline: true,
      }
    )
    .setFooter({
      text: 'Nobu Music • Use the buttons below or slash commands to control playback',
    })
    .setTimestamp();

  if (song.thumbnail) {
    embed.setThumbnail(song.thumbnail);
  }

  return embed;
}

/**
 * Interactive button controls row
 */
function createPlayerControls(queue) {
  const isPaused = typeof queue.isPaused === 'function' ? queue.isPaused() : Boolean(queue.paused);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_pause_resume')
      .setLabel(isPaused ? 'Resume' : 'Pause')
      .setEmoji(isPaused ? '▶️' : '⏸️')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('player_skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('player_loop')
      .setLabel('Loop')
      .setEmoji('🔁')
      .setStyle(queue.repeatMode > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row];
}

/**
 * Creates the Queue Embed with pagination support
 */
function createQueueEmbed(queue, page = 1) {
  const itemsPerPage = 10;
  const songs = queue.songs;
  const totalPages = Math.ceil(songs.length / itemsPerPage) || 1;

  page = Math.max(1, Math.min(page, totalPages));

  const startIndex = (page - 1) * itemsPerPage;
  const currentSongs = songs.slice(startIndex, startIndex + itemsPerPage);

  const description = currentSongs
    .map((song, index) => {
      const position = startIndex + index + 1;
      const isCurrent = position === 1 ? '▶️ **Now Playing:**' : `\`${position}.\``;
      const title = song.name ? (song.name.length > 60 ? song.name.substring(0, 57) + '...' : song.name) : 'Unknown Title';
      return `${isCurrent} [${title}](${song.url || ''}) | \`${song.formattedDuration}\` (Req by: ${song.user})`;
    })
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(`🎶 Queue for ${queue.voiceChannel?.name || 'Voice Channel'}`)
    .setDescription(description || 'The queue is currently empty!')
    .addFields(
      {
        name: 'Total Songs',
        value: `\`${songs.length}\``,
        inline: true,
      },
      {
        name: 'Total Duration',
        value: `\`${queue.formattedDuration}\``,
        inline: true,
      },
      {
        name: 'Loop Mode',
        value: queue.repeatMode === 1 ? '`Song`' : queue.repeatMode === 2 ? '`Queue`' : '`Off`',
        inline: true,
      }
    )
    .setFooter({
      text: `Nobu • Page ${page} of ${totalPages}`,
    })
    .setTimestamp();

  return embed;
}

module.exports = {
  createNowPlayingEmbed,
  createPlayerControls,
  createQueueEmbed,
  createProgressBar,
};
