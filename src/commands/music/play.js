const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');
const { getMemberVoiceChannel } = require('../../utils/voiceUtils');
const { resolvePlayQuery } = require('../../utils/soundcloudUtils');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist from SoundCloud, YouTube, Spotify, or direct link')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Song title, artist, or URL')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('source')
        .setDescription('Search provider (SoundCloud recommended for 24/7 cloud hosting)')
        .setRequired(false)
        .addChoices(
          { name: 'Auto / SoundCloud (Recommended & Fastest)', value: 'auto' },
          { name: 'SoundCloud', value: 'soundcloud' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'Spotify Search', value: 'spotify' }
        )
    ),

  async execute(interaction, client) {
    const voiceChannel = await getMemberVoiceChannel(interaction);

    if (!voiceChannel) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(config.errorColor)
            .setDescription('❌ You must be in a voice channel to use Nobu!'),
        ],
        ephemeral: true,
      });
    }

    // Check bot permissions in voice channel
    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (me) {
      const permissions = voiceChannel.permissionsFor(me);
      if (permissions && (!permissions.has('Connect') || !permissions.has('Speak'))) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(config.errorColor)
              .setDescription('❌ I do not have permission to `Connect` and `Speak` in your voice channel!'),
          ],
          ephemeral: true,
        });
      }
    }

    const rawQuery = interaction.options.getString('query').trim();
    const source = interaction.options.getString('source') || 'auto';

    await interaction.deferReply();

    const scPlugin = client.distube.plugins.find((p) => p.constructor.name === 'SoundCloudPlugin');
    const query = await resolvePlayQuery(scPlugin, rawQuery, source);

    if (typeof global.gc === 'function') {
      try {
        global.gc();
      } catch (_) {}
    }

    try {
      await client.distube.play(voiceChannel, query, {
        textChannel: interaction.channel,
        member: interaction.member,
      });

      const originalQuery = interaction.options.getString('query');
      const loadingEmbed = new EmbedBuilder()
        .setColor(config.embedColor)
        .setDescription(`🔍 Searching and loading: **${originalQuery}**...`);

      return interaction.editReply({ embeds: [loadingEmbed] });
    } catch (err) {
      logger.error('Play error:', err);
      const errEmbed = new EmbedBuilder()
        .setColor(config.errorColor)
        .setTitle('Playback Error')
        .setDescription(`Could not play this track: \`${err.message || 'Unknown error'}\``);

      return interaction.editReply({ embeds: [errEmbed] });
    }
  },
};
