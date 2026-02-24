function registerLifecycleEvents(client, context) {
  const {
    registerCommands,
    primeAeonAgentRuntime,
    primeInviteCache,
    primeWebhookCache,
    updateGuildStatsChannels,
    pruneTempVoiceStateForGuild,
    bootstrapReminders,
    inviteUsesCache,
    memberCountCache,
    statsUpdateInFlight,
    webhookCache,
    remindersStore,
    cancelReminderTimer,
    saveReminders,
    setupConfigStore,
    saveSetupConfig,
    autoRoleStore,
    saveAutoRoleConfig,
    jtcConfigStore,
    saveJtcConfig,
    warningsStore,
    saveWarnings,
    logConfigStore,
    saveLogConfig,
    modActionsStore,
    saveModActions,
    botProfileStore,
    saveBotProfileStore,
  } = context;

  client.once("clientReady", async () => {
    console.log(`Bot is online as ${client.user.tag}`);
    console.log(`Serving ${client.guilds.cache.size} server(s)`);

    if (typeof primeAeonAgentRuntime === "function") {
      primeAeonAgentRuntime().catch((error) => {
        const message = String(error?.message || error || "Unknown error");
        console.warn(`AEON AI prewarm failed: ${message}`);
      });
    }

    for (const guild of client.guilds.cache.values()) {
      await Promise.allSettled([
        registerCommands(guild),
        primeInviteCache(guild),
        primeWebhookCache(guild),
        updateGuildStatsChannels(guild, null),
        pruneTempVoiceStateForGuild(guild),
      ]);
    }

    bootstrapReminders();
  });

  client.on("guildCreate", async (guild) => {
    await Promise.allSettled([
      registerCommands(guild),
      primeInviteCache(guild),
      primeWebhookCache(guild),
      updateGuildStatsChannels(guild, null),
      pruneTempVoiceStateForGuild(guild),
    ]);
  });

  client.on("guildDelete", async (guild) => {
    inviteUsesCache.delete(guild.id);
    memberCountCache?.delete?.(guild.id);
    statsUpdateInFlight?.delete?.(guild.id);

    for (const channelId of [...webhookCache.keys()]) {
      const channel = client.channels.cache.get(channelId);
      if (!channel || channel.guild?.id === guild.id) webhookCache.delete(channelId);
    }

    for (const reminder of Object.values(remindersStore)) {
      if (reminder.guildId !== guild.id) continue;
      cancelReminderTimer(reminder.id);
      delete remindersStore[reminder.id];
    }
    saveReminders();

    delete setupConfigStore[guild.id];
    saveSetupConfig();

    delete autoRoleStore[guild.id];
    saveAutoRoleConfig();

    delete jtcConfigStore[guild.id];
    saveJtcConfig();

    delete warningsStore[guild.id];
    saveWarnings();

    delete logConfigStore[guild.id];
    saveLogConfig();

    delete modActionsStore[guild.id];
    saveModActions();

    if (botProfileStore && typeof botProfileStore === "object") {
      delete botProfileStore[guild.id];
      if (typeof saveBotProfileStore === "function") saveBotProfileStore();
    }
  });
}

module.exports = { registerLifecycleEvents };
