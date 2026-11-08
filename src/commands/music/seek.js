const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');
const { getMemberVoiceChannel } = require('../../utils/voiceUtils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a specific timestamp in the current track')
    .addIntegerOption((option) =>
      option
        .setName('seconds')
        .setDescription('Target position in seconds (e.g. 90 for 1:30)')
        .setMinValue(0)
        .setRequired(true)
    ),

  async execute(interaction, client) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue || !queue.songs || queue.songs.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.errorColor).setDescription('❌ There is nothing playing right now!')],
        ephemeral: true,
      });
    }

    const memberVoice = await getMemberVoiceChannel(interaction);
    if (!memberVoice || memberVoice.id !== queue.voiceChannel?.id) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.errorColor).setDescription('❌ You must be in the same voice channel as Nobu!')],
        ephemeral: true,
      });
    }

    const seconds = interaction.options.getInteger('seconds');
    const song = queue.songs[0];

    if (song.duration && seconds > song.duration) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(config.warningColor)
            .setDescription(`⚠️ Target timestamp exceeds song length (\`${song.formattedDuration}\`)!`),
        ],
        ephemeral: true,
      });
    }

    await queue.seek(seconds);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.successColor)
          .setDescription(`⏩ Jumped to \`${seconds}\` seconds into the track!`),
      ],
    });
  },
};
