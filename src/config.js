require('dotenv').config();

function normalizePrivateKey(raw) {
  let key = (raw || '').trim().replace(/^["']|["']$/g, '');
  if (!key) return '';
  key = key.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').trim();
  const body = key
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body) return '';
  const isRsa = key.includes('BEGIN RSA PRIVATE KEY');
  const label = isRsa ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const lines = body.match(/.{1,64}/g) || [body];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

const config = {
  // Discord Bot
  token: (process.env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, ''),
  clientId: (process.env.CLIENT_ID || '').trim().replace(/^["']|["']$/g, ''),
  clientSecret: (process.env.DISCORD_CLIENT_SECRET || '').trim().replace(/^["']|["']$/g, ''),
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

  // Firebase Realtime Database Sync for Web Dashboard (Optional)
  firebase: {
    databaseUrl: (process.env.FIREBASE_DATABASE_URL || '').trim().replace(/\/+$/, ''),
    clientEmail: (process.env.FIREBASE_CLIENT_EMAIL || '').trim(),
    privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    dbSecret: (process.env.FIREBASE_DB_SECRET || '').trim(),
    allowedEmails: (process.env.DASHBOARD_ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
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
