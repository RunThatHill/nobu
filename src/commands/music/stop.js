const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');
const { getMemberVoiceChannel } = require('../../utils/voiceUtils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel'),

  async execute(interaction, client) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue) {
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

    await queue.stop();

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.successColor)
          .setDescription('⏹️ Playback stopped and queue cleared by ' + interaction.user.toString()),
      ],
    });
  },
};
