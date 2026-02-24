const math = require("mathjs");
const fetch = require("node-fetch");
const { QuickDB } = require("quick.db");

const db = new QuickDB();

const XP_PER_MESSAGE = Math.max(1, Number.parseInt(process.env.XP_PER_MESSAGE || "5", 10) || 5);
const XP_COOLDOWN_MS = Math.max(250, Number.parseInt(process.env.XP_COOLDOWN_MS || "500", 10) || 500);
const LEADERBOARD_PAGE_SIZE = 10;
const HOF_LEADERBOARD_PAGE_SIZE = 10;
const MAX_LEVEL_RULE_LEVEL = 1000;
const MAX_SET_LEVEL_VALUE = 1000;
const MAX_ADD_XP_AMOUNT = 1_000_000;
const LEGACY_LEVEL_UP_CHANNEL_KEY = process.env.LEGACY_LEVEL_UP_CHANNEL_KEY || "";
const POKETWO_BOT_ID = process.env.POKETWO_BOT_ID || "";
const HALL_OF_FAME_CHANNEL_ID = process.env.HALL_OF_FAME_CHANNEL_ID || "";
const HOF_STAR_THRESHOLD = Math.max(1, Number.parseInt(process.env.HOF_STAR_THRESHOLD || "5", 10) || 5);

const MU_COMMAND_NAMES = new Set([
  "roast",
  "ship",
  "pokeping",
  "embed_send",
  "level_blacklist_add",
  "level_blacklist_remove",
  "level_blacklist_list",
  "hotrate",
  "mute",
  "leaderboard",
  "hof_leaderboard",
  "unmute",
  "quote",
  "quote_style",
  "calculate",
  "member_count",
  "rules",
  "rules_dm",
  "meme",
  "meme_mc",
  "joke",
  "8ball",
  "wholesome",
  "say",
  "flip",
  "rps",
  "kill",
  "level_channel",
  "level_role_add",
  "level_role_remove",
  "level_role_clear",
  "level_xp_add",
  "level_set",
  "gayrate",
  "wordgame_start",
  "level",
  "autoreact_toggle",
]);

const autoReactByGuild = new Map();
const pokePingUsersByGuild = new Map();
const xpCooldowns = new Map();
const hallOfFameSyncInFlight = new Set();

const RPS_CHOICES = ["rock", "paper", "scissors"];
const EIGHT_BALL_RESPONSES = [
  "It is certain.",
  "Without a doubt.",
  "Most likely.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
  "Yes. Absolutely.",
];
const WHOLESOME_LINES = [
  "You are doing better than you think.",
  "Small progress still counts.",
  "Your effort has value even when it feels invisible.",
  "One kind message can change someone's entire day.",
  "You belong here.",
  "Keep going. Your future self will thank you.",
];
const ROAST_LINES = [
  "{target} has two brain cells and both are buffering.",
  "{target} is the reason the mute button exists.",
  "{target} brings everyone joy when they go offline.",
  "{target} typed this with autocorrect turned off and common sense turned down.",
  "{target} could get lost in a straight hallway.",
  "{target} is what happens when lag becomes a personality.",
];
const KILL_LINES = [
  "{killer} challenged {target} to a 1v1 and the respawn timer never ended.",
  "{killer} sent {target} into the shadow realm.",
  "{target} accepted a free Nitro link from {killer}. It was fatal.",
  "{killer} used Alt+F4. {target} disconnected permanently.",
  "{target} got comboed by {killer} and rage quit existence.",
];
const THEME_COLORS = {
  dark: "#111827",
  blue: "#1D4ED8",
  purple: "#7C3AED",
  gradient: "#DB2777",
  red: "#B91C1C",
  green: "#15803D",
};
const WORD_FRAGMENTS = [
  "ing",
  "ion",
  "ent",
  "ate",
  "ous",
  "est",
  "ble",
  "ive",
  "ack",
  "ash",
  "ock",
  "ell",
  "all",
  "ore",
  "ish",
  "art",
  "ump",
  "ift",
  "ink",
  "ick",
];

function isMuCommand(commandName) {
  return MU_COMMAND_NAMES.has(commandName);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function sanitizeColor(input, fallback = "#2F6DB3") {
  const text = String(input || "").trim();
  if (!text) return fallback;
  const match = text.match(/^#?([A-Fa-f0-9]{6})$/);
  if (!match) return fallback;
  return `#${match[1].toUpperCase()}`;
}

function shortenText(input, maxLength = 1024) {
  const text = String(input ?? "");
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, Math.max(0, maxLength));
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getRequiredXP(level) {
  return 100 + level * 25;
}

function parseDurationMs(input) {
  const text = String(input || "").trim().toLowerCase();
  const match = text.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) {
    return { ok: false, ms: 0, error: "Use format like `30s`, `10m`, `2h`, `1d`." };
  }
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = value * multipliers[unit];
  if (!Number.isFinite(ms) || ms <= 0) {
    return { ok: false, ms: 0, error: "Duration must be a positive value." };
  }
  const max = 28 * 24 * 60 * 60 * 1000;
  if (ms > max) {
    return { ok: false, ms: 0, error: "Duration cannot exceed 28 days." };
  }
  return { ok: true, ms };
}

function parseSubcommandSafe(interaction) {
  try {
    return interaction.options.getSubcommand(false);
  } catch (_) {
    return null;
  }
}

function progressBar(percent, width = 10) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${"=".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
}

function levelStorageKey(guildId, userId) {
  return `${guildId}-${userId}`;
}

async function getLevelUpChannelId(guildId) {
  const current = await db.get(`levelup_channel.${guildId}`);
  if (current) return current;
  if (LEGACY_LEVEL_UP_CHANNEL_KEY) {
    const direct = await db.get(`${guildId}_${LEGACY_LEVEL_UP_CHANNEL_KEY}`);
    if (direct) return direct;
  }
  const allRows = await db.all().catch(() => []);
  const candidate = allRows.find((row) => {
    const key = String(row?.id || "");
    const value = row?.value;
    return key.startsWith(`${guildId}_`) && /^\d{17,20}$/.test(String(value || ""));
  });
  return candidate?.value || "";
}

async function setLevelUpChannelId(guildId, channelId) {
  await db.set(`levelup_channel.${guildId}`, channelId);
  if (LEGACY_LEVEL_UP_CHANNEL_KEY) {
    await db.set(`${guildId}_${LEGACY_LEVEL_UP_CHANNEL_KEY}`, channelId);
  }
}

async function getBlacklist(guildId) {
  return (await db.get(`xp_blacklist.${guildId}`)) || [];
}

async function getAutoReactConfig(guildId) {
  if (autoReactByGuild.has(guildId)) return autoReactByGuild.get(guildId);
  const stored = (await db.get(`autoreact.${guildId}`)) || {
    enabled: false,
    targetUserId: "",
    emoji: "",
  };
  autoReactByGuild.set(guildId, stored);
  return stored;
}

async function saveAutoReactConfig(guildId, config) {
  autoReactByGuild.set(guildId, config);
  await db.set(`autoreact.${guildId}`, config);
}

async function getPokePingSet(guildId) {
  if (pokePingUsersByGuild.has(guildId)) return pokePingUsersByGuild.get(guildId);
  const stored = (await db.get(`pokeping.${guildId}`)) || [];
  const set = new Set(stored);
  pokePingUsersByGuild.set(guildId, set);
  return set;
}

async function savePokePingSet(guildId) {
  const set = pokePingUsersByGuild.get(guildId) || new Set();
  await db.set(`pokeping.${guildId}`, [...set]);
}

function hasPermission(member, permission) {
  try {
    return Boolean(member?.permissions?.has?.(permission));
  } catch (_) {
    return false;
  }
}

function hasChannelPermission(channel, member, permission) {
  try {
    return Boolean(channel?.permissionsFor?.(member)?.has?.(permission));
  } catch (_) {
    return false;
  }
}

function toSafeInt(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

async function getGuildLevelStats(guildId) {
  const stats = new Map();
  const guildText = String(guildId || "");

  const setField = (userId, field, value) => {
    if (!/^\d{17,20}$/.test(String(userId || ""))) return;
    const current = stats.get(userId) || { xp: 0, level: 0 };
    current[field] = toSafeInt(value, current[field]);
    stats.set(userId, current);
  };

  const ingestBucket = (bucket, field) => {
    if (!bucket || typeof bucket !== "object") return;

    for (const [key, value] of Object.entries(bucket)) {
      const compositeMatch = key.match(/^(\d{17,20})[-_](\d{17,20})$/);
      if (compositeMatch) {
        const [, rowGuildId, rowUserId] = compositeMatch;
        if (rowGuildId === guildText) setField(rowUserId, field, value);
        continue;
      }

      if (key === guildText && value && typeof value === "object") {
        for (const [nestedUserId, nestedValue] of Object.entries(value)) {
          setField(nestedUserId, field, nestedValue);
        }
        continue;
      }

      if (/^\d{17,20}$/.test(key) && Number.isFinite(Number(value))) {
        setField(key, field, value);
      }
    }
  };

  const xpBucket = await db.get("xp").catch(() => null);
  const levelBucket = await db.get("level").catch(() => null);
  ingestBucket(xpBucket, "xp");
  ingestBucket(levelBucket, "level");

  if (stats.size > 0) return stats;

  const rows = await db.all().catch(() => []);
  const xpPrefixDash = `xp.${guildText}-`;
  const levelPrefixDash = `level.${guildText}-`;
  const xpPrefixUnderscore = `xp.${guildText}_`;
  const levelPrefixUnderscore = `level.${guildText}_`;

  for (const row of rows) {
    const key = String(row?.id || "");
    if (key.startsWith(xpPrefixDash)) {
      setField(key.slice(xpPrefixDash.length), "xp", row?.value);
      continue;
    }
    if (key.startsWith(levelPrefixDash)) {
      setField(key.slice(levelPrefixDash.length), "level", row?.value);
      continue;
    }
    if (key.startsWith(xpPrefixUnderscore)) {
      setField(key.slice(xpPrefixUnderscore.length), "xp", row?.value);
      continue;
    }
    if (key.startsWith(levelPrefixUnderscore)) {
      setField(key.slice(levelPrefixUnderscore.length), "level", row?.value);
    }
  }

  return stats;
}

function resolveHallOfFameChannelId(guildId, getGuildSetupConfig = null) {
  if (typeof getGuildSetupConfig === "function") {
    const setup = getGuildSetupConfig(guildId);
    const configured = typeof setup?.hallOfFameChannelId === "string" ? setup.hallOfFameChannelId : "";
    if (configured) return configured;
  }
  return HALL_OF_FAME_CHANNEL_ID;
}

function isHallOfFameStarEmoji(emoji) {
  const id = String(emoji?.id || "");
  const name = String(emoji?.name || "").trim();
  if (!id) return name === "⭐";
  return name.toLowerCase() === "star";
}

function normalizeHallOfFameEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const sourceMessageId = String(entry.sourceMessageId || "").trim();
  const sourceChannelId = String(entry.sourceChannelId || "").trim();
  const authorId = String(entry.authorId || "").trim();
  const hofMessageId = String(entry.hofMessageId || "").trim();
  if (!/^\d{17,20}$/.test(sourceMessageId)) return null;
  if (!/^\d{17,20}$/.test(sourceChannelId)) return null;
  if (!/^\d{17,20}$/.test(authorId)) return null;
  if (hofMessageId && !/^\d{17,20}$/.test(hofMessageId)) return null;
  return {
    sourceMessageId,
    sourceChannelId,
    authorId,
    hofMessageId,
    starCount: toSafeInt(entry.starCount, 0),
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
  };
}

function normalizeHallOfFameEntriesMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const output = {};
  for (const [messageId, entry] of Object.entries(raw)) {
    if (!/^\d{17,20}$/.test(String(messageId || ""))) continue;
    const normalized = normalizeHallOfFameEntry(entry);
    if (!normalized) continue;
    output[messageId] = normalized;
  }
  return output;
}

async function getGuildHallOfFameEntries(guildId) {
  const raw = await db.get(`hof.entries.${guildId}`).catch(() => ({}));
  return normalizeHallOfFameEntriesMap(raw);
}

async function getGuildHallOfFameEntry(guildId, messageId) {
  const raw = await db.get(`hof.entries.${guildId}.${messageId}`).catch(() => null);
  return normalizeHallOfFameEntry(raw);
}

async function setGuildHallOfFameEntry(guildId, messageId, entry) {
  const normalized = normalizeHallOfFameEntry(entry);
  if (!normalized) return;
  await db.set(`hof.entries.${guildId}.${messageId}`, normalized);
}

function pickMessageImageAttachment(message) {
  const attachments = message?.attachments;
  if (!attachments || typeof attachments.values !== "function") return null;
  for (const attachment of attachments.values()) {
    const contentType = String(attachment?.contentType || "").toLowerCase();
    const name = String(attachment?.name || "").toLowerCase();
    const isImage =
      contentType.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|bmp|tiff|avif)$/i.test(name);
    if (isImage && attachment?.url) return attachment.url;
  }
  return null;
}

function buildHallOfFameEmbed(message, starCount, context) {
  const { makeEmbed, setEmbedAuthorSafe, setEmbedFooterSafe } = context;
  const content = String(message?.content || "").trim();
  const description = content ? shortenText(content, 2800) : "*No text content*";
  const embed = makeEmbed("Hall of Fame", description, "#F59E0B", [
    { name: "Author", value: `<@${message.author.id}>`, inline: true },
    { name: "Stars", value: `⭐ **${toSafeInt(starCount, 0)}**`, inline: true },
    { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
    { name: "Jump", value: `[Go to message](${message.url})`, inline: false },
  ]);
  const authorIcon =
    typeof message.author?.displayAvatarURL === "function"
      ? message.author.displayAvatarURL({ dynamic: true, size: 512 })
      : null;
  setEmbedAuthorSafe(embed, message.author.tag || message.author.username || "Unknown User", authorIcon);

  const imageUrl = pickMessageImageAttachment(message);
  if (imageUrl && typeof embed.setImage === "function") {
    try {
      embed.setImage(imageUrl);
    } catch (_) {
      // ignore invalid attachment URL
    }
  }

  setEmbedFooterSafe(embed, `Source Message ID: ${message.id}`);
  return embed;
}

async function resolveReactionMessage(reaction) {
  if (!reaction) return null;
  try {
    if (reaction.partial && typeof reaction.fetch === "function") {
      await reaction.fetch();
    }
  } catch (_) {
    return null;
  }
  const message = reaction.message || null;
  if (!message) return null;
  try {
    if (message.partial && typeof message.fetch === "function") {
      await message.fetch();
    }
  } catch (_) {
    return null;
  }
  return message;
}

async function syncHallOfFameFromReaction(reaction, user, context) {
  if (!reaction || !user || user.bot) return;
  if (!isHallOfFameStarEmoji(reaction.emoji)) return;

  const message = await resolveReactionMessage(reaction);
  if (!message?.guild || !message?.author) return;
  if (message.author.bot) return;

  const guildId = message.guild.id;
  const hallOfFameChannelId = resolveHallOfFameChannelId(guildId, context.getGuildSetupConfig);
  if (!hallOfFameChannelId) return;
  if (message.channel?.id === hallOfFameChannelId) return;

  const lockKey = `${guildId}:${message.id}`;
  if (hallOfFameSyncInFlight.has(lockKey)) return;
  hallOfFameSyncInFlight.add(lockKey);

  try {
    const nowIso = new Date().toISOString();
    const starCount = toSafeInt(reaction.count, 0);
    const existing = await getGuildHallOfFameEntry(guildId, message.id);

    const hofChannel =
      message.guild.channels.cache.get(hallOfFameChannelId) ||
      (await message.guild.channels.fetch(hallOfFameChannelId).catch(() => null));
    if (!hofChannel || !context.isTextChannel(hofChannel)) return;

    if (!existing) {
      if (starCount < HOF_STAR_THRESHOLD) return;

      const embed = buildHallOfFameEmbed(message, starCount, context);
      const posted = await hofChannel.send({ embeds: [embed] }).catch(() => null);
      if (!posted) return;

      await setGuildHallOfFameEntry(guildId, message.id, {
        sourceMessageId: message.id,
        sourceChannelId: message.channel.id,
        authorId: message.author.id,
        hofMessageId: posted.id,
        starCount,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      return;
    }

    const next = {
      ...existing,
      sourceMessageId: message.id,
      sourceChannelId: message.channel.id,
      authorId: message.author.id,
      starCount,
      updatedAt: nowIso,
    };
    await setGuildHallOfFameEntry(guildId, message.id, next);

    if (!next.hofMessageId) return;
    const hofMessage = await hofChannel.messages.fetch(next.hofMessageId).catch(() => null);
    if (!hofMessage) return;
    const updatedEmbed = buildHallOfFameEmbed(message, starCount, context);
    await hofMessage.edit({ embeds: [updatedEmbed] }).catch(() => null);
  } finally {
    hallOfFameSyncInFlight.delete(lockKey);
  }
}

function getTimeoutUntilMs(member) {
  const raw = member?.communicationDisabledUntilTimestamp
    || member?.communicationDisabledUntil?.getTime?.()
    || 0;
  return Number.isFinite(raw) ? raw : 0;
}

async function handleMuCommand(context) {
  const {
    interaction,
    send,
    fail,
    makeEmbed,
    COLORS,
    setEmbedAuthorSafe,
    setEmbedFooterSafe,
    setEmbedThumbnailSafe,
    getGuildAutoRoleConfig,
    setGuildAutoRoleConfig,
    canManageRoleByHierarchy,
    getBotMember,
    isTextChannel,
    validateTarget,
    Permissions,
    ActionRowClass,
    ButtonClass,
    resolveButtonStyle,
    getGuildSetupConfig,
  } = context;

  if (!interaction?.inGuild?.() || !isMuCommand(interaction.commandName)) return false;

  const cmd = interaction.commandName;
  const guildId = interaction.guild.id;
  const member = interaction.member;
  const botMember = await getBotMember(interaction.guild).catch(() => null);

  const buildUserCard = (title, targetUser, description, color = COLORS.INFO) => {
    const embed = makeEmbed(title, description, color);
    if (targetUser?.displayAvatarURL) {
      setEmbedThumbnailSafe(embed, targetUser.displayAvatarURL({ dynamic: true, size: 512 }));
    }
    return embed;
  };

  const ensureBotPermission = async (permission, label) => {
    if (!botMember) {
      await fail(interaction, "Bot Permission Missing", "I could not resolve my member record in this server.");
      return false;
    }
    if (!hasPermission(botMember, permission)) {
      await fail(interaction, "Bot Permission Missing", `I need \`${label}\` permission to complete this action.`);
      return false;
    }
    return true;
  };

  const ensureBotChannelPermission = async (channel, permission, label) => {
    if (!botMember) {
      await fail(interaction, "Bot Permission Missing", "I could not resolve my member record in this server.");
      return false;
    }
    if (!hasChannelPermission(channel, botMember, permission)) {
      await fail(interaction, "Bot Permission Missing", `I need \`${label}\` permission in ${channel}.`);
      return false;
    }
    return true;
  };

  try {
    if (cmd === "roast") {
      const target = interaction.options.getUser("target", true);
      const line = pick(ROAST_LINES).replaceAll("{target}", target.username);
      await send(interaction, makeEmbed("Roast Delivered", line, "#C0392B"), false);
      return true;
    }

    if (cmd === "ship") {
      const user1 = interaction.options.getUser("user1", true);
      const user2 = interaction.options.getUser("user2", true);
      const score = randomInt(1, 100);
      const verdict =
        score > 90 ? "Soulbound pairing." : score > 70 ? "Strong chemistry." : score > 40 ? "It might work." : "Unstable connection.";
      await send(
        interaction,
        makeEmbed(
          "Compatibility Scan",
          `${user1} + ${user2}\n\n**${score}%** match\n${verdict}`,
          "#E11D48",
        ),
        false,
      );
      return true;
    }

    if (cmd === "autoreact_toggle") {
      if (!hasPermission(member, Permissions.FLAGS.ADMINISTRATOR)) {
        await fail(interaction, "Access Denied", "Administrator permission is required.");
        return true;
      }
      const user = interaction.options.getUser("user", true);
      const emoji = interaction.options.getString("emoji", true).trim();
      if (emoji.length > 64) {
        await fail(interaction, "Invalid Emoji", "Emoji value is too long.");
        return true;
      }
      const current = await getAutoReactConfig(guildId);
      const isSameConfig = current.enabled && current.targetUserId === user.id && current.emoji === emoji;
      const enabled = !isSameConfig;
      const next = {
        enabled,
        targetUserId: enabled ? user.id : "",
        emoji: enabled ? emoji : "",
      };
      await saveAutoReactConfig(guildId, next);
      const text = enabled
        ? `Auto-react enabled for ${user} with ${emoji}.`
        : "Auto-react disabled.";
      await send(interaction, makeEmbed("Auto React", text, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "pokeping") {
      const sub = parseSubcommandSafe(interaction) || "add";
      const set = await getPokePingSet(guildId);
      if (sub === "add") {
        if (set.has(interaction.user.id)) {
          await send(interaction, makeEmbed("PokePing Enabled", "You are already registered for spawn pings.", COLORS.WARNING));
          return true;
        }
        set.add(interaction.user.id);
        await savePokePingSet(guildId);
        await send(interaction, makeEmbed("PokePing Enabled", "You will be pinged on Poketwo spawns.", COLORS.SUCCESS));
        return true;
      }
      if (sub === "remove") {
        if (!set.has(interaction.user.id)) {
          await send(interaction, makeEmbed("PokePing Disabled", "You are not currently registered.", COLORS.WARNING));
          return true;
        }
        set.delete(interaction.user.id);
        await savePokePingSet(guildId);
        await send(interaction, makeEmbed("PokePing Disabled", "You will no longer be pinged.", COLORS.WARNING));
        return true;
      }
      if (!set.size) {
        await send(interaction, makeEmbed("PokePing List", "No registered users.", COLORS.INFO));
        return true;
      }
      const allMentions = [...set].map((id) => `<@${id}>`);
      const preview = allMentions.slice(0, 50).join(", ");
      const suffix = allMentions.length > 50 ? `\n+${allMentions.length - 50} more` : "";
      await send(interaction, makeEmbed("PokePing List", `${preview}${suffix}`, COLORS.INFO), false);
      return true;
    }

    if (cmd === "embed_send") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_GUILD)) {
        await fail(interaction, "Access Denied", "Manage Server permission is required.");
        return true;
      }
      const channel = interaction.options.getChannel("channel", true);
      if (!isTextChannel(channel)) {
        await fail(interaction, "Invalid Channel", "Please choose a standard text channel.");
        return true;
      }

      const title = String(interaction.options.getString("title") || "Announcement").trim().slice(0, 256) || "Announcement";
      const description = String(interaction.options.getString("description") || "No description provided.")
        .trim()
        .slice(0, 4000) || "No description provided.";
      const color = sanitizeColor(interaction.options.getString("color"), "#1F4E79");

      if (!(await ensureBotChannelPermission(channel, Permissions.FLAGS.SEND_MESSAGES, "Send Messages"))) {
        return true;
      }
      const embedPerm = Permissions.FLAGS.EMBED_LINKS;
      if (embedPerm !== undefined && !(await ensureBotChannelPermission(channel, embedPerm, "Embed Links"))) {
        return true;
      }

      const panel = makeEmbed(title, description, color);
      setEmbedFooterSafe(panel, `Sent by ${interaction.user.tag}`);
      await channel.send({ embeds: [panel] });
      await send(interaction, makeEmbed("Embed Sent", `Message posted in ${channel}.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_blacklist_add") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_GUILD)) {
        await fail(interaction, "Access Denied", "Manage Server permission is required.");
        return true;
      }
      const channel = interaction.options.getChannel("channel", true);
      if (!isTextChannel(channel)) {
        await fail(interaction, "Invalid Channel", "Please choose a standard text channel.");
        return true;
      }
      const list = await getBlacklist(guildId);
      if (list.includes(channel.id)) {
        await send(interaction, makeEmbed("XP Blacklist", `${channel} is already blacklisted.`, COLORS.WARNING));
        return true;
      }
      list.push(channel.id);
      await db.set(`xp_blacklist.${guildId}`, list);
      await send(interaction, makeEmbed("XP Blacklist Updated", `${channel} was blacklisted.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_blacklist_remove") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_GUILD)) {
        await fail(interaction, "Access Denied", "Manage Server permission is required.");
        return true;
      }
      const channel = interaction.options.getChannel("channel", true);
      if (!isTextChannel(channel)) {
        await fail(interaction, "Invalid Channel", "Please choose a standard text channel.");
        return true;
      }
      const list = await getBlacklist(guildId);
      if (!list.includes(channel.id)) {
        await send(interaction, makeEmbed("XP Blacklist", `${channel} is not blacklisted.`, COLORS.WARNING));
        return true;
      }
      const next = list.filter((id) => id !== channel.id);
      await db.set(`xp_blacklist.${guildId}`, next);
      await send(interaction, makeEmbed("XP Blacklist Updated", `${channel} was removed.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_blacklist_list") {
      const list = await getBlacklist(guildId);
      const text = list.length ? list.map((id) => `<#${id}>`).join("\n") : "No blacklisted channels.";
      await send(interaction, makeEmbed("XP Blacklisted Channels", text, COLORS.INFO));
      return true;
    }

    if (cmd === "mute") {
      if (!hasPermission(member, Permissions.FLAGS.MODERATE_MEMBERS)) {
        await fail(interaction, "Access Denied", "Moderate Members permission is required.");
        return true;
      }
      if (!(await ensureBotPermission(Permissions.FLAGS.MODERATE_MEMBERS, "Moderate Members"))) {
        return true;
      }
      const targetUser = interaction.options.getUser("target", true);
      const target =
        interaction.options.getMember("target") ||
        (await interaction.guild.members.fetch(targetUser.id).catch(() => null));
      if (!target) {
        await fail(interaction, "Target Not Found", "That user is not in this server.");
        return true;
      }
      if (typeof validateTarget === "function" && !(await validateTarget(interaction, botMember, target))) {
        return true;
      }
      const parsed = parseDurationMs(interaction.options.getString("duration", true));
      if (!parsed.ok) {
        await fail(interaction, "Invalid Duration", parsed.error);
        return true;
      }
      const timeoutUntil = getTimeoutUntilMs(target);
      if (timeoutUntil > Date.now()) {
        await fail(interaction, "Already Muted", `This user is already muted until <t:${Math.floor(timeoutUntil / 1000)}:f>.`);
        return true;
      }
      await target.timeout(parsed.ms, `Muted by ${interaction.user.tag} (${interaction.user.id})`);
      const unmuteAt = Math.floor((Date.now() + parsed.ms) / 1000);
      await send(
        interaction,
        makeEmbed(
          "User Muted",
          `${target} timed out for \`${interaction.options.getString("duration", true)}\`.\nEnds: <t:${unmuteAt}:f> (<t:${unmuteAt}:R>)`,
          COLORS.SUCCESS,
        ),
      );
      return true;
    }

    if (cmd === "unmute") {
      if (!hasPermission(member, Permissions.FLAGS.MODERATE_MEMBERS)) {
        await fail(interaction, "Access Denied", "Moderate Members permission is required.");
        return true;
      }
      if (!(await ensureBotPermission(Permissions.FLAGS.MODERATE_MEMBERS, "Moderate Members"))) {
        return true;
      }
      const targetUser = interaction.options.getUser("target", true);
      const target =
        interaction.options.getMember("target") ||
        (await interaction.guild.members.fetch(targetUser.id).catch(() => null));
      if (!target) {
        await fail(interaction, "Target Not Found", "That user is not in this server.");
        return true;
      }
      if (typeof validateTarget === "function" && !(await validateTarget(interaction, botMember, target))) {
        return true;
      }
      const timeoutUntil = getTimeoutUntilMs(target);
      if (timeoutUntil <= Date.now()) {
        await fail(interaction, "Not Muted", "This user does not have an active timeout.");
        return true;
      }
      await target.timeout(null, `Unmuted by ${interaction.user.tag} (${interaction.user.id})`);
      await send(interaction, makeEmbed("User Unmuted", `${target} can talk again.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_channel") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_GUILD)) {
        await fail(interaction, "Access Denied", "Manage Server permission is required.");
        return true;
      }
      const channel = interaction.options.getChannel("channel", true);
      if (!isTextChannel(channel)) {
        await fail(interaction, "Invalid Channel", "Please choose a standard text channel.");
        return true;
      }
      if (!(await ensureBotChannelPermission(channel, Permissions.FLAGS.SEND_MESSAGES, "Send Messages"))) {
        return true;
      }
      await setLevelUpChannelId(guildId, channel.id);
      await send(interaction, makeEmbed("Level-Up Channel Set", `Announcements will be sent in ${channel}.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_role_add") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_ROLES)) {
        await fail(interaction, "Access Denied", "Manage Roles permission is required.");
        return true;
      }
      if (!(await ensureBotPermission(Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) {
        return true;
      }
      const level = interaction.options.getInteger("level", true);
      const role = interaction.options.getRole("role", true);
      if (level < 1 || level > MAX_LEVEL_RULE_LEVEL) {
        await fail(interaction, "Invalid Level", `Level must be between **1** and **${MAX_LEVEL_RULE_LEVEL}**.`);
        return true;
      }
      if (role.id === interaction.guild.id) {
        await fail(interaction, "Invalid Role", "Cannot use @everyone.");
        return true;
      }
      if (role.managed) {
        await fail(interaction, "Managed Role", "Managed roles cannot be assigned as level rewards.");
        return true;
      }
      if (!canManageRoleByHierarchy(member, role, interaction.guild.ownerId)) {
        await fail(interaction, "Hierarchy Error", "Your top role must be above the target role.");
        return true;
      }
      if (botMember?.roles?.highest?.comparePositionTo?.(role) <= 0) {
        await fail(interaction, "Hierarchy Error", "My top role must be above the target role.");
        return true;
      }
      await db.set(`levelrole.${guildId}.${level}`, role.id);
      await send(interaction, makeEmbed("Level Role Set", `${role} will be granted at level **${level}**.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_role_remove") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_ROLES)) {
        await fail(interaction, "Access Denied", "Manage Roles permission is required.");
        return true;
      }
      if (!(await ensureBotPermission(Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) {
        return true;
      }
      const level = interaction.options.getInteger("level", true);
      const role = interaction.options.getRole("role", true);
      if (level < 1 || level > MAX_LEVEL_RULE_LEVEL) {
        await fail(interaction, "Invalid Level", `Level must be between **1** and **${MAX_LEVEL_RULE_LEVEL}**.`);
        return true;
      }
      if (role.id === interaction.guild.id) {
        await fail(interaction, "Invalid Role", "Cannot use @everyone.");
        return true;
      }
      if (role.managed) {
        await fail(interaction, "Managed Role", "Managed roles cannot be used in clear-role rules.");
        return true;
      }
      if (!canManageRoleByHierarchy(member, role, interaction.guild.ownerId)) {
        await fail(interaction, "Hierarchy Error", "Your top role must be above the target role.");
        return true;
      }
      if (botMember?.roles?.highest?.comparePositionTo?.(role) <= 0) {
        await fail(interaction, "Hierarchy Error", "My top role must be above the target role.");
        return true;
      }
      await db.set(`clearrole.${guildId}.${level}`, role.id);
      await send(interaction, makeEmbed("Level Clear Role Set", `${role} will be removed at level **${level}**.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_role_clear") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_GUILD)) {
        await fail(interaction, "Access Denied", "Manage Server permission is required.");
        return true;
      }
      await db.delete(`levelrole.${guildId}`);
      await db.delete(`clearrole.${guildId}`);
      await send(interaction, makeEmbed("Level Role Rules Cleared", "All level role rules were removed.", COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_xp_add") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_GUILD)) {
        await fail(interaction, "Access Denied", "Manage Server permission is required.");
        return true;
      }
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      if (amount <= 0) {
        await fail(interaction, "Invalid Amount", "XP amount must be greater than 0.");
        return true;
      }
      if (amount > MAX_ADD_XP_AMOUNT) {
        await fail(interaction, "Invalid Amount", `XP amount cannot exceed **${MAX_ADD_XP_AMOUNT.toLocaleString()}**.`);
        return true;
      }
      const key = levelStorageKey(guildId, target.id);
      const current = (await db.get(`xp.${key}`)) || 0;
      const nextXp = Math.max(0, current + amount);
      await db.set(`xp.${key}`, nextXp);
      await send(interaction, makeEmbed("XP Updated", `Added **${amount} XP** to ${target}.\nCurrent XP: **${nextXp}**`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level_set") {
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_GUILD)) {
        await fail(interaction, "Access Denied", "Manage Server permission is required.");
        return true;
      }
      const target = interaction.options.getUser("user", true);
      const level = interaction.options.getInteger("level", true);
      if (level < 0 || level > MAX_SET_LEVEL_VALUE) {
        await fail(interaction, "Invalid Level", `Level must be between **0** and **${MAX_SET_LEVEL_VALUE}**.`);
        return true;
      }
      const key = levelStorageKey(guildId, target.id);
      await db.set(`level.${key}`, level);
      await db.set(`xp.${key}`, 0);
      await send(interaction, makeEmbed("Level Updated", `${target} is now level **${level}**.\nXP progress reset to **0**.`, COLORS.SUCCESS));
      return true;
    }

    if (cmd === "level") {
      const target = interaction.options.getUser("user") || interaction.user;
      const key = levelStorageKey(guildId, target.id);
      const xp = (await db.get(`xp.${key}`)) || 0;
      const level = (await db.get(`level.${key}`)) || 0;
      const required = getRequiredXP(level);
      const pct = required > 0 ? Math.max(0, Math.min(100, Math.round((xp / required) * 100))) : 0;
      const embed = buildUserCard(
        "Level Profile",
        target,
        `${target}\nLevel **${level}**\nXP **${xp}/${required}**\n\`${progressBar(pct)}\` ${pct}%`,
        "#1D4ED8",
      );
      await send(interaction, embed, false);
      return true;
    }

    if (cmd === "leaderboard") {
      await interaction.deferReply();
      const page = Math.max(1, interaction.options.getInteger("page") || 1);
      const statsByUserId = await getGuildLevelStats(guildId);
      let members = null;
      try {
        members = await interaction.guild.members.fetch();
      } catch (_) {
        members = null;
      }

      const ranked = [];
      for (const [memberId, stats] of statsByUserId.entries()) {
        const target = members?.get(memberId) || interaction.guild.members.cache.get(memberId) || null;
        if (target?.user?.bot) continue;
        const xp = toSafeInt(stats?.xp, 0);
        const level = toSafeInt(stats?.level, 0);
        if (!xp && !level) continue;
        ranked.push({
          id: memberId,
          mention: `<@${memberId}>`,
          name: target?.displayName || target?.user?.username || "Unknown User",
          xp,
          level,
          avatarUrl:
            typeof target?.user?.displayAvatarURL === "function"
              ? target.user.displayAvatarURL({ dynamic: true, size: 256 })
              : "",
        });
      }
      ranked.sort((a, b) => (b.level - a.level) || (b.xp - a.xp));
      if (!ranked.length) {
        await interaction.editReply({ embeds: [makeEmbed("Leaderboard", "No XP data found yet.", COLORS.INFO)] });
        return true;
      }
      const totalPages = Math.max(1, Math.ceil(ranked.length / LEADERBOARD_PAGE_SIZE));
      const current = Math.min(page, totalPages);
      const start = (current - 1) * LEADERBOARD_PAGE_SIZE;
      const slice = ranked.slice(start, start + LEADERBOARD_PAGE_SIZE);
      const pageStart = start + 1;
      const pageEnd = start + slice.length;
      const viewerRank = ranked.findIndex((entry) => entry.id === interaction.user.id) + 1;
      const topThree = ranked
        .slice(0, 3)
        .map((entry, index) => {
          const badge = index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉";
          return `${badge} ${entry.mention} | Lv **${entry.level}**`;
        })
        .join("\n");
      const pageRows = slice
        .map((entry, idx) => {
          const rank = start + idx + 1;
          const required = getRequiredXP(entry.level);
          const pct = required > 0 ? Math.max(0, Math.min(100, Math.floor((entry.xp / required) * 100))) : 0;
          const badge = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "•";
          return `${badge} **#${rank}** ${entry.mention}\n\`Lv ${entry.level} | XP ${entry.xp}/${required} | ${pct}%\``;
        })
        .join("\n\n");

      const embed = makeEmbed(
        "XP Leaderboard",
        `**${interaction.guild.name}** standings\nShowing **#${pageStart}-#${pageEnd}** of **${ranked.length}** ranked users.`,
        "#D01C28",
        [
          { name: "Top 3", value: topThree || "No entries", inline: false },
          { name: `This Page (${current}/${totalPages})`, value: pageRows || "No entries", inline: false },
          { name: "Your Rank", value: viewerRank > 0 ? `**#${viewerRank}**` : "Unranked", inline: true },
          { name: "Users / Page", value: `**${LEADERBOARD_PAGE_SIZE}**`, inline: true },
          { name: "Total Ranked", value: `**${ranked.length}**`, inline: true },
        ],
      );

      const topUser = ranked[0];
      if (topUser?.avatarUrl && typeof setEmbedAuthorSafe === "function") {
        setEmbedAuthorSafe(embed, `Top User: ${topUser.name}`, topUser.avatarUrl);
      }
      if (typeof interaction.guild.iconURL === "function") {
        setEmbedThumbnailSafe(embed, interaction.guild.iconURL({ dynamic: true, size: 512 }));
      }

      setEmbedFooterSafe(embed, "Use /leaderboard page:<number>");
      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    if (cmd === "hof_leaderboard") {
      await interaction.deferReply();
      const page = Math.max(1, interaction.options.getInteger("page") || 1);
      const entries = await getGuildHallOfFameEntries(guildId);
      const aggregate = new Map();

      for (const entry of Object.values(entries)) {
        const authorId = String(entry?.authorId || "");
        if (!/^\d{17,20}$/.test(authorId)) continue;
        const stars = toSafeInt(entry?.starCount, 0);
        if (stars <= 0) continue;
        const current = aggregate.get(authorId) || { authorId, stars: 0, posts: 0 };
        current.stars += stars;
        current.posts += 1;
        aggregate.set(authorId, current);
      }

      const ranked = [...aggregate.values()].sort((a, b) => (b.stars - a.stars) || (b.posts - a.posts));
      if (!ranked.length) {
        await interaction.editReply({
          embeds: [makeEmbed("Hall of Fame Leaderboard", "No Hall of Fame star data yet.", COLORS.INFO)],
        });
        return true;
      }

      let members = null;
      try {
        members = await interaction.guild.members.fetch();
      } catch (_) {
        members = null;
      }

      const totalPages = Math.max(1, Math.ceil(ranked.length / HOF_LEADERBOARD_PAGE_SIZE));
      const current = Math.min(page, totalPages);
      const start = (current - 1) * HOF_LEADERBOARD_PAGE_SIZE;
      const slice = ranked.slice(start, start + HOF_LEADERBOARD_PAGE_SIZE);
      const pageStart = start + 1;
      const pageEnd = start + slice.length;
      const viewerRank = ranked.findIndex((entry) => entry.authorId === interaction.user.id) + 1;

      const topThree = ranked
        .slice(0, 3)
        .map((entry, index) => {
          const badge = index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉";
          return `${badge} <@${entry.authorId}> | ⭐ **${entry.stars}**`;
        })
        .join("\n");

      const pageRows = slice
        .map((entry, idx) => {
          const rank = start + idx + 1;
          const member = members?.get(entry.authorId) || interaction.guild.members.cache.get(entry.authorId) || null;
          const displayName = member?.displayName || member?.user?.username || `User ${entry.authorId}`;
          const badge = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "•";
          return `${badge} **#${rank}** <@${entry.authorId}> (${shortenText(displayName, 32)})\n\`⭐ ${entry.stars} | ${entry.posts} post(s)\``;
        })
        .join("\n\n");

      const embed = makeEmbed(
        "Hall of Fame Leaderboard",
        `**${interaction.guild.name}** Hall of Fame standings\nShowing **#${pageStart}-#${pageEnd}** of **${ranked.length}** ranked users.`,
        "#F59E0B",
        [
          { name: "Top 3", value: topThree || "No entries", inline: false },
          { name: `This Page (${current}/${totalPages})`, value: pageRows || "No entries", inline: false },
          { name: "Your Rank", value: viewerRank > 0 ? `**#${viewerRank}**` : "Unranked", inline: true },
          { name: "Users / Page", value: `**${HOF_LEADERBOARD_PAGE_SIZE}**`, inline: true },
          { name: "Total Ranked", value: `**${ranked.length}**`, inline: true },
        ],
      );
      setEmbedFooterSafe(embed, "Star a message (⭐) to push it toward Hall of Fame");
      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    if (cmd === "calculate") {
      const expression = interaction.options.getString("expression", true).trim();
      if (expression.length > 200) {
        await fail(interaction, "Expression Too Long", "Please keep the expression within 200 characters.");
        return true;
      }
      try {
        const result = math.evaluate(expression);
        const output = typeof result === "string" ? result : JSON.stringify(result);
        await send(
          interaction,
          makeEmbed(
            "Calculator",
            `Expression:\n\`${expression}\`\n\nResult:\n\`${String(output ?? result).slice(0, 1200)}\``,
            COLORS.INFO,
          ),
        );
        return true;
      } catch (_) {
        await fail(interaction, "Invalid Expression", "Could not evaluate that expression.");
        return true;
      }
    }

    if (cmd === "quote" || cmd === "quote_style") {
      const text = interaction.options.getString("text", true).trim();
      const author = interaction.options.getString("author")?.trim() || interaction.user.username;
      if (text.length > 600) {
        await fail(interaction, "Quote Too Long", "Quote text must be 600 characters or fewer.");
        return true;
      }
      const theme = cmd === "quote_style" ? (interaction.options.getString("theme") || "dark") : "dark";
      const color = THEME_COLORS[theme] || THEME_COLORS.dark;
      const embed = makeEmbed("Quote Card", `*"${text}"*\n\n- **${author.slice(0, 100)}**`, color);
      setEmbedFooterSafe(embed, `Requested by ${interaction.user.tag}`);
      setEmbedThumbnailSafe(embed, interaction.user.displayAvatarURL({ dynamic: true, size: 256 }));
      await send(interaction, embed, false);
      return true;
    }

    if (cmd === "member_count") {
      let bots = 0;
      let total = Number(interaction.guild.memberCount || 0);
      try {
        const members = await interaction.guild.members.fetch();
        bots = members.filter((m) => m.user?.bot).size;
        total = members.size;
      } catch (_) {
        const cached = interaction.guild.members?.cache;
        if (cached?.size) {
          bots = cached.filter((m) => m.user?.bot).size;
        }
      }
      const humans = Math.max(0, total - bots);
      await send(
        interaction,
        makeEmbed("Member Count", `Total: **${total}**\nHumans: **${humans}**\nBots: **${bots}**`, COLORS.INFO),
        false,
      );
      return true;
    }

    if (cmd === "meme" || cmd === "meme_mc") {
      const endpoint = cmd === "meme_mc" ? "https://meme-api.com/gimme/MinecraftMemes" : "https://meme-api.com/gimme";
      const payload = await fetch(endpoint).then((r) => r.json()).catch(() => null);
      if (!payload?.url) {
        await fail(interaction, "Fetch Failed", "Could not fetch a meme right now.");
        return true;
      }
      const embed = makeEmbed(payload.title || "Meme", payload.postLink || payload.subreddit || "Random meme", COLORS.INFO);
      if (typeof embed.setImage === "function") embed.setImage(payload.url);
      setEmbedFooterSafe(embed, `Upvotes: ${payload.ups || 0}`);
      await send(interaction, embed, false);
      return true;
    }

    if (cmd === "joke") {
      const payload = await fetch("https://official-joke-api.appspot.com/random_joke").then((r) => r.json()).catch(() => null);
      const setup = payload?.setup || "Why do programmers confuse Halloween and Christmas?";
      const punchline = payload?.punchline || "Because OCT 31 == DEC 25.";
      await send(interaction, makeEmbed("Joke", `${setup}\n\n||${punchline}||`, COLORS.INFO));
      return true;
    }

    if (cmd === "wholesome") {
      await send(interaction, makeEmbed("Wholesome Drop", pick(WHOLESOME_LINES), COLORS.SUCCESS));
      return true;
    }

    if (cmd === "8ball") {
      const question = interaction.options.getString("question", true);
      const answer = pick(EIGHT_BALL_RESPONSES);
      await send(interaction, makeEmbed("Magic 8-Ball", `Q: ${question}\nA: **${answer}**`, COLORS.INFO));
      return true;
    }

    if (cmd === "say") {
      const text = interaction.options.getString("text", true).trim();
      if (!hasPermission(member, Permissions.FLAGS.MANAGE_MESSAGES)) {
        await fail(interaction, "Access Denied", "Manage Messages permission is required for `/say`.");
        return true;
      }
      if (!(await ensureBotChannelPermission(interaction.channel, Permissions.FLAGS.SEND_MESSAGES, "Send Messages"))) {
        return true;
      }
      if (!text) {
        await fail(interaction, "Invalid Text", "Message cannot be empty.");
        return true;
      }
      if (text.length > 1800) {
        await fail(interaction, "Message Too Long", "Please keep the message under 1800 characters.");
        return true;
      }
      await interaction.channel.send({
        content: text,
        allowedMentions: { parse: [] },
      });
      await send(interaction, makeEmbed("Message Sent", "Posted successfully.", COLORS.SUCCESS));
      return true;
    }

    if (cmd === "flip") {
      const result = Math.random() > 0.5 ? "Heads" : "Tails";
      await send(interaction, makeEmbed("Coin Flip", `Result: **${result}**`, COLORS.INFO));
      return true;
    }

    if (cmd === "rps") {
      const userChoice = String(interaction.options.getString("choice", true)).toLowerCase();
      if (!RPS_CHOICES.includes(userChoice)) {
        await fail(interaction, "Invalid Choice", "Choose `rock`, `paper`, or `scissors`.");
        return true;
      }
      const botChoice = pick(RPS_CHOICES);
      const win =
        (userChoice === "rock" && botChoice === "scissors") ||
        (userChoice === "paper" && botChoice === "rock") ||
        (userChoice === "scissors" && botChoice === "paper");
      const same = userChoice === botChoice;
      const verdict = same ? "Draw." : win ? "You win." : "Bot wins.";
      await send(
        interaction,
        makeEmbed("Rock Paper Scissors", `You: **${userChoice}**\nBot: **${botChoice}**\n\n${verdict}`, COLORS.INFO),
      );
      return true;
    }

    if (cmd === "kill") {
      const target = interaction.options.getUser("target", true);
      const line = pick(KILL_LINES)
        .replaceAll("{killer}", interaction.user.username)
        .replaceAll("{target}", target.username);
      await send(interaction, makeEmbed("Fatality (Fake)", line, "#C0392B"), false);
      return true;
    }

    if (cmd === "hotrate") {
      const target = interaction.options.getUser("target") || interaction.user;
      const score = randomInt(1, 100);
      await send(interaction, buildUserCard("Hot Rate", target, `${target} is **${score}% hot**.`, "#F97316"));
      return true;
    }

    if (cmd === "gayrate") {
      const target = interaction.options.getUser("target") || interaction.user;
      const score = randomInt(1, 100);
      await send(interaction, buildUserCard("Rainbow Rate", target, `${target} is **${score}% rainbow**.`, "#EC4899"));
      return true;
    }

    if (cmd === "rules" || cmd === "rules_dm") {
      const embed = makeEmbed(
        "Server Rules",
        [
          "**1. Be Respectful**",
          "Treat everyone with respect. No harassing, bullying, or offensive language is allowed. Be mindful of your language and how it may affect others.",
          "",
          "**2. No Discrimination**",
          "Discrimination or hate speech based on race, ethnicity, gender, sexual orientation, religion, or any other characteristic will not be tolerated.",
          "",
          "**3. Keep it Safe**",
          "Do not share personal information such as addresses, phone numbers, or passwords. Keep conversations within appropriate boundaries.",
          "",
          "**4. No Spamming or Self-Promotion**",
          "Avoid flooding the chat with repetitive messages or promoting personal content excessively. This includes advertisements for other Discord servers or external websites unless partnered and approved by the server owner.",
          "",
          "**5. Respect Privacy**",
          "Do not share screenshots or conversations from the server without permission from all parties involved.",
          "",
          "**6. Use Appropriate Channels**",
          "Post in the appropriate channels. Use the designated channels for different topics or discussions.",
          "",
          "**7. No NSFW Content**",
          "Keep all content safe for work. This includes images, links, and discussions. Any NSFW content will be removed, and the user may be subject to disciplinary action. Yes, the NSFW channel is a blatant joke, do not get whooshed.",
          "",
          "**8. Listen to Moderators**",
          "Follow the instructions of the server moderators. They are here to help maintain order and resolve disputes.",
          "",
          "**9. Report Issues**",
          "If you encounter any problems or witness rule violations, report them to the moderators privately. Do not engage in public arguments or conflicts.",
          "",
          "**10. No Trolling or Flaming**",
          "Deliberately provoking arguments or disrupting the community with inflammatory remarks is not allowed.",
          "",
          "**11. English Only**",
          "To ensure everyone can understand and participate, please use English as the primary language in the server.",
          "",
          "**12. Drop Feedback**",
          "If you have any feedback about potential improvements to the server, send a private message or head over to #server-feedback. We are always looking for improvement.",
          "",
          "**13. Have Fun!**",
          "Enjoy your time in the server and make new friends. Let's create a welcoming and enjoyable environment for everyone. Cheers to the batch of 2026!",
        ].join("\n"),
        "#1F4E79",
      );
      if (cmd === "rules_dm") {
        try {
          await interaction.user.send({ embeds: [embed] });
          await send(interaction, makeEmbed("Rules Delivered", "I sent the rules in DM.", COLORS.SUCCESS));
          return true;
        } catch (_) {
          await fail(interaction, "DM Failed", "I could not DM you. Check privacy settings.");
          return true;
        }
      }
      await send(interaction, embed, false);
      return true;
    }

    if (cmd === "wordgame_start") {
      if (!hasPermission(member, Permissions.FLAGS.ADMINISTRATOR)) {
        await fail(interaction, "Access Denied", "Administrator permission is required.");
        return true;
      }

      const players = new Set();
      const roundRow = new ActionRowClass().addComponents(
        new ButtonClass().setCustomId(`wordgame:join:${interaction.id}`).setLabel("Join").setStyle(resolveButtonStyle("SUCCESS")),
        new ButtonClass().setCustomId(`wordgame:start:${interaction.id}`).setLabel("Start").setStyle(resolveButtonStyle("PRIMARY")),
        new ButtonClass().setCustomId(`wordgame:stop:${interaction.id}`).setLabel("Stop").setStyle(resolveButtonStyle("DANGER")),
      );
      const lobby = makeEmbed(
        "WordCore Survival",
        "Press **Join** to enter.\nAn admin can press **Start** when ready.\nYou must send a word containing the shown 3-letter fragment.",
        "#0F766E",
      );
      setEmbedFooterSafe(lobby, "Simple quick mode");
      const reply = await interaction.reply({ embeds: [lobby], components: [roundRow], fetchReply: true });

      const componentCollector = reply.createMessageComponentCollector({
        time: 3 * 60 * 1000,
      });

      componentCollector.on("collect", async (i) => {
        if (i.customId !== `wordgame:join:${interaction.id}` && i.customId !== `wordgame:start:${interaction.id}` && i.customId !== `wordgame:stop:${interaction.id}`) return;
        if (i.customId === `wordgame:join:${interaction.id}`) {
          players.add(i.user.id);
          await i.reply({ content: `Joined. Players: **${players.size}**`, flags: 64 }).catch(() => null);
          return;
        }

        if (!hasPermission(i.member, Permissions.FLAGS.ADMINISTRATOR)) {
          await i.reply({ content: "Only admins can start/stop this game.", flags: 64 }).catch(() => null);
          return;
        }

        if (i.customId === `wordgame:stop:${interaction.id}`) {
          componentCollector.stop("stopped");
          await i.update({ embeds: [makeEmbed("WordCore Survival", "Game stopped.", COLORS.WARNING)], components: [] }).catch(() => null);
          return;
        }

        if (players.size < 2) {
          await i.reply({ content: "Need at least 2 players.", flags: 64 }).catch(() => null);
          return;
        }

        const fragment = pick(WORD_FRAGMENTS);
        await i.update({
          embeds: [makeEmbed("WordCore Round", `Fragment: **${fragment.toUpperCase()}**\nFirst valid word in 15s wins this round.`, "#0F766E")],
          components: [],
        }).catch(() => null);

        const msgCollector = interaction.channel.createMessageCollector({
          time: 15_000,
          filter: (m) => players.has(m.author.id) && !m.author.bot,
        });
        let winner = null;
        msgCollector.on("collect", (m) => {
          const content = String(m.content || "").toLowerCase().trim();
          if (winner) return;
          if (content.length < 3) return;
          if (!content.includes(fragment)) return;
          winner = m.author.id;
          msgCollector.stop("winner");
        });

        msgCollector.on("end", async () => {
          const result = winner
            ? `Winner: <@${winner}>`
            : "No valid word submitted in time.";
          await interaction.channel.send({ embeds: [makeEmbed("Round Result", result, winner ? COLORS.SUCCESS : COLORS.WARNING)] }).catch(() => null);
        });

        componentCollector.stop("started");
      });

      componentCollector.on("end", async (_collected, reason) => {
        if (reason === "time") {
          await interaction.editReply({ components: [], embeds: [makeEmbed("WordCore Survival", "Lobby timed out.", COLORS.WARNING)] }).catch(() => null);
        }
      });

      return true;
    }

    return false;
  } catch (error) {
    console.error(`MU command failed: ${cmd}`, error);
    await fail(interaction, "Action Failed", "An unexpected error occurred while processing this command.");
    return true;
  }
}

async function awardXpForMessage(message, context) {
  const { makeEmbed, setEmbedFooterSafe, setEmbedThumbnailSafe } = context;
  if (!message.guild || message.author.bot || message.system) return;
  const guildId = message.guild.id;
  const userId = message.author.id;
  const key = levelStorageKey(guildId, userId);

  const blacklist = await getBlacklist(guildId);
  if (blacklist.includes(message.channel.id)) return;

  const cooldownKey = `${guildId}-${userId}`;
  const lastAt = xpCooldowns.get(cooldownKey) || 0;
  if (Date.now() - lastAt < XP_COOLDOWN_MS) return;
  xpCooldowns.set(cooldownKey, Date.now());

  const currentXp = (await db.get(`xp.${key}`)) || 0;
  const currentLevel = (await db.get(`level.${key}`)) || 0;
  const nextXp = currentXp + XP_PER_MESSAGE;
  const required = getRequiredXP(currentLevel);

  await db.set(`xp.${key}`, nextXp);
  if (nextXp < required) return;

  const newLevel = currentLevel + 1;
  const remainingXp = nextXp - required;
  await db.set(`xp.${key}`, remainingXp);
  await db.set(`level.${key}`, newLevel);

  const announceChannelId = await getLevelUpChannelId(guildId);
  const announceChannel =
    message.guild.channels.cache.get(announceChannelId) ||
    (await message.guild.channels.fetch(announceChannelId).catch(() => null)) ||
    message.channel;
  if (announceChannel?.send) {
    const embed = makeEmbed(
      "Level Up",
      `${message.author} reached **Level ${newLevel}**.`,
      "#D97706",
    );
    setEmbedThumbnailSafe(embed, message.author.displayAvatarURL({ dynamic: true, size: 256 }));
    setEmbedFooterSafe(embed, "Keep chatting to earn more XP");
    await announceChannel.send({ embeds: [embed] }).catch(() => null);
  }

  const rewardRoleId = await db.get(`levelrole.${guildId}.${newLevel}`);
  if (rewardRoleId) {
    const role = message.guild.roles.cache.get(rewardRoleId);
    if (role) await message.member.roles.add(role).catch(() => null);
  }

  const clearRoleId = await db.get(`clearrole.${guildId}.${newLevel}`);
  if (clearRoleId) {
    const role = message.guild.roles.cache.get(clearRoleId);
    if (role) await message.member.roles.remove(role).catch(() => null);
  }
}

async function maybeHandleAutoReact(message) {
  if (!message.guild || message.author.bot) return;
  const config = await getAutoReactConfig(message.guild.id);
  if (!config.enabled) return;
  if (!config.targetUserId || !config.emoji) return;
  if (message.author.id !== config.targetUserId) return;
  await message.react(config.emoji).catch(() => null);
}

async function maybeHandlePokePing(message) {
  if (!message.guild || !message.author) return;
  if (!POKETWO_BOT_ID) return;
  if (message.author.id !== POKETWO_BOT_ID) return;
  const firstEmbed = message.embeds?.[0];
  const title = String(firstEmbed?.title || "").toLowerCase();
  if (!title.includes("wild pok")) return;
  const set = await getPokePingSet(message.guild.id);
  if (!set.size) return;
  const mentions = [...set].map((id) => `<@${id}>`).join(" ");
  await message.channel.send(`Pokemon spawn alert ${mentions}`).catch(() => null);
}

function registerMuMessageEvents(client, context) {
  client.on("messageCreate", async (message) => {
    await maybeHandlePokePing(message);
    if (message.author?.bot) return;
    await maybeHandleAutoReact(message);

    if (String(message.content || "").trim().toLowerCase() === "hi bot") {
      await message.reply("Hello. Run `/help` for the command panel.").catch(() => null);
    }

    await awardXpForMessage(message, context);
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    await syncHallOfFameFromReaction(reaction, user, context).catch(() => null);
  });

  client.on("messageReactionRemove", async (reaction, user) => {
    await syncHallOfFameFromReaction(reaction, user, context).catch(() => null);
  });
}

module.exports = {
  MU_COMMAND_NAMES,
  isMuCommand,
  getLevelUpChannelId,
  setLevelUpChannelId,
  handleMuCommand,
  registerMuMessageEvents,
};
