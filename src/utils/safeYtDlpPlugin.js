const { PlayableExtractorPlugin, Song, Playlist, DisTubeError } = require('distube');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const isWindows = process.platform === 'win32';
const ytdlpBin = path.resolve(__dirname, '../../node_modules/@distube/yt-dlp/bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp');

// Ensure executable permissions on Linux/macOS
if (!isWindows && fs.existsSync(ytdlpBin)) {
  try {
    fs.chmodSync(ytdlpBin, 0o755);
  } catch (_) {}
}

/**
 * Spawns yt-dlp cleanly without mixing stderr into JSON stdout
 */
function cleanJson(url, extraFlags = [], timeoutMs = 12000) {
  const flags = [
    url,
    '--dump-single-json',
    '--no-warnings',
    '--prefer-free-formats',
    '--skip-download',
    '--simulate',
    '--extractor-args',
    'youtube:player_client=android',
    ...extraFlags,
  ];

  return new Promise((resolve, reject) => {
    const binPath = fs.existsSync(ytdlpBin) ? ytdlpBin : 'yt-dlp';
    const proc = spawn(binPath, flags, { windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      reject(new Error('yt-dlp extraction timed out'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        try {
          const data = JSON.parse(stdout);
          resolve(data);
        } catch (err) {
          reject(new Error(`Failed to parse yt-dlp JSON: ${err.message}`));
        }
      } else {
        reject(new Error(stderr.trim() || `yt-dlp process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn yt-dlp (${binPath}): ${err.message}`));
    });
  });
}

class SafeYtDlpSong extends Song {
  constructor(plugin, info, options = {}) {
    super(
      {
        plugin,
        source: info.extractor || 'youtube',
        playFromSource: true,
        id: info.id ? info.id.toString() : 'unknown',
        name: info.title || 'Unknown Title',
        url: info.webpage_url || info.url || '',
        thumbnail: (info.thumbnails && info.thumbnails[0]?.url) || info.thumbnail || '',
        duration: info.duration || 0,
        views: info.view_count || 0,
        likes: info.like_count || 0,
        uploader: {
          name: info.uploader || 'Unknown',
          url: info.uploader_url || '',
        },
      },
      options
    );
  }
}

class SafeYtDlpPlugin extends PlayableExtractorPlugin {
  constructor(options = {}) {
    super();
    if (options.update === true) {
      try {
        const { download } = require('@distube/yt-dlp');
        download().catch(() => {});
      } catch (_) {}
    }
  }

  /**
   * Only validate direct YouTube URLs or explicit ytsearch: queries.
   * This allows SoundCloud to handle normal text search queries cleanly.
   */
  validate(url) {
    if (typeof url !== 'string') return false;
    return (
      url.includes('youtube.com') ||
      url.includes('youtu.be') ||
      url.startsWith('ytsearch:')
    );
  }

  async resolve(url, options) {
    const info = await cleanJson(url);
    if (Array.isArray(info.entries)) {
      if (info.entries.length === 0) {
        throw new DisTubeError('YTDLP_ERROR', 'The playlist is empty');
      }
      return new Playlist(
        {
          source: info.extractor || 'youtube',
          songs: info.entries.map((i) => new SafeYtDlpSong(this, i, options)),
          id: info.id?.toString(),
          name: info.title,
          url: info.webpage_url,
          thumbnail: info.thumbnails?.[0]?.url,
        },
        options
      );
    }
    return new SafeYtDlpSong(this, info, options);
  }

  async getDirectYouTubeStream(queryOrUrl) {
    const info = await cleanJson(queryOrUrl, ['--format-sort', 'abr,asr', '-f', 'ba/ba*']);
    const entry = Array.isArray(info?.entries) ? info.entries[0] : info;
    if (entry && entry.url) {
      return {
        url: entry.url,
        title: entry.title || queryOrUrl,
        duration: entry.duration || 0,
      };
    }
    return null;
  }

  async getStreamURL(song) {
    if (!song.url) {
      throw new DisTubeError('YTDLP_PLUGIN_INVALID_SONG', 'Cannot get stream url from invalid song.');
    }

    logger.info(`Extracting audio stream for: "${song.name}"`);

    // 1. Attempt direct YouTube stream extraction
    try {
      const direct = await this.getDirectYouTubeStream(song.url);
      if (direct?.url) {
        return direct.url;
      }
    } catch (err) {
      logger.warn(`[SafeYtDlp] Direct YouTube extraction failed (${err.message}). Attempting SoundCloud audio fallback...`);
    }

    // 2. Seamless Fallback: Search SoundCloud for the song title if YouTube blocked the cloud IP
    const scPlugin = this.distube?.plugins?.find((p) => p.constructor.name === 'SoundCloudPlugin');
    if (scPlugin) {
      try {
        const scSong = await scPlugin.searchSong(song.name);
        if (scSong) {
          const scUrl = await scPlugin.getStreamURL(scSong);
          if (scUrl) {
            logger.info(`[SafeYtDlp] Successfully resolved SoundCloud audio fallback for: "${song.name}"`);
            return scUrl;
          }
        }
      } catch (scErr) {
        logger.error(`[SafeYtDlp] SoundCloud fallback failed: ${scErr.message}`);
      }
    }

    throw new DisTubeError('YTDLP_NO_STREAM', `Could not extract audio stream for "${song.name}". YouTube may be blocking datacenter IP requests.`);
  }

  async searchYouTube(query, limit = 8) {
    try {
      const data = await cleanJson(`ytsearch${limit}:${query}`, ['--flat-playlist']);
      const entries = Array.isArray(data?.entries) ? data.entries : (data ? [data] : []);
      return entries.filter((e) => e && (e.title || e.url)).map((e) => {
        const sec = Number(e.duration) || 0;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        const formatted = sec > 0 ? `${m}:${String(s).padStart(2, '0')}` : 'Live';
        return {
          name: e.title || 'Unknown Title',
          url: e.url && e.url.startsWith('http') ? e.url : (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ''),
          duration: sec,
          formattedDuration: formatted,
          thumbnail: (Array.isArray(e.thumbnails) && e.thumbnails[0]?.url) || e.thumbnail || '',
          uploader: e.uploader || e.channel || 'YouTube',
          source: 'youtube',
        };
      });
    } catch (err) {
      logger.warn(`[SafeYtDlp] YouTube search error: ${err.message}`);
      return [];
    }
  }

  getRelatedSongs() {
    return [];
  }
}

module.exports = {
  SafeYtDlpPlugin,
  cleanJson,
};
