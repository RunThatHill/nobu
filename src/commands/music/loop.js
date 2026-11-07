const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set the loop repeat mode for the current song or entire queue')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Disable Loop', value: '0' },
          { name: 'Repeat Song', value: '1' },
          { name: 'Repeat Queue', value: '2' }
        )
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

    const mode = parseInt(interaction.options.getString('mode'), 10);
    const result = queue.setRepeatMode(mode);

    const modeText = result === 1 ? '🔂 Repeating current song' : result === 2 ? '🔁 Repeating entire queue' : '❌ Loop disabled';

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.successColor)
          .setDescription(`**Loop Mode:** ${modeText}`),
      ],
    });
  },
};
