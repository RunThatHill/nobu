const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the currently playing track'),

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

    try {
      const currentSong = queue.songs[0];
      if (queue.songs.length <= 1 && !queue.autoplay && queue.repeatMode === 0) {
        await queue.stop();
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(config.successColor)
              .setDescription(`⏭️ Skipped **${currentSong.name}**. No more tracks in queue.`),
          ],
        });
      }

      const song = await queue.skip();
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(config.successColor)
            .setDescription(`⏭️ Skipped **${currentSong.name}**! Now playing **${song.name}**.`),
        ],
      });
    } catch (err) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(config.errorColor)
            .setDescription(`❌ Could not skip: \`${err.message || 'End of queue'}\``),
        ],
        ephemeral: true,
      });
    }
  },
};
