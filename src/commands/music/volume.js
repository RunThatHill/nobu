const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the music playback volume')
    .addIntegerOption((option) =>
      option
        .setName('percent')
        .setDescription('Volume level (1 to 100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    ),

  async execute(interaction, client) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.errorColor).setDescription('❌ There is nothing playing right now!')],
        ephemeral: true,
      });
    }

    if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== queue.voiceChannel?.id) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.errorColor).setDescription('❌ You must be in the same voice channel as Nobu!')],
        ephemeral: true,
      });
    }

    const volume = interaction.options.getInteger('percent');
    queue.setVolume(volume);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.successColor)
          .setDescription(`🔊 Volume set to **${volume}%**`),
      ],
    });
  },
};
