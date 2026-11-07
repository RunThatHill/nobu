const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume paused playback'),

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

    const isPaused = typeof queue.isPaused === 'function' ? queue.isPaused() : Boolean(queue.paused);
    if (!isPaused) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.warningColor).setDescription('⚠️ The player is not paused!')],
        ephemeral: true,
      });
    }

    queue.resume();

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.successColor)
          .setDescription('▶️ Playback has been **resumed**!'),
      ],
    });
  },
};
