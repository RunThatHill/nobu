const { DisTubeError, Song } = require('distube');
const logger = require('./logger');

// Short-lived cache (30s) to avoid redundant SoundCloud API calls between search and play
const streamUrlCache = new Map();

const VARIANT_TERMS = [
  'remix',
  'slowed',
  'reverb',
  'reverbed',
  'sped up',
  'speed up',
  'nightcore',
  'cover',
  'remake',
  'bootleg',
  'mashup',
  'jersey club',
  '8d',
  'karaoke',
  'instrumental',
  'edit',
  'flip',
  'loop',
  'live',
  'acoustic',
  'type beat',
  'chopnotslop',
];

function containsWordOrPhrase(haystackLower, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystackLower);
}

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

function scoreSoundCloudCandidate(candidate, query, meta = {}) {
  const titleLower = (candidate?.name || '').toLowerCase();
  const uploaderLower = (candidate?.uploader?.name || '').toLowerCase();
  const queryLower = (query || '').toLowerCase();
  const expectedDuration = Number(meta.expectedDuration || 0);
  const artistLower = (meta.artistName || '').split(',')[0].trim().toLowerCase();
  const duration = Number(candidate?.duration || 0);

  let score = 0;
  let isVariant = false;

  // Penalize remixes, covers, slowed, sped-up, loops unless explicitly requested in query
  for (const term of VARIANT_TERMS) {
    if (containsWordOrPhrase(titleLower, term) && !containsWordOrPhrase(queryLower, term)) {
      isVariant = true;
      score -= 1000;
      break;
    }
  }
  if (!isVariant && titleLower.includes(' x ') && !queryLower.includes(' x ')) {
    isVariant = true;
    score -= 800;
  }

  // Filter 30s Go+ previews and match Spotify duration when known
  if (duration > 0 && duration <= 45 && (expectedDuration === 0 || expectedDuration > 55)) {
    score -= 5000;
  } else if (expectedDuration > 45 && duration > 0) {
    const diff = Math.abs(duration - expectedDuration);
    if (diff <= 8) score += 150;
    else if (diff <= 20) score += 90;
    else if (diff <= 40) score += 25;
    else if (diff > 60) score -= 350;
  }

  // Reward artist & title alignment
  if (artistLower && artistLower.length >= 2) {
    if (uploaderLower.includes(artistLower) || titleLower.includes(artistLower)) {
      score += 50;
    }
  }

  const queryTokens = queryLower
    .split(/[^a-z0-9\u0600-\u06FF]+/u)
    .filter((tok) => tok.length >= 2);
  for (const tok of queryTokens) {
    if (titleLower.includes(tok) || uploaderLower.includes(tok)) {
      score += 6;
    }
  }

  const exactDuration = expectedDuration > 45 ? Math.abs(duration - expectedDuration) <= 25 : duration > 45;
  return {
    song: candidate,
    score,
    isVariant,
    isExactMatch: !isVariant && exactDuration,
  };
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
 * Searches SoundCloud for up to 10 tracks, ranks original/duration-matched tracks
 * above remixes/covers/30s previews, and returns the best playable unencrypted stream.
 */
async function findPlayableSoundCloudTrack(scPlugin, query, options = {}, meta = {}) {
  let candidates;
  try {
    candidates = await scPlugin.search(query, 'track', 10, options);
  } catch (_) {
    return null;
  }

  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const excludeUrl = meta.excludeUrl || null;
  const scored = candidates
    .filter((c) => c?.url && c.url !== excludeUrl)
    .map((c) => scoreSoundCloudCandidate(c, query, meta))
    .sort((a, b) => b.score - a.score);

  for (const item of scored) {
    const streamUrl = await getUnencryptedStreamForTrack(scPlugin, item.song.url);
    if (streamUrl) {
      cacheStreamUrl(item.song.url, streamUrl);
      return {
        song: item.song,
        streamUrl,
        isVariant: item.isVariant,
        isExactMatch: item.isExactMatch,
      };
    }
  }

  return null;
}

function buildResolvedSong(plugin, source, info, streamUrl, options) {
  const resolved = new Song(
    {
      plugin,
      source,
      playFromSource: true,
      id: info.id,
      name: info.name,
      url: info.url,
      duration: info.duration,
    },
    options
  );
  resolved.stream.url = streamUrl;
  return resolved;
}

/**
 * Resolves a Spotify/InfoExtractor track to an original unencrypted stream:
 * 1) Prefers an exact (non-remix, duration-matched) SoundCloud upload.
 * 2) If SoundCloud only has remixes or 30s Go+ previews, tries YouTube official audio first.
 * 3) Falls back to best SoundCloud candidate if YouTube blocks the cloud IP.
 */
async function resolveSpotifyTrackStream(song, scPlugin, ytPlugin) {
  const artistName = song?.uploader?.name || '';
  const query = `${song.name} ${artistName}`.trim();
  const songOptions = { member: song.member, metadata: song.metadata };
  const meta = {
    expectedDuration: song.duration || 0,
    artistName,
  };

  let scFound = null;
  if (scPlugin) {
    scFound = await findPlayableSoundCloudTrack(scPlugin, query, {}, meta);
    if (scFound?.isExactMatch && scFound.streamUrl) {
      logger.info(`[Spotify->SC] Exact original match for "${song.name}": "${scFound.song.name}" (${Math.round(scFound.song.duration)}s)`);
      return buildResolvedSong(scPlugin, 'soundcloud', scFound.song, scFound.streamUrl, songOptions);
    }
  }

  // SoundCloud had only remixes, Go+ 30s previews, or duration mismatches -> try YouTube original
  if (ytPlugin && typeof ytPlugin.getDirectYouTubeStream === 'function') {
    try {
      logger.info(`[Spotify->YT] SoundCloud lacked exact non-remix match for "${song.name}". Trying YouTube original audio...`);
      const ytDirect = await ytPlugin.getDirectYouTubeStream(`ytsearch:${query} official audio`);
      if (ytDirect?.url) {
        logger.info(`[Spotify->YT] Resolved YouTube original for "${song.name}": "${ytDirect.title}"`);
        return buildResolvedSong(
          ytPlugin,
          'youtube',
          {
            id: song.id,
            name: ytDirect.title || song.name,
            url: song.url,
            duration: ytDirect.duration || song.duration,
          },
          ytDirect.url,
          songOptions
        );
      }
    } catch (ytErr) {
      logger.warn(`[Spotify->YT] YouTube lookup failed (${ytErr.message}). Falling back to best SoundCloud match.`);
    }
  }

  if (scFound?.song && scFound.streamUrl) {
    logger.warn(`[Spotify->SC Fallback] Using closest SoundCloud track for "${song.name}": "${scFound.song.name}" (variant=${scFound.isVariant})`);
    return buildResolvedSong(scPlugin, 'soundcloud', scFound.song, scFound.streamUrl, songOptions);
  }

  return null;
}

/**
 * Enhances SoundCloudPlugin to avoid DRM (/cbcs/) streams, remixes, and 30s Go+ previews,
 * falling back to unencrypted uploads or YouTube if a track is DRM-locked.
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
      const alt = await findPlayableSoundCloudTrack(scPlugin, song.name, {}, {
        excludeUrl: song.url,
        expectedDuration: song.duration || 0,
      });
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
        const ytDirect = await ytPlugin.getDirectYouTubeStream(`ytsearch:${song.name}`);
        if (ytDirect?.url) return ytDirect.url;
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
  resolveSpotifyTrackStream,
  scoreSoundCloudCandidate,
};
