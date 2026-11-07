const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Display information and guide for all Nobu commands'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(config.embedColor)
      .setTitle('🎧 Nobu Music Bot - Command Guide')
      .setDescription(
        'Nobu is a high-performance, crystal-clear music bot supporting YouTube, Spotify, SoundCloud, direct audio links, interactive UI buttons, and sound filters!'
      )
      .addFields(
        {
          name: '🎶 Music Playback Commands',
          value:
            '`/play <query> [source]` - Play a track/playlist (YouTube, Spotify, SoundCloud, direct links)\n' +
            '`/pause` - Pause playback\n' +
            '`/resume` - Resume paused playback\n' +
            '`/skip` - Skip to the next track in queue\n' +
            '`/stop` - Stop playback, clear queue, and leave voice channel\n' +
            '`/nowplaying` - View currently playing song and interactive buttons\n' +
            '`/queue [page]` - Display upcoming songs in queue\n' +
            '`/volume <1-100>` - Adjust playback volume\n' +
            '`/seek <seconds>` - Seek to a position in current song',
          inline: false,
        },
        {
          name: '🎛️ Queue & Audio Controls',
          value:
            '`/loop <mode>` - Set repeat mode (Off, Song, or Queue)\n' +
            '`/shuffle` - Shuffle songs in queue\n' +
            '`/autoplay` - Automatically queue related tracks when queue finishes\n' +
            '`/filter <effect>` - Apply filters: Bass Boost, Nightcore, 3D, Echo, Vaporwave, etc.',
          inline: false,
        },
        {
          name: 'ℹ️ Utility Commands',
          value:
            '`/help` - Show this help guide\n' +
            '`/ping` - Check bot and API latency\n' +
            '`/stats` - View bot resource usage and system status',
          inline: false,
        },
        {
          name: '🎛️ Interactive Buttons',
          value:
            'When a song is playing, Nobu displays interactive buttons beneath the player:\n' +
            '⏯️ **Pause/Resume** | ⏭️ **Skip** | ⏹️ **Stop** | 🔁 **Loop** | 🔀 **Shuffle**',
          inline: false,
        }
      )
      .setFooter({
        text: 'Nobu • Crafted for 24/7 crystal-clear audio',
      })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
