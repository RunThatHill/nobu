const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');
const { getMemberVoiceChannel } = require('../../utils/voiceUtils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist from YouTube, Spotify, SoundCloud, or direct link')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Song title, artist, or URL (YouTube / Spotify / SoundCloud)')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('source')
        .setDescription('Preferred search provider (helps bypass YouTube blocks on cloud hosting)')
        .setRequired(false)
        .addChoices(
          { name: 'Auto (Recommended)', value: 'auto' },
          { name: 'SoundCloud (Most reliable on cloud hosts)', value: 'soundcloud' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'Spotify', value: 'spotify' }
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

    let query = interaction.options.getString('query').trim();
    const source = interaction.options.getString('source') || 'auto';

    // If user explicitly chose soundcloud and query is not a URL, prefix it or search soundcloud
    if (source === 'soundcloud' && !query.startsWith('http://') && !query.startsWith('https://')) {
      query = `scsearch:${query}`;
    } else if (source === 'youtube' && !query.startsWith('http://') && !query.startsWith('https://')) {
      query = `ytsearch:${query}`;
    }

    await interaction.deferReply();

    try {
      await client.distube.play(voiceChannel, query, {
        textChannel: interaction.channel,
        member: interaction.member,
      });

      const loadingEmbed = new EmbedBuilder()
        .setColor(config.embedColor)
        .setDescription(`🔍 Searching and loading: **${interaction.options.getString('query')}**...`);

      return interaction.editReply({ embeds: [loadingEmbed] });
    } catch (err) {
      console.error('Play error:', err);
      const errEmbed = new EmbedBuilder()
        .setColor(config.errorColor)
        .setTitle('Playback Error')
        .setDescription(`Could not play this track: \`${err.message || 'Unknown error'}\``);

      return interaction.editReply({ embeds: [errEmbed] });
    }
  },
};
