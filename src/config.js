require('dotenv').config();

const config = {
  // Discord Bot
  token: (process.env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, ''),
  clientId: (process.env.CLIENT_ID || '').trim().replace(/^["']|["']$/g, ''),
  guildId: process.env.GUILD_ID || '', // Optional: Instant registration for testing
  prefix: process.env.BOT_PREFIX || '!',
  defaultVolume: parseInt(process.env.DEFAULT_VOLUME || '50', 10),

  // Web Server / Health Check
  port: parseInt(process.env.PORT || '3000', 10),

  // Spotify (Optional)
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || undefined,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || undefined,
  },

  // SoundCloud (Optional)
  soundcloud: {
    clientId: process.env.SOUNDCLOUD_CLIENT_ID || undefined,
  },

  // Bot Theme & Branding
  embedColor: 0x5865F2, // Discord Blurple
  successColor: 0x57F287, // Discord Green
  warningColor: 0xFEE75C, // Discord Yellow
  errorColor: 0xED4245, // Discord Red

  // Audio & Bot Settings
  leaveOnEmptyCooldown: 60, // seconds to wait before leaving an empty voice channel
  leaveOnFinishCooldown: 60, // seconds to wait after queue ends before leaving
};

function validateConfig() {
  const missing = [];
  if (!config.token) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('CLIENT_ID');

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      message: `Missing required environment variables: ${missing.join(', ')}. Please check your .env file.`,
    };
  }
  return { valid: true };
}

module.exports = {
  config,
  validateConfig,
};
