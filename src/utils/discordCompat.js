function pickValue(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined) return source[key];
  }
  return undefined;
}

function toPascalCaseFromUpperSnake(value) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function createDiscordCompat(Discord) {
  const { Client } = Discord;

  const IntentsSource = Discord.Intents?.FLAGS || Discord.GatewayIntentBits || {};
  const PartialsSource = Discord.Partials || {};
  const ChannelTypes = Discord.ChannelType || {};
  const PermissionSource = Discord.Permissions?.FLAGS || Discord.PermissionFlagsBits || {};
  const AuditLogEventSource = Discord.AuditLogEvent || Discord.Constants?.AuditLogEvent || {};

  const MessageEmbed = Discord.MessageEmbed || Discord.EmbedBuilder;
  const ActionRowClass = Discord.ActionRowBuilder || Discord.MessageActionRow;
  const ButtonClass = Discord.ButtonBuilder || Discord.MessageButton;
  const StringSelectClass = Discord.StringSelectMenuBuilder || Discord.MessageSelectMenu;
  const ButtonStyleSource = Discord.ButtonStyle || {};
  const ModalClass = Discord.ModalBuilder || null;
  const TextInputClass = Discord.TextInputBuilder || null;
  const TextInputStyleSource = Discord.TextInputStyle || {};

  function resolveIntentKey(key) {
    return pickValue(IntentsSource, [key, toPascalCaseFromUpperSnake(key)]);
  }

  function resolvePartialKey(key) {
    return pickValue(PartialsSource, [key, toPascalCaseFromUpperSnake(key)]) || key;
  }

  function resolvePermission(upperSnake, pascal) {
    return pickValue(PermissionSource, [upperSnake, pascal]);
  }

  const Permissions = {
    FLAGS: {
      KICK_MEMBERS: resolvePermission("KICK_MEMBERS", "KickMembers"),
      BAN_MEMBERS: resolvePermission("BAN_MEMBERS", "BanMembers"),
      MODERATE_MEMBERS: resolvePermission("MODERATE_MEMBERS", "ModerateMembers"),
      MANAGE_MESSAGES: resolvePermission("MANAGE_MESSAGES", "ManageMessages"),
      MANAGE_CHANNELS: resolvePermission("MANAGE_CHANNELS", "ManageChannels"),
      MANAGE_ROLES: resolvePermission("MANAGE_ROLES", "ManageRoles"),
      MANAGE_NICKNAMES: resolvePermission("MANAGE_NICKNAMES", "ManageNicknames"),
      MANAGE_GUILD: resolvePermission("MANAGE_GUILD", "ManageGuild"),
      SEND_MESSAGES: resolvePermission("SEND_MESSAGES", "SendMessages"),
      EMBED_LINKS: resolvePermission("EMBED_LINKS", "EmbedLinks"),
      CONNECT: resolvePermission("CONNECT", "Connect"),
      VIEW_CHANNEL: resolvePermission("VIEW_CHANNEL", "ViewChannel"),
      SPEAK: resolvePermission("SPEAK", "Speak"),
      STREAM: resolvePermission("STREAM", "Stream"),
      USE_VAD: resolvePermission("USE_VAD", "UseVAD"),
      MOVE_MEMBERS: resolvePermission("MOVE_MEMBERS", "MoveMembers"),
      MUTE_MEMBERS: resolvePermission("MUTE_MEMBERS", "MuteMembers"),
      DEAFEN_MEMBERS: resolvePermission("DEAFEN_MEMBERS", "DeafenMembers"),
      ADMINISTRATOR: resolvePermission("ADMINISTRATOR", "Administrator"),
    },
  };

  const SEND_MESSAGES_PERMISSION_KEY =
    PermissionSource.SEND_MESSAGES !== undefined ? "SEND_MESSAGES" : "SendMessages";
  const CONNECT_PERMISSION_KEY = PermissionSource.CONNECT !== undefined ? "CONNECT" : "Connect";
  const VIEW_CHANNEL_PERMISSION_KEY = PermissionSource.VIEW_CHANNEL !== undefined ? "VIEW_CHANNEL" : "ViewChannel";
  const SPEAK_PERMISSION_KEY = PermissionSource.SPEAK !== undefined ? "SPEAK" : "Speak";
  const STREAM_PERMISSION_KEY = PermissionSource.STREAM !== undefined ? "STREAM" : "Stream";
  const USE_VAD_PERMISSION_KEY = PermissionSource.USE_VAD !== undefined ? "USE_VAD" : "UseVAD";
  const MANAGE_CHANNELS_PERMISSION_KEY =
    PermissionSource.MANAGE_CHANNELS !== undefined ? "MANAGE_CHANNELS" : "ManageChannels";
  const MOVE_MEMBERS_PERMISSION_KEY =
    PermissionSource.MOVE_MEMBERS !== undefined ? "MOVE_MEMBERS" : "MoveMembers";
  const MUTE_MEMBERS_PERMISSION_KEY =
    PermissionSource.MUTE_MEMBERS !== undefined ? "MUTE_MEMBERS" : "MuteMembers";
  const DEAFEN_MEMBERS_PERMISSION_KEY =
    PermissionSource.DEAFEN_MEMBERS !== undefined ? "DEAFEN_MEMBERS" : "DeafenMembers";

  function resolveButtonStyle(styleName) {
    if (!ButtonStyleSource || ButtonStyleSource.Primary === undefined) {
      return styleName;
    }
    const map = {
      PRIMARY: ButtonStyleSource.Primary,
      SECONDARY: ButtonStyleSource.Secondary,
      SUCCESS: ButtonStyleSource.Success,
      DANGER: ButtonStyleSource.Danger,
    };
    return map[styleName] ?? ButtonStyleSource.Secondary;
  }

  function getTextInputStyle(name) {
    if (!TextInputStyleSource || TextInputStyleSource.Short === undefined) {
      return name === "PARAGRAPH" ? 2 : 1;
    }
    return name === "PARAGRAPH" ? TextInputStyleSource.Paragraph : TextInputStyleSource.Short;
  }

  const clientIntentKeys = [
    "GUILDS",
    "GUILD_MESSAGES",
    "GUILD_MESSAGE_REACTIONS",
    "GUILD_MEMBERS",
    "MESSAGE_CONTENT",
    "GUILD_BANS",
    "GUILD_VOICE_STATES",
    "GUILD_INVITES",
    "GUILD_EMOJIS_AND_STICKERS",
    "GUILD_WEBHOOKS",
    "AUTO_MODERATION_CONFIGURATION",
    "AUTO_MODERATION_EXECUTION",
  ];

  const clientIntents = clientIntentKeys.map((key) => resolveIntentKey(key)).filter((value) => value !== undefined);
  const clientPartials = ["MESSAGE", "CHANNEL", "REACTION", "GUILD_MEMBER", "USER"]
    .map((key) => resolvePartialKey(key))
    .filter((value) => value !== undefined);

  return {
    Client,
    ChannelTypes,
    Permissions,
    PermissionSource,
    AuditLogEventSource,
    ButtonStyleSource,
    TextInputStyleSource,
    MessageEmbed,
    ActionRowClass,
    ButtonClass,
    StringSelectClass,
    ModalClass,
    TextInputClass,
    SEND_MESSAGES_PERMISSION_KEY,
    CONNECT_PERMISSION_KEY,
    VIEW_CHANNEL_PERMISSION_KEY,
    SPEAK_PERMISSION_KEY,
    STREAM_PERMISSION_KEY,
    USE_VAD_PERMISSION_KEY,
    MANAGE_CHANNELS_PERMISSION_KEY,
    MOVE_MEMBERS_PERMISSION_KEY,
    MUTE_MEMBERS_PERMISSION_KEY,
    DEAFEN_MEMBERS_PERMISSION_KEY,
    resolveButtonStyle,
    getTextInputStyle,
    clientIntents,
    clientPartials,
  };
}

module.exports = {
  createDiscordCompat,
};
