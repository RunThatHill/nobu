/**
 * Reliably resolves the voice channel for a user in Discord.js v14
 * regardless of caching or whether the interaction was handled as raw API payload.
 */
async function getMemberVoiceChannel(interactionOrMessage) {
  const guild = interactionOrMessage.guild;
  const user = interactionOrMessage.user || interactionOrMessage.author;
  const userId = user?.id;

  if (!guild || !userId) return null;

  // 1. Direct property check on member
  if (interactionOrMessage.member?.voice?.channel) {
    return interactionOrMessage.member.voice.channel;
  }

  // 2. If member has channelId but channel object is not cached
  const directChannelId = interactionOrMessage.member?.voice?.channelId;
  if (directChannelId) {
    try {
      const ch = guild.channels.cache.get(directChannelId) ||
                 await guild.channels.fetch(directChannelId).catch(() => null) ||
                 await guild.client.channels.fetch(directChannelId).catch(() => null);
      if (ch) return ch;
    } catch (e) {}
  }

  // 3. Fetch full GuildMember from Discord REST API
  try {
    const member = await guild.members.fetch(userId);
    if (member?.voice?.channel) {
      return member.voice.channel;
    }
    if (member?.voice?.channelId) {
      const ch = guild.channels.cache.get(member.voice.channelId) ||
                 await guild.channels.fetch(member.voice.channelId).catch(() => null);
      if (ch) return ch;
    }
  } catch (err) {}

  // 4. Check guild voiceStates cache
  const voiceState = guild.voiceStates?.cache?.get(userId);
  if (voiceState?.channelId) {
    try {
      const ch = guild.channels.cache.get(voiceState.channelId) ||
                 await guild.channels.fetch(voiceState.channelId).catch(() => null);
      if (ch) return ch;
    } catch (e) {}
  }

  // 5. Fetch all guild channels and look for the member inside voice channels
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    if (channels) {
      for (const ch of channels.values()) {
        if (ch && typeof ch.isVoiceBased === 'function' && ch.isVoiceBased()) {
          if (ch.members && ch.members.has(userId)) {
            return ch;
          }
        }
      }
    }
  } catch (err) {}

  return null;
}

module.exports = {
  getMemberVoiceChannel,
};
