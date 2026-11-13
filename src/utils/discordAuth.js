const crypto = require('crypto');
const https = require('https');
const { config } = require('../config');
const logger = require('./logger');

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function resolveRedirectUri(req) {
  const host = req?.headers?.host || '';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `http://${host}/api/auth/discord/callback`;
  }
  return 'https://nobu-production-943fc9a4.up.railway.app/api/auth/discord/callback';
}

/**
 * Mint a standard Firebase Custom Auth Token using RSA256 signature
 * from the service account private key in .env.
 */
function mintFirebaseCustomToken(discordUserId, claims = {}) {
  const fb = config.firebase;
  if (!fb.clientEmail || !fb.privateKey) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: fb.clientEmail,
      sub: fb.clientEmail,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: now,
      exp: now + 3600, // 1 hour token
      uid: `discord:${discordUserId}`,
      claims: {
        provider: 'discord',
        discordId: discordUserId,
        ...claims,
      },
    })
  );

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = base64UrlEncode(signer.sign(fb.privateKey));
  return `${header}.${payload}.${signature}`;
}

function httpsPostForm(urlStr, formData) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(formData).toString();
    const parsed = new URL(urlStr);
    const req = https.request(
      parsed,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent': 'DiscordBot (https://github.com/RunThatHill/nobu, 1.0.0)',
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(json.error_description || json.error || `HTTP ${res.statusCode}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${body.slice(0, 100)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Discord token exchange timed out')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGetJson(urlStr, bearerToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = https.request(
      parsed,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'User-Agent': 'DiscordBot (https://github.com/RunThatHill/nobu, 1.0.0)',
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(json.message || `HTTP ${res.statusCode}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${body.slice(0, 100)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Discord API request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Builds the Discord OAuth2 Authorization URL
 */
function getDiscordAuthUrl(req, returnUrl = 'https://nobu-181df.web.app') {
  const redirectUri = resolveRedirectUri(req);
  const statePayload = {
    returnUrl,
    ts: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const state = base64UrlEncode(JSON.stringify(statePayload));
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'identify guilds',
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchanges authorization code with Discord and returns authenticated user details + Firebase custom token
 */
async function exchangeCodeForUser(req, code, stateStr) {
  const redirectUri = resolveRedirectUri(req);
  let returnUrl = 'https://nobu-181df.web.app';
  try {
    if (stateStr) {
      const decoded = JSON.parse(Buffer.from(stateStr, 'base64').toString('utf8'));
      if (decoded.returnUrl) returnUrl = decoded.returnUrl;
    }
  } catch (_) {}

  // 1. Exchange code for access token
  const tokenData = await httpsPostForm('https://discord.com/api/oauth2/token', {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const accessToken = tokenData.access_token;
  if (!accessToken) {
    throw new Error('No access_token returned by Discord');
  }

  // 2. Fetch user profile
  const user = await httpsGetJson('https://discord.com/api/users/@me', accessToken);
  if (!user || !user.id) {
    throw new Error('Could not fetch user profile from Discord');
  }

  // 3. Fetch user's joined guilds
  let userGuilds = [];
  try {
    userGuilds = await httpsGetJson('https://discord.com/api/users/@me/guilds', accessToken);
  } catch (err) {
    logger.warn(`[DiscordAuth] Could not fetch user guilds: ${err.message}`);
  }

  // 4. Mint Firebase custom auth token
  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`;

  const customToken = mintFirebaseCustomToken(user.id, {
    username: user.username,
    globalName: user.global_name || user.username,
    avatar: avatarUrl,
  });

  return {
    user: {
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      discriminator: user.discriminator || '0',
      avatar: user.avatar,
      avatarUrl,
    },
    guildIds: Array.isArray(userGuilds) ? userGuilds.map((g) => g.id) : [],
    customToken,
    returnUrl,
  };
}

module.exports = {
  getDiscordAuthUrl,
  exchangeCodeForUser,
  mintFirebaseCustomToken,
  resolveRedirectUri,
};
