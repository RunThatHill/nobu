/**
 * Reliably resolves the voice channel for a user in Discord.js v14
 * regardless of whether member caching is enabled or interaction was raw API.
 */
async function getMemberVoiceChannel(interactionOrMessage) {
  const guild = interactionOrMessage.guild;
  const user = interactionOrMessage.user || interactionOrMessage.author;
  const userId = user?.id;

  if (!guild || !userId) return null;

  // 1. Check if already populated on member
  if (interactionOrMessage.member?.voice?.channel) {
    return interactionOrMessage.member.voice.channel;
  }

  // 2. Fetch GuildMember from Discord API
  try {
    const member = await guild.members.fetch(userId);
    if (member?.voice?.channel) {
      return member.voice.channel;
    }
    if (member?.voice?.channelId) {
      const channel = guild.channels.cache.get(member.voice.channelId) ||
                      await guild.channels.fetch(member.voice.channelId).catch(() => null);
      if (channel) return channel;
    }
  } catch (err) {}

  // 3. Check guild voiceStates cache
  const voiceState = guild.voiceStates?.cache?.get(userId);
  if (voiceState?.channelId) {
    const channel = guild.channels.cache.get(voiceState.channelId) ||
                    await guild.channels.fetch(voiceState.channelId).catch(() => null);
    if (channel) return channel;
  }

  // 4. Scan voice channels in the guild
  try {
    const channels = guild.channels.cache;
    for (const ch of channels.values()) {
      if (ch && typeof ch.isVoiceBased === 'function' && ch.isVoiceBased()) {
        if (ch.members && ch.members.has(userId)) {
          return ch;
        }
      }
    }
  } catch (err) {}

  return null;
}

module.exports = {
  getMemberVoiceChannel,
};
