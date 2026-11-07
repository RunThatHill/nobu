const { SlashCommandBuilder, EmbedBuilder, version: djsVersion } = require('discord.js');
const os = require('os');
const { config } = require('../../config');

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Display bot statistics, memory usage, and runtime environment'),

  async execute(interaction, client) {
    const memory = process.memoryUsage();
    const usedMemoryMB = (memory.heapUsed / 1024 / 1024).toFixed(2);
    const totalMemoryMB = (memory.heapTotal / 1024 / 1024).toFixed(2);

    const activeQueues = client.distube.queues?.collection?.size || 0;
    const uptime = formatUptime(process.uptime());

    const embed = new EmbedBuilder()
      .setColor(config.embedColor)
      .setTitle('📊 Nobu System Statistics')
      .addFields(
        {
          name: '⏱️ Uptime',
          value: `\`${uptime}\``,
          inline: true,
        },
        {
          name: '🌐 Servers (Guilds)',
          value: `\`${client.guilds.cache.size}\``,
          inline: true,
        },
        {
          name: '👥 Cached Users',
          value: `\`${client.users.cache.size}\``,
          inline: true,
        },
        {
          name: '🎶 Active Music Players',
          value: `\`${activeQueues}\``,
          inline: true,
        },
        {
          name: '💾 Memory Usage',
          value: `\`${usedMemoryMB} MB / ${totalMemoryMB} MB\``,
          inline: true,
        },
        {
          name: '⚙️ Platform / Node',
          value: `\`${os.platform()} (${os.arch()})\`\n\`Node ${process.version}\`\n\`discord.js v${djsVersion}\``,
          inline: true,
        }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
