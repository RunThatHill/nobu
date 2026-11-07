const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');
const { createNowPlayingEmbed, createPlayerControls } = require('../../utils/playerUi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Display the currently playing track with interactive controls'),

  async execute(interaction, client) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue || !queue.songs || queue.songs.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(config.errorColor).setDescription('❌ There is nothing playing right now!')],
        ephemeral: true,
      });
    }

    const currentSong = queue.songs[0];
    const embed = createNowPlayingEmbed(currentSong, queue);
    const components = createPlayerControls(queue);

    return interaction.reply({
      embeds: [embed],
      components,
    });
  },
};
