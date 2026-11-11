const { DisTubeError } = require('distube');
const logger = require('./logger');

// Short-lived cache (30s) to avoid redundant SoundCloud API calls between search and play
const streamUrlCache = new Map();

function cacheStreamUrl(trackUrl, streamUrl) {
  if (!trackUrl || !streamUrl) return;
  streamUrlCache.set(trackUrl, { url: streamUrl, expiresAt: Date.now() + 30_000 });
  if (streamUrlCache.size > 20) {
    const oldestKey = streamUrlCache.keys().next().value;
    streamUrlCache.delete(oldestKey);
  }
}

function takeCachedStreamUrl(trackUrl) {
  const entry = streamUrlCache.get(trackUrl);
  if (!entry) return null;
  streamUrlCache.delete(trackUrl);
  if (Date.now() > entry.expiresAt) return null;
  return entry.url;
}

function isPlayableStreamUrl(url) {
  return (
    typeof url === 'string' &&
    url.startsWith('http') &&
    !url.includes('/cbcs/')
  );
}

/**
 * Inspects all transcodings of a SoundCloud track, skipping encrypted DRM (/cbcs/)
 * streams and prioritizing progressive MP3 -> standard HLS streams.
 */
async function getUnencryptedStreamForTrack(scPlugin, trackUrl) {
  let track;
  try {
    track = await scPlugin.soundcloud.util.resolveTrack(trackUrl);
  } catch (err) {
    logger.warn(`[SoundCloud] Failed to resolve track metadata (${trackUrl}): ${err.message}`);
    return null;
  }

  const transcodings = [...(track?.media?.transcodings || [])].filter((t) => {
    const proto = t?.format?.protocol || '';
    return !proto.includes('encrypted') && t?.preset !== 'abr_sq';
  });

  // Sort: progressive mp3 first, then hls mp3, then hls aac (hq before lq)
  transcodings.sort((a, b) => {
    const score = (t) => {
      let s = 0;
      if (t.format?.protocol === 'progressive') s += 100;
      if (t.format?.mime_type?.includes('mpeg')) s += 20;
      if (t.quality === 'hq' || t.quality === 'sq') s += 5;
      return s;
    };
    return score(b) - score(a);
  });

  for (const transcoding of transcodings) {
    try {
      const link = await scPlugin.soundcloud.util.getStreamLink(transcoding);
      if (isPlayableStreamUrl(link)) {
        return link;
      }
      if (typeof link === 'string' && link.includes('/cbcs/')) {
        logger.warn(`[SoundCloud] Skipping encrypted /cbcs/ transcoding (${transcoding.preset || transcoding.format?.mime_type}) for "${track.title}"`);
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Searches SoundCloud for up to 5 tracks and returns the first candidate
 * with an unencrypted, FFmpeg-playable audio stream (preferring full tracks > 45s).
 */
async function findPlayableSoundCloudTrack(scPlugin, query, options = {}, excludeUrl = null) {
  let candidates;
  try {
    candidates = await scPlugin.search(query, 'track', 5, options);
  } catch (err) {
    return null;
  }

  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const filtered = candidates.filter((c) => c?.url && c.url !== excludeUrl);
  const fullTracks = filtered.filter((c) => (c.duration || 0) > 45);
  const shortTracks = filtered.filter((c) => (c.duration || 0) <= 45);
  const ordered = [...fullTracks, ...shortTracks];

  for (const candidate of ordered) {
    const streamUrl = await getUnencryptedStreamForTrack(scPlugin, candidate.url);
    if (streamUrl) {
      cacheStreamUrl(candidate.url, streamUrl);
      return { song: candidate, streamUrl };
    }
  }

  return null;
}

/**
 * Enhances SoundCloudPlugin to avoid DRM (/cbcs/) streams, 30s Go+ previews,
 * and seamlessly fall back to another upload or YouTube if a track is DRM-locked.
 */
function enhanceSoundCloudPlugin(scPlugin, getFallbackPlugin) {
  if (!scPlugin || scPlugin.__nobuEnhanced) return scPlugin;
  scPlugin.__nobuEnhanced = true;

  scPlugin.searchSong = async function enhancedSearchSong(query, options = {}) {
    const found = await findPlayableSoundCloudTrack(scPlugin, query, options);
    if (found?.song) return found.song;

    const results = await scPlugin.search(query, 'track', 1, options);
    return results[0];
  };

  scPlugin.getStreamURL = async function enhancedGetStreamURL(song) {
    if (!song?.url) {
      throw new DisTubeError('SOUNDCLOUD_PLUGIN_INVALID_SONG', 'Cannot get stream url from invalid song.');
    }

    const cached = takeCachedStreamUrl(song.url);
    if (cached) return cached;

    const directStream = await getUnencryptedStreamForTrack(scPlugin, song.url);
    if (directStream) return directStream;

    // Fallback 1: Find another unencrypted SoundCloud upload of the same song title
    if (song.name) {
      logger.warn(`[SoundCloud] "${song.name}" had only DRM/unplayable streams. Searching unencrypted SoundCloud alternative...`);
      const alt = await findPlayableSoundCloudTrack(scPlugin, song.name, {}, song.url);
      if (alt?.streamUrl) {
        logger.info(`[SoundCloud] Switched to playable alternative: "${alt.song.name}" (${alt.song.url})`);
        return alt.streamUrl;
      }
    }

    // Fallback 2: YouTube fallback via SafeYtDlpPlugin if available
    const ytPlugin = typeof getFallbackPlugin === 'function' ? getFallbackPlugin() : null;
    if (ytPlugin && song.name) {
      try {
        logger.warn(`[SoundCloud] Attempting YouTube fallback for "${song.name}"...`);
        const ytSong = await ytPlugin.resolve(`ytsearch:${song.name}`, {});
        if (ytSong) {
          const ytUrl = await ytPlugin.getStreamURL(ytSong);
          if (ytUrl) return ytUrl;
        }
      } catch (ytErr) {
        logger.warn(`[SoundCloud] YouTube fallback failed: ${ytErr.message}`);
      }
    }

    throw new DisTubeError(
      'SOUNDCLOUD_PLUGIN_DRM_OR_RATE_LIMITED',
      `Track "${song.name}" is DRM-protected (/cbcs/) or rate-limited with no playable alternative.`
    );
  };

  return scPlugin;
}

module.exports = {
  enhanceSoundCloudPlugin,
  findPlayableSoundCloudTrack,
  getUnencryptedStreamForTrack,
};
