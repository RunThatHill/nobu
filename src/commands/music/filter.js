const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');
const { getMemberVoiceChannel } = require('../../utils/voiceUtils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Apply an audio filter or sound effect to playback')
    .addStringOption((option) =>
      option
        .setName('effect')
        .setDescription('Filter effect to toggle or clear')
        .setRequired(true)
        .addChoices(
          { name: 'Clear All Filters', value: 'clear' },
          { name: 'Bass Boost', value: 'bassboost' },
          { name: 'Nightcore', value: 'nightcore' },
          { name: '3D Surround', value: '3d' },
          { name: 'Echo', value: 'echo' },
          { name: 'Karaoke (Vocal Cut)', value: 'karaoke' },
          { name: 'Vaporwave (Slowed)', value: 'vaporwave' },
          { name: 'Flanger', value: 'flanger' }
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

    const memberVoice = await getMemberVoiceChannel(interaction);
    if (!memberVoice || memberVoice.id !== queue.voiceChannel?.id) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.errorColor).setDescription('❌ You must be in the same voice channel as Nobu!')],
        ephemeral: true,
      });
    }

    const effect = interaction.options.getString('effect');

    if (effect === 'clear') {
      queue.filters.clear();
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(config.successColor)
            .setDescription('✨ Cleared all active audio filters!'),
        ],
      });
    }

    if (queue.filters.has(effect)) {
      queue.filters.remove(effect);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(config.warningColor)
            .setDescription(`🎛️ Removed filter: **${effect}**`),
        ],
      });
    } else {
      queue.filters.add(effect);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(config.successColor)
            .setDescription(`🎛️ Applied filter: **${effect}** (audio will refresh momentarily)`),
        ],
      });
    }
  },
};
