const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');
const { createQueueEmbed } = require('../../utils/playerUi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Display the current music queue')
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('Page number to view')
        .setMinValue(1)
        .setRequired(false)
    ),

  async execute(interaction, client) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue || !queue.songs || queue.songs.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.warningColor).setDescription('📜 The queue is currently empty!')],
        ephemeral: true,
      });
    }

    const page = interaction.options.getInteger('page') || 1;
    const embed = createQueueEmbed(queue, page);

    return interaction.reply({ embeds: [embed] });
  },
};
