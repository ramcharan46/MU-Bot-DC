function registerLoggingEvents(client, context) {
  const {
    updateGuildStatsChannels,
    applyAutoRolesForMember,
    sendWelcomeMessage,
    detectInviteUsage,
    makeEmbed,
    COLORS,
    sendLog,
    fetchAuditEntry,
    pushChange,
    roleMentionsFromIds,
    appendAuditFields,
    shorten,
    channelTypeLabel,
    shouldIgnoreStatsChannelLog,
    removeTempVoiceState,
    summarizeOverwriteDiffs,
    getGuildJtcConfig,
    cleanupTempVoiceChannelIfEmpty,
    getBotMember,
    Permissions,
    getTempVoiceStateByOwner,
    isVoiceChannel,
    postTempVoiceInterface,
    createTempVoiceChannel,
    setTempVoiceState,
    primeInviteCache,
    snapshotWebhookCollection,
    webhookCache,
    setEmbedAuthorSafe,
    setEmbedFooterSafe,
  } = context;

  const isPrivateThread = (thread) =>
    Boolean(thread) && (thread.type === "GUILD_PRIVATE_THREAD" || thread.type === 12);

  const normalizeComparable = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || trimmed.toLowerCase() === "none") return null;
      return trimmed;
    }
    return value;
  };

  const sameComparable = (before, after) => normalizeComparable(before) === normalizeComparable(after);

client.on("guildMemberAdd", async (member) => {
  await updateGuildStatsChannels(member.guild, null).catch(() => null);
  await applyAutoRolesForMember(member).catch(() => null);
  await sendWelcomeMessage(member).catch(() => null);
  const inviteUsage = await detectInviteUsage(member.guild);
  const fields = [
    { name: "User", value: `${member.user.tag} (${member.id})` },
    { name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:f>` },
    { name: "Member Count", value: `${member.guild.memberCount}` },
  ];

  if (inviteUsage.usedInvite) {
    const used = inviteUsage.usedInvite;
    fields.push({
      name: "Invite",
      value: `Code: \`${used.invite.code}\`\nUses: ${used.before} -> ${used.after}\nBy: ${used.invite.inviter ? `${used.invite.inviter.tag} (${used.invite.inviter.id})` : "Unknown"}`,
    });
  }

  const embed = makeEmbed("Member Joined", `${member.user.tag} joined the server.`, COLORS.SUCCESS, fields);
  await sendLog(member.guild, embed, "member");

  if (inviteUsage.spikes.length) {
    for (const spike of inviteUsage.spikes.slice(0, 3)) {
      const spikeEmbed = makeEmbed("Invite Usage Spike", `Invite \`${spike.invite.code}\` increased by ${spike.delta} uses in a single interval.`, COLORS.WARNING, [
        { name: "Invite", value: `\`${spike.invite.code}\`` },
        { name: "Uses", value: `${spike.before} -> ${spike.after}` },
        { name: "Inviter", value: spike.invite.inviter ? `${spike.invite.inviter.tag} (${spike.invite.inviter.id})` : "Unknown" },
      ]);
      await sendLog(member.guild, spikeEmbed, "channel");
    }
  }
});

client.on("guildMemberRemove", async (member) => {
  await updateGuildStatsChannels(member.guild, null).catch(() => null);
  const kickEntry = await fetchAuditEntry(member.guild, "MEMBER_KICK", member.id, 7000);
  if (kickEntry) {
    const embed = makeEmbed("Member Kicked", `${member.user.tag} was removed from the server.`, COLORS.WARNING, [
      { name: "User", value: `${member.user.tag} (${member.id})` },
      { name: "Action By", value: kickEntry.executor ? `${kickEntry.executor.tag} (${kickEntry.executor.id})` : "Unknown" },
      { name: "Reason", value: kickEntry.reason || "No reason provided." },
    ]);
    await sendLog(member.guild, embed, "moderation");
    return;
  }

  const banEntry = await fetchAuditEntry(member.guild, "MEMBER_BAN_ADD", member.id, 7000);
  if (banEntry) return;

  const embed = makeEmbed("Member Left", `${member.user.tag} left the server.`, COLORS.INFO, [
    { name: "User", value: `${member.user.tag} (${member.id})` },
    { name: "Member Count", value: `${member.guild.memberCount}` },
  ]);
  await sendLog(member.guild, embed, "member");
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const changes = [];
  pushChange(changes, "Nickname", oldMember.nickname, newMember.nickname);
  if (typeof oldMember.pending === "boolean" && typeof newMember.pending === "boolean") {
    pushChange(changes, "Pending Verification", oldMember.pending, newMember.pending);
  }
  pushChange(
    changes,
    "Server Avatar",
    oldMember.avatar ? "Set" : "None",
    newMember.avatar ? "Set" : "None",
  );
  pushChange(
    changes,
    "Timeout",
    oldMember.communicationDisabledUntilTimestamp
      ? `<t:${Math.floor(oldMember.communicationDisabledUntilTimestamp / 1000)}:f>`
      : "None",
    newMember.communicationDisabledUntilTimestamp
      ? `<t:${Math.floor(newMember.communicationDisabledUntilTimestamp / 1000)}:f>`
      : "None",
  );
  pushChange(
    changes,
    "Boosting Since",
    oldMember.premiumSinceTimestamp ? `<t:${Math.floor(oldMember.premiumSinceTimestamp / 1000)}:f>` : "None",
    newMember.premiumSinceTimestamp ? `<t:${Math.floor(newMember.premiumSinceTimestamp / 1000)}:f>` : "None",
  );

  const oldRoleIds = new Set(oldMember.roles.cache.map((role) => role.id));
  const newRoleIds = new Set(newMember.roles.cache.map((role) => role.id));
  const addedRoles = [...newRoleIds].filter((id) => !oldRoleIds.has(id) && id !== newMember.guild.id);
  const removedRoles = [...oldRoleIds].filter((id) => !newRoleIds.has(id) && id !== newMember.guild.id);
  if (addedRoles.length) changes.push({ name: "Roles Added", value: roleMentionsFromIds(addedRoles) });
  if (removedRoles.length) changes.push({ name: "Roles Removed", value: roleMentionsFromIds(removedRoles) });

  if (!changes.length) return;
  await appendAuditFields(changes, newMember.guild, "MEMBER_UPDATE", newMember.id, 7000);

  const nicknameChanged = oldMember.nickname !== newMember.nickname;
  const timeoutChanged =
    oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp;
  const pendingChanged = oldMember.pending !== newMember.pending;
  const serverAvatarChanged = oldMember.avatar !== newMember.avatar;
  const boostingChanged = oldMember.premiumSinceTimestamp !== newMember.premiumSinceTimestamp;

  let title = "Member Updated";
  let description = `${newMember} profile settings changed.`;
  let color = COLORS.INFO;

  if (addedRoles.length && !removedRoles.length) {
    title = addedRoles.length === 1 ? "Role Added" : "Roles Added";
    description = `${newMember} received ${roleMentionsFromIds(addedRoles)}.`;
    color = COLORS.SUCCESS;
  } else if (removedRoles.length && !addedRoles.length) {
    title = removedRoles.length === 1 ? "Role Removed" : "Roles Removed";
    description = `${newMember} lost ${roleMentionsFromIds(removedRoles)}.`;
    color = COLORS.ERROR;
  } else if (addedRoles.length && removedRoles.length) {
    title = "Roles Updated";
    description = `${newMember} role set was updated.`;
    color = COLORS.INFO;
  } else if (timeoutChanged) {
    if (newMember.communicationDisabledUntilTimestamp) {
      title = "Member Timed Out";
      description = `${newMember} is timed out until <t:${Math.floor(newMember.communicationDisabledUntilTimestamp / 1000)}:f>.`;
      color = COLORS.WARNING;
    } else {
      title = "Member Timeout Removed";
      description = `${newMember} timeout was removed.`;
      color = COLORS.SUCCESS;
    }
  } else if (nicknameChanged) {
    title = "Nickname Changed";
    description = `${newMember} nickname was updated.`;
  } else if (serverAvatarChanged) {
    title = "Server Avatar Updated";
    description = `${newMember} server avatar was updated.`;
  } else if (boostingChanged) {
    if (newMember.premiumSinceTimestamp) {
      title = "Boost Started";
      description = `${newMember} started boosting the server.`;
      color = COLORS.SUCCESS;
    } else {
      title = "Boost Ended";
      description = `${newMember} stopped boosting the server.`;
      color = COLORS.WARNING;
    }
  } else if (pendingChanged) {
    title = "Verification Status Updated";
    description = `${newMember} verification status changed.`;
  }

  const embed = makeEmbed(title, description, color, [
    { name: "User", value: `${newMember.user.tag} (${newMember.id})` },
    ...changes.slice(0, 20),
  ]);
  await sendLog(newMember.guild, embed, "member");
});

client.on("userUpdate", async (oldUser, newUser) => {
  const changes = [];
  pushChange(changes, "Username", oldUser.username, newUser.username);
  pushChange(changes, "Display Avatar", oldUser.displayAvatarURL(), newUser.displayAvatarURL());
  pushChange(changes, "Discriminator", oldUser.discriminator, newUser.discriminator);
  if (!changes.length) return;

  let title = "User Profile Updated";
  let description = `${newUser.tag} account details changed.`;
  if (!sameComparable(oldUser.username, newUser.username)) {
    title = "Username Changed";
    description = `${newUser.tag} username was updated.`;
  } else if (!sameComparable(oldUser.displayAvatarURL(), newUser.displayAvatarURL())) {
    title = "User Avatar Updated";
    description = `${newUser.tag} avatar was updated.`;
  } else if (!sameComparable(oldUser.discriminator, newUser.discriminator)) {
    title = "Discriminator Updated";
    description = `${newUser.tag} discriminator changed.`;
  }

  for (const guild of client.guilds.cache.values()) {
    const member =
      guild.members.cache.get(newUser.id) ||
      (await guild.members.fetch(newUser.id).catch(() => null));
    if (!member) continue;

    const embed = makeEmbed(title, description, COLORS.INFO, [
      { name: "User", value: `${newUser.tag} (${newUser.id})` },
      ...changes.slice(0, 20),
    ]);
    await sendLog(guild, embed, "member");
  }
});

client.on("roleCreate", async (role) => {
  const fields = [
    { name: "Role", value: `${role.name} (${role.id})` },
    { name: "Color", value: role.hexColor || "Default" },
    { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
    { name: "Hoisted", value: role.hoist ? "Yes" : "No", inline: true },
  ];
  await appendAuditFields(fields, role.guild, "ROLE_CREATE", role.id, 9000);
  const embed = makeEmbed("Role Created", `Role ${role} was created.`, COLORS.SUCCESS, fields);
  await sendLog(role.guild, embed, "role");
});

client.on("roleDelete", async (role) => {
  const fields = [
    { name: "Role ID", value: role.id },
    { name: "Role Name", value: role.name },
  ];
  await appendAuditFields(fields, role.guild, "ROLE_DELETE", role.id, 9000);
  const embed = makeEmbed("Role Deleted", `Role \`${role.name}\` was deleted.`, COLORS.ERROR, fields);
  await sendLog(role.guild, embed, "role");
});

client.on("roleUpdate", async (oldRole, newRole) => {
  const changes = [];
  pushChange(changes, "Name", oldRole.name, newRole.name);
  pushChange(changes, "Color", oldRole.hexColor, newRole.hexColor);
  pushChange(changes, "Mentionable", oldRole.mentionable, newRole.mentionable);
  pushChange(changes, "Displayed Separately", oldRole.hoist, newRole.hoist);

  const beforePerms = oldRole.permissions.toArray();
  const afterPerms = newRole.permissions.toArray();
  const addedPerms = afterPerms.filter((perm) => !beforePerms.includes(perm));
  const removedPerms = beforePerms.filter((perm) => !afterPerms.includes(perm));
  if (addedPerms.length) changes.push({ name: "Permissions Added", value: shorten(addedPerms.join(", "), 900) });
  if (removedPerms.length) changes.push({ name: "Permissions Removed", value: shorten(removedPerms.join(", "), 900) });

  if (!changes.length) return;
  await appendAuditFields(changes, newRole.guild, "ROLE_UPDATE", newRole.id, 9000);

  let title = "Role Updated";
  let description = `${newRole} settings changed.`;
  let color = COLORS.INFO;
  if (addedPerms.length || removedPerms.length) {
    title = "Role Permissions Updated";
    description = `Permissions were updated for ${newRole}.`;
    color = COLORS.WARNING;
  } else if (!sameComparable(oldRole.name, newRole.name)) {
    title = "Role Renamed";
    description = `\`${oldRole.name}\` -> \`${newRole.name}\``;
  } else if (!sameComparable(oldRole.hexColor, newRole.hexColor)) {
    title = "Role Color Updated";
    description = `Color was updated for ${newRole}.`;
  } else if (oldRole.mentionable !== newRole.mentionable) {
    title = "Role Mentionability Updated";
    description = `${newRole} mentionability was updated.`;
  } else if (oldRole.hoist !== newRole.hoist) {
    title = "Role Display Updated";
    description = `${newRole} display settings were updated.`;
  }

  const embed = makeEmbed(title, description, color, [
    { name: "Role", value: `${newRole.name} (${newRole.id})` },
    ...changes.slice(0, 20),
  ]);
  await sendLog(newRole.guild, embed, "role");
});

client.on("channelCreate", async (channel) => {
  if (!channel.guild) return;
  if (shouldIgnoreStatsChannelLog(channel)) return;
  const fields = [
    { name: "Channel", value: `${channel.name || "Unknown"} (${channel.id})` },
    { name: "Type", value: channelTypeLabel(channel), inline: true },
    { name: "Category", value: channel.parentId ? `<#${channel.parentId}>` : "None", inline: true },
  ];
  await appendAuditFields(fields, channel.guild, "CHANNEL_CREATE", channel.id, 9000);
  const embed = makeEmbed("Channel Created", `${channel} was created.`, COLORS.SUCCESS, fields);
  await sendLog(channel.guild, embed, "channel");
});

client.on("channelDelete", async (channel) => {
  if (!channel.guild) return;
  const removedTempState = removeTempVoiceState(channel.guild.id, channel.id);
  if (removedTempState?.textChannelId) {
    const tempText =
      channel.guild.channels.cache.get(removedTempState.textChannelId) ||
      (await channel.guild.channels.fetch(removedTempState.textChannelId).catch(() => null));
    if (tempText) await tempText.delete("Temporary voice channel deleted").catch(() => null);
  }
  if (shouldIgnoreStatsChannelLog(channel)) return;
  const fields = [
    { name: "Channel ID", value: channel.id },
    { name: "Name", value: channel.name || "Unknown" },
    { name: "Type", value: channelTypeLabel(channel), inline: true },
    { name: "Category", value: channel.parentId ? `<#${channel.parentId}>` : "None", inline: true },
  ];
  await appendAuditFields(fields, channel.guild, "CHANNEL_DELETE", channel.id, 9000);
  const embed = makeEmbed("Channel Deleted", `\`${channel.name || "Unknown"}\` was deleted.`, COLORS.ERROR, fields);
  await sendLog(channel.guild, embed, "channel");
});

client.on("channelUpdate", async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  if (shouldIgnoreStatsChannelLog(oldChannel) || shouldIgnoreStatsChannelLog(newChannel)) return;
  const overwriteDiff = summarizeOverwriteDiffs(oldChannel, newChannel);

  const hasMeaningfulChange =
    !sameComparable(oldChannel.name, newChannel.name) ||
    !sameComparable(channelTypeLabel(oldChannel), channelTypeLabel(newChannel)) ||
    !sameComparable(oldChannel.parentId, newChannel.parentId) ||
    !sameComparable(oldChannel.nsfw, newChannel.nsfw) ||
    !sameComparable(oldChannel.topic, newChannel.topic) ||
    !sameComparable(oldChannel.rateLimitPerUser, newChannel.rateLimitPerUser) ||
    !sameComparable(oldChannel.bitrate, newChannel.bitrate) ||
    !sameComparable(oldChannel.userLimit, newChannel.userLimit) ||
    Boolean(overwriteDiff);
  if (!hasMeaningfulChange) return;

  const changes = [];
  pushChange(changes, "Name", oldChannel.name, newChannel.name);
  pushChange(changes, "Type", channelTypeLabel(oldChannel), channelTypeLabel(newChannel));
  pushChange(changes, "Category", oldChannel.parentId ? `<#${oldChannel.parentId}>` : "None", newChannel.parentId ? `<#${newChannel.parentId}>` : "None");
  pushChange(changes, "NSFW", oldChannel.nsfw, newChannel.nsfw);
  pushChange(changes, "Topic", oldChannel.topic, newChannel.topic);
  pushChange(changes, "Slowmode", oldChannel.rateLimitPerUser, newChannel.rateLimitPerUser);
  pushChange(changes, "Bitrate", oldChannel.bitrate, newChannel.bitrate);
  pushChange(changes, "User Limit", oldChannel.userLimit, newChannel.userLimit);
  if (overwriteDiff) changes.push({ name: "Permission Overwrites", value: overwriteDiff });

  if (!changes.length) return;
  await appendAuditFields(changes, newChannel.guild, "CHANNEL_UPDATE", newChannel.id, 9000);

  let title = "Channel Updated";
  let description = `${newChannel} settings changed.`;
  let color = COLORS.INFO;
  if (!sameComparable(oldChannel.name, newChannel.name)) {
    title = "Channel Renamed";
    description = `\`${oldChannel.name || "Unknown"}\` -> \`${newChannel.name || "Unknown"}\``;
  } else if (!sameComparable(oldChannel.parentId, newChannel.parentId)) {
    title = "Channel Category Changed";
    description = `${newChannel} moved to a different category.`;
  } else if (overwriteDiff) {
    title = "Channel Permissions Updated";
    description = `Permissions were updated in ${newChannel}.`;
    color = COLORS.WARNING;
  } else if (!sameComparable(oldChannel.topic, newChannel.topic)) {
    title = "Channel Topic Updated";
    description = `Topic was updated in ${newChannel}.`;
  } else if (!sameComparable(oldChannel.rateLimitPerUser, newChannel.rateLimitPerUser)) {
    title = "Channel Slowmode Updated";
    description = `Slowmode was updated in ${newChannel}.`;
  } else if (!sameComparable(oldChannel.nsfw, newChannel.nsfw)) {
    title = "Channel NSFW Updated";
    description = `NSFW setting was updated in ${newChannel}.`;
  } else if (!sameComparable(oldChannel.bitrate, newChannel.bitrate) || !sameComparable(oldChannel.userLimit, newChannel.userLimit)) {
    title = "Voice Channel Settings Updated";
    description = `Voice settings were updated in ${newChannel}.`;
  } else if (!sameComparable(channelTypeLabel(oldChannel), channelTypeLabel(newChannel))) {
    title = "Channel Type Updated";
    description = `${newChannel} type was updated.`;
  }

  const embed = makeEmbed(title, description, color, [
    { name: "Channel", value: `${newChannel.name || "Unknown"} (${newChannel.id})` },
    ...changes.slice(0, 20),
  ]);
  await sendLog(newChannel.guild, embed, "channel");
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!newState.guild || !newState.member || newState.member.user?.bot) return;
  const guild = newState.guild;
  const config = getGuildJtcConfig(guild.id);

  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await cleanupTempVoiceChannelIfEmpty(guild, oldState.channelId).catch(() => null);
  }

  const triggerConfig = newState.channelId ? config.triggers[newState.channelId] : null;
  if (!triggerConfig) return;
  if (oldState.channelId === newState.channelId) return;

  const botMember = await getBotMember(guild).catch(() => null);
  if (!botMember) return;
  if (!botMember.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)) return;
  if (!botMember.permissions?.has(Permissions.FLAGS.MOVE_MEMBERS)) return;

  const existing = getTempVoiceStateByOwner(guild.id, newState.member.id);
  if (existing) {
    const existingChannel =
      guild.channels.cache.get(existing.channelId) || (await guild.channels.fetch(existing.channelId).catch(() => null));
    if (existingChannel && isVoiceChannel(existingChannel)) {
      await newState.member.voice.setChannel(existingChannel, "Move to existing temporary voice channel").catch(() => null);
      await postTempVoiceInterface(guild, existing.channelId).catch(() => null);
      return;
    }
    removeTempVoiceState(guild.id, existing.channelId);
  }

  const tempChannel = await createTempVoiceChannel(
    newState.member,
    newState.channelId,
    triggerConfig.categoryId || "",
  ).catch(() => null);
  if (!tempChannel) return;

  setTempVoiceState(guild.id, tempChannel.id, {
    ownerId: newState.member.id,
    textChannelId: "",
    status: "",
    game: "",
  });

  const moved = await newState.member.voice
    .setChannel(tempChannel, "Join-to-create temporary voice channel")
    .then(() => true)
    .catch(() => false);
  if (!moved) {
    removeTempVoiceState(guild.id, tempChannel.id);
    await tempChannel.delete("Could not move member to temporary channel").catch(() => null);
    return;
  }

  await postTempVoiceInterface(guild, tempChannel.id).catch(() => null);
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!newState.guild || !newState.member || newState.member.user?.bot) return;
  const changes = [];
  let voiceTitle = "Voice State Updated";
  let voiceDescription = `${newState.member.user.tag} voice settings changed.`;
  let voiceColor = COLORS.INFO;

  if (oldState.channelId !== newState.channelId) {
    if (!oldState.channelId && newState.channelId) {
      voiceTitle = "Voice Channel Joined";
      voiceDescription = `Joined ${newState.channel}`;
      voiceColor = COLORS.SUCCESS;
      changes.push({
        name: "Channel",
        value: `Joined ${newState.channel}`,
      });
    } else if (oldState.channelId && !newState.channelId) {
      voiceTitle = "Voice Channel Left";
      voiceDescription = `Left <#${oldState.channelId}>`;
      voiceColor = COLORS.WARNING;
      changes.push({
        name: "Channel",
        value: `Left <#${oldState.channelId}>`,
      });
    } else {
      voiceTitle = "Voice Channel Moved";
      voiceDescription = `Moved <#${oldState.channelId}> -> <#${newState.channelId}>`;
      voiceColor = COLORS.INFO;
      changes.push({
        name: "Channel",
        value: `Moved <#${oldState.channelId}> -> <#${newState.channelId}>`,
      });
    }
  }

  pushChange(changes, "Self Mute", oldState.selfMute, newState.selfMute);
  pushChange(changes, "Self Deaf", oldState.selfDeaf, newState.selfDeaf);
  pushChange(changes, "Server Mute", oldState.serverMute, newState.serverMute);
  pushChange(changes, "Server Deaf", oldState.serverDeaf, newState.serverDeaf);
  pushChange(changes, "Streaming", oldState.streaming, newState.streaming);
  pushChange(changes, "Video", oldState.selfVideo, newState.selfVideo);
  pushChange(changes, "Suppressed", oldState.suppress, newState.suppress);

  if (!changes.length) return;

   const embed = makeEmbed(voiceTitle, voiceDescription, voiceColor, [
    { name: "User", value: `${newState.member.user.tag} (${newState.member.id})` },
    ...changes.slice(0, 20),
  ]);
  await sendLog(newState.guild, embed, "member");
});

client.on("threadCreate", async (thread) => {
  if (!thread.guild) return;
  const fields = [
    { name: "Thread", value: `${thread.name} (${thread.id})` },
    { name: "Parent", value: thread.parentId ? `<#${thread.parentId}>` : "Unknown" },
    { name: "Private", value: isPrivateThread(thread) ? "Yes" : "No", inline: true },
    { name: "Archived", value: thread.archived ? "Yes" : "No", inline: true },
  ];
  await appendAuditFields(fields, thread.guild, "THREAD_CREATE", thread.id, 9000);
  const embed = makeEmbed("Thread Created", `Thread <#${thread.id}> was created.`, COLORS.SUCCESS, fields);
  await sendLog(thread.guild, embed, "channel");
});

client.on("threadDelete", async (thread) => {
  if (!thread.guild) return;
  const fields = [
    { name: "Thread", value: `${thread.name || "Unknown"} (${thread.id})` },
    { name: "Parent", value: thread.parentId ? `<#${thread.parentId}>` : "Unknown" },
  ];
  await appendAuditFields(fields, thread.guild, "THREAD_DELETE", thread.id, 9000);
  const embed = makeEmbed("Thread Deleted", `Thread \`${thread.name || "Unknown"}\` was deleted.`, COLORS.ERROR, fields);
  await sendLog(thread.guild, embed, "channel");
});

client.on("threadUpdate", async (oldThread, newThread) => {
  if (!newThread.guild) return;
  const changes = [];
  pushChange(changes, "Name", oldThread.name, newThread.name);
  pushChange(changes, "Archived", oldThread.archived, newThread.archived);
  pushChange(changes, "Locked", oldThread.locked, newThread.locked);
  pushChange(changes, "Auto Archive Duration", oldThread.autoArchiveDuration, newThread.autoArchiveDuration);
  pushChange(changes, "Slowmode", oldThread.rateLimitPerUser, newThread.rateLimitPerUser);
  if (!changes.length) return;

  await appendAuditFields(changes, newThread.guild, "THREAD_UPDATE", newThread.id, 9000);
  let title = "Thread Updated";
  let description = `Thread <#${newThread.id}> settings changed.`;
  if (!sameComparable(oldThread.name, newThread.name)) {
    title = "Thread Renamed";
    description = `\`${oldThread.name || "Unknown"}\` -> \`${newThread.name || "Unknown"}\``;
  } else if (oldThread.archived !== newThread.archived) {
    title = newThread.archived ? "Thread Archived" : "Thread Unarchived";
    description = `Thread <#${newThread.id}> archive state changed.`;
  } else if (oldThread.locked !== newThread.locked) {
    title = newThread.locked ? "Thread Locked" : "Thread Unlocked";
    description = `Thread <#${newThread.id}> lock state changed.`;
  } else if (!sameComparable(oldThread.rateLimitPerUser, newThread.rateLimitPerUser)) {
    title = "Thread Slowmode Updated";
    description = `Thread <#${newThread.id}> slowmode was updated.`;
  } else if (!sameComparable(oldThread.autoArchiveDuration, newThread.autoArchiveDuration)) {
    title = "Thread Auto-Archive Updated";
    description = `Thread <#${newThread.id}> auto-archive duration changed.`;
  }

  const embed = makeEmbed(title, description, COLORS.INFO, [
    { name: "Thread", value: `${newThread.name} (${newThread.id})` },
    ...changes.slice(0, 20),
  ]);
  await sendLog(newThread.guild, embed, "channel");
});

client.on("inviteCreate", async (invite) => {
  if (!invite.guild) return;
  const fields = [
    { name: "Code", value: `\`${invite.code}\`` },
    { name: "Channel", value: invite.channel ? `${invite.channel} (${invite.channel.id})` : "Unknown" },
    {
      name: "Inviter",
      value: invite.inviter ? `${invite.inviter.tag} (${invite.inviter.id})` : "Unknown",
    },
    { name: "Max Uses", value: `${invite.maxUses || "Unlimited"}`, inline: true },
    { name: "Temporary", value: invite.temporary ? "Yes" : "No", inline: true },
  ];
  await appendAuditFields(fields, invite.guild, "INVITE_CREATE", null, 9000);
  const embed = makeEmbed("Invite Created", `Invite \`${invite.code}\` was created.`, COLORS.SUCCESS, fields);
  await sendLog(invite.guild, embed, "channel");
  await primeInviteCache(invite.guild);
});

client.on("inviteDelete", async (invite) => {
  if (!invite.guild) return;
  const fields = [
    { name: "Code", value: `\`${invite.code}\`` },
    { name: "Channel", value: invite.channel ? `${invite.channel} (${invite.channel.id})` : "Unknown" },
  ];
  await appendAuditFields(fields, invite.guild, "INVITE_DELETE", null, 9000);
  const embed = makeEmbed("Invite Deleted", `Invite \`${invite.code}\` was deleted.`, COLORS.ERROR, fields);
  await sendLog(invite.guild, embed, "channel");
  await primeInviteCache(invite.guild);
});

client.on("guildUpdate", async (oldGuild, newGuild) => {
  const changes = [];
  pushChange(changes, "Name", oldGuild.name, newGuild.name);
  pushChange(changes, "Icon", oldGuild.iconURL(), newGuild.iconURL());
  pushChange(changes, "Verification Level", oldGuild.verificationLevel, newGuild.verificationLevel);
  pushChange(changes, "Explicit Content Filter", oldGuild.explicitContentFilter, newGuild.explicitContentFilter);
  pushChange(changes, "Default Notifications", oldGuild.defaultMessageNotifications, newGuild.defaultMessageNotifications);
  pushChange(changes, "AFK Timeout", oldGuild.afkTimeout, newGuild.afkTimeout);
  pushChange(changes, "AFK Channel", oldGuild.afkChannelId, newGuild.afkChannelId);
  pushChange(changes, "System Channel", oldGuild.systemChannelId, newGuild.systemChannelId);
  pushChange(changes, "Rules Channel", oldGuild.rulesChannelId, newGuild.rulesChannelId);
  pushChange(changes, "Updates Channel", oldGuild.publicUpdatesChannelId, newGuild.publicUpdatesChannelId);
  pushChange(changes, "Preferred Locale", oldGuild.preferredLocale, newGuild.preferredLocale);
  pushChange(changes, "Description", oldGuild.description, newGuild.description);
  if (!changes.length) return;

  await appendAuditFields(changes, newGuild, "GUILD_UPDATE", newGuild.id, 9000);
  let title = "Server Updated";
  let description = "Server settings were updated.";
  if (!sameComparable(oldGuild.name, newGuild.name)) {
    title = "Server Renamed";
    description = `\`${oldGuild.name}\` -> \`${newGuild.name}\``;
  } else if (!sameComparable(oldGuild.iconURL(), newGuild.iconURL())) {
    title = "Server Icon Updated";
    description = "Server icon was updated.";
  } else if (!sameComparable(oldGuild.verificationLevel, newGuild.verificationLevel)) {
    title = "Verification Level Updated";
    description = "Server verification level was updated.";
  } else if (!sameComparable(oldGuild.preferredLocale, newGuild.preferredLocale)) {
    title = "Server Locale Updated";
    description = "Server locale was updated.";
  } else if (!sameComparable(oldGuild.description, newGuild.description)) {
    title = "Server Description Updated";
    description = "Server description was updated.";
  }

  const embed = makeEmbed(title, description, COLORS.INFO, changes.slice(0, 20));
  await sendLog(newGuild, embed, "channel");
});

client.on("emojiCreate", async (emoji) => {
  const fields = [
    { name: "Emoji", value: `${emoji.toString()} (${emoji.id})` },
    { name: "Name", value: emoji.name || "Unknown" },
    { name: "Animated", value: emoji.animated ? "Yes" : "No", inline: true },
  ];
  await appendAuditFields(fields, emoji.guild, "EMOJI_CREATE", emoji.id, 9000);
  const embed = makeEmbed("Emoji Created", `Emoji ${emoji.toString()} was created.`, COLORS.SUCCESS, fields);
  await sendLog(emoji.guild, embed, "channel");
});

client.on("emojiDelete", async (emoji) => {
  const fields = [
    { name: "Emoji ID", value: emoji.id },
    { name: "Name", value: emoji.name || "Unknown" },
  ];
  await appendAuditFields(fields, emoji.guild, "EMOJI_DELETE", emoji.id, 9000);
  const embed = makeEmbed("Emoji Deleted", `Emoji \`${emoji.name || emoji.id}\` was deleted.`, COLORS.ERROR, fields);
  await sendLog(emoji.guild, embed, "channel");
});

client.on("emojiUpdate", async (oldEmoji, newEmoji) => {
  const changes = [];
  pushChange(changes, "Name", oldEmoji.name, newEmoji.name);
  pushChange(changes, "Animated", oldEmoji.animated, newEmoji.animated);
  if (!changes.length) return;
  await appendAuditFields(changes, newEmoji.guild, "EMOJI_UPDATE", newEmoji.id, 9000);

  const title = !sameComparable(oldEmoji.name, newEmoji.name) ? "Emoji Renamed" : "Emoji Updated";
  const description =
    !sameComparable(oldEmoji.name, newEmoji.name)
      ? `Emoji name updated to ${newEmoji.toString()}.`
      : `Emoji ${newEmoji.toString()} settings changed.`;
  const embed = makeEmbed(title, description, COLORS.INFO, [
    { name: "Emoji", value: `${newEmoji.toString()} (${newEmoji.id})` },
    ...changes.slice(0, 20),
  ]);
  await sendLog(newEmoji.guild, embed, "channel");
});

client.on("stickerCreate", async (sticker) => {
  const guild = client.guilds.cache.get(sticker.guildId);
  if (!guild) return;
  const fields = [
    { name: "Sticker", value: `${sticker.name} (${sticker.id})` },
    { name: "Description", value: sticker.description || "None" },
    { name: "Tags", value: sticker.tags || "None" },
  ];
  await appendAuditFields(fields, guild, "STICKER_CREATE", sticker.id, 9000);
  const embed = makeEmbed("Sticker Created", `Sticker \`${sticker.name}\` was created.`, COLORS.SUCCESS, fields);
  await sendLog(guild, embed, "channel");
});

client.on("stickerDelete", async (sticker) => {
  const guild = client.guilds.cache.get(sticker.guildId);
  if (!guild) return;
  const fields = [
    { name: "Sticker", value: `${sticker.name || "Unknown"} (${sticker.id})` },
  ];
  await appendAuditFields(fields, guild, "STICKER_DELETE", sticker.id, 9000);
  const embed = makeEmbed("Sticker Deleted", `Sticker \`${sticker.name || sticker.id}\` was deleted.`, COLORS.ERROR, fields);
  await sendLog(guild, embed, "channel");
});

client.on("stickerUpdate", async (oldSticker, newSticker) => {
  const guild = client.guilds.cache.get(newSticker.guildId);
  if (!guild) return;
  const changes = [];
  pushChange(changes, "Name", oldSticker.name, newSticker.name);
  pushChange(changes, "Description", oldSticker.description, newSticker.description);
  pushChange(changes, "Tags", oldSticker.tags, newSticker.tags);
  if (!changes.length) return;
  await appendAuditFields(changes, guild, "STICKER_UPDATE", newSticker.id, 9000);

  const title = !sameComparable(oldSticker.name, newSticker.name) ? "Sticker Renamed" : "Sticker Updated";
  const description =
    !sameComparable(oldSticker.name, newSticker.name)
      ? `Sticker \`${oldSticker.name || "Unknown"}\` -> \`${newSticker.name || "Unknown"}\``
      : `Sticker \`${newSticker.name}\` settings changed.`;
  const embed = makeEmbed(title, description, COLORS.INFO, [
    { name: "Sticker", value: `${newSticker.name} (${newSticker.id})` },
    ...changes.slice(0, 20),
  ]);
  await sendLog(guild, embed, "channel");
});

client.on("webhookUpdate", async (channel) => {
  if (!channel?.guild || typeof channel.fetchWebhooks !== "function") return;

  const before = webhookCache.get(channel.id) || new Map();
  const hooks = await channel.fetchWebhooks().catch(() => null);
  if (!hooks) return;
  const after = snapshotWebhookCollection(hooks);
  webhookCache.set(channel.id, after);

  const createdIds = [...after.keys()].filter((id) => !before.has(id));
  const deletedIds = [...before.keys()].filter((id) => !after.has(id));
  const sharedIds = [...after.keys()].filter((id) => before.has(id));

  for (const id of createdIds) {
    const hook = after.get(id);
    const fields = [
      { name: "Webhook", value: `${hook.name} (${hook.id})` },
      { name: "Channel", value: `${channel} (${channel.id})` },
    ];
    await appendAuditFields(fields, channel.guild, "WEBHOOK_CREATE", id, 9000);
    await sendLog(channel.guild, makeEmbed("Webhook Created", `Webhook \`${hook.name}\` was created.`, COLORS.SUCCESS, fields), "channel");
  }

  for (const id of deletedIds) {
    const hook = before.get(id);
    const fields = [
      { name: "Webhook", value: `${hook.name} (${hook.id})` },
      { name: "Channel", value: `${channel} (${channel.id})` },
    ];
    await appendAuditFields(fields, channel.guild, "WEBHOOK_DELETE", id, 9000);
    await sendLog(channel.guild, makeEmbed("Webhook Deleted", `Webhook \`${hook.name}\` was deleted.`, COLORS.ERROR, fields), "channel");
  }

  for (const id of sharedIds) {
    const oldHook = before.get(id);
    const newHook = after.get(id);
    const changes = [];
    pushChange(changes, "Name", oldHook.name, newHook.name);
    pushChange(changes, "Avatar", oldHook.avatar, newHook.avatar);
    pushChange(changes, "Channel", oldHook.channelId, newHook.channelId);
    pushChange(changes, "Type", oldHook.type, newHook.type);
    if (!changes.length) continue;
    await appendAuditFields(changes, channel.guild, "WEBHOOK_UPDATE", id, 9000);
    const nameChanged = !sameComparable(oldHook.name, newHook.name);
    const avatarChanged = !sameComparable(oldHook.avatar, newHook.avatar);
    const channelChanged = !sameComparable(oldHook.channelId, newHook.channelId);
    const typeChanged = !sameComparable(oldHook.type, newHook.type);

    let title = "Webhook Updated";
    let description = `Webhook \`${newHook.name}\` settings changed.`;
    let color = COLORS.INFO;

    if (nameChanged && !avatarChanged && !channelChanged && !typeChanged) {
      title = "Webhook Renamed";
      description = `\`${oldHook.name || "Unknown"}\` -> \`${newHook.name || "Unknown"}\``;
    } else if (channelChanged && !nameChanged && !avatarChanged && !typeChanged) {
      title = "Webhook Channel Changed";
      description = `Webhook \`${newHook.name}\` was moved to another channel.`;
      color = COLORS.WARNING;
    } else if (avatarChanged && !nameChanged && !channelChanged && !typeChanged) {
      title = "Webhook Avatar Updated";
      description = `Webhook \`${newHook.name}\` avatar was updated.`;
    } else if (typeChanged && !nameChanged && !avatarChanged && !channelChanged) {
      title = "Webhook Type Updated";
      description = `Webhook \`${newHook.name}\` type was updated.`;
      color = COLORS.WARNING;
    }

    await sendLog(
      channel.guild,
      makeEmbed(title, description, color, [
        { name: "Webhook", value: `${newHook.name} (${newHook.id})` },
        ...changes.slice(0, 20),
      ]),
      "channel",
    );
  }
});

client.on("autoModerationRuleCreate", async (rule) => {
  const guild = rule.guild || client.guilds.cache.get(rule.guildId);
  if (!guild) return;
  const fields = [
    { name: "Rule", value: `${rule.name} (${rule.id})` },
    { name: "Enabled", value: rule.enabled ? "Yes" : "No", inline: true },
    { name: "Trigger Type", value: `${rule.triggerType}`, inline: true },
  ];
  await sendLog(guild, makeEmbed("AutoMod Rule Created", `Auto moderation rule \`${rule.name}\` was created.`, COLORS.SUCCESS, fields), "moderation");
});

client.on("autoModerationRuleDelete", async (rule) => {
  const guild = rule.guild || client.guilds.cache.get(rule.guildId);
  if (!guild) return;
  const fields = [{ name: "Rule", value: `${rule.name} (${rule.id})` }];
  await sendLog(guild, makeEmbed("AutoMod Rule Deleted", `Auto moderation rule \`${rule.name}\` was deleted.`, COLORS.ERROR, fields), "moderation");
});

client.on("autoModerationRuleUpdate", async (oldRule, newRule) => {
  const guild = newRule.guild || client.guilds.cache.get(newRule.guildId);
  if (!guild) return;
  const changes = [];
  pushChange(changes, "Name", oldRule.name, newRule.name);
  pushChange(changes, "Enabled", oldRule.enabled, newRule.enabled);
  pushChange(changes, "Trigger Type", oldRule.triggerType, newRule.triggerType);
  pushChange(changes, "Event Type", oldRule.eventType, newRule.eventType);
  if (!changes.length) return;
  let title = "AutoMod Rule Updated";
  let description = `Auto moderation rule \`${newRule.name}\` was updated.`;
  if (!sameComparable(oldRule.name, newRule.name)) {
    title = "AutoMod Rule Renamed";
    description = `\`${oldRule.name}\` -> \`${newRule.name}\``;
  } else if (oldRule.enabled !== newRule.enabled) {
    title = newRule.enabled ? "AutoMod Rule Enabled" : "AutoMod Rule Disabled";
    description = `Auto moderation rule \`${newRule.name}\` status changed.`;
  } else if (!sameComparable(oldRule.triggerType, newRule.triggerType)) {
    title = "AutoMod Trigger Updated";
    description = `Auto moderation trigger type changed for \`${newRule.name}\`.`;
  }
  await sendLog(
    guild,
    makeEmbed(title, description, COLORS.INFO, [
      { name: "Rule", value: `${newRule.name} (${newRule.id})` },
      ...changes.slice(0, 20),
    ]),
    "moderation",
  );
});

client.on("autoModerationActionExecution", async (execution) => {
  const guild = execution.guild || client.guilds.cache.get(execution.guildId);
  if (!guild) return;
  const fields = [
    { name: "Rule", value: `${execution.ruleName || "Unknown"} (${execution.ruleId || "N/A"})` },
    { name: "User", value: execution.userId ? `<@${execution.userId}> (${execution.userId})` : "Unknown" },
    { name: "Channel", value: execution.channelId ? `<#${execution.channelId}> (${execution.channelId})` : "Unknown" },
    { name: "Action Type", value: `${execution.action?.type ?? "Unknown"}` },
  ];
  if (execution.matchedKeyword) fields.push({ name: "Matched Keyword", value: shorten(execution.matchedKeyword, 400) });
  if (execution.content) fields.push({ name: "Content", value: shorten(execution.content, 900) });
  await sendLog(guild, makeEmbed("AutoMod Action Executed", "An auto moderation action was triggered.", COLORS.WARNING, fields), "moderation");
});

client.on("messageDelete", async (message) => {
  if (message.partial) {
    message = await message.fetch().catch(() => message);
  }
  if (!message.guild) return;
  if (!message.channel) return;

  const channelName = message.channel.name ? `#${message.channel.name}` : `${message.channel}`;
  const content = message.content?.trim()
    ? shorten(message.content.trim(), 1200)
    : message.attachments?.size
      ? "[Attachment/Embed only]"
      : "No text content.";

  const embed = makeEmbed(
    `Message deleted in ${channelName}`,
    `${content}\n\nMessage ID: ${message.id || "Unknown"}`,
    COLORS.ERROR,
  );

  const authorName = message.author?.tag || "Unknown User";
  const authorId = message.author?.id || "Unknown";
  const authorIcon =
    message.author && typeof message.author.displayAvatarURL === "function"
      ? message.author.displayAvatarURL({ dynamic: true })
      : null;

  setEmbedAuthorSafe(embed, authorName, authorIcon);
  setEmbedFooterSafe(embed, `ID: ${authorId}`);
  await sendLog(message.guild, embed, "message");
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (oldMessage.partial) {
    oldMessage = await oldMessage.fetch().catch(() => oldMessage);
  }
  if (newMessage.partial) {
    newMessage = await newMessage.fetch().catch(() => newMessage);
  }

  if (!newMessage.guild) return;
  if (!newMessage.channel) return;
  if ((oldMessage.content || "") === (newMessage.content || "")) return;

  const channelName = newMessage.channel.name ? `#${newMessage.channel.name}` : `${newMessage.channel}`;
  const before = oldMessage.content?.trim() ? shorten(oldMessage.content.trim(), 550) : "No text content.";
  const after = newMessage.content?.trim() ? shorten(newMessage.content.trim(), 550) : "No text content.";

  const embed = makeEmbed(
    `Message edited in ${channelName}`,
    `Before: ${before}\nAfter: ${after}\n\nMessage ID: ${newMessage.id || "Unknown"}`,
    COLORS.INFO,
  );

  const authorName = newMessage.author?.tag || "Unknown User";
  const authorId = newMessage.author?.id || "Unknown";
  const authorIcon =
    newMessage.author && typeof newMessage.author.displayAvatarURL === "function"
      ? newMessage.author.displayAvatarURL({ dynamic: true })
      : null;

  setEmbedAuthorSafe(embed, authorName, authorIcon);
  setEmbedFooterSafe(embed, `ID: ${authorId}`);
  await sendLog(newMessage.guild, embed, "message");
});

client.on("messageDeleteBulk", async (messages, channel) => {
  if (!messages || !messages.size || !channel?.guild) return;
  const embed = makeEmbed("Bulk Message Delete", `A bulk delete removed ${messages.size} messages in ${channel}.`, COLORS.ERROR, [
    { name: "Channel", value: `${channel} (${channel.id})` },
    { name: "Count", value: `${messages.size}` },
  ]);
  await sendLog(channel.guild, embed, "message");
});

client.on("guildBanAdd", async (ban) => {
  const entry = await fetchAuditEntry(ban.guild, "MEMBER_BAN_ADD", ban.user.id, 7000);
  const embed = makeEmbed("User Banned", `${ban.user.tag} was banned.`, COLORS.WARNING, [
    { name: "User", value: `${ban.user.tag} (${ban.user.id})` },
    { name: "Action By", value: entry?.executor ? `${entry.executor.tag} (${entry.executor.id})` : "Unknown" },
    { name: "Reason", value: entry?.reason || "No reason provided." },
  ]);
  await sendLog(ban.guild, embed, "moderation");
});

client.on("guildBanRemove", async (ban) => {
  const entry = await fetchAuditEntry(ban.guild, "MEMBER_BAN_REMOVE", ban.user.id, 7000);
  const embed = makeEmbed("User Unbanned", `${ban.user.tag} was unbanned.`, COLORS.SUCCESS, [
    { name: "User", value: `${ban.user.tag} (${ban.user.id})` },
    { name: "Action By", value: entry?.executor ? `${entry.executor.tag} (${entry.executor.id})` : "Unknown" },
    { name: "Reason", value: entry?.reason || "No reason provided." },
  ]);
  await sendLog(ban.guild, embed, "moderation");
});
}

module.exports = { registerLoggingEvents };

