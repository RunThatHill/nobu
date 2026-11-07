const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check Nobu connection latency and Discord API response time'),

  async execute(interaction, client) {
    const sent = await interaction.reply({
      content: '🏓 Pinging...',
      fetchReply: true,
    });

    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const wsLatency = Math.round(client.ws.ping);

    const embed = new EmbedBuilder()
      .setColor(config.embedColor)
      .setTitle('🏓 Pong!')
      .addFields(
        {
          name: '📡 Roundtrip Latency',
          value: `\`${roundtrip}ms\``,
          inline: true,
        },
        {
          name: '💓 WebSocket Heartbeat',
          value: `\`${wsLatency}ms\``,
          inline: true,
        }
      )
      .setTimestamp();

    return interaction.editReply({ content: null, embeds: [embed] });
  },
};
