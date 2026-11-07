const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the songs currently in the queue'),

  async execute(interaction, client) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue || !queue.songs || queue.songs.length <= 1) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.warningColor).setDescription('⚠️ Need at least 2 songs in the queue to shuffle!')],
        ephemeral: true,
      });
    }

    if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== queue.voiceChannel?.id) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.errorColor).setDescription('❌ You must be in the same voice channel as Nobu!')],
        ephemeral: true,
      });
    }

    await queue.shuffle();

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.successColor)
          .setDescription(`🔀 Shuffled **${queue.songs.length - 1}** upcoming songs in the queue!`),
      ],
    });
  },
};
