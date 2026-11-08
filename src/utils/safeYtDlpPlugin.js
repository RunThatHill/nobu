const { PlayableExtractorPlugin, Song, Playlist, DisTubeError } = require('distube');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const isWindows = process.platform === 'win32';
const ytdlpBin = path.resolve(__dirname, '../../node_modules/@distube/yt-dlp/bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp');

/**
 * Spawns yt-dlp cleanly without concatenating stderr into JSON output
 */
function cleanJson(url, extraFlags = []) {
  const flags = [
    url,
    '--dump-single-json',
    '--no-warnings',
    '--prefer-free-formats',
    '--skip-download',
    '--simulate',
    ...extraFlags,
  ];

  return new Promise((resolve, reject) => {
    const binPath = fs.existsSync(ytdlpBin) ? ytdlpBin : 'yt-dlp';
    const proc = spawn(binPath, flags);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    proc.on('close', (code) => {
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
    try {
      const { download } = require('@distube/yt-dlp');
      if (options.update !== false) {
        download().catch(() => {});
      }
    } catch (e) {}
  }

  validate() {
    return true;
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

  async getStreamURL(song) {
    if (!song.url) {
      throw new DisTubeError('YTDLP_PLUGIN_INVALID_SONG', 'Cannot get stream url from invalid song.');
    }
    logger.info(`Extracting direct stream URL for: ${song.name}`);
    const info = await cleanJson(song.url, ['-f', 'ba/ba*']);
    if (!info.url) {
      throw new DisTubeError('YTDLP_NO_STREAM', 'No direct stream URL returned by yt-dlp');
    }
    return info.url;
  }

  getRelatedSongs() {
    return [];
  }
}

module.exports = {
  SafeYtDlpPlugin,
};
