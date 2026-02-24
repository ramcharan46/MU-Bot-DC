const fs = require("fs");
const path = require("path");
const Discord = require("discord.js");
const dotenv = require("dotenv");
const { DisTube, Events: DisTubeEvents, RepeatMode } = require("distube");
const {
  YT_DLP_BASE_FLAGS,
  YtDlpCompatPlugin,
  normalizePlayableInput,
  ytDlpJson,
} = require("./music/ytDlpCompatPlugin");
const ffmpegPath = require("ffmpeg-static");

dotenv.config();
const ENABLE_AEON_AI = String(process.env.ENABLE_AEON_AI || "false").toLowerCase() === "true";

const { COMMANDS } = require("./config/commands");

const {
  DATABASE_DIR,
  BOT_LOCK_FILE,
  WARNINGS_FILE,
  LOG_CONFIG_FILE,
  SETUP_CONFIG_FILE,
  MOD_ACTIONS_FILE,
  REMINDERS_FILE,
  AUTOROLE_FILE,
  JTC_CONFIG_FILE,
} = require("./config/paths");

if (!fs.existsSync(DATABASE_DIR)) {
  fs.mkdirSync(DATABASE_DIR, { recursive: true });
}
const {
  MAX_REASON_LENGTH,
  MAX_TIMEOUT_MS,
  LOG_CHANNEL_ID,
  LOG_FALLBACK_NAMES,
  MODERATION_COMMANDS,
  COLORS,
  WELCOME_MESSAGES,
  JTC_SETTINGS_OPTIONS,
  JTC_PERMISSION_OPTIONS,
} = require("./config/constants");
const {
  HELP_LIBRARY,
  commandNameFromSyntax,
  isAdminEntry,
} = require("./config/help");
const {
  handleMuCommand,
  getLevelUpChannelId,
  setLevelUpChannelId,
  registerMuMessageEvents,
} = require("./commands/muCommands");
const {
  askAeonAgent,
  getAeonAgentRuntimeStatus,
  reloadAeonAgentKnowledge,
  rewriteAeonKnowledgeFromInput,
  getAeonAgentStatusSnapshot,
  primeAeonAgentRuntime,
} = require("./ai/aeonAgentBridge");
const {
  DEFAULT_ALLOWED_ACTIONS: AEON_ACTION_DEFAULT_ALLOWED,
  parseActionRequest: parseAeonActionRequest,
  normalizeActionType: normalizeAeonActionType,
  actionTypeLabel: aeonActionTypeLabel,
  humanizeAction: humanizeAeonAction,
} = require("./ai/aeonActionEngine");
const { createDiscordCompat } = require("./utils/discordCompat");
const { createEmbedUtils } = require("./utils/embed");
const { acquireSingleInstanceLock } = require("./utils/singleInstance");
const { registerLifecycleEvents } = require("./events/lifecycle");
const { registerLoggingEvents } = require("./events/logging");
const {
  loadNamespace,
  saveNamespace,
  getRuntimeStoreStatus,
} = require("./storage/runtimeStore");

const {
  Client,
  ChannelTypes,
  Permissions,
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
  clientIntents,
  clientPartials,
} = createDiscordCompat(Discord);

const client = new Client({
  intents: clientIntents,
  partials: clientPartials,
});
const distube = new DisTube(client, {
  emitNewSongOnly: true,
  savePreviousSongs: true,
  plugins: [new YtDlpCompatPlugin({ update: true })],
  ffmpeg: ffmpegPath ? { path: ffmpegPath } : undefined,
});
const EPHEMERAL_FLAG = Discord.MessageFlags?.Ephemeral ?? 64;
let releaseBotLock = null;
try {
  releaseBotLock = acquireSingleInstanceLock(BOT_LOCK_FILE, {
    app: "mu-bot",
  });
} catch (error) {
  console.error(`Startup blocked: ${error.message}`);
  process.exit(1);
}

function shutdownBot(code = 0) {
  try {
    if (typeof releaseBotLock === "function") releaseBotLock();
  } catch (_) {
    // ignore lock cleanup failures on shutdown
  }
  process.exit(code);
}

const RETRYABLE_LOGIN_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EACCES",
]);
const LOGIN_RETRY_BASE_MS = 15000;
const LOGIN_RETRY_MAX_MS = 120000;
const SERVERINFO_BANNER_URL =
  process.env.SERVERINFO_BANNER_URL ||
  process.env.HELP_BANNER_URL ||
  "https://i.postimg.cc/xdRL8FpS/freshersatmu.png";
function parsePanelIdleTimeoutMs(rawValue, fallbackMs) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  if (!Number.isFinite(parsed)) return fallbackMs;
  return Math.max(30_000, Math.min(15 * 60 * 1000, parsed));
}
const HELP_PANEL_IDLE_CLOSE_MS = parsePanelIdleTimeoutMs(process.env.HELP_PANEL_IDLE_CLOSE_MS, 3 * 60 * 1000);
const SETUP_PANEL_IDLE_CLOSE_MS = parsePanelIdleTimeoutMs(process.env.SETUP_PANEL_IDLE_CLOSE_MS, 5 * 60 * 1000);
const BOTPROFILE_PANEL_IDLE_CLOSE_MS = parsePanelIdleTimeoutMs(
  process.env.BOTPROFILE_PANEL_IDLE_CLOSE_MS,
  5 * 60 * 1000,
);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectErrorCodes(error, bucket = new Set()) {
  if (!error || typeof error !== "object") return bucket;
  if (typeof error.code === "string") bucket.add(error.code);
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      collectErrorCodes(nested, bucket);
    }
  }
  return bucket;
}

function isNonRetryableLoginError(error) {
  const text = String(error?.message || "").toLowerCase();
  return (
    text.includes("invalid token") ||
    text.includes("disallowed intents") ||
    text.includes("privileged intent")
  );
}

function shouldRetryLogin(error) {
  if (isNonRetryableLoginError(error)) return false;
  const codes = collectErrorCodes(error);
  if ([...codes].some((code) => RETRYABLE_LOGIN_CODES.has(code))) return true;
  const message = String(error?.message || "");
  return /connect|network|timeout|dns|socket/i.test(message);
}

function isNodeNetPermissionRestricted() {
  const optionsText = `${process.env.NODE_OPTIONS || ""} ${process.execArgv.join(" ")}`.toLowerCase();
  if (!optionsText.includes("--permission")) return false;
  return !optionsText.includes("--allow-net");
}

function logLoginDiagnostics(error, attempt, waitMs) {
  const codes = [...collectErrorCodes(error)];
  const codeText = codes.length ? codes.join(", ") : "Unknown";
  console.error(`Login attempt ${attempt} failed (${codeText}). Retrying in ${Math.ceil(waitMs / 1000)}s.`);

  if (codes.includes("EACCES")) {
    console.error(
      "Network access denied for Node.js outbound HTTPS (443). Check firewall/antivirus/proxy policy and allow node.exe.",
    );
    console.error("Quick checks: `Test-NetConnection discord.com -Port 443` and `Resolve-DnsName discord.com`.");
    if (isNodeNetPermissionRestricted()) {
      console.error("Node permission model is enabled without net access. Add `--allow-net` or remove `--permission`.");
    }
  }
}

process.once("SIGINT", () => shutdownBot(0));
process.once("SIGTERM", () => shutdownBot(0));
if (process.platform === "win32") {
  process.once("SIGBREAK", () => shutdownBot(0));
}
process.once("exit", () => {
  try {
    if (typeof releaseBotLock === "function") releaseBotLock();
  } catch (_) {
    // ignore lock cleanup failures on exit
  }
});

const { makeEmbed, setEmbedAuthorSafe, setEmbedFooterSafe, setEmbedThumbnailSafe } = createEmbedUtils(
  MessageEmbed,
  COLORS.INFO,
);
const STORE_NS_WARNINGS = "warnings";
const STORE_NS_LOG_CONFIG = "log_config";
const STORE_NS_SETUP_CONFIG = "setup_config";
const STORE_NS_MOD_ACTIONS = "mod_actions";
const STORE_NS_REMINDERS = "reminders";
const STORE_NS_AUTOROLE_CONFIG = "autorole_config";
const STORE_NS_JTC_CONFIG = "jtc_config";
const STORE_NS_BOT_PROFILE = "bot_profile";
const STORE_NS_OBSERVABILITY = "observability";
const STORE_NS_AEON_CONVERSATIONS = "aeon_conversations";
const STORE_NS_AEON_THREAD_SESSIONS = "aeon_thread_sessions";
const STORE_NS_AEON_ACTION_POLICY = "aeon_action_policy";
const STORE_NS_AEON_ACTION_AUDIT = "aeon_action_audit";
const STORE_NS_AEON_ACTION_WORKFLOWS = "aeon_action_workflows";

let warningsStore = loadWarnings();
let logConfigStore = loadLogConfig();
let setupConfigStore = loadSetupConfig();
let modActionsStore = loadModActions();
let remindersStore = loadReminders();
let autoRoleStore = loadAutoRoleConfig();
let jtcConfigStore = loadJtcConfig();
let botProfileStore = loadBotProfileStore();
let observabilityStore = loadObservabilityStore();
let aeonActionPolicyStore = loadAeonActionPolicyStore();
let aeonActionAuditStore = loadAeonActionAuditStore();
let aeonActionWorkflowStore = loadAeonActionWorkflowStore();
const inviteUsesCache = new Map();
const webhookCache = new Map();
const reminderTimers = new Map();
const statsUpdateInFlight = new Map();
const memberCountCache = new Map();
const MEMBER_COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const aeonConversationStore = new Map();
const AEON_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const AEON_HISTORY_MAX_KEYS = 4000;
const AEON_HISTORY_MAX_TURNS = (() => {
  const parsed = Number.parseInt(process.env.AEON_HISTORY_TURNS || "6", 10);
  if (!Number.isFinite(parsed)) return 6;
  return Math.max(1, Math.min(12, parsed));
})();
const AEON_HISTORY_TEXT_LIMIT = 520;
for (const [key, entry] of Object.entries(loadAeonConversationStore())) {
  aeonConversationStore.set(key, entry);
}
const AEON_TRAIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const aeonTrainSessionStore = new Map();
const AEON_EVENTS_PANEL_TTL_MS = 30 * 60 * 1000;
const aeonEventsPanelStore = new Map();
const AEON_ACTION_PLAN_TTL_MS = 30 * 60 * 1000;
const AEON_ACTION_PLAN_MAX_KEYS = 800;
const AEON_ACTION_AUDIT_MAX_ENTRIES = 180;
const AEON_ACTION_WORKFLOW_MAX = 50;
const AEON_ACTION_WORKFLOW_NAME_MAX = 40;
const AEON_ACTION_REQUEST_MAX = 1500;
const aeonActionPlanStore = new Map();
const AEON_EVENTS_PANEL_COLOR = "#284A78";
const AEON_KNOWLEDGE_FILE = path.join(__dirname, "..", "agentic_ai", "knowledge", "aeon26_kb.md");
const AEON_EVENTS_STRUCTURED_FILE = path.join(__dirname, "..", "database", "aeon26_events_structured.json");
const MAX_AEON_ACTIVATION_TEXTS = 12;
const MAX_AEON_ACTIVATION_TEXT_LENGTH = 80;
const AEON_THREAD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AEON_THREAD_SESSION_MAX_KEYS = 5000;
const AEON_CONTEXT_MESSAGE_LIMIT = (() => {
  const parsed = Number.parseInt(process.env.AEON_CONTEXT_MESSAGE_LIMIT || "8", 10);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(20, parsed));
})();
const AEON_CONTEXT_MAX_CHARS = (() => {
  const parsed = Number.parseInt(process.env.AEON_CONTEXT_MAX_CHARS || "1600", 10);
  if (!Number.isFinite(parsed)) return 1600;
  return Math.max(400, Math.min(4000, parsed));
})();
const AEON_CONTEXT_ATTACHMENT_LIMIT = (() => {
  const parsed = Number.parseInt(process.env.AEON_CONTEXT_ATTACHMENT_LIMIT || "3", 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(8, parsed));
})();
const AEON_THREAD_AUTO_ARCHIVE_MINUTES = (() => {
  const parsed = Number.parseInt(process.env.AEON_THREAD_AUTO_ARCHIVE_MINUTES || "1440", 10);
  const allowed = [60, 1440, 4320, 10080];
  if (!Number.isFinite(parsed)) return 1440;
  if (allowed.includes(parsed)) return parsed;
  let nearest = allowed[0];
  let bestDistance = Math.abs(parsed - nearest);
  for (const value of allowed.slice(1)) {
    const distance = Math.abs(parsed - value);
    if (distance < bestDistance) {
      nearest = value;
      bestDistance = distance;
    }
  }
  return nearest;
})();
const aeonThreadSessionStore = loadAeonThreadSessionStore();
const panelInactivityTimers = new Map();

function makePanelTimerKey(type, ownerId, messageId) {
  return `${type || "panel"}:${ownerId || "unknown"}:${messageId || "nomsg"}`;
}

function clearPanelInactivityTimer(key) {
  const active = panelInactivityTimers.get(key);
  if (active) {
    clearTimeout(active);
    panelInactivityTimers.delete(key);
  }
}

function schedulePanelInactivityClose(key, timeoutMs, onExpire) {
  clearPanelInactivityTimer(key);
  const timer = setTimeout(async () => {
    panelInactivityTimers.delete(key);
    try {
      await onExpire();
    } catch (error) {
      const code = error?.code || error?.errorCode;
      const message = String(error?.message || error?.rawError?.message || "");
      if (code === 10008 || code === 10062) return;
      if (/unknown interaction|unknown message/i.test(message)) return;
      console.error(`Panel auto-close failed (${key}):`, error);
    }
  }, timeoutMs);
  if (typeof timer?.unref === "function") timer.unref();
  panelInactivityTimers.set(key, timer);
}

function buildPanelAutoClosedEmbed(panelName, reopenHint, timeoutMs) {
  const embed = makeEmbed(
    `${panelName} Closed`,
    `This panel was closed due to inactivity.\n${reopenHint}`,
    COLORS.INFO,
  );
  const seconds = Math.max(1, Math.floor(timeoutMs / 1000));
  setEmbedFooterSafe(embed, `Auto-closed after ${formatSeconds(seconds)} inactivity`);
  return embed;
}

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

function createNavButton(customId, label, styleName, disabled = false) {
  const button = new ButtonClass().setCustomId(customId).setLabel(label).setStyle(resolveButtonStyle(styleName));
  if (typeof button.setDisabled === "function") button.setDisabled(disabled);
  return button;
}

function createStringSelectMenu(customId, placeholder, options = []) {
  const menu = new StringSelectClass().setCustomId(customId).setPlaceholder(placeholder);
  if (typeof menu.setMinValues === "function") menu.setMinValues(1);
  if (typeof menu.setMaxValues === "function") menu.setMaxValues(1);
  if (typeof menu.addOptions === "function") menu.addOptions(options);
  return menu;
}

function getTextInputStyle(name) {
  if (!TextInputStyleSource || TextInputStyleSource.Short === undefined) {
    return name === "PARAGRAPH" ? 2 : 1;
  }
  return name === "PARAGRAPH" ? TextInputStyleSource.Paragraph : TextInputStyleSource.Short;
}

function buildSingleInputModal(customId, title, inputId, label, placeholder, value = "", style = "SHORT") {
  if (!ModalClass || !TextInputClass) return null;
  const modal = new ModalClass().setCustomId(customId).setTitle(title);
  const input = new TextInputClass()
    .setCustomId(inputId)
    .setLabel(label)
    .setStyle(getTextInputStyle(style))
    .setRequired(true)
    .setPlaceholder(placeholder);
  if (value) input.setValue(value);

  const row = new ActionRowClass().addComponents(input);
  if (typeof modal.addComponents === "function") modal.addComponents(row);
  return modal;
}

const HELP_PAGE_SIZE = 5;
const HELP_CATEGORY_ORDER = ["moderation", "utility", "leveling", "fun", "music", "jtc", "config"];
const HELP_CATEGORY_META = {
  moderation: {
    label: "Moderation",
    title: "Moderation Commands",
    color: "#8B1E3F",
    description: "Moderation tools with hierarchy and permission checks.",
    overview: "Warnings, roles, channel controls, enforcement.",
  },
  utility: {
    label: "Utility",
    title: "Utility Commands",
    color: "#1F7A5C",
    description: "General utility and info commands.",
    overview: "Info, tools, reminders, reports, calculator.",
  },
  leveling: {
    label: "Leveling",
    title: "Leveling Commands",
    color: "#1D4ED8",
    description: "XP progression and role rewards.",
    overview: "XP, leaderboard, reward rules, channel blacklist.",
  },
  fun: {
    label: "Fun",
    title: "Fun Commands",
    color: "#C026D3",
    description: "Fun and social commands.",
    overview: "Memes, games, quotes, ratings, pokeping, reactions.",
  },
  music: {
    label: "Music",
    title: "Music Commands",
    color: "#5A4FCF",
    description: "Voice playback controls.",
    overview: "Playback and queue controls.",
  },
  jtc: {
    label: "JTC",
    title: "JTC Commands",
    color: "#4A5D23",
    description: "Join-to-create setup and interface.",
    overview: "Join-to-create controls.",
  },
  config: {
    label: "Setup",
    title: "Setup & Config Commands",
    color: "#2C3E50",
    description: "Server setup, logging, and role panels.",
    overview: "Setup panel, autoroles, logs, reaction roles.",
  },
};
const HELP_COMMAND_PERMISSION_RULES = {
  kick: [Permissions.FLAGS.KICK_MEMBERS],
  ban: [Permissions.FLAGS.BAN_MEMBERS],
  unban: [Permissions.FLAGS.BAN_MEMBERS],
  softban: [Permissions.FLAGS.BAN_MEMBERS],
  timeout: [Permissions.FLAGS.MODERATE_MEMBERS],
  untimeout: [Permissions.FLAGS.MODERATE_MEMBERS],
  mute: [Permissions.FLAGS.MODERATE_MEMBERS],
  unmute: [Permissions.FLAGS.MODERATE_MEMBERS],
  purge: [Permissions.FLAGS.MANAGE_MESSAGES],
  warn: [Permissions.FLAGS.MODERATE_MEMBERS],
  warnings: [Permissions.FLAGS.MODERATE_MEMBERS],
  unwarn: [Permissions.FLAGS.MODERATE_MEMBERS],
  clearwarnings: [Permissions.FLAGS.MODERATE_MEMBERS],
  modlogs: [Permissions.FLAGS.MODERATE_MEMBERS],
  nick: [Permissions.FLAGS.MANAGE_NICKNAMES],
  massrole: [Permissions.FLAGS.MANAGE_ROLES],
  lock: [Permissions.FLAGS.MANAGE_CHANNELS],
  unlock: [Permissions.FLAGS.MANAGE_CHANNELS],
  slowmode: [Permissions.FLAGS.MANAGE_CHANNELS],
  embed_send: [Permissions.FLAGS.MANAGE_GUILD],
  level_channel: [Permissions.FLAGS.MANAGE_GUILD],
  level_role_add: [Permissions.FLAGS.MANAGE_ROLES],
  level_role_remove: [Permissions.FLAGS.MANAGE_ROLES],
  level_role_clear: [Permissions.FLAGS.MANAGE_GUILD],
  level_xp_add: [Permissions.FLAGS.MANAGE_GUILD],
  level_set: [Permissions.FLAGS.MANAGE_GUILD],
  level_blacklist_add: [Permissions.FLAGS.MANAGE_GUILD],
  level_blacklist_remove: [Permissions.FLAGS.MANAGE_GUILD],
  say: [Permissions.FLAGS.MANAGE_MESSAGES],
  wordgame_start: [Permissions.FLAGS.ADMINISTRATOR],
  autoreact_toggle: [Permissions.FLAGS.ADMINISTRATOR],
  botprofile: [Permissions.FLAGS.ADMINISTRATOR],
  setup: [Permissions.FLAGS.MANAGE_GUILD],
  config: [Permissions.FLAGS.MANAGE_GUILD],
  autorole: [Permissions.FLAGS.MANAGE_ROLES],
  reactionroles: [Permissions.FLAGS.MANAGE_ROLES],
  log: [Permissions.FLAGS.MANAGE_GUILD],
};

function chunkHelpItems(items, size) {
  if (!Array.isArray(items) || size <= 0) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function hasHelpPermission(member, permission) {
  if (permission === undefined) return false;
  try {
    return Boolean(member?.permissions?.has?.(permission));
  } catch (_) {
    return false;
  }
}

function hasHelpAdministrator(member) {
  return hasHelpPermission(member, Permissions.FLAGS.ADMINISTRATOR);
}

function canAccessHelpEntry(member, entry) {
  const commandName = commandNameFromSyntax(entry?.syntax);
  if (!commandName) return true;
  if (hasHelpAdministrator(member)) return true;

  const required = HELP_COMMAND_PERMISSION_RULES[commandName];
  if (Array.isArray(required) && required.length) {
    return required.some((permission) => hasHelpPermission(member, permission));
  }

  return !isAdminEntry(entry);
}

function buildFilteredHelpFields(entries) {
  return entries.map((entry) => ({
    name: "\u200B",
    value: `${isAdminEntry(entry) ? "`[Admin]` " : ""}**${entry.syntax}**\n${entry.summary}`,
    inline: false,
  }));
}

function buildHelpAccessContext(member, guild = null, botUser = null) {
  const visibleLibrary = {};
  const guildId = guild?.id || member?.guild?.id || "";
  const profile = guildId ? getGuildBotProfile(guildId) : null;
  const brandedName = getGuildBotDisplayName(guild || guildId, botUser || client.user || null);
  const brandedDescription =
    profile?.description || "Sleek slash-command reference.";
  const brandedOverviewColor = profile?.accentColor || "#1F4E79";

  for (const category of HELP_CATEGORY_ORDER) {
    const sourceEntries = Array.isArray(HELP_LIBRARY[category]) ? HELP_LIBRARY[category] : [];
    const filteredEntries = sourceEntries.filter((entry) => canAccessHelpEntry(member, entry));
    if (filteredEntries.length) visibleLibrary[category] = filteredEntries;
  }

  const overviewFields = HELP_CATEGORY_ORDER
    .filter((category) => Array.isArray(visibleLibrary[category]) && visibleLibrary[category].length)
    .map((category) => {
      const meta = HELP_CATEGORY_META[category] || {};
      const count = visibleLibrary[category].length;
      return {
        name: meta.label || category,
        value: `${count} commands\n${meta.overview || "Command references."}`,
      };
    });

  if (!overviewFields.length) {
    overviewFields.push({
      name: "No Commands Available",
      value: "No commands are available for your current permission set.",
    });
  }

  overviewFields.push({
    name: "Format",
    value: "Each item shows syntax and one-line purpose.\n`[Admin]` marks restricted commands.",
  });

  const pages = {
    overview: {
      category: "overview",
      color: brandedOverviewColor,
      title: `${brandedName} Help Interface`,
      description: `${brandedDescription}\n\nCommands shown here match your permission level.`,
      fields: overviewFields,
    },
  };
  const pageOrder = ["overview"];
  const pageCategory = { overview: "overview" };
  const categoryFirstPage = { overview: "overview" };

  for (const category of HELP_CATEGORY_ORDER) {
    const entries = visibleLibrary[category] || [];
    if (!entries.length) continue;

    const chunks = chunkHelpItems(entries, HELP_PAGE_SIZE);
    categoryFirstPage[category] = `${category}_1`;
    const meta = HELP_CATEGORY_META[category] || {};

    for (let i = 0; i < chunks.length; i += 1) {
      const key = `${category}_${i + 1}`;
      pages[key] = {
        category,
        color: meta.color || "#1F4E79",
        title: `${meta.title || "Commands"} (${i + 1}/${chunks.length})`,
        description: meta.description || "Command list.",
        fields: buildFilteredHelpFields(chunks[i]),
      };
      pageOrder.push(key);
      pageCategory[key] = category;
    }
  }

  return { pages, pageOrder, pageCategory, categoryFirstPage };
}

function normalizeHelpPageKeyForContext(helpContext, pageKey) {
  if (helpContext?.pages?.[pageKey]) return pageKey;
  return "overview";
}

function getHelpCategoryKeyForContext(helpContext, pageKey) {
  const key = normalizeHelpPageKeyForContext(helpContext, pageKey);
  return helpContext?.pageCategory?.[key] || helpContext?.pages?.[key]?.category || "overview";
}

function getAdjacentHelpPageForContext(helpContext, pageKey, delta) {
  const key = normalizeHelpPageKeyForContext(helpContext, pageKey);
  const order = Array.isArray(helpContext?.pageOrder) && helpContext.pageOrder.length ? helpContext.pageOrder : ["overview"];
  const currentIndex = Math.max(0, order.indexOf(key));
  const nextIndex = Math.max(0, Math.min(order.length - 1, currentIndex + delta));
  return order[nextIndex];
}

function buildHelpComponents(ownerId, activePage, helpContext) {
  const context = helpContext || buildHelpAccessContext(null);
  const pageKey = normalizeHelpPageKeyForContext(context, activePage);
  const activeCategory = getHelpCategoryKeyForContext(context, pageKey);
  const pageIndex = Math.max(0, context.pageOrder.indexOf(pageKey));
  const totalPages = context.pageOrder.length;

  const categoryButtons = [
    createNavButton(`help:${ownerId}:page:overview`, "Overview", activeCategory === "overview" ? "PRIMARY" : "SECONDARY"),
  ];

  for (const category of HELP_CATEGORY_ORDER) {
    const firstPage = context.categoryFirstPage?.[category];
    if (!firstPage) continue;
    const meta = HELP_CATEGORY_META[category] || {};
    categoryButtons.push(
      createNavButton(
        `help:${ownerId}:page:${firstPage}`,
        meta.label || category,
        activeCategory === category ? "PRIMARY" : "SECONDARY",
      ),
    );
  }

  const rows = chunkHelpItems(categoryButtons, 5).map((buttons) => new ActionRowClass().addComponents(...buttons));

  const navRow = new ActionRowClass().addComponents(
    createNavButton(`help:${ownerId}:prev:${pageKey}`, "Prev", "SUCCESS", pageIndex <= 0),
    createNavButton(`help:${ownerId}:next:${pageKey}`, "Next", "SUCCESS", pageIndex >= totalPages - 1),
    createNavButton(`help:${ownerId}:close`, "Close", "DANGER"),
  );
  rows.push(navRow);
  return rows;
}

function buildHelpEmbed(pageKey, requester, botUser, helpContext) {
  const context = helpContext || buildHelpAccessContext(null);
  const selectedKey = normalizeHelpPageKeyForContext(context, pageKey);
  const page = context.pages[selectedKey] || context.pages.overview;
  const embed = makeEmbed(page.title, page.description, page.color, page.fields);

  if (requester) {
    const iconURL =
      typeof requester.displayAvatarURL === "function"
        ? requester.displayAvatarURL({ dynamic: true })
        : null;
    setEmbedAuthorSafe(embed, `Requested by ${requester.tag}`, iconURL);
  }

  if (botUser && typeof botUser.displayAvatarURL === "function") {
    setEmbedThumbnailSafe(embed, botUser.displayAvatarURL({ dynamic: true }));
  }
  const pageIndex = Math.max(0, context.pageOrder.indexOf(selectedKey)) + 1;
  setEmbedFooterSafe(embed, `Page ${pageIndex}/${context.pageOrder.length} | Use category buttons + Prev/Next`);
  return embed;
}

function buildSetupComponents(ownerId) {
  const row1 = new ActionRowClass().addComponents(
    createNavButton(`setup:${ownerId}:set:logs`, "Set Logs Here", "PRIMARY"),
    createNavButton(`setup:${ownerId}:set:reports`, "Set Reports Here", "PRIMARY"),
    createNavButton(`setup:${ownerId}:set:welcome`, "Set Welcome Here", "PRIMARY"),
    createNavButton(`setup:${ownerId}:set:jtcinterface`, "Set JTC Interface", "PRIMARY"),
    createNavButton(`setup:${ownerId}:set:statsparent`, "Set Stats (Parent)", "SUCCESS"),
  );
  const row2 = new ActionRowClass().addComponents(
    createNavButton(`setup:${ownerId}:set:levelup`, "Set Level-Up Here", "SUCCESS"),
    createNavButton(`setup:${ownerId}:set:halloffame`, "Set Hall of Fame Here", "SUCCESS"),
    createNavButton(`setup:${ownerId}:botprofile`, "Bot Profile", "PRIMARY"),
    createNavButton(`setup:${ownerId}:refresh`, "Refresh", "SECONDARY"),
    createNavButton(`setup:${ownerId}:close`, "Close", "DANGER"),
  );
  return [row1, row2];
}

function formatJtcTriggersSummary(jtcConfig, maxEntries = 4) {
  const entries = Object.entries(jtcConfig?.triggers || {});
  if (!entries.length) return "Not set";

  const lines = entries.slice(0, maxEntries).map(([triggerId, info], index) => {
    const categoryRef = info?.categoryId ? `<#${info.categoryId}>` : "Same as trigger";
    return `${index + 1}. <#${triggerId}> -> ${categoryRef}`;
  });
  if (entries.length > maxEntries) lines.push(`+${entries.length - maxEntries} more`);
  return lines.join("\n");
}

function normalizeAeonActivationTexts(values, maxEntries = MAX_AEON_ACTIVATION_TEXTS) {
  const list = Array.isArray(values) ? values : [values];
  const output = [];
  const seen = new Set();

  for (const value of list) {
    const text = shorten(String(value || ""), MAX_AEON_ACTIVATION_TEXT_LENGTH).trim();
    if (text.length < 2) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= maxEntries) break;
  }

  return output;
}

function getAeonActivationTexts(setupConfig) {
  const current = setupConfig || {};
  const list = normalizeAeonActivationTexts(current.aeonActivationTexts || []);
  if (list.length) return list;
  const legacy = String(current.aeonActivationText || "").trim();
  if (!legacy) return [];
  return normalizeAeonActivationTexts([legacy]);
}

function formatAeonActivationSummary(setupConfig, maxEntries = 4) {
  const activations = getAeonActivationTexts(setupConfig);
  if (!activations.length) return "Not set";
  const lines = activations.slice(0, maxEntries).map((text, index) => `${index + 1}. \`${text}\``);
  if (activations.length > maxEntries) lines.push(`+${activations.length - maxEntries} more`);
  return lines.join("\n");
}

async function buildSetupEmbed(guild, requester, currentChannel = null) {
  const logConfig = getGuildLogConfig(guild.id);
  const setup = getGuildSetupConfig(guild.id);
  const jtc = getGuildJtcConfig(guild.id);
  const profile = getGuildBotProfile(guild.id);
  const botName = getGuildBotDisplayName(guild, client.user);
  const levelUpChannelId = await getLevelUpChannelId(guild.id).catch(() => "");
  const embed = makeEmbed(
    `${botName} Setup Panel`,
    `${profile.description || "Use buttons to assign channels quickly."}\nFor stats, run \`/setup\` in a text channel inside the target category and click **Set Stats (Parent)**.\nFor join-to-create, run \`/config jtc_trigger\` for each trigger and \`/interface\` when needed.\nUse **Set Level-Up Here** to configure level-up announcements.\nUse **Set Hall of Fame Here** to choose where ⭐ highlights are posted.\nUse **Bot Profile** to customize guild branding.`,
    getGuildBotAccentColor(guild, "#2C3E50"),
    [
      { name: "Logs Channel", value: logConfig.channelId ? `<#${logConfig.channelId}>` : "Not set", inline: true },
      { name: "Reports Channel", value: setup.reportChannelId ? `<#${setup.reportChannelId}>` : "Not set", inline: true },
      { name: "Welcome Channel", value: setup.welcomeChannelId ? `<#${setup.welcomeChannelId}>` : "Not set", inline: true },
      { name: "Level-Up Channel", value: levelUpChannelId ? `<#${levelUpChannelId}>` : "Not set", inline: true },
      { name: "Hall of Fame Channel", value: setup.hallOfFameChannelId ? `<#${setup.hallOfFameChannelId}>` : "Not set", inline: true },
      { name: "JTC Triggers", value: formatJtcTriggersSummary(jtc), inline: false },
      { name: "JTC Interface", value: jtc.interfaceChannelId ? `<#${jtc.interfaceChannelId}>` : "Not set", inline: true },
      { name: "Stats Category", value: setup.statsCategoryId ? `<#${setup.statsCategoryId}>` : "Not set", inline: true },
      {
        name: "Stats Channels",
        value:
          setup.statsChannels.all || setup.statsChannels.members || setup.statsChannels.bots
            ? [`<#${setup.statsChannels.all}>`, `<#${setup.statsChannels.members}>`, `<#${setup.statsChannels.bots}>`]
                .filter((v) => !v.includes("<#>"))
                .join(" | ")
            : "Not created",
      },
      { name: "Current Channel", value: currentChannel ? `${currentChannel}` : "Unknown", inline: true },
    ],
  );

  if (requester) {
    const iconURL =
      typeof requester.displayAvatarURL === "function"
        ? requester.displayAvatarURL({ dynamic: true })
        : null;
    setEmbedAuthorSafe(embed, `Setup by ${requester.tag}`, iconURL);
  }
  if (profile.iconUrl) setEmbedThumbnailSafe(embed, profile.iconUrl);
  if (profile.bannerUrl && typeof embed.setImage === "function") {
    try {
      embed.setImage(profile.bannerUrl);
    } catch (_) {
      // ignore invalid banner url
    }
  }

  setEmbedFooterSafe(embed, "Only the command invoker can use these buttons");
  return embed;
}

function buildBotProfileComponents(ownerId) {
  const row1 = new ActionRowClass().addComponents(
    createNavButton(`botprofile:${ownerId}:set:name`, "Set Name", "PRIMARY"),
    createNavButton(`botprofile:${ownerId}:set:description`, "Set Description", "PRIMARY"),
    createNavButton(`botprofile:${ownerId}:set:icon`, "Set Icon URL", "SECONDARY"),
    createNavButton(`botprofile:${ownerId}:set:banner`, "Set Banner URL", "SECONDARY"),
    createNavButton(`botprofile:${ownerId}:set:color`, "Set Color", "SUCCESS"),
  );
  const row2 = new ActionRowClass().addComponents(
    createNavButton(`botprofile:${ownerId}:clear:icon`, "Clear Icon", "SECONDARY"),
    createNavButton(`botprofile:${ownerId}:clear:banner`, "Clear Banner", "SECONDARY"),
    createNavButton(`botprofile:${ownerId}:clear:description`, "Clear Description", "SECONDARY"),
    createNavButton(`botprofile:${ownerId}:reset`, "Reset All", "DANGER"),
    createNavButton(`botprofile:${ownerId}:refresh`, "Refresh", "SUCCESS"),
  );
  const row3 = new ActionRowClass().addComponents(
    createNavButton(`botprofile:${ownerId}:setup`, "Back to Setup", "PRIMARY"),
    createNavButton(`botprofile:${ownerId}:close`, "Close", "DANGER"),
  );
  return [row1, row2, row3];
}

function buildBotProfileEmbed(guild, requester = null) {
  const profile = getGuildBotProfile(guild.id);
  const botName = getGuildBotDisplayName(guild, client.user);
  const color = getGuildBotAccentColor(guild, "#2C3E50");
  const updatedAtMs = profile.updatedAt ? new Date(profile.updatedAt).getTime() : 0;
  const updatedAtUnix = Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? Math.floor(updatedAtMs / 1000) : 0;
  const updatedBy = profile.updatedBy ? `<@${profile.updatedBy}>` : "Unknown";
  const updatedText = updatedAtUnix ? `<t:${updatedAtUnix}:f> by ${updatedBy}` : "Never";

  const embed = makeEmbed(
    `${botName} Profile Interface`,
    `Customize how this bot appears in **${guild.name}**.\nThese settings are guild-specific and do not affect other servers.`,
    color,
    [
      { name: "Display Name", value: profile.name || botName, inline: true },
      { name: "Description", value: profile.description || "Not set", inline: false },
      { name: "Accent Color", value: profile.accentColor || "Default", inline: true },
      { name: "Icon URL", value: profile.iconUrl ? `[Open Icon](${profile.iconUrl})` : "Not set", inline: true },
      { name: "Banner URL", value: profile.bannerUrl ? `[Open Banner](${profile.bannerUrl})` : "Not set", inline: true },
      { name: "Last Updated", value: updatedText, inline: false },
    ],
  );

  if (requester) {
    const iconURL =
      typeof requester.displayAvatarURL === "function"
        ? requester.displayAvatarURL({ dynamic: true })
        : null;
    setEmbedAuthorSafe(embed, `Opened by ${requester.tag}`, iconURL);
  }

  if (profile.iconUrl) {
    setEmbedThumbnailSafe(embed, profile.iconUrl);
  } else if (typeof client.user?.displayAvatarURL === "function") {
    setEmbedThumbnailSafe(embed, client.user.displayAvatarURL({ dynamic: true, size: 1024 }));
  }

  if (profile.bannerUrl && typeof embed.setImage === "function") {
    try {
      embed.setImage(profile.bannerUrl);
    } catch (_) {
      // ignore invalid banner url
    }
  }

  setEmbedFooterSafe(embed, "Only admins can use these controls");
  return embed;
}

async function showBotProfileModal(interaction, ownerId, field, defaults = {}) {
  const modal = buildSingleInputModal(
    `botprofile:modal:${ownerId}:${field}`,
    defaults.title || "Bot Profile",
    "value",
    defaults.label || "Value",
    defaults.placeholder || "Enter a value",
    defaults.value || "",
    defaults.style || "SHORT",
  );
  if (!modal || typeof interaction.showModal !== "function") {
    await interaction.reply({
      embeds: [makeEmbed("Unsupported Action", "Modals are not available in this runtime.", COLORS.ERROR)],
      flags: EPHEMERAL_FLAG,
    });
    return;
  }
  await interaction.showModal(modal);
}

function resolveCommandEntityMentionById(id, guild = null) {
  const rawId = String(id || "").trim();
  if (!/^\d{17,20}$/.test(rawId)) return null;
  if (guild?.channels?.cache?.has(rawId)) return `<#${rawId}>`;
  if (guild?.roles?.cache?.has(rawId)) return `<@&${rawId}>`;
  if (guild?.members?.cache?.has(rawId)) return `<@${rawId}>`;
  if (client.users?.cache?.has(rawId)) return `<@${rawId}>`;
  return `<@${rawId}>`;
}

function mentionifyCommandText(input, guild = null) {
  const raw = String(input ?? "");
  if (!raw) return raw;

  let text = raw;
  text = text.replace(/<@!?(\d{17,20})>\s*\(\d{17,20}\)/g, "<@$1>");
  text = text.replace(/<@&(\d{17,20})>\s*\(\d{17,20}\)/g, "<@&$1>");
  text = text.replace(/<#(\d{17,20})>\s*\(\d{17,20}\)/g, "<#$1>");
  text = text.replace(/([^\n()]{1,140})\s*\((\d{17,20})\)/g, (_match, _label, id) => {
    const mention = resolveCommandEntityMentionById(id, guild);
    return mention || `<@${id}>`;
  });
  text = text.replace(/[ \t]{2,}/g, " ");
  return text;
}

function mentionifyCommandEmbed(embed, guild = null) {
  if (!embed) return embed;
  const data = extractEmbedData(embed);

  if (data.description && typeof embed.setDescription === "function") {
    embed.setDescription(mentionifyCommandText(data.description, guild));
  }
  if (Array.isArray(data.fields) && data.fields.length) {
    const mapped = data.fields.map((field) => ({
      name: field?.name ?? "\u200B",
      value: mentionifyCommandText(field?.value ?? "None", guild),
      inline: Boolean(field?.inline),
    }));
    if (typeof embed.setFields === "function") {
      embed.setFields(mapped);
    } else if (typeof embed.spliceFields === "function") {
      embed.spliceFields(0, data.fields.length, ...mapped);
    }
  }

  return embed;
}

function applyGuildBotProfileBranding(embed, guild = null, botUser = null) {
  if (!embed || !guild?.id) return embed;
  const profile = getGuildBotProfile(guild.id);
  if (!profile) return embed;

  const data = embed.data || {};
  if (!data.color && profile.accentColor && typeof embed.setColor === "function") {
    embed.setColor(profile.accentColor);
  }

  return embed;
}

async function send(interaction, embed, ephemeral = true) {
  const mentionified = mentionifyCommandEmbed(embed, interaction?.guild || null);
  const branded = applyGuildBotProfileBranding(
    mentionified,
    interaction?.guild || null,
    interaction?.client?.user || client.user || null,
  );
  const payload = { embeds: [branded] };
  if (ephemeral) payload.flags = EPHEMERAL_FLAG;
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function fail(interaction, title, description) {
  return send(interaction, makeEmbed(title, description, COLORS.ERROR));
}

function isThreadChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isThread === "function") {
    try {
      if (channel.isThread()) return true;
    } catch (_) {
      // ignore thread detection errors
    }
  }
  const type = channel.type;
  const knownTypes = [
    ChannelTypes?.GUILD_PUBLIC_THREAD,
    ChannelTypes?.GUILD_PRIVATE_THREAD,
    ChannelTypes?.GUILD_NEWS_THREAD,
    ChannelTypes?.PublicThread,
    ChannelTypes?.PrivateThread,
    ChannelTypes?.AnnouncementThread,
    10,
    11,
    12,
  ].filter((value) => value !== undefined);
  if (knownTypes.includes(type)) return true;
  if (typeof type === "string") {
    return type === "GUILD_PUBLIC_THREAD" || type === "GUILD_PRIVATE_THREAD" || type === "GUILD_NEWS_THREAD";
  }
  return false;
}

function buildAeonConversationRef(source, channelOverride = null) {
  const channel = channelOverride || source?.channel || null;
  return {
    guildId: source?.guildId || source?.guild?.id || null,
    guild: source?.guild || null,
    channel,
    channelId: channel?.id || source?.channelId || null,
    user: source?.user || source?.author || null,
    author: source?.author || source?.user || null,
  };
}

function getAeonConversationKey(interaction) {
  const guildId = interaction.guildId || interaction.guild?.id || "noguild";
  const channel = interaction.channel || null;
  const channelId = interaction.channelId || channel?.id || "nochannel";
  const isThread = isThreadChannel(channel);
  const rootChannelId = isThread ? (channel?.parentId || "nothreadparent") : channelId;
  const threadId = isThread ? channelId : "nothread";
  const userId = interaction.user?.id || interaction.author?.id || "nouser";
  return `${guildId}:${rootChannelId}:${threadId}:${userId}`;
}

function pruneAeonConversationStore() {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of aeonConversationStore.entries()) {
    const updatedAt = Number(entry?.updatedAt || 0);
    if (!updatedAt || now - updatedAt > AEON_HISTORY_TTL_MS) {
      aeonConversationStore.delete(key);
      changed = true;
    }
  }
  if (aeonConversationStore.size > AEON_HISTORY_MAX_KEYS) {
    const sorted = [...aeonConversationStore.entries()].sort(
      (a, b) => Number(b?.[1]?.updatedAt || 0) - Number(a?.[1]?.updatedAt || 0),
    );
    aeonConversationStore.clear();
    for (const [key, entry] of sorted.slice(0, AEON_HISTORY_MAX_KEYS)) {
      aeonConversationStore.set(key, entry);
    }
    changed = true;
  }
  if (changed) saveAeonConversationStore();
}

function getAeonConversationHistory(interaction) {
  pruneAeonConversationStore();
  const key = getAeonConversationKey(interaction);
  const entry = aeonConversationStore.get(key);
  if (!entry || !Array.isArray(entry.turns)) return [];
  return entry.turns
    .slice(-AEON_HISTORY_MAX_TURNS)
    .map((turn) => ({
      question: shorten(String(turn?.question || ""), AEON_HISTORY_TEXT_LIMIT),
      answer: shorten(String(turn?.answer || ""), AEON_HISTORY_TEXT_LIMIT),
    }))
    .filter((turn) => turn.question || turn.answer);
}

function pushAeonConversationHistoryTurn(interaction, question, answer) {
  const key = getAeonConversationKey(interaction);
  const current = aeonConversationStore.get(key);
  const turns = Array.isArray(current?.turns) ? current.turns : [];
  turns.push({
    question: shorten(String(question || ""), AEON_HISTORY_TEXT_LIMIT),
    answer: shorten(String(answer || ""), AEON_HISTORY_TEXT_LIMIT),
    at: new Date().toISOString(),
  });
  aeonConversationStore.set(key, {
    turns: turns.slice(-AEON_HISTORY_MAX_TURNS),
    updatedAt: Date.now(),
  });
  saveAeonConversationStore();
}

function sanitizeAeonVisibleAnswer(text) {
  const raw = String(text || "");
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, " ");
  cleaned = cleaned.replace(/<\/think>/gi, " ");

  cleaned = cleaned.replace(/```(?:markdown|md|text)?\s*([\s\S]*?)```/gi, "$1");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
  cleaned = cleaned.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/gi, (_match, label, url) => {
    const cleanLabel = String(label || "").trim();
    const cleanUrl = String(url || "").trim();
    if (!cleanLabel) return cleanUrl;
    const a = cleanLabel.replace(/\/+$/, "").toLowerCase();
    const b = cleanUrl.replace(/\/+$/, "").toLowerCase();
    if (a === b) return cleanUrl;
    return `${cleanLabel}: ${cleanUrl}`;
  });

  cleaned = cleaned.replace(/^\s*#{1,6}\s*/gm, "");
  cleaned = cleaned.replace(/^\s*>\s?/gm, "");
  cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, "• ");
  cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, "• ");
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1");
  cleaned = cleaned.replace(/__(.*?)__/g, "$1");
  cleaned = cleaned.replace(/\*(.*?)\*/g, "$1");
  cleaned = cleaned.replace(/_(.*?)_/g, "$1");
  cleaned = cleaned.replace(/~~(.*?)~~/g, "$1");
  cleaned = cleaned.replace(/^\s*[-*_]{3,}\s*$/gm, "");

  cleaned = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned || "No answer was generated.";
}

function formatAeonAskMetrics(result, snapshot) {
  const confidenceRaw = String(result?.confidence || "unknown").toLowerCase();
  const confidence = confidenceRaw.charAt(0).toUpperCase() + confidenceRaw.slice(1);
  const scopeText = result?.scope === "in_scope" ? "AEON'26 related" : "Out of scope";
  const sources = Array.isArray(result?.sources) ? result.sources.filter(Boolean) : [];
  const variantCount = Array.isArray(result?.query_variants) ? Math.min(result.query_variants.length, 5) : 0;
  const routerModel = shorten(String(result?.router_model || snapshot?.routerModel || "unknown"), 70);
  const answerModel = shorten(
    String(result?.answer_model || result?.model || snapshot?.answerModel || snapshot?.model || "unknown"),
    70,
  );

  const fields = [
    { name: "Scope", value: scopeText, inline: true },
    { name: "Confidence", value: confidence, inline: true },
  ];
  if (sources.length) {
    fields.push({
      name: "Sources",
      value: shorten(
        sources.slice(0, 8).map((name, index) => `${index + 1}. ${shorten(String(name), 80)}`).join("\n"),
        1000,
      ),
      inline: false,
    });
  }
  if (variantCount > 0) {
    fields.push({
      name: "Retrieval Variants",
      value: `${variantCount}`,
      inline: true,
    });
  }

  const textLines = [
    `Scope: ${scopeText}`,
    `Confidence: ${confidence}`,
    sources.length ? `Sources: ${sources.slice(0, 8).join(", ")}` : "",
    variantCount > 0 ? `Retrieval Variants: ${variantCount}` : "",
    `Router: ${routerModel} | Answer: ${answerModel}`,
  ].filter(Boolean);

  return {
    fields,
    footer: `Router: ${routerModel} | Answer: ${answerModel}`,
    text: textLines.join("\n"),
  };
}

function buildAeonAutoQuestionFromMessage(content, activationText) {
  const rawContent = String(content || "");
  const activation = String(activationText || "").trim();
  if (!rawContent || !activation) return "";

  const mentionMatch = activation.match(/^<@!?(\d{17,20})>$/);
  if (mentionMatch) {
    const userId = mentionMatch[1];
    const mentionRegex = new RegExp(`<@!?${userId}>`, "g");
    if (!mentionRegex.test(rawContent)) return "";
    return normalizeText(rawContent.replace(mentionRegex, " ").trim());
  }

  const lowerContent = rawContent.toLowerCase();
  const lowerActivation = activation.toLowerCase();
  const index = lowerContent.indexOf(lowerActivation);
  if (index < 0) return "";
  const before = rawContent.slice(0, index);
  const after = rawContent.slice(index + activation.length);
  return normalizeText(`${before} ${after}`.trim());
}

function findAeonActivationMatch(content, activationTexts) {
  const sorted = [...(Array.isArray(activationTexts) ? activationTexts : [])]
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const activationText of sorted) {
    const question = buildAeonAutoQuestionFromMessage(content, activationText);
    if (question) {
      return { activationText, question };
    }
  }
  return { activationText: "", question: "" };
}

function looksLikeAeonFollowupQuestion(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("?")) return true;
  return /^(what|when|where|who|why|how|can|could|would|should|is|are|do|does|did|if|and|then|so)\b/.test(normalized);
}

function inferAeonResponseModeFromQuestion(question, fallback = "normal") {
  const normalizedFallback = String(fallback || "normal").toLowerCase();
  const base = normalizedFallback === "brief" || normalizedFallback === "detailed" ? normalizedFallback : "normal";
  const text = normalizeText(question).toLowerCase();
  if (!text) return base;

  if (
    /\b(brief|short|quick|concise|in short|one line|one-liner|tldr|summary only)\b/.test(text) &&
    !/\b(detailed|deep|comprehensive|full|everything|all)\b/.test(text)
  ) {
    return "brief";
  }

  if (
    /\b(detailed|detail|as detailed as possible|deep dive|comprehensive|full breakdown|everything|all about|complete|organized|organised)\b/.test(
      text,
    )
  ) {
    return "detailed";
  }

  return base;
}

async function isReplyingToBot(message) {
  if (!message?.reference?.messageId) return false;
  const botId = message.client?.user?.id;
  if (!botId) return false;

  const repliedUserId = message.mentions?.repliedUser?.id;
  if (repliedUserId) return repliedUserId === botId;

  const cachedReference = message.channel?.messages?.cache?.get(message.reference.messageId);
  if (cachedReference?.author?.id) return cachedReference.author.id === botId;

  if (typeof message.fetchReference === "function") {
    try {
      const referenced = await message.fetchReference();
      return referenced?.author?.id === botId;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function extractAeonMentionQuestion(content, botId) {
  const raw = String(content || "");
  const id = String(botId || "").trim();
  if (!raw || !id) return "";
  const mentionRegex = new RegExp(`<@!?${id}>`, "g");
  if (!mentionRegex.test(raw)) return "";
  return normalizeText(raw.replace(mentionRegex, " ").trim());
}

function formatAttachmentContext(attachments) {
  if (!attachments) return "";
  const items = Array.isArray(attachments)
    ? attachments
    : typeof attachments.values === "function"
      ? [...attachments.values()]
      : [];
  if (!items.length) return "";
  const names = items.slice(0, AEON_CONTEXT_ATTACHMENT_LIMIT).map((file) => {
    const fileName = String(file?.name || "file").trim();
    const contentType = String(file?.contentType || "").trim();
    return contentType ? `${fileName} (${contentType})` : fileName;
  });
  return names.join(", ");
}

function summarizeDiscordMessageForAeonContext(message, botId = "") {
  if (!message) return "";
  const author = message.member?.displayName || message.author?.globalName || message.author?.username || "User";
  const mentionRegex = botId ? new RegExp(`<@!?${botId}>`, "g") : null;
  let content = normalizeText(String(message.content || ""));
  if (mentionRegex) {
    content = normalizeText(content.replace(mentionRegex, " "));
  }
  const attachmentInfo = formatAttachmentContext(message.attachments);
  const parts = [];
  if (content) parts.push(shorten(content, 280));
  if (attachmentInfo) parts.push(`Attachments: ${shorten(attachmentInfo, 220)}`);
  if (!parts.length) return "";
  return `${shorten(author, 40)}: ${shorten(parts.join(" | "), 340)}`;
}

function finalizeAeonContextLines(lines, maxChars = AEON_CONTEXT_MAX_CHARS) {
  const cleaned = [];
  const seen = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    const normalized = normalizeText(line);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(normalized);
  }
  if (!cleaned.length) return "";
  const combined = cleaned.join("\n");
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

async function fetchChannelContextMessages(channel, options = {}) {
  if (!channel || !channel.messages || typeof channel.messages.fetch !== "function") return [];
  const limit = Math.max(1, Math.min(20, Number(options.limit || AEON_CONTEXT_MESSAGE_LIMIT)));
  const before = String(options.before || "").trim();
  try {
    const collection = before
      ? await channel.messages.fetch({ limit: Math.min(50, limit + 6), before })
      : await channel.messages.fetch({ limit: Math.min(50, limit + 6) });
    const messages = [...collection.values()]
      .filter((item) => item && !item.system)
      .sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0));
    return messages.slice(-limit);
  } catch (_) {
    return [];
  }
}

async function collectAeonDiscordContextFromMessage(message) {
  if (!message?.channel || !message?.guild) return "";
  const lines = [];
  const botId = message.client?.user?.id || "";

  if (message.reference?.messageId && typeof message.fetchReference === "function") {
    try {
      const referenced = await message.fetchReference();
      const referencedLine = summarizeDiscordMessageForAeonContext(referenced, botId);
      if (referencedLine) lines.push(`Reply target -> ${referencedLine}`);
    } catch (_) {
      // ignore missing references
    }
  }

  const recent = await fetchChannelContextMessages(message.channel, {
    limit: AEON_CONTEXT_MESSAGE_LIMIT,
    before: message.id,
  });
  for (const item of recent) {
    if (!item || item.id === message.id) continue;
    const line = summarizeDiscordMessageForAeonContext(item, botId);
    if (!line) continue;
    lines.push(line);
  }

  const ownAttachments = formatAttachmentContext(message.attachments);
  if (ownAttachments) {
    lines.push(`Current message attachments: ${shorten(ownAttachments, 260)}`);
  }

  return finalizeAeonContextLines(lines, AEON_CONTEXT_MAX_CHARS);
}

async function collectAeonDiscordContextFromInteraction(interaction) {
  if (!interaction?.channel || !interaction?.guild) return "";
  const lines = [];
  const botId = interaction.client?.user?.id || "";
  const recent = await fetchChannelContextMessages(interaction.channel, {
    limit: AEON_CONTEXT_MESSAGE_LIMIT,
  });
  for (const item of recent) {
    if (!item) continue;
    const line = summarizeDiscordMessageForAeonContext(item, botId);
    if (!line) continue;
    lines.push(line);
  }
  return finalizeAeonContextLines(lines, AEON_CONTEXT_MAX_CHARS);
}

function buildAeonContextualQuestion(question, discordContext) {
  const base = normalizeText(question);
  const context = String(discordContext || "").trim();
  if (!context) return base;
  return `${base}\n\n[Discord Context]\nUse this only to resolve references in the latest question.\n${context}\n[/Discord Context]`;
}

function makeAeonThreadName(memberName) {
  const raw = String(memberName || "attendee")
    .toLowerCase()
    .replace(/[^a-z0-9\- ]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safe = raw || "attendee";
  return shorten(`aeon-${safe}`, 90);
}

async function resolveAeonThreadChannelForMessage(message) {
  const sourceChannel = message?.channel || null;
  if (!sourceChannel || isThreadChannel(sourceChannel)) {
    return { channel: sourceChannel, created: false, reused: false, moved: false };
  }
  if (!isTextChannel(sourceChannel)) {
    return { channel: sourceChannel, created: false, reused: false, moved: false };
  }
  const guildId = message.guild?.id;
  const rootChannelId = sourceChannel.id;
  const userId = message.author?.id;
  if (!guildId || !rootChannelId || !userId) {
    return { channel: sourceChannel, created: false, reused: false, moved: false };
  }

  const stored = getAeonThreadSession(guildId, rootChannelId, userId);
  if (stored?.threadId) {
    let existing = null;
    try {
      existing =
        message.guild.channels.cache.get(stored.threadId) ||
        (await message.guild.channels.fetch(stored.threadId).catch(() => null));
    } catch (_) {
      existing = null;
    }
    if (
      existing &&
      isThreadChannel(existing) &&
      existing.parentId === rootChannelId &&
      existing.archived !== true &&
      existing.locked !== true
    ) {
      setAeonThreadSession(guildId, rootChannelId, userId, existing.id);
      return { channel: existing, created: false, reused: true, moved: existing.id !== sourceChannel.id };
    }
    clearAeonThreadSession(guildId, rootChannelId, userId);
  }

  if (typeof message.startThread !== "function") {
    return { channel: sourceChannel, created: false, reused: false, moved: false };
  }

  try {
    const thread = await message.startThread({
      name: makeAeonThreadName(message.member?.displayName || message.author?.username || "attendee"),
      autoArchiveDuration: AEON_THREAD_AUTO_ARCHIVE_MINUTES,
      reason: `AEON AI mention session for ${message.author?.tag || message.author?.id || "user"}`,
    });
    if (thread && thread.id) {
      setAeonThreadSession(guildId, rootChannelId, userId, thread.id);
      return { channel: thread, created: true, reused: false, moved: thread.id !== sourceChannel.id };
    }
  } catch (error) {
    console.error("AEON thread session creation failed:", error?.message || error);
  }
  return { channel: sourceChannel, created: false, reused: false, moved: false };
}

function normalizeText(value) {
  return String(value || "").replace(/\s{2,}/g, " ").trim();
}

function splitTextForDiscord(text, maxLength = 1900) {
  const limit = Math.max(400, Number(maxLength) || 1900);
  const input = String(text || "").trim();
  if (!input) return [];
  if (input.length <= limit) return [input];

  const chunks = [];
  let remaining = input;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" | "),
      window.lastIndexOf(" "),
    );
    if (cut < Math.floor(limit * 0.45)) cut = limit;
    const piece = remaining.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

function normalizeAeonToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isAeonUnknownValue(value) {
  return /^not announced yet\.?$/i.test(String(value || "").trim());
}

function safeReadAeonKnowledge() {
  try {
    if (!fs.existsSync(AEON_KNOWLEDGE_FILE)) return "";
    return fs.readFileSync(AEON_KNOWLEDGE_FILE, "utf8");
  } catch (error) {
    console.error("Failed to read AEON knowledge file:", error);
    return "";
  }
}

function safeWriteAeonKnowledge(content) {
  try {
    const dir = path.dirname(AEON_KNOWLEDGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AEON_KNOWLEDGE_FILE, String(content || ""), "utf8");
    return true;
  } catch (error) {
    console.error("Failed to write AEON knowledge file:", error);
    return false;
  }
}

function isAeonKnownValue(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^none$/i.test(text)) return false;
  return !isAeonUnknownValue(text);
}

function normalizeAeonInlineText(value) {
  return String(value || "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\|\s+/g, " | ")
    .trim();
}

function getAeonKnownFieldValue(fieldMap, aliases) {
  if (!fieldMap || !Array.isArray(aliases)) return "";
  for (const alias of aliases) {
    const key = normalizeAeonToken(alias);
    const raw = fieldMap.get(key);
    if (!isAeonKnownValue(raw)) continue;
    return normalizeAeonInlineText(raw);
  }
  return "";
}

function parseAeonEventsFromKnowledge() {
  const text = safeReadAeonKnowledge();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const events = [];
  let inEventCatalog = false;
  let currentId = "";
  let currentFieldMap = new Map();

  function flushCurrent() {
    if (!currentId) return;
    const eventName = getAeonKnownFieldValue(currentFieldMap, ["Event Name"]) || currentId;
    const category = getAeonKnownFieldValue(currentFieldMap, ["Category/Track", "Track", "Category"]);
    const format = getAeonKnownFieldValue(currentFieldMap, ["Format"]);
    const start = getAeonKnownFieldValue(currentFieldMap, ["Event Start", "Date", "Start"]);
    const end = getAeonKnownFieldValue(currentFieldMap, ["Event End", "End"]);
    const fee = getAeonKnownFieldValue(currentFieldMap, ["Fee"]);
    const prize = getAeonKnownFieldValue(currentFieldMap, ["Prize Pool"]);
    const difficulty = getAeonKnownFieldValue(currentFieldMap, ["Difficulty", "Difficulty Level"]);
    const teamMin = getAeonKnownFieldValue(currentFieldMap, ["Team Size Min"]);
    const teamMax = getAeonKnownFieldValue(currentFieldMap, ["Team Size Max"]);
    const eligibility = getAeonKnownFieldValue(currentFieldMap, ["Eligibility"]);
    const rulebook = getAeonKnownFieldValue(currentFieldMap, ["Rulebook Link"]);
    const submission = getAeonKnownFieldValue(currentFieldMap, ["Submission Link"]);
    const coordinator = getAeonKnownFieldValue(currentFieldMap, ["Coordinator Name"]);
    const coordinatorContact = getAeonKnownFieldValue(currentFieldMap, ["Coordinator Contact"]);
    const description =
      getAeonKnownFieldValue(currentFieldMap, ["Description"]) ||
      getAeonKnownFieldValue(currentFieldMap, ["FAQ Notes"]) ||
      getAeonKnownFieldValue(currentFieldMap, ["Judging Criteria"]);
    const club = getAeonKnownFieldValue(currentFieldMap, [
      "Club Name",
      "Host Club",
      "Organizing Club",
      "Organizer",
    ]);

    const orderMatch = currentId.match(/(\d+)/);
    const order = orderMatch ? Number(orderMatch[1]) : Number.MAX_SAFE_INTEGER;

    events.push({
      id: currentId,
      order,
      name: eventName,
      category,
      format,
      start,
      end,
      fee,
      prize,
      difficulty,
      teamMin,
      teamMax,
      eligibility,
      rulebook,
      submission,
      coordinator,
      coordinatorContact,
      description,
      club,
    });
  }

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();
    if (!trimmed) continue;

    const h2 = /^##\s+(.+)$/.exec(trimmed);
    if (h2) {
      if (inEventCatalog) {
        flushCurrent();
        currentId = "";
        currentFieldMap = new Map();
      }
      inEventCatalog = normalizeAeonToken(h2[1]).includes("event catalog");
      continue;
    }

    if (!inEventCatalog) continue;

    const h3 = /^###\s+(.+)$/.exec(trimmed);
    if (h3) {
      flushCurrent();
      currentId = h3[1].trim();
      currentFieldMap = new Map();
      continue;
    }

    if (!currentId) continue;

    const fieldMatch = /^\s*-\s+([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!fieldMatch) continue;
    const fieldName = String(fieldMatch[1] || "").trim();
    const fieldValue = String(fieldMatch[2] || "").trim();
    if (!fieldName) continue;
    currentFieldMap.set(normalizeAeonToken(fieldName), fieldValue);
  }

  if (inEventCatalog) flushCurrent();

  return events
    .filter((item) => item && item.name)
    .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
}

function parseAeonEventsFromStructuredFile() {
  try {
    if (!fs.existsSync(AEON_EVENTS_STRUCTURED_FILE)) return [];
    const raw = fs.readFileSync(AEON_EVENTS_STRUCTURED_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    return events
      .map((item, index) => ({
        id: `PDF-${String(index + 1).padStart(2, "0")}`,
        order: index + 1,
        name: normalizeAeonInlineText(item?.event_name || ""),
        category: "",
        format: "",
        start: "",
        end: "",
        fee: "",
        prize: "",
        difficulty: "",
        teamMin: "",
        teamMax: "",
        eligibility: "",
        rulebook: "",
        submission: "",
        coordinator: "",
        coordinatorContact: "",
        description: normalizeAeonInlineText(item?.description || ""),
        club: normalizeAeonInlineText(item?.club_name || ""),
      }))
      .filter((item) => item.name);
  } catch (error) {
    console.error("Failed to parse structured AEON events file:", error);
    return [];
  }
}

function loadAeonEventsForPanel() {
  const kbEvents = parseAeonEventsFromKnowledge();
  const extractedEvents = parseAeonEventsFromStructuredFile();
  if (!extractedEvents.length) return kbEvents;
  if (!kbEvents.length) return extractedEvents;
  if (extractedEvents.length > kbEvents.length) return extractedEvents;
  return kbEvents;
}

function pruneAeonEventsPanels() {
  const now = Date.now();
  for (const [panelId, panel] of aeonEventsPanelStore.entries()) {
    if (!panel?.updatedAt || now - panel.updatedAt > AEON_EVENTS_PANEL_TTL_MS) {
      aeonEventsPanelStore.delete(panelId);
    }
  }
}

function createAeonEventsPanel(guildId, ownerId, events) {
  pruneAeonEventsPanels();
  const panelId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const panel = {
    id: panelId,
    guildId,
    ownerId,
    pageIndex: 0,
    events: Array.isArray(events) ? events : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  aeonEventsPanelStore.set(panelId, panel);
  return panel;
}

function getAeonEventsPanel(guildId, ownerId, panelId) {
  pruneAeonEventsPanels();
  const panel = aeonEventsPanelStore.get(panelId);
  if (!panel) return null;
  if (panel.ownerId !== ownerId) return null;
  if (panel.guildId !== guildId) return null;
  return panel;
}

function saveAeonEventsPanel(panel) {
  if (!panel?.id) return;
  panel.updatedAt = Date.now();
  aeonEventsPanelStore.set(panel.id, panel);
}

function clearAeonEventsPanel(panelId) {
  if (!panelId) return;
  aeonEventsPanelStore.delete(panelId);
}

function formatAeonEventTimeline(event) {
  const start = normalizeAeonInlineText(event?.start || "");
  const end = normalizeAeonInlineText(event?.end || "");
  if (start && end) {
    if (start === end) return start;
    return `${start} to ${end}`;
  }
  return start || end || "Not announced yet.";
}

function formatAeonEventTeamSize(event) {
  const min = normalizeAeonInlineText(event?.teamMin || "");
  const max = normalizeAeonInlineText(event?.teamMax || "");
  if (min && max) return `${min} to ${max}`;
  if (min) return `Min ${min}`;
  if (max) return `Max ${max}`;
  return "Not announced yet.";
}

function buildAeonEventsEmbed(panel, requester, botUser) {
  const events = Array.isArray(panel?.events) ? panel.events : [];
  const totalPages = events.length + 1;
  const pageIndex = Math.max(0, Math.min(totalPages - 1, Number(panel?.pageIndex || 0)));

  if (pageIndex === 0) {
    const lines = events.map((event, idx) => {
      const track = event.category || "Track pending";
      const club = event.club || "Club not listed";
      return `**${idx + 1}.** ${event.name}\n${track} | ${club}`;
    });
    const description = [
      `A curated list of AEON'26 events from the knowledge base.`,
      "",
      `Total events: **${events.length}**`,
      "",
      lines.length ? lines.join("\n\n") : "No events available right now.",
    ].join("\n");
    const embed = makeEmbed("AEON'26 Events Directory", shorten(description, 3950), AEON_EVENTS_PANEL_COLOR);
    if (requester) {
      const iconURL =
        typeof requester.displayAvatarURL === "function"
          ? requester.displayAvatarURL({ dynamic: true })
          : null;
      setEmbedAuthorSafe(embed, `Opened by ${requester.tag}`, iconURL);
    }
    if (botUser && typeof botUser.displayAvatarURL === "function") {
      setEmbedThumbnailSafe(embed, botUser.displayAvatarURL({ dynamic: true, size: 1024 }));
    }
    setEmbedFooterSafe(embed, `Page 1/${totalPages} | Use buttons or dropdown to navigate`);
    return embed;
  }

  const event = events[pageIndex - 1];
  const subtitleParts = [];
  if (event.category) subtitleParts.push(event.category);
  if (event.format) subtitleParts.push(event.format);

  const descriptionParts = [];
  if (subtitleParts.length) descriptionParts.push(subtitleParts.join(" | "));
  if (event.description) descriptionParts.push(event.description);
  const description = descriptionParts.join("\n\n") || "No description available yet.";

  const fields = [
    { name: "Club", value: event.club || "Not listed", inline: true },
    { name: "Timeline", value: formatAeonEventTimeline(event), inline: true },
    { name: "Team Size", value: formatAeonEventTeamSize(event), inline: true },
    { name: "Difficulty", value: event.difficulty || "Not announced yet.", inline: true },
    { name: "Fee", value: event.fee || "Not announced yet.", inline: true },
    { name: "Prize Pool", value: event.prize || "Not announced yet.", inline: true },
  ];

  if (event.eligibility) fields.push({ name: "Eligibility", value: shorten(event.eligibility, 600), inline: false });
  if (event.coordinator || event.coordinatorContact) {
    fields.push({
      name: "Coordinator",
      value: [event.coordinator || "Name not announced", event.coordinatorContact || "Contact not announced"]
        .filter(Boolean)
        .join("\n"),
      inline: false,
    });
  }
  if (event.rulebook || event.submission) {
    fields.push({
      name: "Links",
      value: [
        event.rulebook ? `Rulebook: ${event.rulebook}` : null,
        event.submission ? `Submission: ${event.submission}` : null,
      ].filter(Boolean).join("\n"),
      inline: false,
    });
  }

  const embed = makeEmbed(
    `AEON Event ${pageIndex}/${totalPages - 1} | ${event.name}`,
    shorten(description, 3500),
    AEON_EVENTS_PANEL_COLOR,
    fields,
  );
  if (requester) {
    const iconURL =
      typeof requester.displayAvatarURL === "function"
        ? requester.displayAvatarURL({ dynamic: true })
        : null;
    setEmbedAuthorSafe(embed, `Opened by ${requester.tag}`, iconURL);
  }
  if (botUser && typeof botUser.displayAvatarURL === "function") {
    setEmbedThumbnailSafe(embed, botUser.displayAvatarURL({ dynamic: true, size: 1024 }));
  }
  setEmbedFooterSafe(embed, `Page ${pageIndex + 1}/${totalPages} | ${event.id || "Event"}`);
  return embed;
}

function buildAeonEventsComponents(ownerId, panelId, pageIndex, events) {
  const eventList = Array.isArray(events) ? events : [];
  const eventCount = eventList.length;
  const totalPages = Math.max(1, Number(eventCount || 0) + 1);
  const current = Math.max(0, Math.min(totalPages - 1, Number(pageIndex || 0)));

  const navRow = new ActionRowClass().addComponents(
    createNavButton(`aeonevents:nav:${ownerId}:${panelId}:first`, "First", "SECONDARY", current <= 0),
    createNavButton(`aeonevents:nav:${ownerId}:${panelId}:prev`, "Prev", "SUCCESS", current <= 0),
    createNavButton(`aeonevents:nav:${ownerId}:${panelId}:next`, "Next", "SUCCESS", current >= totalPages - 1),
    createNavButton(`aeonevents:nav:${ownerId}:${panelId}:last`, "Last", "SECONDARY", current >= totalPages - 1),
    createNavButton(`aeonevents:nav:${ownerId}:${panelId}:close`, "Close", "DANGER"),
  );

  const options = [{ label: "Overview", value: "0", description: "View all events in one list." }];
  for (let i = 0; i < eventCount && i < 24; i += 1) {
    const index = i + 1;
    const event = eventList[i];
    const summary = event?.category || event?.club || "Event details";
    options.push({
      label: shorten(`${index}. ${event?.name || `Event ${index}`}`, 100),
      value: `${index}`,
      description: shorten(summary, 100),
    });
  }
  const select = createStringSelectMenu(
    `aeonevents:jump:${ownerId}:${panelId}`,
    "Jump to overview or an event page",
    options,
  );
  const selectRow = new ActionRowClass().addComponents(select);
  return [navRow, selectRow];
}

function parseAeonKnowledgeFieldIndex(lines) {
  const entries = [];
  let section = "";
  let subsection = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    const h2 = /^##\s+(.+)$/.exec(line.trim());
    if (h2) {
      section = h2[1].trim();
      subsection = "";
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line.trim());
    if (h3) {
      subsection = h3[1].trim();
      continue;
    }

    const fieldMatch = /^\s*-\s+([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!fieldMatch) continue;
    const field = String(fieldMatch[1] || "").trim();
    const value = String(fieldMatch[2] || "").trim();
    if (!field) continue;
    entries.push({
      lineIndex: i,
      field,
      value,
      section,
      subsection,
      normalizedField: normalizeAeonToken(field),
      normalizedSection: normalizeAeonToken(section),
      normalizedSubsection: normalizeAeonToken(subsection),
    });
  }

  return entries;
}

function findAeonSectionRange(lines, sectionHint) {
  const hint = normalizeAeonToken(sectionHint);
  if (!hint) return null;

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const h2 = /^##\s+(.+)$/.exec(String(lines[i] || "").trim());
    if (!h2) continue;
    const normalized = normalizeAeonToken(h2[1]);
    if (!normalized) continue;
    if (normalized.includes(hint) || hint.includes(normalized)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (/^##\s+/.test(String(lines[j] || "").trim())) {
      end = j;
      break;
    }
  }
  return { start, end };
}

function inferAeonSectionFromField(fieldName) {
  const key = normalizeAeonToken(fieldName);
  if (!key) return "Global Event Metadata";
  if (/registration|team size|participation|portal|deadline|fee|refund/.test(key)) return "Registration & Participation";
  if (/venue|parking|check in|entry|access|medical|emergency|lost and found/.test(key)) return "Venue, Access, and Logistics";
  if (/schedule|date|time|sch /.test(key)) return "Master Schedule";
  if (/event|rulebook|submission|judging|coordinator|prize/.test(key)) return "Event Catalog";
  if (/session|speaker|workshop|talk|panel|materials/.test(key)) return "Workshops / Talks / Panels";
  if (/sponsor|partner|community/.test(key)) return "Sponsors, Partners, and Communities";
  if (/organizing|volunteer|lead/.test(key)) return "Volunteer / Organizer Operations";
  if (/conduct|policy|disqualification|appeals|compliance/.test(key)) return "Rules and Compliance";
  if (/faq|question|answer/.test(key)) return "FAQ Bank";
  return "Global Event Metadata";
}

const AEON_TRAIN_SECTION_PRIORITY = new Map([
  [normalizeAeonToken("Global Event Metadata"), 1],
  [normalizeAeonToken("Registration & Participation"), 2],
  [normalizeAeonToken("Master Schedule"), 3],
  [normalizeAeonToken("Event Catalog"), 4],
  [normalizeAeonToken("Venue, Access, and Logistics"), 5],
  [normalizeAeonToken("Event Tracks / Categories"), 6],
  [normalizeAeonToken("Workshops / Talks / Panels"), 7],
  [normalizeAeonToken("Rules and Compliance"), 8],
  [normalizeAeonToken("FAQ Bank"), 9],
  [normalizeAeonToken("Sponsors, Partners, and Communities"), 10],
  [normalizeAeonToken("Volunteer / Organizer Operations"), 11],
]);

function canonicalizeAeonSectionName(sectionHint) {
  const raw = String(sectionHint || "").trim();
  const key = normalizeAeonToken(raw);
  if (!key) return "";
  if (key.includes("registration") || key.includes("participation")) return "Registration & Participation";
  if (key.includes("venue") || key.includes("logistics") || key.includes("access")) return "Venue, Access, and Logistics";
  if (key.includes("schedule")) return "Master Schedule";
  if (key.includes("catalog") || key.includes("event detailed")) return "Event Catalog";
  if (key.includes("workshop") || key.includes("talk") || key.includes("panel")) return "Workshops / Talks / Panels";
  if (key.includes("track") || key.includes("categories")) return "Event Tracks / Categories";
  if (key.includes("rule") || key.includes("compliance") || key.includes("policy")) return "Rules and Compliance";
  if (key.includes("faq")) return "FAQ Bank";
  if (key.includes("sponsor") || key.includes("partner") || key.includes("community")) return "Sponsors, Partners, and Communities";
  if (key.includes("volunteer") || key.includes("organizer") || key.includes("operations")) return "Volunteer / Organizer Operations";
  if (key.includes("global") || key.includes("metadata")) return "Global Event Metadata";
  return raw;
}

function getAeonSectionPriority(sectionName) {
  const normalized = normalizeAeonToken(sectionName);
  if (!normalized) return 50;
  for (const [key, score] of AEON_TRAIN_SECTION_PRIORITY.entries()) {
    if (normalized === key || normalized.includes(key) || key.includes(normalized)) {
      return score;
    }
  }
  return 50;
}

function getAeonFieldPriority(fieldName) {
  const key = normalizeAeonToken(fieldName);
  if (!key) return 50;
  if (/event name|official website|official email|official discord|host/.test(key)) return 1;
  if (/registration|deadline|opens|closes|fee|team size|eligibility/.test(key)) return 2;
  if (/date|time|schedule|venue|location|map/.test(key)) return 3;
  if (/rulebook|submission|judging|contact|coordinator|policy/.test(key)) return 4;
  if (/speaker|session|track|sponsor|partner/.test(key)) return 5;
  return 20;
}

function getAeonUpdatePriorityLabel(sectionName, fieldName) {
  const sectionRank = getAeonSectionPriority(sectionName);
  const fieldRank = getAeonFieldPriority(fieldName);
  if (sectionRank <= 3 || fieldRank <= 2) return "Critical";
  if (sectionRank <= 6 || fieldRank <= 4) return "High";
  if (sectionRank <= 10) return "Medium";
  return "Low";
}

function sortAeonTrainingUpdates(items) {
  return [...items].sort((a, b) => {
    const sectionDelta = getAeonSectionPriority(a.sectionHint) - getAeonSectionPriority(b.sectionHint);
    if (sectionDelta !== 0) return sectionDelta;
    const fieldDelta = getAeonFieldPriority(a.field) - getAeonFieldPriority(b.field);
    if (fieldDelta !== 0) return fieldDelta;
    const aKey = `${normalizeAeonToken(a.sectionHint)}|${normalizeAeonToken(a.field)}`;
    const bKey = `${normalizeAeonToken(b.sectionHint)}|${normalizeAeonToken(b.field)}`;
    return aKey.localeCompare(bKey);
  });
}

function updateAeonKnowledgeField(lines, fieldName, value, sectionHint = "") {
  const trimmedField = String(fieldName || "").trim();
  const trimmedValue = String(value || "").trim();
  if (!trimmedField || !trimmedValue) {
    return { ok: false, reason: "Field and value are required." };
  }

  const normalizedField = normalizeAeonToken(trimmedField);
  const normalizedHint = normalizeAeonToken(sectionHint);
  const index = parseAeonKnowledgeFieldIndex(lines);

  let candidates = index.filter((item) => item.normalizedField === normalizedField);
  if (normalizedHint) {
    const scoped = candidates.filter(
      (item) =>
        item.normalizedSection.includes(normalizedHint) ||
        normalizedHint.includes(item.normalizedSection) ||
        item.normalizedSubsection.includes(normalizedHint) ||
        normalizedHint.includes(item.normalizedSubsection),
    );
    if (scoped.length) candidates = scoped;
  }

  if (candidates.length === 1) {
    const target = candidates[0];
    lines[target.lineIndex] = `- ${target.field}: ${trimmedValue}`;
    return {
      ok: true,
      action: "updated",
      section: target.section || sectionHint || inferAeonSectionFromField(trimmedField),
      field: target.field,
    };
  }

  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "Ambiguous field; provide section hint using `SECTION | FIELD | VALUE` format.",
    };
  }

  const resolvedSection = canonicalizeAeonSectionName(sectionHint) || inferAeonSectionFromField(trimmedField);
  const range = findAeonSectionRange(lines, resolvedSection);
  if (!range) {
    lines.push("", `## ${resolvedSection}`, "", `- ${trimmedField}: ${trimmedValue}`);
    return { ok: true, action: "added", section: resolvedSection, field: trimmedField };
  }

  let insertAt = range.end;
  while (insertAt > range.start + 1 && String(lines[insertAt - 1] || "").trim() === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, `- ${trimmedField}: ${trimmedValue}`);
  return { ok: true, action: "added", section: resolvedSection, field: trimmedField };
}

function parseAeonTrainingInput(rawInput) {
  const raw = String(rawInput || "");
  const lines = raw.split(/\r?\n/);
  const updates = [];
  let currentSectionHint = "";

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    if (line.startsWith("#") || line === "---") continue;

    const headingMatch = /^#{1,3}\s+(.+)$/.exec(line);
    if (headingMatch) {
      currentSectionHint = canonicalizeAeonSectionName(headingMatch[1]) || currentSectionHint;
      continue;
    }

    const sectionMatch = /^(?:section|category|track)\s*:\s*(.+)$/i.exec(line);
    if (sectionMatch) {
      currentSectionHint = canonicalizeAeonSectionName(sectionMatch[1]) || currentSectionHint;
      continue;
    }

    const bracketSection = /^\[(.+?)\]$/.exec(line);
    if (bracketSection) {
      currentSectionHint = canonicalizeAeonSectionName(bracketSection[1]) || currentSectionHint;
      continue;
    }

    const pipe = /^(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/.exec(line);
    if (pipe) {
      updates.push({
        sectionHint: canonicalizeAeonSectionName(pipe[1]) || currentSectionHint || "Global Event Metadata",
        field: pipe[2].trim(),
        value: pipe[3].trim(),
      });
      continue;
    }

    const colon = /^\s*-?\s*([^:]+):\s*(.+)$/.exec(line);
    if (colon) {
      const field = colon[1].trim();
      const value = colon[2].trim();
      updates.push({
        sectionHint:
          canonicalizeAeonSectionName(currentSectionHint) ||
          inferAeonSectionFromField(field),
        field,
        value,
      });
      continue;
    }
  }

  const deduped = new Map();
  for (const item of updates.filter((entry) => entry.field && entry.value)) {
    const normalizedSection =
      canonicalizeAeonSectionName(item.sectionHint) || inferAeonSectionFromField(item.field);
    const priority = getAeonUpdatePriorityLabel(normalizedSection, item.field);
    const key = `${normalizeAeonToken(normalizedSection)}|${normalizeAeonToken(item.field)}`;
    deduped.set(key, {
      sectionHint: normalizedSection,
      field: String(item.field || "").trim(),
      value: String(item.value || "").trim(),
      priority,
    });
  }

  return sortAeonTrainingUpdates([...deduped.values()]);
}

function applyAeonTrainingInputDeterministic(rawInput) {
  const parsedUpdates = parseAeonTrainingInput(rawInput);
  if (!parsedUpdates.length) {
    return {
      ok: false,
      error: "No valid lines found. Use `SECTION | FIELD | VALUE` or `FIELD: VALUE` format.",
    };
  }

  const current = safeReadAeonKnowledge();
  if (!current) {
    return { ok: false, error: "Knowledge file is missing." };
  }
  const lines = current.split(/\r?\n/);

  let updatedCount = 0;
  let addedCount = 0;
  const failed = [];
  const priorityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const item of parsedUpdates) {
    const level = item.priority || "Medium";
    if (priorityCounts[level] === undefined) priorityCounts[level] = 0;
    priorityCounts[level] += 1;
    const result = updateAeonKnowledgeField(lines, item.field, item.value, item.sectionHint);
    if (!result.ok) {
      failed.push(`${item.field} (${result.reason || "Failed"})`);
      continue;
    }
    if (result.action === "updated") updatedCount += 1;
    if (result.action === "added") addedCount += 1;
  }

  if (updatedCount === 0 && addedCount === 0) {
    return {
      ok: false,
      error: failed.length ? `No updates applied. ${failed.slice(0, 3).join("; ")}` : "No updates applied.",
    };
  }

  const next = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  if (!safeWriteAeonKnowledge(next)) {
    return { ok: false, error: "Failed to write updates to the knowledge file." };
  }

  return {
    ok: true,
    updatedCount,
    addedCount,
    failed,
    totalParsed: parsedUpdates.length,
    priorityCounts,
  };
}

function extractAeonUnknownFields(limit = 80) {
  const text = safeReadAeonKnowledge();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const prioritized = parseAeonKnowledgeFieldIndex(lines)
    .filter((item) => isAeonUnknownValue(item.value))
    .filter((item) => !/^kb version|last updated|timezone$/i.test(item.field))
    .map((item) => {
      const sectionName = canonicalizeAeonSectionName(item.section) || "General";
      const sectionRank = getAeonSectionPriority(sectionName);
      const fieldRank = getAeonFieldPriority(item.field);
      return {
        lineIndex: item.lineIndex,
        field: item.field,
        section: sectionName,
        subsection: item.subsection || "",
        currentValue: item.value,
        priority: getAeonUpdatePriorityLabel(sectionName, item.field),
        priorityScore: (sectionRank * 100) + fieldRank,
      };
    })
    .sort((a, b) => {
      if (a.priorityScore !== b.priorityScore) return a.priorityScore - b.priorityScore;
      const aKey = `${normalizeAeonToken(a.section)}|${normalizeAeonToken(a.field)}`;
      const bKey = `${normalizeAeonToken(b.section)}|${normalizeAeonToken(b.field)}`;
      return aKey.localeCompare(bKey);
    })
    .slice(0, limit);

  const fields = prioritized.map((item) => ({
    lineIndex: item.lineIndex,
    field: item.field,
    section: item.section,
    subsection: item.subsection,
    currentValue: item.currentValue,
    priority: item.priority,
  }));
  return fields;
}

function makeAeonTrainSessionKey(guildId, userId) {
  return `${guildId || "noguild"}:${userId || "nouser"}`;
}

function pruneAeonTrainSessions() {
  const now = Date.now();
  for (const [key, session] of aeonTrainSessionStore.entries()) {
    if (!session?.updatedAt || now - session.updatedAt > AEON_TRAIN_SESSION_TTL_MS) {
      aeonTrainSessionStore.delete(key);
    }
  }
}

function createAeonTrainSession(guildId, userId, mode, payload = {}) {
  pruneAeonTrainSessions();
  const key = makeAeonTrainSessionKey(guildId, userId);
  const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const session = {
    id: sessionId,
    guildId,
    userId,
    mode,
    pointer: 0,
    updatedCount: 0,
    skippedCount: 0,
    appliedFacts: [],
    unknownFields: Array.isArray(payload.unknownFields) ? payload.unknownFields : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  aeonTrainSessionStore.set(key, session);
  return session;
}

function getAeonTrainSession(guildId, userId, sessionId) {
  pruneAeonTrainSessions();
  const key = makeAeonTrainSessionKey(guildId, userId);
  const session = aeonTrainSessionStore.get(key);
  if (!session) return null;
  if (sessionId && session.id !== sessionId) return null;
  return session;
}

function saveAeonTrainSession(session) {
  if (!session) return;
  session.updatedAt = Date.now();
  const key = makeAeonTrainSessionKey(session.guildId, session.userId);
  aeonTrainSessionStore.set(key, session);
}

function clearAeonTrainSession(guildId, userId) {
  const key = makeAeonTrainSessionKey(guildId, userId);
  aeonTrainSessionStore.delete(key);
}

function buildAeonTrainInteractiveEmbed(session, stateText = "in_progress", note = "") {
  const total = session?.unknownFields?.length || 0;
  const current = session?.unknownFields?.[session.pointer] || null;
  const answered = session?.updatedCount || 0;
  const skipped = session?.skippedCount || 0;

  if (stateText === "complete" || !current) {
    const embed = makeEmbed(
      "AEON Train Interactive Complete",
      note || "Interactive session finished.",
      COLORS.SUCCESS,
      [
        { name: "Answered", value: `${answered}`, inline: true },
        { name: "Skipped", value: `${skipped}`, inline: true },
        { name: "Total", value: `${total}`, inline: true },
      ],
    );
    setEmbedFooterSafe(embed, "Knowledge file updated");
    return embed;
  }

  const embed = makeEmbed(
    `AEON Train Interactive (${Math.min(session.pointer + 1, total)}/${total})`,
    `Please provide a real value for:\n**${current.field}**`,
    COLORS.INFO,
    [
      { name: "Section", value: current.section || "General", inline: true },
      { name: "Priority", value: current.priority || "Medium", inline: true },
      { name: "Current Value", value: current.currentValue || "Not set", inline: true },
      { name: "Answered", value: `${answered}`, inline: true },
      { name: "Skipped", value: `${skipped}`, inline: true },
    ],
  );
  if (note) {
    embed.addFields([{ name: "Note", value: shorten(note, 300), inline: false }]);
  }
  setEmbedFooterSafe(embed, "Answer, skip, or stop this session");
  return embed;
}

function buildAeonTrainInteractiveComponents(userId, sessionId, disabled = false) {
  const row = new ActionRowClass().addComponents(
    createNavButton(`aeontrain:act:${userId}:${sessionId}:answer`, "Answer", "PRIMARY", disabled),
    createNavButton(`aeontrain:act:${userId}:${sessionId}:skip`, "Skip", "SECONDARY", disabled),
    createNavButton(`aeontrain:act:${userId}:${sessionId}:stop`, "Stop", "DANGER", disabled),
  );
  return [row];
}

async function showAeonTrainInputModal(interaction, ownerId, sessionId) {
  const modal = buildSingleInputModal(
    `aeontrain:input:${ownerId}:${sessionId}`,
    "AEON Train Input",
    "value",
    "Real Data Input",
    "Use: SECTION | FIELD | VALUE, FIELD: VALUE, or SECTION: ... blocks",
    "",
    "PARAGRAPH",
  );
  if (!modal || typeof interaction.showModal !== "function") {
    await interaction.reply({
      embeds: [makeEmbed("Unsupported Action", "Modals are not available in this runtime.", COLORS.ERROR)],
      flags: EPHEMERAL_FLAG,
    });
    return;
  }
  try {
    await interaction.showModal(modal);
  } catch (error) {
    if (!isUnknownInteractionError(error)) throw error;
  }
}

async function showAeonTrainInteractiveAnswerModal(interaction, ownerId, sessionId, field, section) {
  const modal = buildSingleInputModal(
    `aeontrain:answer:${ownerId}:${sessionId}`,
    "AEON Train Answer",
    "value",
    shorten(`${field} (${section || "General"})`, 45),
    "Enter the real updated value",
    "",
    "PARAGRAPH",
  );
  if (!modal || typeof interaction.showModal !== "function") {
    await interaction.reply({
      embeds: [makeEmbed("Unsupported Action", "Modals are not available in this runtime.", COLORS.ERROR)],
      flags: EPHEMERAL_FLAG,
    });
    return;
  }
  try {
    await interaction.showModal(modal);
  } catch (error) {
    if (!isUnknownInteractionError(error)) throw error;
  }
}

function normalizeReason(input, fallback) {
  if (typeof input !== "string") return fallback;
  const text = input.trim();
  if (!text) return fallback;
  return text.slice(0, MAX_REASON_LENGTH);
}

function parseDurationToMs(raw) {
  if (typeof raw !== "string") return { error: "Duration format is invalid." };
  const match = raw.trim().toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return { error: "Use duration like 30s, 15m, 2h, or 3d." };
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return { error: "Duration must be a positive number." };
  const factor = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  const ms = value * factor;
  if (ms > MAX_TIMEOUT_MS) return { error: "Timeout cannot exceed 28 days." };
  return { ms };
}

function formatSeconds(seconds) {
  if (seconds === 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", s ? `${s}s` : ""].filter(Boolean).join(" ");
}

function parseReminderDurationMs(raw) {
  if (typeof raw !== "string") return { error: "Time format is invalid." };
  const match = raw.trim().toLowerCase().match(/^(\d+)(s|m|h|d|w)$/);
  if (!match) return { error: "Use a duration like 30s, 10m, 2h, 1d, or 1w." };
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return { error: "Time must be a positive number." };
  const factor = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  const ms = value * factor;
  if (ms > 365 * 24 * 60 * 60 * 1000) return { error: "Reminder duration cannot exceed 365 days." };
  return { ms };
}

function parseDateTimeToUnix(dateStr, timeStr) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr || "").trim());
  if (!d || !t) return { error: "Use date `YYYY-MM-DD` and time `HH:mm` (or `HH:mm:ss`)." };

  const year = Number(d[1]);
  const month = Number(d[2]);
  const day = Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = t[3] ? Number(t[3]) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) return { error: "Date values are out of range." };
  if (hour > 23 || minute > 59 || second > 59) return { error: "Time values are out of range." };

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { error: "Invalid calendar date." };
  }

  return { unix: Math.floor(date.getTime() / 1000) };
}

function isLikelyAeonActionRequest(question, parsedPlan) {
  const text = normalizeText(question).toLowerCase();
  if (!text) return false;
  const actionCount = Array.isArray(parsedPlan?.actions) ? parsedPlan.actions.length : 0;
  if (actionCount <= 0) return false;

  const infoIntent =
    /\bhow to\b|\bhow do i\b|\bwhat is\b|\bwhat are\b|\bwhy\b|\bwhen\b|\bwhere\b|\bexplain\b/.test(text);
  const executeIntent =
    /^(please\s+)?(can|could|would)\s+you\b/.test(text) ||
    /^(please\s+)?(create|make|add|remove|delete|rename|set|update|move|lock|unlock|grant|revoke|deny|allow)\b/.test(
      text,
    ) ||
    /\bdo this\b|\bapply this\b|\bperform this\b|\bexecute this\b/.test(text);

  if (executeIntent) return true;
  if (infoIntent) return false;
  return actionCount > 0 && !text.endsWith("?");
}

function inferActionDryRunFromText(text) {
  const q = normalizeText(text).toLowerCase();
  if (!q) return false;
  return /\bdry run\b|\bpreview\b|\bsimulate\b|\btest run\b/.test(q);
}

const AEON_ACTION_PERMISSION_LABELS = new Map([
  [Permissions.FLAGS.MANAGE_GUILD, "Manage Server"],
  [Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"],
  [Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"],
]);

const AEON_ACTION_REQUIRED_PERMS = {
  create_category: [Permissions.FLAGS.MANAGE_CHANNELS],
  create_channel: [Permissions.FLAGS.MANAGE_CHANNELS],
  delete_channel: [Permissions.FLAGS.MANAGE_CHANNELS],
  rename_channel: [Permissions.FLAGS.MANAGE_CHANNELS],
  move_channel_category: [Permissions.FLAGS.MANAGE_CHANNELS],
  set_channel_topic: [Permissions.FLAGS.MANAGE_CHANNELS],
  set_channel_nsfw: [Permissions.FLAGS.MANAGE_CHANNELS],
  set_channel_slowmode: [Permissions.FLAGS.MANAGE_CHANNELS],
  lock_channel: [Permissions.FLAGS.MANAGE_CHANNELS],
  unlock_channel: [Permissions.FLAGS.MANAGE_CHANNELS],
  create_role: [Permissions.FLAGS.MANAGE_ROLES],
  delete_role: [Permissions.FLAGS.MANAGE_ROLES],
  rename_role: [Permissions.FLAGS.MANAGE_ROLES],
  set_role_color: [Permissions.FLAGS.MANAGE_ROLES],
  set_role_mentionable: [Permissions.FLAGS.MANAGE_ROLES],
  set_role_hoist: [Permissions.FLAGS.MANAGE_ROLES],
  add_role_to_member: [Permissions.FLAGS.MANAGE_ROLES],
  remove_role_from_member: [Permissions.FLAGS.MANAGE_ROLES],
  grant_channel_access: [Permissions.FLAGS.MANAGE_CHANNELS],
  revoke_channel_access: [Permissions.FLAGS.MANAGE_CHANNELS],
};

function parseAeonActionPlanId(rawInput) {
  const planId = String(rawInput || "").trim();
  if (!/^plan_[a-z0-9]{6,30}$/i.test(planId)) return "";
  return planId;
}

function parseAeonRunId(rawInput) {
  const runId = String(rawInput || "").trim();
  if (!/^run_[a-z0-9]{6,30}$/i.test(runId)) return "";
  return runId;
}

function makeAeonRunId() {
  const base = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run_${base}${rand}`;
}

function resolveAeonActionRiskColor(risk) {
  const value = String(risk || "low").toLowerCase();
  if (value === "high") return COLORS.ERROR;
  if (value === "medium") return COLORS.WARNING;
  return COLORS.INFO;
}

function actionTargetIdFromRef(ref, kind = "any") {
  const raw = String(ref || "").trim();
  if (!raw) return "";
  const channelMatch = raw.match(/^<#(\d{17,20})>$/);
  const roleMatch = raw.match(/^<@&(\d{17,20})>$/);
  const memberMatch = raw.match(/^<@!?(\d{17,20})>$/);
  if (kind === "channel") return channelMatch ? channelMatch[1] : /^\d{17,20}$/.test(raw) ? raw : "";
  if (kind === "role") return roleMatch ? roleMatch[1] : /^\d{17,20}$/.test(raw) ? raw : "";
  if (kind === "member") return memberMatch ? memberMatch[1] : /^\d{17,20}$/.test(raw) ? raw : "";
  if (channelMatch) return channelMatch[1];
  if (roleMatch) return roleMatch[1];
  if (memberMatch) return memberMatch[1];
  return /^\d{17,20}$/.test(raw) ? raw : "";
}

function normalizeSearchLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^[@#]/, "")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveActionChannel(guild, ref, fallbackChannel = null) {
  const fallback = fallbackChannel || null;
  const raw = String(ref || "").trim();
  if (!raw || /^(here|this|current|same)$/i.test(raw)) return fallback;

  const id = actionTargetIdFromRef(raw, "channel");
  if (id) {
    const byId = guild.channels.cache.get(id) || (await guild.channels.fetch(id).catch(() => null));
    if (byId) return byId;
  }

  const needle = normalizeSearchLabel(raw);
  if (!needle) return null;

  const exact = guild.channels.cache.find((channel) => normalizeSearchLabel(channel.name) === needle);
  if (exact) return exact;

  const startsWith = guild.channels.cache.find((channel) => normalizeSearchLabel(channel.name).startsWith(needle));
  if (startsWith) return startsWith;

  const includes = guild.channels.cache.find((channel) => normalizeSearchLabel(channel.name).includes(needle));
  return includes || null;
}

async function resolveActionCategory(guild, ref) {
  const channel = await resolveActionChannel(guild, ref);
  if (!channel) return null;
  if (isCategoryChannel(channel)) return channel;
  return null;
}

async function resolveActionRole(guild, ref) {
  const raw = String(ref || "").trim();
  if (!raw) return null;
  if (/^@?everyone$/i.test(raw)) return guild.roles.everyone;

  const id = actionTargetIdFromRef(raw, "role");
  if (id) {
    const byId = guild.roles.cache.get(id) || (await guild.roles.fetch(id).catch(() => null));
    if (byId) return byId;
  }

  const needle = normalizeSearchLabel(raw);
  if (!needle) return null;

  const exact = guild.roles.cache.find((role) => normalizeSearchLabel(role.name) === needle);
  if (exact) return exact;

  const startsWith = guild.roles.cache.find((role) => normalizeSearchLabel(role.name).startsWith(needle));
  if (startsWith) return startsWith;

  const includes = guild.roles.cache.find((role) => normalizeSearchLabel(role.name).includes(needle));
  return includes || null;
}

async function resolveActionMember(guild, ref) {
  const raw = String(ref || "").trim();
  if (!raw) return null;

  const id = actionTargetIdFromRef(raw, "member");
  if (id) {
    const byId = guild.members.cache.get(id) || (await guild.members.fetch(id).catch(() => null));
    if (byId) return byId;
  }

  const needle = normalizeSearchLabel(raw);
  if (!needle) return null;

  const exact = guild.members.cache.find((member) => {
    const candidates = [
      member.displayName,
      member.user?.username,
      member.user?.tag,
      `${member.user?.username || ""}#${member.user?.discriminator || ""}`,
    ];
    return candidates.some((value) => normalizeSearchLabel(value) === needle);
  });
  if (exact) return exact;

  const startsWith = guild.members.cache.find((member) => {
    const candidates = [member.displayName, member.user?.username, member.user?.tag];
    return candidates.some((value) => normalizeSearchLabel(value).startsWith(needle));
  });
  if (startsWith) return startsWith;

  const includes = guild.members.cache.find((member) => {
    const candidates = [member.displayName, member.user?.username, member.user?.tag];
    return candidates.some((value) => normalizeSearchLabel(value).includes(needle));
  });
  return includes || null;
}

async function resolveAeonPermissionTarget(guild, ref) {
  const raw = String(ref || "").trim();
  if (!raw) return null;
  if (/^@?everyone$/i.test(raw)) {
    return { type: "role", id: guild.roles.everyone.id, mention: guild.roles.everyone.toString(), entity: guild.roles.everyone };
  }

  const role = await resolveActionRole(guild, raw);
  if (role) return { type: "role", id: role.id, mention: role.toString(), entity: role };

  const member = await resolveActionMember(guild, raw);
  if (member) return { type: "member", id: member.id, mention: member.toString(), entity: member };

  return null;
}

function normalizeHexColor(input) {
  let value = String(input || "").trim();
  if (!value) return "";
  if (!value.startsWith("#")) value = `#${value}`;
  if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) return "";
  return value.toUpperCase();
}

function actionPermLabelsForActions(actions = []) {
  const labels = new Set();
  const seen = new Set();
  for (const action of actions) {
    const type = normalizeAeonActionType(action?.type);
    if (!type) continue;
    const required = Array.isArray(AEON_ACTION_REQUIRED_PERMS[type]) ? AEON_ACTION_REQUIRED_PERMS[type] : [];
    for (const perm of required) {
      if (!perm || seen.has(perm)) continue;
      seen.add(perm);
      labels.add(AEON_ACTION_PERMISSION_LABELS.get(perm) || "Unknown Permission");
    }
  }
  return [...labels];
}

function validateAeonPlanAgainstPolicy(plan, policy) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const allow = new Set(normalizeAeonActionTypeList(policy?.allowedActions || []));
  const blocked = [];
  const allowed = [];
  for (const action of actions) {
    const type = normalizeAeonActionType(action?.type);
    if (!type) continue;
    if (!allow.has(type)) {
      blocked.push(type);
      continue;
    }
    allowed.push(action);
  }

  const warnings = [];
  if (actions.length > Number(policy?.maxActionsPerRun || 8)) {
    warnings.push(`Action count (${actions.length}) exceeds policy max (${policy.maxActionsPerRun}).`);
  }
  if (blocked.length) {
    const names = [...new Set(blocked)].map((type) => aeonActionTypeLabel(type));
    warnings.push(`Blocked by policy: ${names.join(", ")}.`);
  }

  return {
    ok:
      policy?.enabled !== false &&
      actions.length > 0 &&
      blocked.length === 0 &&
      actions.length <= Number(policy?.maxActionsPerRun || 8),
    actions: allowed,
    warnings,
    blockedTypes: [...new Set(blocked)],
  };
}

function buildAeonActionPlanDescription(plan) {
  const lines = [];
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const trimmed = actions.slice(0, 12);
  for (let i = 0; i < trimmed.length; i += 1) {
    lines.push(`${i + 1}. ${humanizeAeonAction(trimmed[i])}`);
  }
  if (actions.length > trimmed.length) {
    lines.push(`+${actions.length - trimmed.length} more action(s)`);
  }
  return lines.join("\n") || "No actions.";
}

function buildAeonActionPlanEmbed(plan, actor = null, mode = "preview", note = "") {
  const risk = String(plan?.risk || "low").toLowerCase();
  const color = resolveAeonActionRiskColor(risk);
  const fields = [
    { name: "Plan ID", value: `\`${plan.id}\``, inline: true },
    { name: "Risk", value: risk.charAt(0).toUpperCase() + risk.slice(1), inline: true },
    { name: "Actions", value: `${Array.isArray(plan.actions) ? plan.actions.length : 0}`, inline: true },
    { name: "Execution", value: mode === "dry_run" ? "Dry Run" : mode === "executed" ? "Executed" : "Pending Approval", inline: true },
  ];
  if (note) {
    fields.push({ name: "Note", value: shorten(note, 900), inline: false });
  }
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings.filter(Boolean) : [];
  if (warnings.length) {
    fields.push({
      name: "Warnings",
      value: shorten(warnings.map((item, idx) => `${idx + 1}. ${item}`).join("\n"), 1000),
      inline: false,
    });
  }
  fields.push({
    name: "Planned Actions",
    value: shorten(buildAeonActionPlanDescription(plan), 1000),
    inline: false,
  });

  const embed = makeEmbed(
    "AEON AI Action Plan",
    shorten(String(plan?.request || "No request."), 1800),
    color,
    fields,
  );
  if (actor) {
    const icon = typeof actor.displayAvatarURL === "function" ? actor.displayAvatarURL({ dynamic: true }) : null;
    setEmbedAuthorSafe(embed, `Requested by ${actor.tag || actor.username || "Unknown"}`, icon);
  }
  setEmbedFooterSafe(embed, "Review carefully before approval.");
  return embed;
}

function buildAeonActionResultEmbed(runResult, actor = null, title = "AEON AI Action Result") {
  const success = runResult?.ok === true;
  const fields = [
    { name: "Run ID", value: `\`${runResult.runId || "unknown"}\``, inline: true },
    { name: "Plan ID", value: runResult.planId ? `\`${runResult.planId}\`` : "None", inline: true },
    { name: "Status", value: success ? "Success" : runResult?.dryRun ? "Dry Run" : "Failed", inline: true },
    { name: "Actions", value: `${Array.isArray(runResult?.results) ? runResult.results.length : 0}`, inline: true },
  ];
  if (runResult?.rolledBack) {
    fields.push({ name: "Rollback", value: "Applied", inline: true });
  } else if (runResult?.dryRun) {
    fields.push({ name: "Rollback", value: "Not required", inline: true });
  }
  const lines = (Array.isArray(runResult?.results) ? runResult.results : [])
    .map((item, idx) => `${idx + 1}. ${item.success ? "OK" : "FAIL"} | ${item.summary || item.type || "Action"}`)
    .slice(0, 16);
  if (lines.length) {
    fields.push({ name: "Execution Summary", value: shorten(lines.join("\n"), 1000), inline: false });
  }
  const errors = (Array.isArray(runResult?.results) ? runResult.results : [])
    .filter((item) => item && item.success === false && item.message)
    .map((item) => item.message);
  if (errors.length) {
    fields.push({ name: "Errors", value: shorten(errors.slice(0, 4).join("\n"), 1000), inline: false });
  }

  const embed = makeEmbed(
    title,
    shorten(String(runResult?.request || "No request."), 1700),
    success ? COLORS.SUCCESS : runResult?.dryRun ? COLORS.INFO : COLORS.ERROR,
    fields,
  );
  if (actor) {
    const icon = typeof actor.displayAvatarURL === "function" ? actor.displayAvatarURL({ dynamic: true }) : null;
    setEmbedAuthorSafe(embed, `${actor.tag || actor.username || "User"}`, icon);
  }
  setEmbedFooterSafe(embed, runResult?.dryRun ? "Dry run only, no changes were made." : "AEON AI action executor");
  return embed;
}

function buildAeonActionPlanComponents(ownerId, planId, disabled = false) {
  const row = new ActionRowClass().addComponents(
    createNavButton(`aeonaction:plan:${ownerId}:${planId}:approve`, "Approve", "SUCCESS", disabled),
    createNavButton(`aeonaction:plan:${ownerId}:${planId}:dryrun`, "Dry Run", "SECONDARY", disabled),
    createNavButton(`aeonaction:plan:${ownerId}:${planId}:deny`, "Cancel", "DANGER", disabled),
  );
  return [row];
}

function actionPermPayload(flag) {
  return {
    flag,
    label: AEON_ACTION_PERMISSION_LABELS.get(flag) || "Unknown Permission",
  };
}

function requiredPermPayloadsForActions(actions = []) {
  const out = [];
  const seen = new Set();
  for (const action of actions) {
    const type = normalizeAeonActionType(action?.type);
    const list = Array.isArray(AEON_ACTION_REQUIRED_PERMS[type]) ? AEON_ACTION_REQUIRED_PERMS[type] : [];
    for (const flag of list) {
      if (!flag || seen.has(flag)) continue;
      seen.add(flag);
      out.push(actionPermPayload(flag));
    }
  }
  return out;
}

function checkAeonActionPermissionBaseline(member, botMember, actions) {
  const required = requiredPermPayloadsForActions(actions);
  const missingMember = [];
  const missingBot = [];
  for (const perm of required) {
    const memberHas = typeof member?.permissions?.has === "function" ? member.permissions.has(perm.flag) : false;
    const botHas = typeof botMember?.permissions?.has === "function" ? botMember.permissions.has(perm.flag) : false;
    if (!memberHas) missingMember.push(perm.label);
    if (!botHas) missingBot.push(perm.label);
  }
  return {
    ok: missingMember.length === 0 && missingBot.length === 0,
    missingMember,
    missingBot,
  };
}

function roleIsEditableByContext(guild, actorMember, botMember, role) {
  if (!guild || !actorMember || !botMember || !role) {
    return { ok: false, reason: "Role context is invalid." };
  }
  if (role.id === guild.roles.everyone.id) {
    return { ok: false, reason: "Cannot edit @everyone role with AI action executor." };
  }
  if (role.managed) {
    return { ok: false, reason: "Cannot edit managed/integration roles." };
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    return { ok: false, reason: "Bot role hierarchy is below the target role." };
  }
  if (!canManageRoleByHierarchy(actorMember, role, guild.ownerId)) {
    return { ok: false, reason: "Your role hierarchy is below the target role." };
  }
  return { ok: true };
}

function memberIsEditableByContext(guild, actorMember, botMember, member) {
  if (!guild || !actorMember || !botMember || !member) return { ok: false, reason: "Member context is invalid." };
  if (member.id === guild.ownerId) return { ok: false, reason: "Cannot target the server owner." };
  if (member.id === botMember.id) return { ok: false, reason: "Cannot target the bot account." };
  if (
    actorMember.id !== guild.ownerId &&
    actorMember.roles.highest.comparePositionTo(member.roles.highest) <= 0
  ) {
    return { ok: false, reason: "Your role hierarchy is below the target member." };
  }
  if (botMember.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return { ok: false, reason: "Bot role hierarchy is below the target member." };
  }
  return { ok: true };
}

function channelKindTypes(kind) {
  const value = String(kind || "text").toLowerCase();
  if (value === "voice") {
    return { modern: ChannelTypes.GuildVoice, legacy: "GUILD_VOICE" };
  }
  if (value === "stage") {
    return { modern: ChannelTypes.GuildStageVoice, legacy: "GUILD_STAGE_VOICE" };
  }
  if (value === "forum") {
    return { modern: ChannelTypes.GuildForum, legacy: "GUILD_FORUM" };
  }
  if (value === "announcement") {
    return { modern: ChannelTypes.GuildAnnouncement, legacy: "GUILD_NEWS" };
  }
  if (value === "category") {
    return { modern: ChannelTypes.GuildCategory, legacy: "GUILD_CATEGORY" };
  }
  return { modern: ChannelTypes.GuildText, legacy: "GUILD_TEXT" };
}

async function createGuildChannelCompat(guild, config) {
  const base = {
    name: config.name,
    type: config.modernType !== undefined ? config.modernType : config.legacyType,
    parent: config.parentId || undefined,
    topic: config.topic || undefined,
    nsfw: config.nsfw === true,
    reason: config.reason || undefined,
    rateLimitPerUser: Number.isFinite(Number(config.rateLimitPerUser))
      ? Math.max(0, Math.min(21600, Number(config.rateLimitPerUser)))
      : undefined,
  };
  try {
    return await guild.channels.create(base);
  } catch (_) {
    return guild.channels.create(config.name, {
      type: config.legacyType || "GUILD_TEXT",
      parent: config.parentId || undefined,
      topic: config.topic || undefined,
      nsfw: config.nsfw === true,
      reason: config.reason || undefined,
      rateLimitPerUser: Number.isFinite(Number(config.rateLimitPerUser))
        ? Math.max(0, Math.min(21600, Number(config.rateLimitPerUser)))
        : undefined,
    });
  }
}

async function createGuildRoleCompat(guild, config) {
  const payload = {
    name: config.name,
    color: config.color || undefined,
    mentionable: config.mentionable === true,
    hoist: config.hoist === true,
    reason: config.reason || undefined,
  };
  try {
    return await guild.roles.create(payload);
  } catch (_) {
    return guild.roles.create({
      data: {
        name: payload.name,
        color: payload.color,
        mentionable: payload.mentionable,
        hoist: payload.hoist,
      },
      reason: payload.reason,
    });
  }
}

function captureOverwriteSnapshot(channel, targetId) {
  const overwrite = channel?.permissionOverwrites?.cache?.get(targetId);
  if (!overwrite) return { hadOverwrite: false, targetId };
  return {
    hadOverwrite: true,
    targetId,
    allow: overwrite.allow?.toArray ? overwrite.allow.toArray() : [],
    deny: overwrite.deny?.toArray ? overwrite.deny.toArray() : [],
    type: overwrite.type || null,
  };
}

async function restoreOverwriteSnapshot(guild, snapshot, reason = "") {
  if (!snapshot?.targetId) return;
  const channel = guild.channels.cache.get(snapshot.channelId) || (await guild.channels.fetch(snapshot.channelId).catch(() => null));
  if (!channel?.permissionOverwrites) return;
  if (!snapshot.hadOverwrite) {
    await channel.permissionOverwrites.delete(snapshot.targetId, reason).catch(() => null);
    return;
  }
  await channel.permissionOverwrites.edit(
    snapshot.targetId,
    {
      ViewChannel: null,
      SendMessages: null,
      Connect: null,
      Speak: null,
      [VIEW_CHANNEL_PERMISSION_KEY]: null,
      [SEND_MESSAGES_PERMISSION_KEY]: null,
      [CONNECT_PERMISSION_KEY]: null,
      [SPEAK_PERMISSION_KEY]: null,
    },
    { reason },
  ).catch(() => null);
  await channel.permissionOverwrites.set(
    [
      ...channel.permissionOverwrites.cache
        .filter((item) => String(item.id) !== String(snapshot.targetId))
        .map((item) => ({
          id: item.id,
          allow: item.allow?.toArray ? item.allow.toArray() : [],
          deny: item.deny?.toArray ? item.deny.toArray() : [],
          type: item.type,
        })),
      {
        id: snapshot.targetId,
        allow: Array.isArray(snapshot.allow) ? snapshot.allow : [],
        deny: Array.isArray(snapshot.deny) ? snapshot.deny : [],
        type: snapshot.type || undefined,
      },
    ],
    reason,
  ).catch(() => null);
}

function makeChannelSnapshot(channel) {
  if (!channel) return null;
  return {
    name: channel.name,
    parentId: channel.parentId || "",
    topic: channel.topic || "",
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: Number(channel.rateLimitPerUser || 0),
    kind: typeof channel.type === "string"
      ? channel.type.includes("VOICE")
        ? channel.type === "GUILD_STAGE_VOICE"
          ? "stage"
          : "voice"
        : channel.type === "GUILD_NEWS"
          ? "announcement"
          : channel.type === "GUILD_FORUM"
            ? "forum"
            : "text"
      : channel.type === ChannelTypes.GuildVoice
        ? "voice"
        : channel.type === ChannelTypes.GuildStageVoice
          ? "stage"
          : channel.type === ChannelTypes.GuildAnnouncement
            ? "announcement"
            : channel.type === ChannelTypes.GuildForum
              ? "forum"
              : "text",
  };
}

function makeRoleSnapshot(role) {
  if (!role) return null;
  return {
    name: role.name,
    color: role.hexColor || "",
    mentionable: Boolean(role.mentionable),
    hoist: Boolean(role.hoist),
  };
}

async function rollbackAeonActionSteps(guild, steps = [], reason = "") {
  const summary = [];
  const list = Array.isArray(steps) ? [...steps].reverse() : [];
  for (const step of list) {
    if (!step || typeof step !== "object") continue;
    try {
      if (step.type === "delete_channel") {
        const channel = guild.channels.cache.get(step.channelId) || (await guild.channels.fetch(step.channelId).catch(() => null));
        if (channel) await channel.delete(reason || "AEON rollback");
        summary.push(`Deleted channel rollback target ${step.channelId}`);
        continue;
      }
      if (step.type === "delete_role") {
        const role = guild.roles.cache.get(step.roleId) || (await guild.roles.fetch(step.roleId).catch(() => null));
        if (role) await role.delete(reason || "AEON rollback");
        summary.push(`Deleted role rollback target ${step.roleId}`);
        continue;
      }
      if (step.type === "restore_channel") {
        const channel = guild.channels.cache.get(step.channelId) || (await guild.channels.fetch(step.channelId).catch(() => null));
        if (!channel) continue;
        if (typeof step.name === "string" && step.name && channel.name !== step.name) {
          await channel.setName(step.name, reason || "AEON rollback").catch(() => null);
        }
        if (step.parentId !== undefined) {
          await channel.setParent(step.parentId || null, { lockPermissions: false, reason: reason || "AEON rollback" }).catch(() => null);
        }
        if (typeof channel.setTopic === "function" && step.topic !== undefined) {
          await channel.setTopic(step.topic || "", reason || "AEON rollback").catch(() => null);
        }
        if (typeof channel.setNSFW === "function" && step.nsfw !== undefined) {
          await channel.setNSFW(Boolean(step.nsfw), reason || "AEON rollback").catch(() => null);
        }
        if (typeof channel.setRateLimitPerUser === "function" && step.rateLimitPerUser !== undefined) {
          await channel
            .setRateLimitPerUser(Math.max(0, Math.min(21600, Number(step.rateLimitPerUser) || 0)), reason || "AEON rollback")
            .catch(() => null);
        }
        summary.push(`Restored channel ${step.channelId}`);
        continue;
      }
      if (step.type === "restore_role") {
        const role = guild.roles.cache.get(step.roleId) || (await guild.roles.fetch(step.roleId).catch(() => null));
        if (!role) continue;
        if (typeof step.name === "string" && step.name && role.name !== step.name) {
          await role.setName(step.name, reason || "AEON rollback").catch(() => null);
        }
        if (typeof step.color === "string" && step.color) {
          await role.setColor(step.color, reason || "AEON rollback").catch(() => null);
        }
        if (typeof step.mentionable === "boolean") {
          await role.setMentionable(step.mentionable, reason || "AEON rollback").catch(() => null);
        }
        if (typeof step.hoist === "boolean") {
          await role.setHoist(step.hoist, reason || "AEON rollback").catch(() => null);
        }
        summary.push(`Restored role ${step.roleId}`);
        continue;
      }
      if (step.type === "restore_overwrite") {
        await restoreOverwriteSnapshot(guild, step, reason || "AEON rollback");
        summary.push(`Restored channel permissions for ${step.targetId}`);
        continue;
      }
      if (step.type === "member_role") {
        const member = guild.members.cache.get(step.memberId) || (await guild.members.fetch(step.memberId).catch(() => null));
        const role = guild.roles.cache.get(step.roleId) || (await guild.roles.fetch(step.roleId).catch(() => null));
        if (!member || !role) continue;
        if (step.add === true) await member.roles.add(role, reason || "AEON rollback").catch(() => null);
        else await member.roles.remove(role, reason || "AEON rollback").catch(() => null);
        summary.push(`Restored member role assignment ${step.roleId}`);
        continue;
      }
      if (step.type === "recreate_channel") {
        const snap = step.snapshot || {};
        if (!snap.name) continue;
        const types = channelKindTypes(snap.kind || "text");
        await createGuildChannelCompat(guild, {
          name: snap.name,
          modernType: types.modern,
          legacyType: types.legacy,
          parentId: snap.parentId || "",
          topic: snap.topic || "",
          nsfw: snap.nsfw === true,
          rateLimitPerUser: Number(snap.rateLimitPerUser || 0),
          reason: reason || "AEON rollback",
        }).catch(() => null);
        summary.push(`Recreated deleted channel "${snap.name}"`);
        continue;
      }
      if (step.type === "recreate_role") {
        const snap = step.snapshot || {};
        if (!snap.name) continue;
        await createGuildRoleCompat(guild, {
          name: snap.name,
          color: snap.color || "",
          mentionable: snap.mentionable === true,
          hoist: snap.hoist === true,
          reason: reason || "AEON rollback",
        }).catch(() => null);
        summary.push(`Recreated deleted role "${snap.name}"`);
      }
    } catch (_) {
      // best-effort rollback
    }
  }
  return summary;
}

function channelPermissionUpdateForAccess(channel, allow) {
  const grant = allow === true;
  const updates = {};
  updates[VIEW_CHANNEL_PERMISSION_KEY] = grant ? true : false;
  if (isTextChannel(channel)) {
    updates[SEND_MESSAGES_PERMISSION_KEY] = grant ? true : false;
  }
  if (isVoiceChannel(channel) || String(channel?.type || "").includes("STAGE")) {
    updates[CONNECT_PERMISSION_KEY] = grant ? true : false;
    updates[SPEAK_PERMISSION_KEY] = grant ? true : false;
  }
  return updates;
}

async function executeAeonActionStep(action, context) {
  const type = normalizeAeonActionType(action?.type);
  const args = action?.args || {};
  const { guild, actorMember, botMember, actorUser, defaultChannel, dryRun } = context;
  const reason = `AEON AI action by ${actorUser?.tag || actorUser?.id || "unknown"} (${actorUser?.id || "unknown"})`;

  const okResult = (summary, rollbackStep = null, message = "") => ({
    type,
    success: true,
    summary,
    message,
    rollbackStep,
  });
  const failResult = (summary, message) => ({
    type,
    success: false,
    summary,
    message,
    rollbackStep: null,
  });

  if (type === "create_category") {
    const name = shorten(String(args.name || "").trim(), 100);
    if (!name) return failResult("Create category", "Category name is required.");
    if (dryRun) return okResult(`Would create category "${name}".`);
    const types = channelKindTypes("category");
    const channel = await createGuildChannelCompat(guild, {
      name,
      modernType: types.modern,
      legacyType: types.legacy,
      reason,
    });
    return okResult(`Created category ${channel}.`, { type: "delete_channel", channelId: channel.id });
  }

  if (type === "create_channel") {
    const name = shorten(String(args.name || "").trim(), 100);
    if (!name) return failResult("Create channel", "Channel name is required.");
    const kind = String(args.kind || "text").toLowerCase();
    const category = args.categoryRef ? await resolveActionCategory(guild, args.categoryRef) : null;
    if (args.categoryRef && !category) {
      return failResult("Create channel", `Category not found: ${args.categoryRef}`);
    }
    const topic = String(args.topic || "").trim();
    if (dryRun) {
      return okResult(
        `Would create ${kind} channel "${name}"${category ? ` under ${category}` : ""}.`,
      );
    }
    const types = channelKindTypes(kind);
    const channel = await createGuildChannelCompat(guild, {
      name,
      modernType: types.modern,
      legacyType: types.legacy,
      parentId: category?.id || "",
      topic,
      reason,
    });
    return okResult(
      `Created channel ${channel}.`,
      { type: "delete_channel", channelId: channel.id },
    );
  }

  if (type === "delete_channel") {
    const channel = await resolveActionChannel(guild, args.channelRef, null);
    if (!channel) return failResult("Delete channel", `Channel not found: ${args.channelRef || "unknown"}`);
    if (isCategoryChannel(channel)) return failResult("Delete channel", "Deleting categories is blocked by safety guardrail.");
    const snapshot = makeChannelSnapshot(channel);
    if (dryRun) return okResult(`Would delete channel ${channel}.`);
    await channel.delete(reason);
    return okResult(`Deleted channel ${channel.name}.`, {
      type: "recreate_channel",
      snapshot,
    });
  }

  if (type === "rename_channel") {
    const channel = await resolveActionChannel(guild, args.channelRef, defaultChannel);
    if (!channel) return failResult("Rename channel", `Channel not found: ${args.channelRef || "current channel"}`);
    const newName = shorten(String(args.newName || "").trim().replace(/^#/, ""), 100);
    if (!newName) return failResult("Rename channel", "New channel name is required.");
    const oldName = channel.name;
    if (oldName === newName) return okResult(`No change for ${channel}.`);
    if (dryRun) return okResult(`Would rename ${channel} to "${newName}".`);
    await channel.setName(newName, reason);
    return okResult(`Renamed channel to ${channel}.`, {
      type: "restore_channel",
      channelId: channel.id,
      name: oldName,
    });
  }

  if (type === "move_channel_category") {
    const channel = await resolveActionChannel(guild, args.channelRef, null);
    if (!channel) return failResult("Move channel", `Channel not found: ${args.channelRef || "unknown"}`);
    const category = await resolveActionCategory(guild, args.categoryRef);
    if (!category) return failResult("Move channel", `Category not found: ${args.categoryRef || "unknown"}`);
    const oldParentId = channel.parentId || "";
    if (oldParentId === category.id) return okResult(`No change for ${channel}.`);
    if (dryRun) return okResult(`Would move ${channel} under ${category}.`);
    await channel.setParent(category.id, { lockPermissions: false, reason });
    return okResult(`Moved ${channel} under ${category}.`, {
      type: "restore_channel",
      channelId: channel.id,
      parentId: oldParentId,
    });
  }

  if (type === "set_channel_topic") {
    const channel = await resolveActionChannel(guild, args.channelRef, defaultChannel);
    if (!channel) return failResult("Set topic", `Channel not found: ${args.channelRef || "current channel"}`);
    if (typeof channel.setTopic !== "function") return failResult("Set topic", "This channel type does not support topics.");
    const topic = shorten(String(args.topic || "").trim(), 1024);
    const before = String(channel.topic || "");
    if (before === topic) return okResult(`No topic change for ${channel}.`);
    if (dryRun) return okResult(`Would update topic for ${channel}.`);
    await channel.setTopic(topic, reason);
    return okResult(`Updated topic for ${channel}.`, {
      type: "restore_channel",
      channelId: channel.id,
      topic: before,
    });
  }

  if (type === "set_channel_nsfw") {
    const channel = await resolveActionChannel(guild, args.channelRef, defaultChannel);
    if (!channel) return failResult("Set NSFW", `Channel not found: ${args.channelRef || "current channel"}`);
    if (typeof channel.setNSFW !== "function") return failResult("Set NSFW", "This channel type does not support NSFW.");
    const value = args.value === true;
    const before = Boolean(channel.nsfw);
    if (before === value) return okResult(`No NSFW change for ${channel}.`);
    if (dryRun) return okResult(`Would set NSFW ${value ? "on" : "off"} for ${channel}.`);
    await channel.setNSFW(value, reason);
    return okResult(`Set NSFW ${value ? "on" : "off"} for ${channel}.`, {
      type: "restore_channel",
      channelId: channel.id,
      nsfw: before,
    });
  }

  if (type === "set_channel_slowmode") {
    const channel = await resolveActionChannel(guild, args.channelRef, defaultChannel);
    if (!channel) return failResult("Set slowmode", `Channel not found: ${args.channelRef || "current channel"}`);
    if (typeof channel.setRateLimitPerUser !== "function") return failResult("Set slowmode", "This channel type does not support slowmode.");
    const seconds = Math.max(0, Math.min(21600, Number(args.seconds || 0)));
    const before = Number(channel.rateLimitPerUser || 0);
    if (before === seconds) return okResult(`No slowmode change for ${channel}.`);
    if (dryRun) return okResult(`Would set slowmode of ${channel} to ${seconds}s.`);
    await channel.setRateLimitPerUser(seconds, reason);
    return okResult(`Set slowmode of ${channel} to ${seconds}s.`, {
      type: "restore_channel",
      channelId: channel.id,
      rateLimitPerUser: before,
    });
  }

  if (type === "lock_channel" || type === "unlock_channel") {
    const channel = await resolveActionChannel(guild, args.channelRef, defaultChannel);
    if (!channel) return failResult(type === "lock_channel" ? "Lock channel" : "Unlock channel", "Channel not found.");
    const everyone = guild.roles.everyone;
    const snapshot = captureOverwriteSnapshot(channel, everyone.id);
    snapshot.channelId = channel.id;
    const lock = type === "lock_channel";
    const updates = {};
    updates[SEND_MESSAGES_PERMISSION_KEY] = lock ? false : null;
    updates[CONNECT_PERMISSION_KEY] = lock ? false : null;
    if (dryRun) return okResult(`Would ${lock ? "lock" : "unlock"} ${channel}.`);
    await channel.permissionOverwrites.edit(everyone.id, updates, { reason });
    return okResult(`${lock ? "Locked" : "Unlocked"} ${channel}.`, {
      ...snapshot,
      type: "restore_overwrite",
    });
  }

  if (type === "create_role") {
    const name = shorten(String(args.name || "").trim(), 100);
    if (!name) return failResult("Create role", "Role name is required.");
    const color = normalizeHexColor(args.color || "");
    const mentionable = args.mentionable === true;
    const hoist = args.hoist === true;
    if (dryRun) return okResult(`Would create role "${name}".`);
    const role = await createGuildRoleCompat(guild, {
      name,
      color,
      mentionable,
      hoist,
      reason,
    });
    return okResult(`Created role ${role}.`, { type: "delete_role", roleId: role.id });
  }

  if (type === "delete_role") {
    const role = await resolveActionRole(guild, args.roleRef);
    if (!role) return failResult("Delete role", `Role not found: ${args.roleRef || "unknown"}`);
    const editable = roleIsEditableByContext(guild, actorMember, botMember, role);
    if (!editable.ok) return failResult("Delete role", editable.reason);
    const snapshot = makeRoleSnapshot(role);
    if (dryRun) return okResult(`Would delete role ${role}.`);
    await role.delete(reason);
    return okResult(`Deleted role ${role.name}.`, { type: "recreate_role", snapshot });
  }

  if (type === "rename_role" || type === "set_role_color" || type === "set_role_mentionable" || type === "set_role_hoist") {
    const role = await resolveActionRole(guild, args.roleRef);
    if (!role) return failResult("Update role", `Role not found: ${args.roleRef || "unknown"}`);
    const editable = roleIsEditableByContext(guild, actorMember, botMember, role);
    if (!editable.ok) return failResult("Update role", editable.reason);

    if (type === "rename_role") {
      const newName = shorten(String(args.newName || "").trim(), 100);
      if (!newName) return failResult("Rename role", "New role name is required.");
      if (role.name === newName) return okResult(`No change for ${role}.`);
      if (dryRun) return okResult(`Would rename ${role} to "${newName}".`);
      const snapshot = makeRoleSnapshot(role);
      await role.setName(newName, reason);
      return okResult(`Renamed role to ${role.name}.`, { type: "restore_role", roleId: role.id, ...snapshot });
    }

    if (type === "set_role_color") {
      const color = normalizeHexColor(args.color || "");
      if (!color) return failResult("Set role color", "Valid color is required (example: #5A8DEE).");
      const snapshot = makeRoleSnapshot(role);
      if ((role.hexColor || "").toUpperCase() === color.toUpperCase()) return okResult(`No color change for ${role}.`);
      if (dryRun) return okResult(`Would set color of ${role} to ${color}.`);
      await role.setColor(color, reason);
      return okResult(`Set color of ${role} to ${color}.`, { type: "restore_role", roleId: role.id, ...snapshot });
    }

    if (type === "set_role_mentionable") {
      const value = args.value === true;
      if (role.mentionable === value) return okResult(`No mentionable change for ${role}.`);
      const snapshot = makeRoleSnapshot(role);
      if (dryRun) return okResult(`Would set mentionable ${value ? "on" : "off"} for ${role}.`);
      await role.setMentionable(value, reason);
      return okResult(`Set mentionable ${value ? "on" : "off"} for ${role}.`, { type: "restore_role", roleId: role.id, ...snapshot });
    }

    if (type === "set_role_hoist") {
      const value = args.value === true;
      if (role.hoist === value) return okResult(`No hoist change for ${role}.`);
      const snapshot = makeRoleSnapshot(role);
      if (dryRun) return okResult(`Would set hoist ${value ? "on" : "off"} for ${role}.`);
      await role.setHoist(value, reason);
      return okResult(`Set hoist ${value ? "on" : "off"} for ${role}.`, { type: "restore_role", roleId: role.id, ...snapshot });
    }
  }

  if (type === "add_role_to_member" || type === "remove_role_from_member") {
    const role = await resolveActionRole(guild, args.roleRef);
    if (!role) return failResult("Member role update", `Role not found: ${args.roleRef || "unknown"}`);
    const member = await resolveActionMember(guild, args.memberRef);
    if (!member) return failResult("Member role update", `Member not found: ${args.memberRef || "unknown"}`);
    const roleEditable = roleIsEditableByContext(guild, actorMember, botMember, role);
    if (!roleEditable.ok) return failResult("Member role update", roleEditable.reason);
    const memberEditable = memberIsEditableByContext(guild, actorMember, botMember, member);
    if (!memberEditable.ok) return failResult("Member role update", memberEditable.reason);

    const shouldAdd = type === "add_role_to_member";
    const hasRole = member.roles.cache.has(role.id);
    if (shouldAdd && hasRole) return okResult(`${member} already has ${role}.`);
    if (!shouldAdd && !hasRole) return okResult(`${member} does not have ${role}.`);
    if (dryRun) return okResult(`Would ${shouldAdd ? "add" : "remove"} ${role} ${shouldAdd ? "to" : "from"} ${member}.`);

    if (shouldAdd) await member.roles.add(role, reason);
    else await member.roles.remove(role, reason);
    return okResult(
      `${shouldAdd ? "Added" : "Removed"} ${role} ${shouldAdd ? "to" : "from"} ${member}.`,
      { type: "member_role", memberId: member.id, roleId: role.id, add: !shouldAdd },
    );
  }

  if (type === "grant_channel_access" || type === "revoke_channel_access") {
    const channel = await resolveActionChannel(guild, args.channelRef, defaultChannel);
    if (!channel) return failResult("Channel access", `Channel not found: ${args.channelRef || "current channel"}`);
    const target = await resolveAeonPermissionTarget(guild, args.targetRef);
    if (!target) return failResult("Channel access", `Target not found: ${args.targetRef || "unknown"}`);
    if (target.type === "role" && target.entity) {
      const editable = roleIsEditableByContext(guild, actorMember, botMember, target.entity);
      if (!editable.ok && target.id !== guild.roles.everyone.id) return failResult("Channel access", editable.reason);
    }
    const snapshot = captureOverwriteSnapshot(channel, target.id);
    snapshot.channelId = channel.id;
    const allow = type === "grant_channel_access";
    const updates = channelPermissionUpdateForAccess(channel, allow);
    if (dryRun) return okResult(`Would ${allow ? "grant" : "revoke"} access for ${target.mention} in ${channel}.`);
    await channel.permissionOverwrites.edit(target.id, updates, { reason });
    return okResult(
      `${allow ? "Granted" : "Revoked"} access for ${target.mention} in ${channel}.`,
      { ...snapshot, type: "restore_overwrite" },
    );
  }

  return failResult("Unknown action", `Unsupported action type: ${type || "unknown"}`);
}

async function executeAeonActionPlan(plan, context) {
  const runId = makeAeonRunId();
  const startedAt = new Date().toISOString();
  const dryRun = context?.dryRun === true;
  const results = [];
  const rollbackSteps = [];
  let ok = true;
  let rolledBack = false;

  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  for (const action of actions) {
    const result = await executeAeonActionStep(action, context).catch((error) => ({
      type: normalizeAeonActionType(action?.type),
      success: false,
      summary: humanizeAeonAction(action),
      message: shorten(error?.message || "Execution failed.", 500),
      rollbackStep: null,
    }));
    results.push(result);
    if (result.success && !dryRun && result.rollbackStep) {
      rollbackSteps.push(result.rollbackStep);
    }
    if (!result.success) {
      ok = false;
      break;
    }
  }

  if (!ok && !dryRun && rollbackSteps.length) {
    await rollbackAeonActionSteps(
      context.guild,
      rollbackSteps,
      `AEON rollback after failed run ${runId}`,
    ).catch(() => null);
    rolledBack = true;
  }

  const finishedAt = new Date().toISOString();
  return {
    runId,
    planId: plan?.id || "",
    request: plan?.request || "",
    dryRun,
    ok: ok && (dryRun || !rolledBack || results.every((item) => item.success)),
    rolledBack,
    startedAt,
    finishedAt,
    results,
    rollbackSteps,
  };
}

function createAeonActionPlanObject(guild, ownerId, request, options = {}) {
  const parsed = parseAeonActionRequest(request);
  const policy = getGuildAeonActionPolicy(guild.id);
  const policyCheck = validateAeonPlanAgainstPolicy(parsed, policy);
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const planId = makeAeonActionPlanId();
  const warnings = [...(parsed.warnings || []), ...(policyCheck.warnings || [])];
  const actions = policyCheck.actions || [];
  const risk = parsed.risk || "low";
  return {
    id: planId,
    guildId: guild.id,
    ownerId,
    request: shorten(String(request || "").trim(), AEON_ACTION_REQUEST_MAX),
    source: String(options.source || "manual"),
    workflowName: String(options.workflowName || ""),
    dryRunRequested: options.dryRun === true,
    risk,
    policy,
    policyCheck,
    actions,
    unsupportedClauses: parsed.unsupportedClauses || [],
    warnings,
    createdAt: nowIso,
    createdAtMs: nowMs,
  };
}

function formatAeonActionAuditLine(entry, index) {
  const status = String(entry?.status || "unknown").toUpperCase();
  const risk = String(entry?.risk || "low");
  const when = entry?.createdAt ? `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:R>` : "unknown time";
  const plan = entry?.planId ? ` | plan \`${entry.planId}\`` : "";
  return `${index + 1}. \`${status}\` | ${risk} | ${when}${plan}\n${shorten(entry?.summary || entry?.request || "No summary", 130)}`;
}

function buildAeonActionHistoryEmbed(guildId, limit = 10) {
  const entries = getGuildAeonActionAudit(guildId, limit);
  if (!entries.length) {
    return makeEmbed("AEON AI Action Audit", "No audit entries found yet.", COLORS.INFO);
  }
  const body = entries.map((entry, index) => formatAeonActionAuditLine(entry, index)).join("\n\n");
  return makeEmbed("AEON AI Action Audit", shorten(body, 3900), COLORS.INFO);
}

async function logAeonActionRun(guild, actorUser, runResult, plan) {
  if (!guild || !runResult) return;
  const fields = [
    { name: "Run ID", value: `\`${runResult.runId}\``, inline: true },
    { name: "Plan ID", value: runResult.planId ? `\`${runResult.planId}\`` : "None", inline: true },
    { name: "Status", value: runResult.ok ? (runResult.dryRun ? "Dry Run" : "Success") : "Failed", inline: true },
    { name: "Risk", value: String(plan?.risk || "low"), inline: true },
  ];
  const summary = (runResult.results || [])
    .map((item, index) => `${index + 1}. ${item.success ? "OK" : "FAIL"} | ${item.summary || item.type || "Action"}`)
    .slice(0, 12)
    .join("\n");
  if (summary) fields.push({ name: "Actions", value: shorten(summary, 950), inline: false });
  if (runResult.rolledBack) fields.push({ name: "Rollback", value: "Applied after failure.", inline: false });
  const embed = makeEmbed(
    "AEON AI Action Execution",
    shorten(runResult.request || plan?.request || "No request.", 1500),
    runResult.ok ? (runResult.dryRun ? COLORS.INFO : COLORS.SUCCESS) : COLORS.ERROR,
    fields,
  );
  if (actorUser) {
    const icon = typeof actorUser.displayAvatarURL === "function" ? actorUser.displayAvatarURL({ dynamic: true }) : null;
    setEmbedAuthorSafe(embed, actorUser.tag || actorUser.username || "Unknown User", icon);
  }
  await sendLog(guild, embed, "moderation");
}

function buildAeonActionPolicyEmbed(policy) {
  const allowed = Array.isArray(policy?.allowedActions) ? policy.allowedActions : [];
  const allowedLabels = allowed.map((type) => aeonActionTypeLabel(type));
  const fields = [
    { name: "Enabled", value: policy.enabled ? "Yes" : "No", inline: true },
    { name: "Approval Required", value: policy.requireApproval ? "Yes" : "No", inline: true },
    { name: "Max Actions / Run", value: `${policy.maxActionsPerRun}`, inline: true },
    {
      name: "Allowed Actions",
      value: allowedLabels.length ? shorten(allowedLabels.join(", "), 1000) : "None",
      inline: false,
    },
  ];
  return makeEmbed("AEON AI Manager Policy", "Current execution guardrails for AI-managed server actions.", COLORS.INFO, fields);
}

function buildAeonActionWorkflowListEmbed(workflows = []) {
  if (!workflows.length) {
    return makeEmbed("AI Workflows", "No workflows saved yet.", COLORS.INFO);
  }
  const lines = workflows
    .slice(0, 25)
    .map((item, index) => `${index + 1}. \`${item.name}\`\n${shorten(item.request, 130)}`)
    .join("\n\n");
  return makeEmbed("AI Workflows", shorten(lines, 3800), COLORS.INFO);
}

async function executePendingAeonActionPlan(plan, interaction, dryRun = false) {
  if (!plan || !interaction?.guild) {
    throw new Error("Plan is unavailable.");
  }
  const guild = interaction.guild;
  const botMember = await getBotMember(guild).catch(() => null);
  if (!botMember) throw new Error("Bot member context unavailable.");

  const member =
    interaction.member?.permissions?.has
      ? interaction.member
      : await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) throw new Error("Could not resolve your member context.");

  const permissionCheck = checkAeonActionPermissionBaseline(member, botMember, plan.actions || []);
  if (!permissionCheck.ok) {
    const chunks = [];
    if (permissionCheck.missingMember.length) {
      chunks.push(`Missing member permissions: ${permissionCheck.missingMember.join(", ")}`);
    }
    if (permissionCheck.missingBot.length) {
      chunks.push(`Missing bot permissions: ${permissionCheck.missingBot.join(", ")}`);
    }
    throw new Error(chunks.join("\n"));
  }

  const runResult = await executeAeonActionPlan(plan, {
    guild,
    actorUser: interaction.user,
    actorMember: member,
    botMember,
    defaultChannel: interaction.channel || null,
    dryRun,
  });

  const summary = (runResult.results || [])
    .map((item, index) => `${index + 1}. ${item.success ? "OK" : "FAIL"} | ${item.summary || item.type || "Action"}`)
    .join("\n");

  const auditEntry = appendGuildAeonActionAudit(guild.id, {
    id: runResult.runId,
    planId: plan.id,
    request: plan.request,
    summary,
    status: runResult.ok ? (dryRun ? "dry_run" : "success") : "failed",
    risk: plan.risk || "low",
    dryRun: dryRun === true,
    createdBy: interaction.user.id,
    createdAt: runResult.startedAt || new Date().toISOString(),
    finishedAt: runResult.finishedAt || new Date().toISOString(),
    actions: runResult.results || [],
    warnings: plan.warnings || [],
    rollbackSteps: runResult.rollbackSteps || [],
    rollbackStatus: runResult.rolledBack ? "auto_rollback_applied" : null,
  });

  await logAeonActionRun(guild, interaction.user, runResult, plan).catch(() => null);
  return { runResult, auditEntry };
}

const MUSIC_COMMANDS = new Set([
  "join",
  "play",
  "queue",
  "skip",
  "pause",
  "resume",
  "stop",
  "disconnect",
  "clear",
  "shuffle",
  "loop",
  "volume",
]);
const MUSIC_AUTOCOMPLETE_COMMANDS = new Set(["play"]);
const MUSIC_COLOR = "#4B5F8C";
const MUSIC_AUTOCOMPLETE_TIMEOUT_MS = 2200;
const MUSIC_SEARCH_TIMEOUT_MS = 7000;
const MUSIC_SUGGEST_TIMEOUT_MS = 1400;
const MUSIC_AUTOCOMPLETE_CACHE_TTL_MS = 60 * 1000;
const MAX_MUSIC_AUTOCOMPLETE_CACHE = 60;
const musicAutocompleteCache = new Map();

function makeMusicEmbed(title, description, color = MUSIC_COLOR, fields = []) {
  return makeEmbed(title, description, color, fields);
}

function truncateAutocompleteText(value, max = 100) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(max - 3, 1)).trim()}...`;
}

function makeAutocompleteChoice(name, value) {
  return {
    name: truncateAutocompleteText(name, 100),
    value: truncateAutocompleteText(value, 100),
  };
}

function formatYtSearchDuration(entry) {
  const durationText = String(entry?.duration_string || "").trim();
  if (durationText) return durationText;

  const seconds = Number(entry?.duration);
  if (Number.isFinite(seconds) && seconds > 0) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return entry?.is_live ? "Live" : "--:--";
}

function resolveYtSearchEntryUrl(entry) {
  const webpage = String(entry?.webpage_url || "").trim();
  if (/^https?:\/\//i.test(webpage)) return webpage;

  const direct = String(entry?.url || "").trim();
  if (/^https?:\/\//i.test(direct)) return direct;

  const id = String(entry?.id || "").trim();
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return "";
}

function withTimeout(task, timeoutMs, fallback = null) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(task);

  let timeoutRef;
  const timer = new Promise((resolve) => {
    timeoutRef = setTimeout(() => resolve(fallback), timeoutMs);
  });

  return Promise.race([
    Promise.resolve(task).finally(() => {
      clearTimeout(timeoutRef);
    }),
    timer,
  ]);
}

function makeYtSearchQuery(raw, limit = 1) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 1));
  return `ytsearch${safeLimit}:${raw}`;
}

function cleanupMusicAutocompleteCache() {
  const now = Date.now();
  for (const [key, value] of musicAutocompleteCache.entries()) {
    if (!value || now - value.ts > MUSIC_AUTOCOMPLETE_CACHE_TTL_MS) {
      musicAutocompleteCache.delete(key);
    }
  }
}

function getCachedMusicAutocompleteChoices(query) {
  const raw = String(query || "").trim().toLowerCase();
  if (!raw) return null;

  cleanupMusicAutocompleteCache();
  const exact = musicAutocompleteCache.get(raw);
  if (exact?.choices?.length) {
    return exact.choices.slice(0, 25);
  }

  let bestPrefix = null;
  for (const [key, value] of musicAutocompleteCache.entries()) {
    if (!value?.choices?.length) continue;
    if (raw.startsWith(key) && (!bestPrefix || key.length > bestPrefix.key.length)) {
      bestPrefix = { key, choices: value.choices };
    }
  }
  if (!bestPrefix) return null;

  const filtered = bestPrefix.choices.filter((choice) => String(choice?.name || "").toLowerCase().includes(raw));
  if (filtered.length) return filtered.slice(0, 25);
  return bestPrefix.choices.slice(0, 25);
}

function setCachedMusicAutocompleteChoices(query, choices) {
  const raw = String(query || "").trim().toLowerCase();
  if (!raw || !Array.isArray(choices) || !choices.length) return;

  cleanupMusicAutocompleteCache();
  if (musicAutocompleteCache.has(raw)) musicAutocompleteCache.delete(raw);
  musicAutocompleteCache.set(raw, { ts: Date.now(), choices: choices.slice(0, 25) });

  if (musicAutocompleteCache.size > MAX_MUSIC_AUTOCOMPLETE_CACHE) {
    const oldestKey = musicAutocompleteCache.keys().next().value;
    if (oldestKey) musicAutocompleteCache.delete(oldestKey);
  }
}

function dedupeAutocompleteChoices(choices) {
  const seen = new Set();
  const deduped = [];
  for (const item of choices) {
    const value = String(item?.value || "").trim();
    if (!value) continue;
    const dedupeKey = value.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(item);
    if (deduped.length >= 25) break;
  }
  return deduped;
}

async function searchYtDlpEntries(rawQuery, limit = 1, timeoutMs = MUSIC_SEARCH_TIMEOUT_MS) {
  const raw = String(rawQuery || "").trim();
  if (!raw) return [];

  const response = await withTimeout(
    ytDlpJson(makeYtSearchQuery(raw, limit), {
      ...YT_DLP_BASE_FLAGS,
    }).catch(() => null),
    timeoutMs,
    null,
  );
  const entries = Array.isArray(response?.entries) ? response.entries.filter(Boolean) : [];
  return entries;
}

async function fetchYouTubeSearchSuggestions(rawQuery, timeoutMs = MUSIC_SUGGEST_TIMEOUT_MS) {
  const raw = String(rawQuery || "").trim();
  if (!raw) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(raw)}`;
    const response = await fetch(url, { signal: controller.signal }).catch(() => null);
    if (!response || !response.ok) return [];

    const payload = await response.json().catch(() => null);
    const items = Array.isArray(payload?.[1]) ? payload[1] : [];
    return items
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, 12)
      .map((item) => makeAutocompleteChoice(item, item));
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveMusicQueryToPlayable(query) {
  const raw = String(query || "").trim();
  if (!raw) return { error: "Query cannot be empty." };

  const normalized = normalizePlayableInput(raw);
  if (normalized !== raw && /^ytsearch\d*:/i.test(normalized)) {
    const entries = await searchYtDlpEntries(raw, 1, MUSIC_SEARCH_TIMEOUT_MS);
    const first = entries[0];
    if (!first) return { error: `Cannot find any song with this query (${raw}).` };
    const url = resolveYtSearchEntryUrl(first);
    if (!url) return { error: `Cannot find any playable song with this query (${raw}).` };

    return {
      raw,
      query: url,
      pickedTitle: String(first?.title || first?.fulltitle || raw),
    };
  }

  return {
    raw,
    query: normalized,
    pickedTitle: raw,
  };
}

async function buildMusicAutocompleteChoices(query) {
  const raw = String(query || "").trim();
  if (!raw) return [];
  if (raw.length < 2) return [];

  const queryLooksLikeUrl = /^https?:\/\//i.test(raw) || /^ytsearch\d*:/i.test(raw);
  if (queryLooksLikeUrl) {
    return [makeAutocompleteChoice("Use provided link", raw)];
  }

  const cached = getCachedMusicAutocompleteChoices(raw);
  if (cached?.length) return cached;

  const [entries, suggestionChoices] = await Promise.all([
    searchYtDlpEntries(raw, 10, MUSIC_AUTOCOMPLETE_TIMEOUT_MS),
    fetchYouTubeSearchSuggestions(raw, MUSIC_SUGGEST_TIMEOUT_MS),
  ]);

  const trackChoices = entries.map((item) => {
    const title = String(item?.title || item?.fulltitle || item?.name || "Unknown track");
    const duration = formatYtSearchDuration(item);
    const label = `${title} (${duration})`;
    const url = resolveYtSearchEntryUrl(item);
    const value = url && url.length <= 100 ? url : title;
    return makeAutocompleteChoice(label, value);
  });

  const choices = dedupeAutocompleteChoices([...trackChoices, ...suggestionChoices]);
  if (!choices.length) {
    return [makeAutocompleteChoice(`Search "${raw}"`, raw)];
  }

  const ranked = dedupeAutocompleteChoices(
    choices.sort((a, b) => {
      const aStarts = String(a.name || "").toLowerCase().startsWith(raw.toLowerCase()) ? 1 : 0;
      const bStarts = String(b.name || "").toLowerCase().startsWith(raw.toLowerCase()) ? 1 : 0;
      return bStarts - aStarts;
    }),
  );

  if (ranked.length) setCachedMusicAutocompleteChoices(raw, ranked);
  return ranked.length ? ranked : [makeAutocompleteChoice(`Search "${raw}"`, raw)];
}

function isUnknownInteractionError(error) {
  if (!error) return false;
  if (error.code === 10062 || error.errorCode === 10062) return true;
  const message = String(error?.message || error?.rawError?.message || "");
  return /unknown interaction/i.test(message);
}

async function safeAutocompleteRespond(interaction, choices) {
  const payload = Array.isArray(choices) ? choices.slice(0, 25) : [];
  try {
    await interaction.respond(payload);
  } catch (error) {
    if (!isUnknownInteractionError(error)) {
      console.error(`Autocomplete response failed for /${interaction.commandName}:`, error);
    }
  }
}

async function sendMusicResponse(interaction, embed, ephemeral = false) {
  const payload = { embeds: [embed] };
  if (interaction.deferred && !interaction.replied) {
    return interaction.editReply(payload);
  }
  if (interaction.replied) return interaction.followUp(payload);
  if (ephemeral) payload.flags = EPHEMERAL_FLAG;
  return interaction.reply(payload);
}

function parseMusicTimeInput(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return { error: "Time is required." };

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return { error: "Time must be a non-negative number." };
    return { seconds };
  }

  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return { error: "Use seconds, `mm:ss`, or `hh:mm:ss`." };
  }
  if (parts.some((part) => !/^\d+$/.test(part))) {
    return { error: "Time can only contain numbers and colons." };
  }

  const nums = parts.map((part) => Number(part));
  const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
  if (m > 59 || s > 59) return { error: "Minutes and seconds must be between 0 and 59." };

  const seconds = h * 3600 + m * 60 + s;
  if (!Number.isFinite(seconds)) return { error: "Time is too large." };
  return { seconds };
}

function musicSongTitle(song, max = 70) {
  const name = shorten(song?.name || "Unknown track", max);
  return song?.url ? `[${name}](${song.url})` : name;
}

function musicSongDuration(song) {
  return song?.formattedDuration || "Live";
}

function musicModeLabel(mode) {
  if (mode === RepeatMode.SONG) return "Song";
  if (mode === RepeatMode.QUEUE) return "Queue";
  return "Off";
}

function musicSourceFromCommand(interaction, botMember) {
  const queue = distube.getQueue(interaction.guild);
  const userVoice = interaction.member?.voice?.channel || null;
  const botVoice = queue?.voiceChannel || botMember?.voice?.channel || null;
  return { queue, userVoice, botVoice };
}

function buildQueuePage(queue, page = 1, pageSize = 8) {
  const current = queue?.songs?.[0];
  const upcoming = Array.isArray(queue?.songs) ? queue.songs.slice(1) : [];
  const totalPages = Math.max(1, Math.ceil(Math.max(upcoming.length, 1) / pageSize));
  const safePage = Math.max(1, Math.min(totalPages, page));
  const offset = (safePage - 1) * pageSize;
  const pageItems = upcoming.slice(offset, offset + pageSize);

  const lines = [];
  if (current) {
    lines.push(`Now: ${musicSongTitle(current, 65)} \`${musicSongDuration(current)}\``);
    lines.push("");
  }

  if (!pageItems.length) {
    lines.push("No upcoming songs.");
  } else {
    for (let i = 0; i < pageItems.length; i += 1) {
      const item = pageItems[i];
      const absolutePosition = offset + i + 1;
      lines.push(`${absolutePosition}. ${musicSongTitle(item, 65)} \`${musicSongDuration(item)}\``);
    }
  }

  return {
    description: lines.join("\n"),
    page: safePage,
    totalPages,
    upcomingTotal: upcoming.length,
  };
}

function parseReactionRoleEmoji(raw) {
  const value = String(raw || "").trim();
  if (!value) return { error: "Emoji cannot be empty." };

  const custom = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/.exec(value);
  if (custom) {
    return {
      emoji: {
        kind: "custom",
        id: custom[3],
        name: custom[2],
        animated: custom[1] === "a",
        text: value,
      },
    };
  }

  const customShort = /^:([A-Za-z0-9_]{2,32}):$/.exec(value);
  if (customShort) {
    return {
      emoji: {
        kind: "custom_name",
        name: customShort[1],
        text: value,
      },
    };
  }

  const customId = /^(\d{17,20})$/.exec(value);
  if (customId) {
    return {
      emoji: {
        kind: "custom_id",
        id: customId[1],
        text: value,
      },
    };
  }

  if (/\s/.test(value)) {
    return { error: "Emoji must be a single token (example: `?` or `<:name:id>`)." };
  }

  return {
    emoji: {
      kind: "unicode",
      value,
      text: value,
    },
  };
}

async function resolveReactionRoleEmoji(guild, emoji) {
  if (!emoji || typeof emoji !== "object") return { error: "Emoji is invalid." };

  if (emoji.kind === "custom") {
    return {
      emoji: {
        ...emoji,
        text: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`,
      },
    };
  }

  if (emoji.kind === "unicode") {
    return { emoji };
  }

  const findInCache = () => {
    if (!guild?.emojis?.cache) return null;
    if (emoji.kind === "custom_name") {
      const exact = guild.emojis.cache.find((item) => item.name === emoji.name);
      if (exact) return exact;
      const lowered = String(emoji.name || "").toLowerCase();
      return guild.emojis.cache.find((item) => String(item.name || "").toLowerCase() === lowered) || null;
    }
    if (emoji.kind === "custom_id") {
      return guild.emojis.cache.get(emoji.id) || null;
    }
    return null;
  };

  let resolved = findInCache();
  if (!resolved) {
    await guild?.emojis?.fetch?.().catch(() => null);
    resolved = findInCache();
  }

  if (!resolved) {
    return { error: "Custom emoji was not found in this server. Use a server emoji like `<:name:id>`." };
  }

  return {
    emoji: {
      kind: "custom",
      id: resolved.id,
      name: resolved.name,
      animated: Boolean(resolved.animated),
      text: resolved.toString(),
    },
  };
}

function formatReactionRoleEmoji(emoji) {
  if (!emoji || typeof emoji !== "object") return "";
  if (emoji.kind === "custom" && emoji.id && emoji.name) {
    return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
  }
  if (emoji.kind === "unicode") return emoji.value || emoji.text || "";
  return emoji.text || "";
}

function replaceCustomEmojiShortcodes(guild, input) {
  const text = String(input || "");
  if (!text || !guild?.emojis?.cache) return text;
  return text.replace(/:([A-Za-z0-9_]{2,32}):/g, (full, name) => {
    const exact = guild.emojis.cache.find((item) => item.name === name);
    if (exact) return exact.toString();
    const lowered = String(name || "").toLowerCase();
    const match = guild.emojis.cache.find((item) => String(item.name || "").toLowerCase() === lowered);
    return match ? match.toString() : full;
  });
}

function buildReactionRoleComponents(entries) {
  const rows = [];
  if (!entries.length) return rows;

  let row = new ActionRowClass();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const button = new ButtonClass()
      .setCustomId(`rr:toggle:${entry.role.id}`)
      .setLabel(shorten(entry.label, 80))
      .setStyle(resolveButtonStyle("SECONDARY"));

    if (entry.emoji.kind === "custom") {
      button.setEmoji({
        id: entry.emoji.id,
        name: entry.emoji.name,
        animated: entry.emoji.animated,
      });
    } else {
      button.setEmoji(entry.emoji.value);
    }

    row.addComponents(button);
    const atEnd = i === entries.length - 1;
    if ((i + 1) % 5 === 0 || atEnd) {
      rows.push(row);
      if (!atEnd) row = new ActionRowClass();
    }
  }

  return rows;
}

function isTextChannel(channel) {
  if (!channel) return false;
  if (typeof channel.type === "string") {
    return channel.type === "GUILD_TEXT" || channel.type === "GUILD_NEWS";
  }
  return (
    channel.type === ChannelTypes.GuildText ||
    channel.type === ChannelTypes.GuildAnnouncement
  );
}

function isCategoryChannel(channel) {
  if (!channel) return false;
  if (typeof channel.type === "string") return channel.type === "GUILD_CATEGORY";
  return channel.type === ChannelTypes.GuildCategory;
}

function isVoiceChannel(channel) {
  if (!channel) return false;
  if (typeof channel.type === "string") return channel.type === "GUILD_VOICE";
  return channel.type === ChannelTypes.GuildVoice;
}

function shorten(text, max = 900) {
  if (text === null || text === undefined) return "None";
  const normalized = String(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "None";
  return shorten(value, 800);
}

function normalizeComparableLogValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase() === "none") return null;
    return trimmed;
  }
  return value;
}

function pushChange(changes, label, before, after) {
  const normalizedBefore = normalizeComparableLogValue(before);
  const normalizedAfter = normalizeComparableLogValue(after);
  if (normalizedBefore === normalizedAfter) return;
  changes.push({
    name: label,
    value: `Before: ${displayValue(normalizedBefore)}\nAfter: ${displayValue(normalizedAfter)}`,
  });
}

function extractEmbedData(embed) {
  if (!embed) return {};
  const data = embed.data || {};
  return {
    title: data.title || embed.title || "",
    description: data.description || embed.description || "",
    color: data.color ?? embed.color ?? COLORS.INFO,
    author: data.author || embed.author || null,
    footer: data.footer || embed.footer || null,
    fields: data.fields || embed.fields || [],
  };
}

function extractSnowflake(text) {
  const match = String(text || "").match(/\b\d{17,20}\b/);
  return match ? match[0] : null;
}

function extractNameFromUserField(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/^<@!?\d{17,20}>$/.test(raw)) return null;
  const withoutLeadingMention = raw.replace(/^<@!?\d{17,20}>\s*/g, "").trim();
  if (withoutLeadingMention) {
    const nameWithOptionalId = withoutLeadingMention;
    const parenIndex = nameWithOptionalId.lastIndexOf(" (");
    if (parenIndex > 0) return nameWithOptionalId.slice(0, parenIndex).trim();
    return nameWithOptionalId;
  }
  const parenIndex = raw.lastIndexOf(" (");
  if (parenIndex > 0) return raw.slice(0, parenIndex).trim();
  return raw;
}

function normalizeAuthorName(input) {
  let value = String(input || "").trim();
  if (!value) return null;
  value = value.replace(/^<@!?\d{17,20}>\s*/g, "").trim();
  value = value.replace(/\s*\(\d{17,20}\)\s*$/g, "").trim();
  if (!value) return null;
  if (/^<@!?\d{17,20}>$/.test(value)) return null;
  return value;
}

function resolveAuthorNameFromId(guild, userId) {
  if (!userId) return null;

  const member = guild?.members?.cache?.get(userId);
  if (member?.user) return member.user.tag || member.user.username || member.displayName || null;

  const user = client.users?.cache?.get(userId);
  if (user) return user.tag || user.username || null;

  return null;
}

function resolveAuthorIconFromId(guild, userId) {
  if (!userId) return null;

  const member = guild?.members?.cache?.get(userId);
  if (member?.user && typeof member.user.displayAvatarURL === "function") {
    return member.user.displayAvatarURL({ dynamic: true });
  }

  const user = client.users?.cache?.get(userId);
  if (user && typeof user.displayAvatarURL === "function") {
    return user.displayAvatarURL({ dynamic: true });
  }

  return null;
}

function sanitizeLogText(input) {
  let text = String(input || "").trim();
  if (!text) return "";

  text = text.replace(
    /\b(User|Author|Member|Moderator|Action By|By|Inviter|Executor|Target|Target User|Reported User)\s*:\s*([^\n]*?)\((\d{17,20})\)/gi,
    (_, label, __, id) => `${label}: <@${id}>`,
  );
  text = text.replace(/<@!?(\d{17,20})>\s*\(\d{17,20}\)/g, "<@$1>");
  text = text.replace(/(^|\n)\s*(Message ID|Channel ID|Role ID|ID)\s*:\s*\d{17,20}\s*(?=\n|$)/gi, "$1");
  text = text.replace(/\s*\(\d{17,20}\)/g, "");
  text = text.replace(/(?<![<@#&])\b\d{17,20}\b(?!>)/g, "");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function compactLogEmbed(inputEmbed, guild = null) {
  const data = extractEmbedData(inputEmbed);
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const fieldMap = new Map(
    fields
      .filter((field) => field && field.name !== undefined)
      .map((field) => [String(field.name).toLowerCase(), String(field.value || "")]),
  );
  const getField = (name) => fieldMap.get(String(name).toLowerCase());

  let title = String(data.title || "Log");
  let description = String(data.description || "").trim();
  let color = data.color ?? COLORS.INFO;

  const rolesAdded = getField("roles added");
  const rolesRemoved = getField("roles removed");
  if (rolesAdded && !rolesRemoved) {
    title = "Role added";
    description = sanitizeLogText(shorten(rolesAdded, 900));
    color = COLORS.SUCCESS;
  } else if (rolesRemoved && !rolesAdded) {
    title = "Role removed";
    description = sanitizeLogText(shorten(rolesRemoved, 900));
    color = COLORS.ERROR;
  } else if (rolesAdded && rolesRemoved) {
    title = "Roles updated";
    description = sanitizeLogText(`Added: ${shorten(rolesAdded, 450)}\nRemoved: ${shorten(rolesRemoved, 450)}`);
    color = COLORS.INFO;
  }

  const reason = getField("reason");
  if (!description && reason) description = sanitizeLogText(shorten(reason, 900));

  const content = getField("content");
  if (!description && content) description = sanitizeLogText(shorten(content, 900));

  if (!description) {
    const primaryField = fields.find((field) => field && field.value);
    description = primaryField ? sanitizeLogText(shorten(String(primaryField.value), 900)) : "No details.";
  }

  title = sanitizeLogText(title) || "Log";
  description = sanitizeLogText(description) || "No details.";
  const compact = makeEmbed(title, description, color);

  const userField = getField("author") || getField("user") || getField("member") || getField("reported user");
  const userIdFromFields =
    extractSnowflake(userField) ||
    extractSnowflake(getField("moderator")) ||
    extractSnowflake(getField("action by")) ||
    extractSnowflake(getField("inviter")) ||
    extractSnowflake(data.footer?.text || data.footer);
  const authorName =
    normalizeAuthorName(data.author && (data.author.name || data.author.text)) ||
    extractNameFromUserField(userField) ||
    resolveAuthorNameFromId(guild, userIdFromFields) ||
    (userIdFromFields ? "Unknown User" : null);
  const authorIcon =
    (data.author && (data.author.iconURL || data.author.icon_url)) ||
    resolveAuthorIconFromId(guild, userIdFromFields) ||
    null;
  if (authorName) setEmbedAuthorSafe(compact, shorten(authorName, 256), authorIcon);

  return compact;
}

async function getLogChannel(guild) {
  if (!guild) return null;

  const cfg = getGuildLogConfig(guild.id);
  if (cfg.channelId) {
    const configured = guild.channels.cache.get(cfg.channelId);
    if (configured && isTextChannel(configured)) return configured;
  }

  if (LOG_CHANNEL_ID) {
    const explicit = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (explicit && isTextChannel(explicit)) return explicit;
  }

  const fallback = guild.channels.cache.find(
    (channel) => isTextChannel(channel) && LOG_FALLBACK_NAMES.includes(channel.name.toLowerCase()),
  );
  return fallback || null;
}

async function sendLog(guild, embed, eventKey = null) {
  if (!guild) return;
  if (eventKey && !isLogEventEnabled(guild.id, eventKey)) return;

  const channel = await getLogChannel(guild);
  if (!channel) return;

  const botMember =
    guild.members?.me ||
    guild.me ||
    (await guild.members.fetch(client.user.id).catch(() => null));
  if (!botMember) return;

  const channelPerms = channel.permissionsFor(botMember);
  const canSend = channelPerms?.has(Permissions.FLAGS.SEND_MESSAGES);
  if (!canSend) return;

  const canEmbed =
    Permissions.FLAGS.EMBED_LINKS === undefined || channelPerms?.has(Permissions.FLAGS.EMBED_LINKS);
  if (!canEmbed) return;

  const compact = compactLogEmbed(embed, guild);
  await channel.send({ embeds: [compact] }).catch((error) => {
    console.error(`Failed sending log in guild ${guild.id}:`, error);
  });
}

async function logModerationAction(guild, action, fields, color = COLORS.INFO) {
  const embed = makeEmbed(action, "A moderation action was executed.", color, fields);
  await sendLog(guild, embed, "moderation");
}

function channelTypeLabel(channel) {
  if (!channel) return "Unknown";
  const legacyMap = {
    GUILD_TEXT: "Text",
    GUILD_NEWS: "Announcement",
    GUILD_VOICE: "Voice",
    GUILD_STAGE_VOICE: "Stage",
    GUILD_CATEGORY: "Category",
    GUILD_FORUM: "Forum",
    GUILD_PUBLIC_THREAD: "Public Thread",
    GUILD_PRIVATE_THREAD: "Private Thread",
    GUILD_NEWS_THREAD: "News Thread",
  };
  if (typeof channel.type === "string") {
    return legacyMap[channel.type] || channel.type;
  }

  const modernMap = new Map([
    [ChannelTypes.GuildText, "Text"],
    [ChannelTypes.GuildAnnouncement, "Announcement"],
    [ChannelTypes.GuildVoice, "Voice"],
    [ChannelTypes.GuildStageVoice, "Stage"],
    [ChannelTypes.GuildCategory, "Category"],
    [ChannelTypes.GuildForum, "Forum"],
    [ChannelTypes.PublicThread, "Public Thread"],
    [ChannelTypes.PrivateThread, "Private Thread"],
    [ChannelTypes.AnnouncementThread, "News Thread"],
  ]);
  return modernMap.get(channel.type) || `${channel.type}`;
}

function roleMentionsFromIds(ids) {
  if (!ids.length) return "None";
  return ids.map((id) => `<@&${id}>`).join(", ");
}

function toPascalCaseFromUpperSnake(value) {
  return String(value || "")
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function resolveAuditLogType(type) {
  if (typeof type === "number") return type;
  if (typeof type !== "string") return null;
  if (!AuditLogEventSource || typeof AuditLogEventSource !== "object") return type;

  const candidates = [type, toPascalCaseFromUpperSnake(type)];
  for (const key of candidates) {
    if (AuditLogEventSource[key] !== undefined) return AuditLogEventSource[key];
  }
  return type;
}

async function fetchAuditEntry(guild, type, targetId = null, maxAgeMs = 8000) {
  try {
    const resolvedType = resolveAuditLogType(type);
    const logs = await guild.fetchAuditLogs({ type: resolvedType, limit: 6 });
    const entry = logs.entries.find((item) => {
      const created = item.createdTimestamp || 0;
      if (Date.now() - created > maxAgeMs) return false;

      if (!targetId) return true;
      const itemTargetId = item.target?.id || item.extra?.channel?.id || null;
      return itemTargetId && String(itemTargetId) === String(targetId);
    });
    return entry || null;
  } catch (_) {
    return null;
  }
}

async function appendAuditFields(fields, guild, type, targetId = null, maxAgeMs = 8000) {
  const entry = await fetchAuditEntry(guild, type, targetId, maxAgeMs);
  if (!entry) return;

  const actor = entry.executor ? `${entry.executor.tag} (${entry.executor.id})` : "Unknown";
  const reason = entry.reason || "No reason provided.";
  fields.push({ name: "Action By", value: actor, inline: true });
  fields.push({ name: "Reason", value: shorten(reason, 600), inline: true });
}

function overwriteEntityLabel(guild, id) {
  if (guild.roles.cache.has(id)) return `<@&${id}>`;
  return `<@${id}>`;
}

function diffPermissionList(beforeList, afterList) {
  return {
    added: afterList.filter((perm) => !beforeList.includes(perm)),
    removed: beforeList.filter((perm) => !afterList.includes(perm)),
  };
}

function summarizeOverwriteDiffs(oldChannel, newChannel) {
  const oldCache = oldChannel.permissionOverwrites?.cache;
  const newCache = newChannel.permissionOverwrites?.cache;
  if (!oldCache || !newCache) return null;

  const ids = new Set([...oldCache.keys(), ...newCache.keys()]);
  const lines = [];

  for (const id of ids) {
    const before = oldCache.get(id);
    const after = newCache.get(id);
    const label = overwriteEntityLabel(newChannel.guild, id);

    if (!before && after) {
      lines.push(`Added overwrite for ${label}`);
      continue;
    }

    if (before && !after) {
      lines.push(`Removed overwrite for ${label}`);
      continue;
    }

    if (!before || !after) continue;
    const allow = diffPermissionList(before.allow.toArray(), after.allow.toArray());
    const deny = diffPermissionList(before.deny.toArray(), after.deny.toArray());

    if (!allow.added.length && !allow.removed.length && !deny.added.length && !deny.removed.length) {
      continue;
    }

    const parts = [];
    if (allow.added.length) parts.push(`Allow+ ${allow.added.join(", ")}`);
    if (allow.removed.length) parts.push(`Allow- ${allow.removed.join(", ")}`);
    if (deny.added.length) parts.push(`Deny+ ${deny.added.join(", ")}`);
    if (deny.removed.length) parts.push(`Deny- ${deny.removed.join(", ")}`);

    lines.push(`${label}: ${shorten(parts.join(" | "), 400)}`);
  }

  if (!lines.length) return null;
  return shorten(lines.slice(0, 12).join("\n"), 950);
}

function snapshotInviteUses(invites) {
  const map = new Map();
  invites.forEach((invite) => map.set(invite.code, invite.uses || 0));
  return map;
}

async function primeInviteCache(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  inviteUsesCache.set(guild.id, snapshotInviteUses(invites));
}

async function detectInviteUsage(guild) {
  const previous = inviteUsesCache.get(guild.id) || new Map();
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return { usedInvite: null, spikes: [] };

  const current = snapshotInviteUses(invites);
  inviteUsesCache.set(guild.id, current);

  const deltas = [];
  invites.forEach((invite) => {
    const before = previous.get(invite.code) || 0;
    const after = invite.uses || 0;
    const delta = after - before;
    if (delta > 0) deltas.push({ invite, before, after, delta });
  });

  deltas.sort((a, b) => b.delta - a.delta);
  return {
    usedInvite: deltas[0] || null,
    spikes: deltas.filter((item) => item.delta > 1),
  };
}

function snapshotWebhookCollection(collection) {
  const map = new Map();
  collection.forEach((webhook) => {
    map.set(webhook.id, {
      id: webhook.id,
      name: webhook.name || "Unnamed",
      type: webhook.type,
      channelId: webhook.channelId,
      avatar: webhook.avatar || null,
    });
  });
  return map;
}

async function refreshWebhookCacheForChannel(channel) {
  if (!channel || typeof channel.fetchWebhooks !== "function") return null;
  const hooks = await channel.fetchWebhooks().catch(() => null);
  if (!hooks) return null;
  const snapshot = snapshotWebhookCollection(hooks);
  webhookCache.set(channel.id, snapshot);
  return snapshot;
}

async function primeWebhookCache(guild) {
  const channels = guild.channels.cache.filter((channel) => typeof channel.fetchWebhooks === "function");
  const tasks = [...channels.values()].map((channel) => refreshWebhookCacheForChannel(channel));
  await Promise.allSettled(tasks);
}

function describeInteractionTarget(interaction) {
  if (!interaction?.options) return "None";

  const names = ["user", "target"];
  for (const name of names) {
    try {
      const user = interaction.options.getUser(name);
      if (user) return `<@${user.id}>`;
    } catch (_) {
      // ignore missing option
    }
  }

  return "None";
}

async function logFailedModerationAttempt(interaction, reasonText) {
  if (!interaction?.guild) return;
  if (!MODERATION_COMMANDS.has(interaction.commandName)) return;

  const embed = makeEmbed("Moderation Attempt Blocked", reasonText, COLORS.WARNING, [
    { name: "Command", value: `/${interaction.commandName}` },
    { name: "Moderator", value: `<@${interaction.user.id}>` },
    { name: "Target", value: describeInteractionTarget(interaction) },
  ]);
  await sendLog(interaction.guild, embed, "moderation");
}

function normalizeStoreObject(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function loadStoreNamespace(namespace, fallbackFilePath, label) {
  try {
    return normalizeStoreObject(loadNamespace(namespace, fallbackFilePath));
  } catch (error) {
    console.error(`Failed to load ${label || namespace}:`, error);
    return {};
  }
}

function saveStoreNamespace(namespace, payload, label) {
  try {
    saveNamespace(namespace, normalizeStoreObject(payload));
  } catch (error) {
    console.error(`Failed to save ${label || namespace}:`, error);
  }
}

function normalizeAeonConversationEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const turnsRaw = Array.isArray(entry.turns) ? entry.turns : [];
  const turns = turnsRaw
    .slice(-AEON_HISTORY_MAX_TURNS)
    .map((turn) => ({
      question: shorten(String(turn?.question || ""), AEON_HISTORY_TEXT_LIMIT),
      answer: shorten(String(turn?.answer || ""), AEON_HISTORY_TEXT_LIMIT),
      at: String(turn?.at || new Date().toISOString()),
    }))
    .filter((turn) => turn.question || turn.answer);
  if (!turns.length) return null;
  const updatedAt = Number(entry.updatedAt || 0);
  return {
    turns,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  };
}

function loadAeonConversationStore() {
  const raw = loadStoreNamespace(STORE_NS_AEON_CONVERSATIONS, "", "aeon-conversations");
  const now = Date.now();
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const normalized = normalizeAeonConversationEntry(value);
    if (!normalized) continue;
    if (now - normalized.updatedAt > AEON_HISTORY_TTL_MS) continue;
    out[key] = normalized;
  }
  return out;
}

function saveAeonConversationStore() {
  const payload = {};
  const sorted = [...aeonConversationStore.entries()].sort(
    (a, b) => Number(b?.[1]?.updatedAt || 0) - Number(a?.[1]?.updatedAt || 0),
  );
  for (const [key, value] of sorted.slice(0, AEON_HISTORY_MAX_KEYS)) {
    const normalized = normalizeAeonConversationEntry(value);
    if (!normalized) continue;
    payload[key] = normalized;
  }
  saveStoreNamespace(STORE_NS_AEON_CONVERSATIONS, payload, "aeon-conversations");
}

function normalizeAeonThreadSessionEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const threadId = String(entry.threadId || "").trim();
  if (!threadId) return null;
  const rootChannelId = String(entry.rootChannelId || "").trim();
  if (!rootChannelId) return null;
  const userId = String(entry.userId || "").trim();
  if (!userId) return null;
  const updatedAt = Number(entry.updatedAt || 0);
  return {
    threadId,
    rootChannelId,
    userId,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  };
}

function makeAeonThreadSessionKey(guildId, rootChannelId, userId) {
  const g = String(guildId || "").trim() || "noguild";
  const c = String(rootChannelId || "").trim() || "nochannel";
  const u = String(userId || "").trim() || "nouser";
  return `${g}:${c}:${u}`;
}

function loadAeonThreadSessionStore() {
  const raw = loadStoreNamespace(STORE_NS_AEON_THREAD_SESSIONS, "", "aeon-thread-sessions");
  const out = {};
  const now = Date.now();
  for (const [key, value] of Object.entries(raw || {})) {
    const normalized = normalizeAeonThreadSessionEntry(value);
    if (!normalized) continue;
    if (now - normalized.updatedAt > AEON_THREAD_SESSION_TTL_MS) continue;
    out[key] = normalized;
  }
  return out;
}

function saveAeonThreadSessionStore() {
  const sorted = Object.entries(aeonThreadSessionStore || {}).sort(
    (a, b) => Number(b?.[1]?.updatedAt || 0) - Number(a?.[1]?.updatedAt || 0),
  );
  const payload = {};
  for (const [key, value] of sorted.slice(0, AEON_THREAD_SESSION_MAX_KEYS)) {
    const normalized = normalizeAeonThreadSessionEntry(value);
    if (!normalized) continue;
    payload[key] = normalized;
  }
  saveStoreNamespace(STORE_NS_AEON_THREAD_SESSIONS, payload, "aeon-thread-sessions");
}

function pruneAeonThreadSessionStore() {
  const now = Date.now();
  let changed = false;
  for (const [key, value] of Object.entries(aeonThreadSessionStore || {})) {
    const normalized = normalizeAeonThreadSessionEntry(value);
    if (!normalized) {
      delete aeonThreadSessionStore[key];
      changed = true;
      continue;
    }
    if (now - normalized.updatedAt > AEON_THREAD_SESSION_TTL_MS) {
      delete aeonThreadSessionStore[key];
      changed = true;
      continue;
    }
    if (
      normalized.threadId !== value.threadId ||
      normalized.rootChannelId !== value.rootChannelId ||
      normalized.userId !== value.userId ||
      normalized.updatedAt !== value.updatedAt
    ) {
      aeonThreadSessionStore[key] = normalized;
      changed = true;
    }
  }
  const keys = Object.keys(aeonThreadSessionStore || {});
  if (keys.length > AEON_THREAD_SESSION_MAX_KEYS) {
    const sortedKeys = keys.sort(
      (a, b) => Number(aeonThreadSessionStore[b]?.updatedAt || 0) - Number(aeonThreadSessionStore[a]?.updatedAt || 0),
    );
    for (const key of sortedKeys.slice(AEON_THREAD_SESSION_MAX_KEYS)) {
      delete aeonThreadSessionStore[key];
      changed = true;
    }
  }
  if (changed) saveAeonThreadSessionStore();
}

function setAeonThreadSession(guildId, rootChannelId, userId, threadId) {
  const key = makeAeonThreadSessionKey(guildId, rootChannelId, userId);
  aeonThreadSessionStore[key] = {
    threadId: String(threadId || ""),
    rootChannelId: String(rootChannelId || ""),
    userId: String(userId || ""),
    updatedAt: Date.now(),
  };
  pruneAeonThreadSessionStore();
}

function clearAeonThreadSession(guildId, rootChannelId, userId) {
  const key = makeAeonThreadSessionKey(guildId, rootChannelId, userId);
  if (!aeonThreadSessionStore[key]) return;
  delete aeonThreadSessionStore[key];
  saveAeonThreadSessionStore();
}

function getAeonThreadSession(guildId, rootChannelId, userId) {
  pruneAeonThreadSessionStore();
  const key = makeAeonThreadSessionKey(guildId, rootChannelId, userId);
  const normalized = normalizeAeonThreadSessionEntry(aeonThreadSessionStore[key]);
  if (!normalized) return null;
  return normalized;
}

function loadWarnings() {
  return loadStoreNamespace(STORE_NS_WARNINGS, WARNINGS_FILE, "warnings");
}

function saveWarnings() {
  saveStoreNamespace(STORE_NS_WARNINGS, warningsStore, "warnings");
}

function getWarnings(guildId, userId) {
  return warningsStore[guildId]?.[userId] || [];
}

function setWarnings(guildId, userId, list) {
  if (!warningsStore[guildId]) warningsStore[guildId] = {};
  warningsStore[guildId][userId] = list;
  saveWarnings();
}

function clearWarnings(guildId, userId) {
  if (!warningsStore[guildId]) return 0;
  const count = (warningsStore[guildId][userId] || []).length;
  delete warningsStore[guildId][userId];
  if (!Object.keys(warningsStore[guildId]).length) delete warningsStore[guildId];
  saveWarnings();
  return count;
}

function defaultLogEvents() {
  return {
    member: true,
    role: true,
    channel: true,
    message: true,
    moderation: true,
  };
}

function normalizeLogEvents(events) {
  const base = defaultLogEvents();
  if (!events || typeof events !== "object") return base;
  return {
    member: events.member !== false,
    role: events.role !== false,
    channel: events.channel !== false,
    message: events.message !== false,
    moderation: events.moderation !== false,
  };
}

function loadLogConfig() {
  return loadStoreNamespace(STORE_NS_LOG_CONFIG, LOG_CONFIG_FILE, "log-config");
}

function saveLogConfig() {
  saveStoreNamespace(STORE_NS_LOG_CONFIG, logConfigStore, "log-config");
}

function getGuildLogConfig(guildId) {
  const current = logConfigStore[guildId];
  if (!current || typeof current !== "object") {
    return {
      channelId: "",
      events: defaultLogEvents(),
      updatedAt: null,
      updatedBy: null,
    };
  }

  return {
    channelId: typeof current.channelId === "string" ? current.channelId : "",
    events: normalizeLogEvents(current.events),
    updatedAt: current.updatedAt || null,
    updatedBy: current.updatedBy || null,
  };
}

function setGuildLogConfig(guildId, patch = {}) {
  const current = getGuildLogConfig(guildId);
  const next = {
    channelId: typeof patch.channelId === "string" ? patch.channelId : current.channelId,
    events: normalizeLogEvents(patch.events || current.events),
    updatedAt: patch.updatedAt || new Date().toISOString(),
    updatedBy: patch.updatedBy || current.updatedBy || null,
  };

  logConfigStore[guildId] = next;
  saveLogConfig();
  return next;
}

function isLogEventEnabled(guildId, eventKey) {
  const config = getGuildLogConfig(guildId);
  return config.events[eventKey] !== false;
}

function loadSetupConfig() {
  return loadStoreNamespace(STORE_NS_SETUP_CONFIG, SETUP_CONFIG_FILE, "setup-config");
}

function saveSetupConfig() {
  saveStoreNamespace(STORE_NS_SETUP_CONFIG, setupConfigStore, "setup-config");
}

function getGuildSetupConfig(guildId) {
  const current = setupConfigStore[guildId];
  if (!current || typeof current !== "object") {
    return {
      reportChannelId: "",
      welcomeChannelId: "",
      hallOfFameChannelId: "",
      statsCategoryId: "",
      statsChannels: {
        all: "",
        members: "",
        bots: "",
      },
      aeonActivationText: "",
      aeonActivationTexts: [],
      updatedAt: null,
      updatedBy: null,
    };
  }
  const activationTexts = getAeonActivationTexts(current);
  return {
    reportChannelId: typeof current.reportChannelId === "string" ? current.reportChannelId : "",
    welcomeChannelId: typeof current.welcomeChannelId === "string" ? current.welcomeChannelId : "",
    hallOfFameChannelId: typeof current.hallOfFameChannelId === "string" ? current.hallOfFameChannelId : "",
    statsCategoryId: typeof current.statsCategoryId === "string" ? current.statsCategoryId : "",
    statsChannels: {
      all: typeof current.statsChannels?.all === "string" ? current.statsChannels.all : "",
      members: typeof current.statsChannels?.members === "string" ? current.statsChannels.members : "",
      bots: typeof current.statsChannels?.bots === "string" ? current.statsChannels.bots : "",
    },
    aeonActivationText: activationTexts[0] || "",
    aeonActivationTexts: activationTexts,
    updatedAt: current.updatedAt || null,
    updatedBy: current.updatedBy || null,
  };
}

function setGuildSetupConfig(guildId, patch = {}) {
  const current = getGuildSetupConfig(guildId);
  const inputStats = patch.statsChannels || {};
  let activationTexts = current.aeonActivationTexts;
  if (Array.isArray(patch.aeonActivationTexts)) {
    activationTexts = normalizeAeonActivationTexts(patch.aeonActivationTexts);
  } else if (typeof patch.aeonActivationText === "string") {
    activationTexts = normalizeAeonActivationTexts([patch.aeonActivationText]);
  } else {
    activationTexts = normalizeAeonActivationTexts(current.aeonActivationTexts || [current.aeonActivationText]);
  }

  const next = {
    reportChannelId: typeof patch.reportChannelId === "string" ? patch.reportChannelId : current.reportChannelId,
    welcomeChannelId: typeof patch.welcomeChannelId === "string" ? patch.welcomeChannelId : current.welcomeChannelId,
    hallOfFameChannelId:
      typeof patch.hallOfFameChannelId === "string" ? patch.hallOfFameChannelId : current.hallOfFameChannelId,
    statsCategoryId: typeof patch.statsCategoryId === "string" ? patch.statsCategoryId : current.statsCategoryId,
    statsChannels: {
      all: typeof inputStats.all === "string" ? inputStats.all : current.statsChannels.all,
      members: typeof inputStats.members === "string" ? inputStats.members : current.statsChannels.members,
      bots: typeof inputStats.bots === "string" ? inputStats.bots : current.statsChannels.bots,
    },
    aeonActivationText: activationTexts[0] || "",
    aeonActivationTexts: activationTexts,
    updatedAt: patch.updatedAt || new Date().toISOString(),
    updatedBy: patch.updatedBy || current.updatedBy || null,
  };
  setupConfigStore[guildId] = next;
  saveSetupConfig();
  return next;
}

function loadBotProfileStore() {
  return loadStoreNamespace(STORE_NS_BOT_PROFILE, "", "bot-profile");
}

function saveBotProfileStore() {
  saveStoreNamespace(STORE_NS_BOT_PROFILE, botProfileStore, "bot-profile");
}

function normalizeBotProfileName(raw, fallback = "") {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  return value.slice(0, 32);
}

function normalizeBotProfileDescription(raw, fallback = "") {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  return value.slice(0, 300);
}

function isValidHttpUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function normalizeBotProfileImageUrl(raw, fallback = "") {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  if (!isValidHttpUrl(value)) return fallback;
  return value.slice(0, 500);
}

function normalizeBotProfileColor(raw, fallback = "") {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  const match = value.match(/^#?([A-Fa-f0-9]{6})$/);
  if (!match) return fallback;
  return `#${match[1].toUpperCase()}`;
}

function normalizeBotProfileSyncFields(fields) {
  const input = Array.isArray(fields) ? fields : [fields];
  const allowed = new Set(["name", "description", "icon", "banner"]);
  const output = [];
  const seen = new Set();

  for (const item of input) {
    const key = String(item || "").trim().toLowerCase();
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }

  return output;
}

function formatBotProfileSyncError(error) {
  const code = error?.code || error?.rawError?.code || "";
  const message = String(error?.rawError?.message || error?.message || "Unknown error");
  return shorten(`${code ? `[${code}] ` : ""}${message}`, 220);
}

async function syncGuildBotMemberProfile(guild, profile, actorUser = null, fields = []) {
  const targets = normalizeBotProfileSyncFields(fields);
  const result = {
    requested: targets,
    updated: [],
    errors: [],
  };

  if (!targets.length) return result;
  if (!guild?.members || typeof guild.members.editMe !== "function") {
    result.errors.push("Guild profile sync is not supported in this runtime.");
    return result;
  }

  const actorTag = actorUser?.tag || actorUser?.username || "unknown";
  const actorId = actorUser?.id || "unknown";
  const reason = shorten(`Bot profile updated by ${actorTag} (${actorId})`, 480);

  for (const field of targets) {
    try {
      if (field === "name") {
        await guild.members.editMe({
          nick: profile?.name || null,
          reason,
        });
        result.updated.push(profile?.name ? "name" : "name cleared");
        continue;
      }

      if (field === "description") {
        const bio = profile?.description ? String(profile.description).slice(0, 190) : null;
        await guild.members.editMe({
          bio,
          reason,
        });
        result.updated.push(profile?.description ? "description" : "description cleared");
        continue;
      }

      if (field === "icon") {
        // discord.js can resolve remote URLs internally for avatar/banner updates.
        const avatar = profile?.iconUrl || null;
        await guild.members.editMe({
          avatar,
          reason,
        });
        result.updated.push(profile?.iconUrl ? "icon" : "icon cleared");
        continue;
      }

      if (field === "banner") {
        const banner = profile?.bannerUrl || null;
        await guild.members.editMe({
          banner,
          reason,
        });
        result.updated.push(profile?.bannerUrl ? "banner" : "banner cleared");
      }
    } catch (error) {
      const label = field.charAt(0).toUpperCase() + field.slice(1);
      result.errors.push(`${label}: ${formatBotProfileSyncError(error)}`);
    }
  }

  return result;
}

function appendBotProfileSyncField(embed, syncResult) {
  if (!embed || !syncResult) return;
  const lines = [];
  if (Array.isArray(syncResult.updated) && syncResult.updated.length) {
    lines.push(`Updated: ${syncResult.updated.join(", ")}`);
  }
  if (Array.isArray(syncResult.errors) && syncResult.errors.length) {
    lines.push(`Issues:\n${syncResult.errors.map((item) => `- ${item}`).join("\n")}`);
  }
  if (!lines.length) return;

  if (typeof embed.addFields === "function") {
    embed.addFields({
      name: "Guild Profile Sync",
      value: shorten(lines.join("\n"), 1000),
      inline: false,
    });
  }
}

function getGuildBotProfile(guildId) {
  const current = botProfileStore[guildId];
  if (!current || typeof current !== "object") {
    return {
      name: "",
      description: "",
      iconUrl: "",
      bannerUrl: "",
      accentColor: "",
      updatedAt: null,
      updatedBy: null,
    };
  }
  return {
    name: normalizeBotProfileName(current.name, ""),
    description: normalizeBotProfileDescription(current.description, ""),
    iconUrl: normalizeBotProfileImageUrl(current.iconUrl, ""),
    bannerUrl: normalizeBotProfileImageUrl(current.bannerUrl, ""),
    accentColor: normalizeBotProfileColor(current.accentColor, ""),
    updatedAt: current.updatedAt || null,
    updatedBy: current.updatedBy || null,
  };
}

function setGuildBotProfile(guildId, patch = {}) {
  const current = getGuildBotProfile(guildId);
  const next = {
    name:
      patch.name === null
        ? ""
        : typeof patch.name === "string"
          ? normalizeBotProfileName(patch.name, "")
          : current.name,
    description:
      patch.description === null
        ? ""
        : typeof patch.description === "string"
          ? normalizeBotProfileDescription(patch.description, "")
          : current.description,
    iconUrl:
      patch.iconUrl === null
        ? ""
        : typeof patch.iconUrl === "string"
          ? normalizeBotProfileImageUrl(patch.iconUrl, "")
          : current.iconUrl,
    bannerUrl:
      patch.bannerUrl === null
        ? ""
        : typeof patch.bannerUrl === "string"
          ? normalizeBotProfileImageUrl(patch.bannerUrl, "")
          : current.bannerUrl,
    accentColor:
      patch.accentColor === null
        ? ""
        : typeof patch.accentColor === "string"
          ? normalizeBotProfileColor(patch.accentColor, "")
          : current.accentColor,
    updatedAt: patch.updatedAt || new Date().toISOString(),
    updatedBy: patch.updatedBy || current.updatedBy || null,
  };

  if (!next.name && !next.description && !next.iconUrl && !next.bannerUrl && !next.accentColor) {
    delete botProfileStore[guildId];
  } else {
    botProfileStore[guildId] = next;
  }
  saveBotProfileStore();
  return getGuildBotProfile(guildId);
}

function clearGuildBotProfile(guildId, updatedBy = null) {
  delete botProfileStore[guildId];
  saveBotProfileStore();
  return {
    name: "",
    description: "",
    iconUrl: "",
    bannerUrl: "",
    accentColor: "",
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || null,
  };
}

function guildIdFromContext(guildOrId) {
  if (!guildOrId) return "";
  if (typeof guildOrId === "string") return guildOrId;
  return String(guildOrId.id || "");
}

function getGuildBotDisplayName(guildOrId, fallbackUser = null) {
  const guildId = guildIdFromContext(guildOrId);
  const profile = guildId ? getGuildBotProfile(guildId) : null;
  const fallback = fallbackUser?.username || client.user?.username || "MU Bot";
  return profile?.name || fallback;
}

function getGuildBotDisplayDescription(guildOrId, fallback = "") {
  const guildId = guildIdFromContext(guildOrId);
  if (!guildId) return fallback;
  const profile = getGuildBotProfile(guildId);
  return profile.description || fallback;
}

function getGuildBotAccentColor(guildOrId, fallback = COLORS.INFO) {
  const guildId = guildIdFromContext(guildOrId);
  if (!guildId) return fallback;
  const profile = getGuildBotProfile(guildId);
  return profile.accentColor || fallback;
}

function defaultAeonActionPolicy() {
  return {
    enabled: true,
    requireApproval: true,
    maxActionsPerRun: 8,
    allowedActions: [...AEON_ACTION_DEFAULT_ALLOWED],
    updatedAt: null,
    updatedBy: null,
  };
}

function normalizeAeonActionTypeList(values, fallback = AEON_ACTION_DEFAULT_ALLOWED) {
  if (Array.isArray(values) && values.length === 0) {
    return [];
  }
  const source = Array.isArray(values) ? values : fallback;
  const list = [];
  const seen = new Set();
  for (const value of source) {
    const type = normalizeAeonActionType(value);
    if (!type || seen.has(type)) continue;
    seen.add(type);
    list.push(type);
  }
  if (!list.length && !Array.isArray(values)) {
    return [...AEON_ACTION_DEFAULT_ALLOWED];
  }
  return list;
}

function normalizeAeonActionPolicyEntry(entry) {
  const base = defaultAeonActionPolicy();
  const source = entry && typeof entry === "object" ? entry : {};
  const maxRaw = Number.parseInt(String(source.maxActionsPerRun ?? base.maxActionsPerRun), 10);
  return {
    enabled: source.enabled !== false,
    requireApproval: source.requireApproval !== false,
    maxActionsPerRun: Number.isFinite(maxRaw) ? Math.max(1, Math.min(12, maxRaw)) : base.maxActionsPerRun,
    allowedActions: normalizeAeonActionTypeList(source.allowedActions, base.allowedActions),
    updatedAt: source.updatedAt || null,
    updatedBy: source.updatedBy || null,
  };
}

function loadAeonActionPolicyStore() {
  const raw = loadStoreNamespace(STORE_NS_AEON_ACTION_POLICY, "", "aeon-action-policy");
  const out = {};
  for (const [guildId, value] of Object.entries(raw || {})) {
    out[guildId] = normalizeAeonActionPolicyEntry(value);
  }
  return out;
}

function saveAeonActionPolicyStore() {
  saveStoreNamespace(STORE_NS_AEON_ACTION_POLICY, aeonActionPolicyStore, "aeon-action-policy");
}

function getGuildAeonActionPolicy(guildId) {
  const current = aeonActionPolicyStore[guildId];
  return normalizeAeonActionPolicyEntry(current);
}

function setGuildAeonActionPolicy(guildId, patch = {}) {
  const current = getGuildAeonActionPolicy(guildId);
  const next = normalizeAeonActionPolicyEntry({
    ...current,
    ...patch,
    updatedAt: patch.updatedAt || new Date().toISOString(),
    updatedBy: patch.updatedBy || current.updatedBy || null,
  });
  aeonActionPolicyStore[guildId] = next;
  saveAeonActionPolicyStore();
  return next;
}

function normalizeWorkflowName(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, AEON_ACTION_WORKFLOW_NAME_MAX);
}

function normalizeAeonActionWorkflowEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = normalizeWorkflowName(entry.name || entry.key || "");
  if (!name) return null;
  const request = shorten(String(entry.request || ""), AEON_ACTION_REQUEST_MAX).trim();
  if (!request) return null;
  return {
    key: name,
    name,
    request,
    createdAt: entry.createdAt || new Date().toISOString(),
    createdBy: entry.createdBy || null,
    updatedAt: entry.updatedAt || null,
    updatedBy: entry.updatedBy || null,
  };
}

function loadAeonActionWorkflowStore() {
  const raw = loadStoreNamespace(STORE_NS_AEON_ACTION_WORKFLOWS, "", "aeon-action-workflows");
  const out = {};
  for (const [guildId, value] of Object.entries(raw || {})) {
    const obj = value && typeof value === "object" ? value : {};
    const sourceItems = obj.workflows && typeof obj.workflows === "object" ? obj.workflows : {};
    const workflows = {};
    for (const [key, item] of Object.entries(sourceItems)) {
      const normalized = normalizeAeonActionWorkflowEntry({
        ...(item || {}),
        key,
      });
      if (!normalized) continue;
      workflows[normalized.key] = normalized;
    }
    out[guildId] = {
      workflows,
      updatedAt: obj.updatedAt || null,
      updatedBy: obj.updatedBy || null,
    };
  }
  return out;
}

function saveAeonActionWorkflowStore() {
  saveStoreNamespace(STORE_NS_AEON_ACTION_WORKFLOWS, aeonActionWorkflowStore, "aeon-action-workflows");
}

function getGuildAeonActionWorkflowConfig(guildId) {
  const current = aeonActionWorkflowStore[guildId];
  if (!current || typeof current !== "object") {
    return {
      workflows: {},
      updatedAt: null,
      updatedBy: null,
    };
  }
  return {
    workflows: current.workflows && typeof current.workflows === "object" ? current.workflows : {},
    updatedAt: current.updatedAt || null,
    updatedBy: current.updatedBy || null,
  };
}

function getGuildAeonActionWorkflows(guildId) {
  const config = getGuildAeonActionWorkflowConfig(guildId);
  const list = Object.values(config.workflows || {});
  return list
    .map((item) => normalizeAeonActionWorkflowEntry(item))
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function upsertGuildAeonActionWorkflow(guildId, workflow, actorId = null) {
  const config = getGuildAeonActionWorkflowConfig(guildId);
  const normalized = normalizeAeonActionWorkflowEntry(workflow);
  if (!normalized) return null;
  const existing = config.workflows[normalized.key] || null;
  const next = {
    ...normalized,
    createdAt: existing?.createdAt || normalized.createdAt || new Date().toISOString(),
    createdBy: existing?.createdBy || normalized.createdBy || actorId || null,
    updatedAt: new Date().toISOString(),
    updatedBy: actorId || null,
  };
  const workflows = { ...config.workflows, [normalized.key]: next };
  const names = Object.keys(workflows).sort();
  if (names.length > AEON_ACTION_WORKFLOW_MAX) {
    const dropKey = names[names.length - 1];
    delete workflows[dropKey];
  }
  aeonActionWorkflowStore[guildId] = {
    workflows,
    updatedAt: new Date().toISOString(),
    updatedBy: actorId || null,
  };
  saveAeonActionWorkflowStore();
  return next;
}

function removeGuildAeonActionWorkflow(guildId, name, actorId = null) {
  const key = normalizeWorkflowName(name);
  if (!key) return false;
  const config = getGuildAeonActionWorkflowConfig(guildId);
  if (!config.workflows[key]) return false;
  const workflows = { ...config.workflows };
  delete workflows[key];
  aeonActionWorkflowStore[guildId] = {
    workflows,
    updatedAt: new Date().toISOString(),
    updatedBy: actorId || null,
  };
  saveAeonActionWorkflowStore();
  return true;
}

function getGuildAeonActionWorkflow(guildId, name) {
  const key = normalizeWorkflowName(name);
  if (!key) return null;
  const config = getGuildAeonActionWorkflowConfig(guildId);
  return normalizeAeonActionWorkflowEntry(config.workflows[key] || null);
}

function normalizeAeonActionAuditEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || "").trim();
  if (!id) return null;
  const status = String(entry.status || "unknown").trim() || "unknown";
  const request = shorten(String(entry.request || ""), AEON_ACTION_REQUEST_MAX).trim();
  const createdAt = entry.createdAt || new Date().toISOString();
  const risk = ["low", "medium", "high"].includes(String(entry.risk || "").toLowerCase())
    ? String(entry.risk).toLowerCase()
    : "low";
  const actions = Array.isArray(entry.actions)
    ? entry.actions
        .map((item) => ({
          type: normalizeAeonActionType(item?.type),
          summary: shorten(String(item?.summary || ""), 240),
          success: item?.success !== false,
          message: shorten(String(item?.message || ""), 500),
        }))
        .filter((item) => item.type || item.summary || item.message)
    : [];
  const rollbackSteps = Array.isArray(entry.rollbackSteps)
    ? entry.rollbackSteps
        .filter((step) => step && typeof step === "object" && String(step.type || "").trim())
        .slice(0, 200)
    : [];
  return {
    id,
    planId: String(entry.planId || "").trim(),
    request,
    summary: shorten(String(entry.summary || ""), 1200),
    status,
    risk,
    dryRun: entry.dryRun === true,
    createdBy: entry.createdBy || null,
    createdAt,
    finishedAt: entry.finishedAt || null,
    actions,
    warnings: Array.isArray(entry.warnings) ? entry.warnings.map((w) => shorten(String(w), 250)).slice(0, 20) : [],
    rollbackSteps,
    rollbackStatus: entry.rollbackStatus || null,
  };
}

function loadAeonActionAuditStore() {
  const raw = loadStoreNamespace(STORE_NS_AEON_ACTION_AUDIT, "", "aeon-action-audit");
  const out = {};
  for (const [guildId, value] of Object.entries(raw || {})) {
    const list = Array.isArray(value) ? value : [];
    const normalized = list
      .map((item) => normalizeAeonActionAuditEntry(item))
      .filter(Boolean)
      .slice(-AEON_ACTION_AUDIT_MAX_ENTRIES);
    out[guildId] = normalized;
  }
  return out;
}

function saveAeonActionAuditStore() {
  saveStoreNamespace(STORE_NS_AEON_ACTION_AUDIT, aeonActionAuditStore, "aeon-action-audit");
}

function appendGuildAeonActionAudit(guildId, entry) {
  const normalized = normalizeAeonActionAuditEntry(entry);
  if (!normalized) return null;
  const current = Array.isArray(aeonActionAuditStore[guildId]) ? aeonActionAuditStore[guildId] : [];
  const next = [...current, normalized].slice(-AEON_ACTION_AUDIT_MAX_ENTRIES);
  aeonActionAuditStore[guildId] = next;
  saveAeonActionAuditStore();
  return normalized;
}

function updateGuildAeonActionAudit(guildId, runId, patch = {}) {
  const list = Array.isArray(aeonActionAuditStore[guildId]) ? [...aeonActionAuditStore[guildId]] : [];
  const index = list.findIndex((item) => item && item.id === runId);
  if (index < 0) return null;
  const updated = normalizeAeonActionAuditEntry({
    ...list[index],
    ...patch,
  });
  if (!updated) return null;
  list[index] = updated;
  aeonActionAuditStore[guildId] = list.slice(-AEON_ACTION_AUDIT_MAX_ENTRIES);
  saveAeonActionAuditStore();
  return updated;
}

function getGuildAeonActionAudit(guildId, limit = 10) {
  const size = Number.isFinite(Number(limit)) ? Number(limit) : 10;
  const safe = Math.max(1, Math.min(20, size));
  const list = Array.isArray(aeonActionAuditStore[guildId]) ? aeonActionAuditStore[guildId] : [];
  return list.slice(-safe).reverse();
}

function pruneAeonActionPlanStore() {
  const now = Date.now();
  for (const [key, plan] of aeonActionPlanStore.entries()) {
    const createdAt = Number(plan?.createdAtMs || 0);
    if (!createdAt || now - createdAt > AEON_ACTION_PLAN_TTL_MS) {
      aeonActionPlanStore.delete(key);
    }
  }
  if (aeonActionPlanStore.size > AEON_ACTION_PLAN_MAX_KEYS) {
    const sorted = [...aeonActionPlanStore.entries()].sort(
      (a, b) => Number(b?.[1]?.createdAtMs || 0) - Number(a?.[1]?.createdAtMs || 0),
    );
    aeonActionPlanStore.clear();
    for (const [key, value] of sorted.slice(0, AEON_ACTION_PLAN_MAX_KEYS)) {
      aeonActionPlanStore.set(key, value);
    }
  }
}

function makeAeonActionPlanId() {
  const base = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `plan_${base}${rand}`;
}

function makeAeonActionPlanKey(guildId, planId) {
  return `${String(guildId || "noguild")}:${String(planId || "noplan")}`;
}

function saveAeonActionPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  const guildId = String(plan.guildId || "").trim();
  const planId = String(plan.id || "").trim();
  if (!guildId || !planId) return null;
  const key = makeAeonActionPlanKey(guildId, planId);
  aeonActionPlanStore.set(key, {
    ...plan,
    createdAtMs: Number(plan.createdAtMs || Date.now()),
  });
  pruneAeonActionPlanStore();
  return aeonActionPlanStore.get(key) || null;
}

function deleteAeonActionPlan(guildId, planId) {
  const key = makeAeonActionPlanKey(guildId, planId);
  aeonActionPlanStore.delete(key);
}

function getAeonActionPlan(guildId, planId) {
  pruneAeonActionPlanStore();
  const key = makeAeonActionPlanKey(guildId, planId);
  return aeonActionPlanStore.get(key) || null;
}

function loadAutoRoleConfig() {
  return loadStoreNamespace(STORE_NS_AUTOROLE_CONFIG, AUTOROLE_FILE, "autorole-config");
}

function saveAutoRoleConfig() {
  saveStoreNamespace(STORE_NS_AUTOROLE_CONFIG, autoRoleStore, "autorole-config");
}

function normalizeRoleIdList(roleIds) {
  if (!Array.isArray(roleIds)) return [];
  return [...new Set(roleIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
}

function getGuildAutoRoleConfig(guildId) {
  const current = autoRoleStore[guildId];
  if (!current || typeof current !== "object") {
    return {
      roleIds: [],
      updatedAt: null,
      updatedBy: null,
    };
  }

  return {
    roleIds: normalizeRoleIdList(current.roleIds),
    updatedAt: current.updatedAt || null,
    updatedBy: current.updatedBy || null,
  };
}

function setGuildAutoRoleConfig(guildId, patch = {}) {
  const current = getGuildAutoRoleConfig(guildId);
  const next = {
    roleIds: patch.roleIds ? normalizeRoleIdList(patch.roleIds) : current.roleIds,
    updatedAt: patch.updatedAt || new Date().toISOString(),
    updatedBy: patch.updatedBy || current.updatedBy || null,
  };
  autoRoleStore[guildId] = next;
  saveAutoRoleConfig();
  return next;
}

function canManageRoleByHierarchy(member, role, guildOwnerId) {
  if (!member || !role) return false;
  if (member.id === guildOwnerId) return true;
  return member.roles.highest.comparePositionTo(role) > 0;
}

async function applyAutoRolesForMember(member) {
  if (!member?.guild || member.user?.bot) return { assigned: 0, skipped: 0, failed: 0 };

  const config = getGuildAutoRoleConfig(member.guild.id);
  if (!config.roleIds.length) return { assigned: 0, skipped: 0, failed: 0 };

  const botMember = await getBotMember(member.guild).catch(() => null);
  if (!botMember) return { assigned: 0, skipped: config.roleIds.length, failed: 0 };
  if (!botMember.permissions?.has(Permissions.FLAGS.MANAGE_ROLES)) {
    return { assigned: 0, skipped: config.roleIds.length, failed: 0 };
  }

  const roleIds = [...config.roleIds];
  const validRoleIds = [];
  let assigned = 0;
  let skipped = 0;
  let failed = 0;

  for (const roleId of roleIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role) continue;
    validRoleIds.push(role.id);

    if (role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
      skipped += 1;
      continue;
    }
    if (member.roles.cache.has(role.id)) {
      skipped += 1;
      continue;
    }

    try {
      await member.roles.add(role, "Autorole assignment on member join");
      assigned += 1;
    } catch (_) {
      failed += 1;
    }
  }

  if (validRoleIds.length !== config.roleIds.length) {
    setGuildAutoRoleConfig(member.guild.id, {
      roleIds: validRoleIds,
      updatedBy: config.updatedBy || null,
      updatedAt: new Date().toISOString(),
    });
  }

  return { assigned, skipped, failed };
}

function loadJtcConfig() {
  return loadStoreNamespace(STORE_NS_JTC_CONFIG, JTC_CONFIG_FILE, "jtc-config");
}

function saveJtcConfig() {
  saveStoreNamespace(STORE_NS_JTC_CONFIG, jtcConfigStore, "jtc-config");
}

function normalizeJtcChannels(channels) {
  if (!channels || typeof channels !== "object") return {};
  const next = {};
  for (const [channelId, state] of Object.entries(channels)) {
    if (!state || typeof state !== "object") continue;
    if (typeof state.ownerId !== "string" || !state.ownerId) continue;
    next[channelId] = {
      ownerId: state.ownerId,
      textChannelId: typeof state.textChannelId === "string" ? state.textChannelId : "",
      status: typeof state.status === "string" ? state.status : "",
      game: typeof state.game === "string" ? state.game : "",
      createdAt: state.createdAt || new Date().toISOString(),
    };
  }
  return next;
}

function normalizeJtcTriggers(triggers) {
  if (!triggers || typeof triggers !== "object") return {};
  const next = {};
  for (const [channelId, config] of Object.entries(triggers)) {
    if (typeof channelId !== "string" || !channelId.trim()) continue;
    const categoryId = typeof config?.categoryId === "string" ? config.categoryId : "";
    next[channelId.trim()] = { categoryId };
  }
  return next;
}

function getFirstJtcTriggerId(triggers) {
  const ids = Object.keys(triggers || {});
  return ids.length ? ids[0] : "";
}

function getGuildJtcConfig(guildId) {
  const current = jtcConfigStore[guildId];
  if (!current || typeof current !== "object") {
    return {
      triggers: {},
      triggerChannelId: "",
      categoryId: "",
      interfaceChannelId: "",
      channels: {},
      updatedAt: null,
      updatedBy: null,
    };
  }
  const triggers = normalizeJtcTriggers(current.triggers);
  if (!Object.keys(triggers).length && typeof current.triggerChannelId === "string" && current.triggerChannelId) {
    triggers[current.triggerChannelId] = {
      categoryId: typeof current.categoryId === "string" ? current.categoryId : "",
    };
  }
  const firstTriggerId = getFirstJtcTriggerId(triggers);
  return {
    triggers,
    triggerChannelId: firstTriggerId,
    categoryId: firstTriggerId ? triggers[firstTriggerId].categoryId || "" : "",
    interfaceChannelId: typeof current.interfaceChannelId === "string" ? current.interfaceChannelId : "",
    channels: normalizeJtcChannels(current.channels),
    updatedAt: current.updatedAt || null,
    updatedBy: current.updatedBy || null,
  };
}

function setGuildJtcConfig(guildId, patch = {}) {
  const current = getGuildJtcConfig(guildId);
  let nextTriggers = patch.triggers ? normalizeJtcTriggers(patch.triggers) : { ...current.triggers };

  if (patch.clearTriggers === true) nextTriggers = {};
  if (typeof patch.removeTriggerId === "string" && patch.removeTriggerId) {
    delete nextTriggers[patch.removeTriggerId];
  }
  if (typeof patch.triggerChannelId === "string" && patch.triggerChannelId) {
    const existing = nextTriggers[patch.triggerChannelId] || { categoryId: "" };
    nextTriggers[patch.triggerChannelId] = {
      categoryId:
        typeof patch.categoryId === "string"
          ? patch.categoryId
          : typeof existing.categoryId === "string"
            ? existing.categoryId
            : "",
    };
  }

  const firstTriggerId = getFirstJtcTriggerId(nextTriggers);
  const next = {
    triggers: nextTriggers,
    triggerChannelId: firstTriggerId,
    categoryId: firstTriggerId ? nextTriggers[firstTriggerId].categoryId || "" : "",
    interfaceChannelId:
      typeof patch.interfaceChannelId === "string" ? patch.interfaceChannelId : current.interfaceChannelId,
    channels: patch.channels ? normalizeJtcChannels(patch.channels) : current.channels,
    updatedAt: patch.updatedAt || new Date().toISOString(),
    updatedBy: patch.updatedBy || current.updatedBy || null,
  };
  jtcConfigStore[guildId] = next;
  saveJtcConfig();
  return next;
}

function getTempVoiceState(guildId, voiceChannelId) {
  const cfg = getGuildJtcConfig(guildId);
  return cfg.channels[voiceChannelId] || null;
}

function setTempVoiceState(guildId, voiceChannelId, statePatch = {}) {
  const cfg = getGuildJtcConfig(guildId);
  const current = cfg.channels[voiceChannelId] || {
    ownerId: "",
    textChannelId: "",
    status: "",
    game: "",
    createdAt: new Date().toISOString(),
  };
  cfg.channels[voiceChannelId] = {
    ownerId: typeof statePatch.ownerId === "string" ? statePatch.ownerId : current.ownerId,
    textChannelId:
      typeof statePatch.textChannelId === "string" ? statePatch.textChannelId : current.textChannelId,
    status: typeof statePatch.status === "string" ? statePatch.status : current.status,
    game: typeof statePatch.game === "string" ? statePatch.game : current.game,
    createdAt: current.createdAt || new Date().toISOString(),
  };
  setGuildJtcConfig(guildId, {
    triggers: cfg.triggers,
    interfaceChannelId: cfg.interfaceChannelId,
    channels: cfg.channels,
    updatedBy: cfg.updatedBy || null,
    updatedAt: new Date().toISOString(),
  });
  return cfg.channels[voiceChannelId];
}

function removeTempVoiceState(guildId, voiceChannelId) {
  const cfg = getGuildJtcConfig(guildId);
  if (!cfg.channels[voiceChannelId]) return null;
  const removed = cfg.channels[voiceChannelId];
  delete cfg.channels[voiceChannelId];
  setGuildJtcConfig(guildId, {
    triggers: cfg.triggers,
    interfaceChannelId: cfg.interfaceChannelId,
    channels: cfg.channels,
    updatedBy: cfg.updatedBy || null,
    updatedAt: new Date().toISOString(),
  });
  return removed;
}

function getTempVoiceStateByOwner(guildId, ownerId) {
  const cfg = getGuildJtcConfig(guildId);
  const entry = Object.entries(cfg.channels).find(([, state]) => state.ownerId === ownerId);
  if (!entry) return null;
  return { channelId: entry[0], state: entry[1] };
}

function sanitizeChannelBaseName(input) {
  const normalized = String(input || "").trim().replace(/[\r\n]/g, " ");
  const cleaned = normalized.replace(/\s+/g, " ");
  return cleaned.slice(0, 80);
}

function mentionToId(value) {
  const raw = String(value || "").trim();
  const mentionMatch = raw.match(/^<@!?(\d{17,20})>$/) || raw.match(/^<@&(\d{17,20})>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{17,20}$/.test(raw)) return raw;
  return null;
}

function makeOwnerVoiceOverwrite(ownerId) {
  const allow = [
    Permissions.FLAGS.VIEW_CHANNEL,
    Permissions.FLAGS.CONNECT,
    Permissions.FLAGS.SPEAK,
    Permissions.FLAGS.STREAM,
    Permissions.FLAGS.USE_VAD,
    Permissions.FLAGS.MANAGE_CHANNELS,
    Permissions.FLAGS.MOVE_MEMBERS,
    Permissions.FLAGS.MUTE_MEMBERS,
    Permissions.FLAGS.DEAFEN_MEMBERS,
  ].filter((perm) => perm !== undefined);
  return { id: ownerId, allow };
}

function ownerVoicePermissionMap() {
  return {
    [VIEW_CHANNEL_PERMISSION_KEY]: true,
    [CONNECT_PERMISSION_KEY]: true,
    [SPEAK_PERMISSION_KEY]: true,
    [STREAM_PERMISSION_KEY]: true,
    [USE_VAD_PERMISSION_KEY]: true,
    [MANAGE_CHANNELS_PERMISSION_KEY]: true,
    [MOVE_MEMBERS_PERMISSION_KEY]: true,
    [MUTE_MEMBERS_PERMISSION_KEY]: true,
    [DEAFEN_MEMBERS_PERMISSION_KEY]: true,
  };
}

function makeEveryonePrivateVoiceOverwrite(guild) {
  const deny = [Permissions.FLAGS.CONNECT].filter((perm) => perm !== undefined);
  return { id: guild.roles.everyone.id, deny };
}

async function createTempVoiceChannel(member, triggerChannelId, categoryId = "") {
  const guild = member.guild;
  const trigger = guild.channels.cache.get(triggerChannelId);
  const parentId = categoryId || trigger?.parentId || null;
  const channelName = `${sanitizeChannelBaseName(member.user.username)}'s VC`;
  const overwrites = [makeEveryonePrivateVoiceOverwrite(guild), makeOwnerVoiceOverwrite(member.id)];
  const voiceType = ChannelTypes.GuildVoice !== undefined ? ChannelTypes.GuildVoice : "GUILD_VOICE";

  try {
    return await guild.channels.create({
      name: channelName,
      type: voiceType,
      parent: parentId || undefined,
      permissionOverwrites: overwrites,
      reason: `Join-to-create voice for ${member.user.tag} (${member.id})`,
    });
  } catch (_) {
    return guild.channels.create(channelName, {
      type: "GUILD_VOICE",
      parent: parentId || undefined,
      permissionOverwrites: overwrites,
      reason: `Join-to-create voice for ${member.user.tag} (${member.id})`,
    });
  }
}

async function createTempTextChannel(guild, voiceChannel, ownerId) {
  const textType = ChannelTypes.GuildText !== undefined ? ChannelTypes.GuildText : "GUILD_TEXT";
  const name = `vc-${sanitizeChannelBaseName(voiceChannel.name).toLowerCase().replace(/\s+/g, "-").slice(0, 20) || "chat"}`;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [Permissions.FLAGS.VIEW_CHANNEL].filter((perm) => perm !== undefined) },
    {
      id: ownerId,
      allow: [Permissions.FLAGS.VIEW_CHANNEL, Permissions.FLAGS.SEND_MESSAGES].filter((perm) => perm !== undefined),
    },
  ];

  try {
    return await guild.channels.create({
      name,
      type: textType,
      parent: voiceChannel.parentId || undefined,
      permissionOverwrites: overwrites,
      reason: `Temp text channel for ${voiceChannel.name}`,
    });
  } catch (_) {
    return guild.channels.create(name, {
      type: "GUILD_TEXT",
      parent: voiceChannel.parentId || undefined,
      permissionOverwrites: overwrites,
      reason: `Temp text channel for ${voiceChannel.name}`,
    });
  }
}

function buildTempVoiceInterfaceEmbed(guild, voiceChannel, state) {
  const owner = state?.ownerId ? `<@${state.ownerId}>` : "Unknown";
  const status = state?.status?.trim() ? state.status.trim() : "None";
  const game = state?.game?.trim() ? state.game.trim() : "None";
  const embed = makeEmbed(
    "Temporary Voice Controls",
    "Use the menus to manage this temporary channel.",
    "#345A7A",
    [
      { name: "Channel", value: `${voiceChannel}`, inline: true },
      { name: "Owner", value: owner, inline: true },
      { name: "Members", value: `${voiceChannel.members?.size || 0}`, inline: true },
      { name: "Status", value: status, inline: true },
      { name: "Game", value: game, inline: true },
    ],
  );
  setEmbedFooterSafe(embed, "Join-to-create controls");
  return embed;
}

function buildTempVoiceInterfaceComponents(voiceChannelId) {
  const settingsMenu = createStringSelectMenu(
    `jtc:settings:${voiceChannelId}`,
    "Channel Settings",
    JTC_SETTINGS_OPTIONS,
  );
  const permissionMenu = createStringSelectMenu(
    `jtc:permissions:${voiceChannelId}`,
    "Channel Permissions",
    JTC_PERMISSION_OPTIONS,
  );
  const row1 = new ActionRowClass().addComponents(settingsMenu);
  const row2 = new ActionRowClass().addComponents(permissionMenu);
  const row3 = new ActionRowClass().addComponents(
    createNavButton(`jtc:button:refresh:${voiceChannelId}`, "Refresh", "SECONDARY"),
    createNavButton(`jtc:button:close:${voiceChannelId}`, "Close", "DANGER"),
  );
  return [row1, row2, row3];
}

async function resolveTempInterfaceTargetChannel(guild, voiceChannelId) {
  const voiceChannel = guild.channels.cache.get(voiceChannelId) || (await guild.channels.fetch(voiceChannelId).catch(() => null));
  if (voiceChannel && typeof voiceChannel.send === "function") return voiceChannel;

  const cfg = getGuildJtcConfig(guild.id);
  if (!cfg.interfaceChannelId) return null;
  const fallback = guild.channels.cache.get(cfg.interfaceChannelId) || (await guild.channels.fetch(cfg.interfaceChannelId).catch(() => null));
  if (fallback && isTextChannel(fallback)) return fallback;
  return null;
}

async function postTempVoiceInterface(guild, voiceChannelId) {
  const voiceChannel =
    guild.channels.cache.get(voiceChannelId) || (await guild.channels.fetch(voiceChannelId).catch(() => null));
  if (!voiceChannel || !isVoiceChannel(voiceChannel)) return null;

  const state = getTempVoiceState(guild.id, voiceChannel.id);
  if (!state) return null;

  const targetChannel = await resolveTempInterfaceTargetChannel(guild, voiceChannel.id);
  if (!targetChannel || typeof targetChannel.send !== "function") return null;

  const embed = buildTempVoiceInterfaceEmbed(guild, voiceChannel, state);
  const components = buildTempVoiceInterfaceComponents(voiceChannel.id);
  return targetChannel.send({ embeds: [embed], components }).catch(() => null);
}

function canManageTempVoice(interaction, voiceChannelId, allowClaim = false) {
  const state = getTempVoiceState(interaction.guild.id, voiceChannelId);
  if (!state) return { ok: false, reason: "This channel is not managed as a temporary voice channel." };
  const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
  if (!voiceChannel || !isVoiceChannel(voiceChannel)) {
    return { ok: false, reason: "Temporary channel was not found." };
  }

  if (interaction.member.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)) {
    return { ok: true, state, voiceChannel };
  }

  if (state.ownerId === interaction.user.id) return { ok: true, state, voiceChannel };
  if (allowClaim) {
    const ownerStillIn = voiceChannel.members?.has(state.ownerId);
    if (!ownerStillIn) return { ok: true, state, voiceChannel };
  }
  return { ok: false, reason: "Only the temporary channel owner can use this action." };
}

async function cleanupTempVoiceChannelIfEmpty(guild, channelId) {
  if (!channelId) return;
  const state = getTempVoiceState(guild.id, channelId);
  if (!state) return;

  const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel || !isVoiceChannel(channel)) {
    removeTempVoiceState(guild.id, channelId);
    return;
  }
  if (channel.members?.size > 0) return;

  const removed = removeTempVoiceState(guild.id, channelId);
  await channel.delete("Temporary voice channel cleanup").catch(() => null);
  if (removed?.textChannelId) {
    const text = guild.channels.cache.get(removed.textChannelId) || (await guild.channels.fetch(removed.textChannelId).catch(() => null));
    if (text) await text.delete("Temporary text channel cleanup").catch(() => null);
  }
}

async function pruneTempVoiceStateForGuild(guild) {
  const cfg = getGuildJtcConfig(guild.id);
  if (!Object.keys(cfg.channels).length) return;

  let changed = false;
  for (const [voiceChannelId, state] of Object.entries(cfg.channels)) {
    const channel = guild.channels.cache.get(voiceChannelId) || (await guild.channels.fetch(voiceChannelId).catch(() => null));
    if (!channel || !isVoiceChannel(channel)) {
      delete cfg.channels[voiceChannelId];
      if (state?.textChannelId) {
        const text = guild.channels.cache.get(state.textChannelId) || (await guild.channels.fetch(state.textChannelId).catch(() => null));
        if (text) await text.delete("Cleaning stale temp text channel").catch(() => null);
      }
      changed = true;
    }
  }

  if (changed) {
    setGuildJtcConfig(guild.id, {
      triggers: cfg.triggers,
      interfaceChannelId: cfg.interfaceChannelId,
      channels: cfg.channels,
      updatedBy: cfg.updatedBy || null,
      updatedAt: new Date().toISOString(),
    });
  }
}

function getModalInputValue(interaction, inputId) {
  try {
    return interaction.fields?.getTextInputValue(inputId)?.trim() || "";
  } catch (_) {
    return "";
  }
}

async function resolveMemberOrRoleFromInput(guild, input) {
  const id = mentionToId(input);
  if (!id) return null;

  const role = guild.roles.cache.get(id) || (await guild.roles.fetch(id).catch(() => null));
  if (role) return { type: "role", target: role };

  const member = guild.members.cache.get(id) || (await guild.members.fetch(id).catch(() => null));
  if (member) return { type: "member", target: member };

  return null;
}

function updateTempVoiceInterfaceState(guildId, voiceChannelId, patch) {
  return setTempVoiceState(guildId, voiceChannelId, patch);
}

async function showTempVoiceModal(interaction, modalAction, voiceChannelId, defaults = {}) {
  const modal = buildSingleInputModal(
    `jtc:modal:${modalAction}:${voiceChannelId}`,
    defaults.title || "Voice Control",
    "value",
    defaults.label || "Value",
    defaults.placeholder || "Enter value",
    defaults.value || "",
    defaults.style || "SHORT",
  );
  if (!modal || typeof interaction.showModal !== "function") {
    await interaction.reply({
      embeds: [makeEmbed("Unsupported Action", "Modals are not available in this runtime.", COLORS.ERROR)],
      flags: EPHEMERAL_FLAG,
    });
    return;
  }
  await interaction.showModal(modal);
}

function loadModActions() {
  return loadStoreNamespace(STORE_NS_MOD_ACTIONS, MOD_ACTIONS_FILE, "mod-actions");
}

function saveModActions() {
  saveStoreNamespace(STORE_NS_MOD_ACTIONS, modActionsStore, "mod-actions");
}

function recordModerationHistory(guildId, userId, entry) {
  if (!guildId || !userId || !entry) return;
  if (!modActionsStore[guildId]) modActionsStore[guildId] = {};
  if (!Array.isArray(modActionsStore[guildId][userId])) modActionsStore[guildId][userId] = [];
  modActionsStore[guildId][userId].push({
    id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    action: entry.action || "Unknown",
    moderatorId: entry.moderatorId || null,
    reason: entry.reason || "No reason provided.",
    meta: entry.meta || null,
    createdAt: entry.createdAt || new Date().toISOString(),
  });
  modActionsStore[guildId][userId] = modActionsStore[guildId][userId].slice(-100);
  saveModActions();
}

function getModerationHistory(guildId, userId) {
  return modActionsStore[guildId]?.[userId] || [];
}

function loadReminders() {
  return loadStoreNamespace(STORE_NS_REMINDERS, REMINDERS_FILE, "reminders");
}

function saveReminders() {
  saveStoreNamespace(STORE_NS_REMINDERS, remindersStore, "reminders");
}

function cancelReminderTimer(reminderId) {
  const active = reminderTimers.get(reminderId);
  if (!active) return;
  clearTimeout(active);
  reminderTimers.delete(reminderId);
}

async function dispatchReminder(reminderId) {
  const reminder = remindersStore[reminderId];
  if (!reminder) return;

  const channel =
    client.channels.cache.get(reminder.channelId) ||
    (await client.channels.fetch(reminder.channelId).catch(() => null));
  if (!channel || typeof channel.send !== "function") {
    delete remindersStore[reminderId];
    saveReminders();
    cancelReminderTimer(reminderId);
    return;
  }

  const embed = makeEmbed(
    "Reminder",
    `> ${shorten(reminder.text, 1800)}`,
    COLORS.INFO,
    [
      { name: "For", value: `<@${reminder.userId}>`, inline: true },
      { name: "Set At", value: `<t:${Math.floor(new Date(reminder.createdAt).getTime() / 1000)}:f>`, inline: true },
      { name: "Due At", value: `<t:${Math.floor(new Date(reminder.remindAt).getTime() / 1000)}:f>`, inline: true },
    ],
  );
  setEmbedFooterSafe(embed, `Reminder ID: ${reminder.id}`);

  await channel.send({
    content: `<@${reminder.userId}>`,
    embeds: [embed],
  }).catch(() => null);

  delete remindersStore[reminderId];
  saveReminders();
  cancelReminderTimer(reminderId);
}

function scheduleReminder(reminder) {
  if (!reminder?.id || !reminder.remindAt) return;
  cancelReminderTimer(reminder.id);

  const delay = new Date(reminder.remindAt).getTime() - Date.now();
  if (Number.isNaN(delay)) return;

  if (delay <= 0) {
    setTimeout(() => {
      dispatchReminder(reminder.id).catch(() => null);
    }, 1000);
    return;
  }

  const MAX_DELAY = 2 ** 31 - 1;
  const timeout = Math.min(delay, MAX_DELAY);
  const timer = setTimeout(() => {
    if (delay > MAX_DELAY) {
      scheduleReminder(reminder);
      return;
    }
    dispatchReminder(reminder.id).catch(() => null);
  }, timeout);
  reminderTimers.set(reminder.id, timer);
}

function createReminder(reminderInput) {
  const reminder = {
    id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    guildId: reminderInput.guildId,
    channelId: reminderInput.channelId,
    userId: reminderInput.userId,
    text: reminderInput.text,
    createdAt: new Date().toISOString(),
    remindAt: new Date(Date.now() + reminderInput.ms).toISOString(),
  };
  remindersStore[reminder.id] = reminder;
  saveReminders();
  scheduleReminder(reminder);
  return reminder;
}

function bootstrapReminders() {
  for (const reminder of Object.values(remindersStore)) {
    scheduleReminder(reminder);
  }
}

function loadObservabilityStore() {
  const raw = loadStoreNamespace(STORE_NS_OBSERVABILITY, "", "observability");
  const commands = raw.commands && typeof raw.commands === "object" ? raw.commands : {};
  const aeonRaw = raw.aeon && typeof raw.aeon === "object" ? raw.aeon : {};
  const topicCounts = aeonRaw.topicCounts && typeof aeonRaw.topicCounts === "object" ? aeonRaw.topicCounts : {};
  const noResultQueries = Array.isArray(aeonRaw.noResultQueries) ? aeonRaw.noResultQueries : [];
  return {
    startedAt: raw.startedAt || new Date().toISOString(),
    totalCommands: Number.isFinite(raw.totalCommands) ? raw.totalCommands : 0,
    totalErrors: Number.isFinite(raw.totalErrors) ? raw.totalErrors : 0,
    commands,
    aeon: {
      asks: Number.isFinite(aeonRaw.asks) ? aeonRaw.asks : 0,
      autoAsks: Number.isFinite(aeonRaw.autoAsks) ? aeonRaw.autoAsks : 0,
      noResultQueries: noResultQueries
        .slice(-25)
        .map((item) => ({
          question: shorten(String(item?.question || ""), 140),
          at: String(item?.at || new Date().toISOString()),
          scope: String(item?.scope || "unknown"),
          sourceCount: Number.isFinite(item?.sourceCount) ? item.sourceCount : 0,
        })),
      topicCounts,
    },
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

function saveObservabilityStore() {
  observabilityStore.updatedAt = new Date().toISOString();
  saveStoreNamespace(STORE_NS_OBSERVABILITY, observabilityStore, "observability");
}

function markCommandInvocation(commandName) {
  if (!commandName) return;
  observabilityStore.totalCommands += 1;
  if (!observabilityStore.commands[commandName]) {
    observabilityStore.commands[commandName] = {
      calls: 0,
      errors: 0,
      lastCalledAt: null,
      lastErrorAt: null,
      lastErrorMessage: "",
    };
  }
  const bucket = observabilityStore.commands[commandName];
  bucket.calls += 1;
  bucket.lastCalledAt = new Date().toISOString();
  saveObservabilityStore();
}

function markCommandFailure(commandName, error) {
  if (!commandName) return;
  observabilityStore.totalErrors += 1;
  if (!observabilityStore.commands[commandName]) {
    observabilityStore.commands[commandName] = {
      calls: 0,
      errors: 0,
      lastCalledAt: null,
      lastErrorAt: null,
      lastErrorMessage: "",
    };
  }
  const bucket = observabilityStore.commands[commandName];
  bucket.errors += 1;
  bucket.lastErrorAt = new Date().toISOString();
  bucket.lastErrorMessage = shorten(String(error?.message || error || "Unknown error"), 300);
  saveObservabilityStore();
}

function formatTopCommandUsage(limit = 3) {
  const entries = Object.entries(observabilityStore.commands || {})
    .map(([name, stats]) => ({
      name,
      calls: Number.isFinite(stats?.calls) ? stats.calls : 0,
      errors: Number.isFinite(stats?.errors) ? stats.errors : 0,
    }))
    .filter((item) => item.calls > 0)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, limit);
  if (!entries.length) return "No command usage yet.";
  return entries.map((item) => `/${item.name} ${item.calls} (${item.errors} err)`).join("\n");
}

function inferAeonTopic(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return "general";
  if (/register|registration|fee|team|eligib/.test(q)) return "registration";
  if (/event|track|competition|workshop|talk|panel|hackathon|robowar|esports/.test(q)) return "events";
  if (/schedule|date|time|when/.test(q)) return "schedule";
  if (/venue|location|parking|entry|gate|map|travel/.test(q)) return "venue";
  if (/refund|cancel|policy|privacy|law|rule|conduct/.test(q)) return "policy";
  if (/sponsor|partner|tier|deliverable|brand/.test(q)) return "sponsorship";
  if (/contact|email|phone|discord|instagram|linkedin|x\b/.test(q)) return "contact";
  return "general";
}

function formatTopAeonTopics(limit = 5) {
  const topicCounts = observabilityStore?.aeon?.topicCounts || {};
  const entries = Object.entries(topicCounts)
    .map(([topic, count]) => ({ topic, count: Number.isFinite(count) ? count : 0 }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  if (!entries.length) return "No AEON topics tracked yet.";
  return entries.map((item) => `${item.topic}: ${item.count}`).join("\n");
}

function formatRecentAeonNoResult(limit = 5) {
  const items = Array.isArray(observabilityStore?.aeon?.noResultQueries)
    ? observabilityStore.aeon.noResultQueries.slice(-limit).reverse()
    : [];
  if (!items.length) return "No no-result queries recorded.";
  return items
    .map((item) => {
      const unix = Math.floor(new Date(item.at).getTime() / 1000);
      const when = Number.isFinite(unix) && unix > 0 ? `<t:${unix}:R>` : "recently";
      const scope = String(item.scope || "unknown");
      return `• ${shorten(item.question || "Unknown query", 90)} (${scope}, ${item.sourceCount || 0} src, ${when})`;
    })
    .join("\n");
}

function recordAeonAskTelemetry(question, result, options = {}) {
  if (!observabilityStore.aeon || typeof observabilityStore.aeon !== "object") {
    observabilityStore.aeon = {
      asks: 0,
      autoAsks: 0,
      noResultQueries: [],
      topicCounts: {},
    };
  }

  observabilityStore.aeon.asks += 1;
  if (options.auto) observabilityStore.aeon.autoAsks += 1;

  const topic = inferAeonTopic(question);
  if (!observabilityStore.aeon.topicCounts[topic]) observabilityStore.aeon.topicCounts[topic] = 0;
  observabilityStore.aeon.topicCounts[topic] += 1;

  const sources = Array.isArray(result?.sources) ? result.sources.filter(Boolean) : [];
  const answer = String(result?.answer || "").toLowerCase();
  const noResult =
    (result?.scope === "in_scope" && sources.length === 0) ||
    answer.includes("no verified context found in the local aeon");
  if (noResult) {
    const list = Array.isArray(observabilityStore.aeon.noResultQueries)
      ? observabilityStore.aeon.noResultQueries
      : [];
    list.push({
      question: shorten(String(question || ""), 140),
      at: new Date().toISOString(),
      scope: String(result?.scope || "unknown"),
      sourceCount: sources.length,
    });
    observabilityStore.aeon.noResultQueries = list.slice(-25);
  }

  saveObservabilityStore();
}

async function fetchChannelSafe(guild, channelId) {
  if (!channelId) return null;
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  return guild.channels.fetch(channelId).catch(() => null);
}

async function createVoiceStatsChannel(guild, categoryId, name) {
  const connectPermission = Permissions.FLAGS.CONNECT;
  const overwrite =
    connectPermission !== undefined
      ? [{ id: guild.roles.everyone.id, deny: [connectPermission] }]
      : [];

  const v14Type = ChannelTypes.GuildVoice !== undefined ? ChannelTypes.GuildVoice : undefined;
  try {
    if (v14Type !== undefined) {
      return await guild.channels.create({
        name,
        type: v14Type,
        parent: categoryId,
        permissionOverwrites: overwrite,
      });
    }
  } catch (_) {
    // fallback to legacy create signature
  }

  return guild.channels.create(name, {
    type: "GUILD_VOICE",
    parent: categoryId,
    permissionOverwrites: overwrite,
  });
}

function snapshotGuildMemberCounts(guild) {
  const total = Number(guild?.memberCount || guild?.members?.cache?.size || 0);
  const bots = guild?.members?.cache?.filter((member) => member.user?.bot).size || 0;
  const members = Math.max(total - bots, 0);
  return { total, members, bots };
}

async function getGuildMemberCounts(guild, forceRefresh = false) {
  if (!guild?.id) return { total: 0, members: 0, bots: 0 };

  const now = Date.now();
  const cached = memberCountCache.get(guild.id);
  const snapshot = snapshotGuildMemberCounts(guild);

  if (!forceRefresh && cached && now - cached.at <= MEMBER_COUNT_CACHE_TTL_MS) {
    if (cached.counts.total === snapshot.total) return cached.counts;
    memberCountCache.set(guild.id, { at: now, counts: snapshot });
    return snapshot;
  }

  let counts = snapshot;
  const cachedMemberCount = guild?.members?.cache?.size || 0;
  const shouldRefreshMembers = forceRefresh || cachedMemberCount < snapshot.total;
  if (shouldRefreshMembers) {
    await guild.members.fetch().catch(() => null);
    counts = snapshotGuildMemberCounts(guild);
  }

  memberCountCache.set(guild.id, { at: now, counts });
  return counts;
}

function getStatsChannelNames(counts) {
  return {
    all: `\u250C All Members: ${counts.total}`,
    members: `\u251C Members: ${counts.members}`,
    bots: `\u2514 Bots: ${counts.bots}`,
  };
}

function normalizeStatsCounterName(name) {
  return String(name || "").trim().replace(/^[\u250C\u251C\u2514]\s*/u, "");
}

function matchesStatsCounterLabel(name, keyLabel) {
  const normalized = normalizeStatsCounterName(name).toLowerCase();
  return normalized.startsWith(`${String(keyLabel || "").toLowerCase()}:`);
}

async function resolveStatsChannel(guild, categoryId, existingId, keyLabel, initialName) {
  let channel = await fetchChannelSafe(guild, existingId);
  if (channel && (!isVoiceChannel(channel) || channel.parentId !== categoryId)) channel = null;

  if (!channel) {
    channel = guild.channels.cache.find(
      (candidate) =>
        isVoiceChannel(candidate) &&
        candidate.parentId === categoryId &&
        matchesStatsCounterLabel(candidate.name, keyLabel),
    );
  }

  if (!channel) {
    channel = await createVoiceStatsChannel(guild, categoryId, initialName).catch(() => null);
  }

  if (!channel) return null;
  if (channel.parentId !== categoryId && typeof channel.setParent === "function") {
    await channel.setParent(categoryId).catch(() => null);
  }
  return channel;
}

async function updateGuildStatsChannels(guild, updatedBy = null) {
  if (!guild?.id) return null;

  const active = statsUpdateInFlight.get(guild.id);
  if (active) return active;

  const task = (async () => {
    const setup = getGuildSetupConfig(guild.id);
    if (!setup.statsCategoryId) return null;

    const category = await fetchChannelSafe(guild, setup.statsCategoryId);
    if (!isCategoryChannel(category)) return null;

    const zeroNames = getStatsChannelNames({ total: 0, members: 0, bots: 0 });
    const allChannel = await resolveStatsChannel(
      guild,
      category.id,
      setup.statsChannels.all,
      "All Members",
      zeroNames.all,
    );
    const memberChannel = await resolveStatsChannel(
      guild,
      category.id,
      setup.statsChannels.members,
      "Members",
      zeroNames.members,
    );
    const botChannel = await resolveStatsChannel(guild, category.id, setup.statsChannels.bots, "Bots", zeroNames.bots);
    if (!allChannel || !memberChannel || !botChannel) return null;

    const counts = await getGuildMemberCounts(guild);
    const names = getStatsChannelNames(counts);

    if (allChannel.name !== names.all) await allChannel.setName(names.all).catch(() => null);
    if (memberChannel.name !== names.members) await memberChannel.setName(names.members).catch(() => null);
    if (botChannel.name !== names.bots) await botChannel.setName(names.bots).catch(() => null);

    const needsConfigWrite =
      setup.statsCategoryId !== category.id ||
      setup.statsChannels.all !== allChannel.id ||
      setup.statsChannels.members !== memberChannel.id ||
      setup.statsChannels.bots !== botChannel.id;

    if (needsConfigWrite || updatedBy) {
      setGuildSetupConfig(guild.id, {
        reportChannelId: setup.reportChannelId,
        welcomeChannelId: setup.welcomeChannelId,
        statsCategoryId: category.id,
        statsChannels: {
          all: allChannel.id,
          members: memberChannel.id,
          bots: botChannel.id,
        },
        updatedBy: updatedBy || setup.updatedBy || null,
        updatedAt: new Date().toISOString(),
      });
    }

    return {
      categoryId: category.id,
      channels: {
        all: allChannel.id,
        members: memberChannel.id,
        bots: botChannel.id,
      },
      counts,
    };
  })()
    .catch((error) => {
      console.error(`Failed to update stats channels for guild ${guild.id}:`, error);
      return null;
    })
    .finally(() => {
      statsUpdateInFlight.delete(guild.id);
    });

  statsUpdateInFlight.set(guild.id, task);
  return task;
}

function isConfiguredStatsChannel(guildId, channelId) {
  if (!guildId || !channelId) return false;
  const setup = getGuildSetupConfig(guildId);
  return (
    setup.statsChannels.all === channelId ||
    setup.statsChannels.members === channelId ||
    setup.statsChannels.bots === channelId
  );
}

function isStatsCounterName(name) {
  const value = normalizeStatsCounterName(name);
  return /^(all members|members|bots):\s*\d+$/i.test(value);
}

function shouldIgnoreStatsChannelLog(channel) {
  if (!channel?.guild?.id || !channel?.id) return false;
  if (isConfiguredStatsChannel(channel.guild.id, channel.id)) return true;
  if (!isVoiceChannel(channel)) return false;

  const setup = getGuildSetupConfig(channel.guild.id);
  if (!setup.statsCategoryId || channel.parentId !== setup.statsCategoryId) return false;
  return isStatsCounterName(channel.name);
}

function pickWelcomeMessage(member) {
  const index = Math.floor(Math.random() * WELCOME_MESSAGES.length);
  const template = WELCOME_MESSAGES[index] || WELCOME_MESSAGES[0];
  return template.replace("{user}", `<@${member.id}>`);
}

async function sendWelcomeMessage(member) {
  if (!member?.guild?.id) return;
  if (member.user?.bot) return;
  const setup = getGuildSetupConfig(member.guild.id);
  if (!setup.welcomeChannelId) return;

  const channel = await fetchChannelSafe(member.guild, setup.welcomeChannelId);
  if (!channel || !isTextChannel(channel)) return;

  const botMember = await getBotMember(member.guild).catch(() => null);
  if (!botMember) return;
  if (!channel.permissionsFor(botMember)?.has(Permissions.FLAGS.SEND_MESSAGES)) return;

  const embed = makeEmbed(`Welcome, ${member.user.username}`, pickWelcomeMessage(member), COLORS.SUCCESS);
  if (typeof member.user.displayAvatarURL === "function") {
    setEmbedThumbnailSafe(embed, member.user.displayAvatarURL({ dynamic: true }));
  }
  setEmbedFooterSafe(embed, `ID: ${member.id}`);
  await channel.send({ embeds: [embed] }).catch(() => null);
}

async function getBotMember(guild) {
  if (guild.members?.me) return guild.members.me;
  if (guild.me) return guild.me;
  return guild.members.fetch(client.user.id);
}

async function requireMemberPerm(interaction, permission, label) {
  if (interaction.member.permissions.has(permission)) return true;
  await logFailedModerationAttempt(interaction, `Missing member permission: ${label}`);
  await fail(interaction, "Permission Denied", `You need \`${label}\` permission to use this command.`);
  return false;
}

async function requireBotPerm(interaction, botMember, permission, label, channel = null) {
  if (!botMember) {
    await logFailedModerationAttempt(interaction, `Could not resolve bot member while checking: ${label}`);
    await fail(interaction, "Bot Permission Missing", "I could not resolve my member record in this server.");
    return false;
  }
  const scope = channel ? channel.permissionsFor(botMember) : botMember.permissions;
  if (scope && scope.has(permission)) return true;
  await logFailedModerationAttempt(interaction, `Missing bot permission: ${label}`);
  await fail(interaction, "Bot Permission Missing", `I need \`${label}\` permission to complete this action.`);
  return false;
}

async function requireBotVoicePerms(interaction, botMember, voiceChannel) {
  const checks = [
    [Permissions.FLAGS.VIEW_CHANNEL, "View Channel"],
    [Permissions.FLAGS.CONNECT, "Connect"],
    [Permissions.FLAGS.SPEAK, "Speak"],
  ];

  for (const [permission, label] of checks) {
    if (permission === undefined) continue;
    if (!(await requireBotPerm(interaction, botMember, permission, label, voiceChannel))) return false;
  }
  return true;
}

async function validateTarget(interaction, botMember, targetMember) {
  if (!botMember) {
    await logFailedModerationAttempt(interaction, "Could not resolve bot member for target validation.");
    await fail(interaction, "Bot Permission Missing", "I could not resolve my member record in this server.");
    return false;
  }
  if (!targetMember) {
    await logFailedModerationAttempt(interaction, "Target user not found in guild.");
    await fail(interaction, "Target Not Found", "The target user is not in this server.");
    return false;
  }
  if (targetMember.id === interaction.user.id) {
    await logFailedModerationAttempt(interaction, "Attempted moderation action on self.");
    await fail(interaction, "Invalid Target", "You cannot moderate yourself.");
    return false;
  }
  if (targetMember.id === client.user.id) {
    await logFailedModerationAttempt(interaction, "Attempted moderation action against bot.");
    await fail(interaction, "Invalid Target", "This action cannot target the bot account.");
    return false;
  }
  if (targetMember.id === interaction.guild.ownerId) {
    await logFailedModerationAttempt(interaction, "Attempted moderation action against server owner.");
    await fail(interaction, "Invalid Target", "The server owner cannot be moderated.");
    return false;
  }
  if (
    interaction.user.id !== interaction.guild.ownerId &&
    interaction.member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0
  ) {
    await logFailedModerationAttempt(interaction, "Invoker role hierarchy is not above target.");
    await fail(interaction, "Role Hierarchy Blocked", "Your highest role must be above the target's highest role.");
    return false;
  }
  if (botMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    await logFailedModerationAttempt(interaction, "Bot role hierarchy is not above target.");
    await fail(interaction, "Role Hierarchy Blocked", "My highest role must be above the target's highest role.");
    return false;
  }
  return true;
}

function sendMusicQueueEmbed(queue, embed) {
  const textChannel = queue?.textChannel;
  if (!textChannel || typeof textChannel.send !== "function") return;
  textChannel.send({ embeds: [embed] }).catch(() => null);
}

distube
  .on(DisTubeEvents.PLAY_SONG, (queue, song) => {
    const embed = makeMusicEmbed(
      "Now Playing",
      `${musicSongTitle(song)} \`${musicSongDuration(song)}\``,
      COLORS.SUCCESS,
      [
        { name: "Requested By", value: song?.user?.tag || song?.member?.user?.tag || "Unknown", inline: true },
        { name: "Volume", value: `${queue.volume}%`, inline: true },
        { name: "Loop", value: musicModeLabel(queue.repeatMode), inline: true },
      ],
    );
    sendMusicQueueEmbed(queue, embed);
  })
  .on(DisTubeEvents.ADD_SONG, (queue, song) => {
    if (!queue || queue.songs.length <= 1) return;
    const embed = makeMusicEmbed(
      "Queued",
      `${musicSongTitle(song)} \`${musicSongDuration(song)}\``,
      MUSIC_COLOR,
      [{ name: "Queue Size", value: `${Math.max(queue.songs.length - 1, 0)} song(s)`, inline: true }],
    );
    sendMusicQueueEmbed(queue, embed);
  })
  .on(DisTubeEvents.ADD_LIST, (queue, playlist) => {
    const embed = makeMusicEmbed(
      "Playlist Queued",
      `${shorten(playlist?.name || "Playlist", 120)}`,
      MUSIC_COLOR,
      [
        { name: "Tracks", value: `${playlist?.songs?.length || 0}`, inline: true },
        { name: "Queue Size", value: `${Math.max(queue?.songs?.length - 1 || 0, 0)} song(s)`, inline: true },
      ],
    );
    sendMusicQueueEmbed(queue, embed);
  })
  .on(DisTubeEvents.FINISH, (queue) => {
    sendMusicQueueEmbed(queue, makeMusicEmbed("Queue Finished", "No more songs in queue.", COLORS.INFO));
  })
  .on(DisTubeEvents.DISCONNECT, (queue) => {
    sendMusicQueueEmbed(queue, makeMusicEmbed("Disconnected", "Left the voice channel.", COLORS.WARNING));
  })
  .on(DisTubeEvents.ERROR, (error, queue, song) => {
    const message = shorten(error?.message || "An unknown playback error occurred.", 350);
    if (queue) {
      sendMusicQueueEmbed(
        queue,
        makeMusicEmbed(
          "Playback Error",
          `${song ? `${musicSongTitle(song, 50)}\n` : ""}${message}`,
          COLORS.ERROR,
        ),
      );
      return;
    }
    console.error("DisTube error:", error);
  });

async function handleMusicCommand(interaction, botMember) {
  if (!MUSIC_COMMANDS.has(interaction.commandName)) return false;

  const refreshState = () => musicSourceFromCommand(interaction, botMember);

  const ensureQueue = async () => {
    const queue = distube.getQueue(interaction.guild);
    if (!queue || !Array.isArray(queue.songs) || !queue.songs.length) {
      await fail(interaction, "Queue Empty", "There is no active music queue right now.");
      return null;
    }
    return queue;
  };

  const ensureUserVoice = async () => {
    const { userVoice } = refreshState();
    if (!userVoice || !isVoiceChannel(userVoice)) {
      await fail(interaction, "Voice Channel Required", "Join a voice channel to use this command.");
      return null;
    }
    return userVoice;
  };

  const ensureSameVoiceAsBot = async (userVoice, queueOverride = null) => {
    const state = refreshState();
    const botVoice = queueOverride?.voiceChannel || state.botVoice;
    if (botVoice && userVoice && botVoice.id !== userVoice.id) {
      await fail(interaction, "Wrong Voice Channel", `Join ${botVoice} to control playback.`);
      return null;
    }
    return botVoice;
  };

  const ensurePlaybackControl = async () => {
    const queue = await ensureQueue();
    if (!queue) return null;
    const userVoice = await ensureUserVoice();
    if (!userVoice) return null;
    const botVoice = await ensureSameVoiceAsBot(userVoice, queue);
    if (botVoice === null && (queue.voiceChannel || refreshState().botVoice)) return null;
    return { queue, userVoice, botVoice };
  };

  try {
    if (interaction.commandName === "join") {
      const requestedChannel = interaction.options.getChannel("channel");
      const { userVoice, botVoice } = refreshState();
      const targetChannel = requestedChannel || userVoice;

      if (!targetChannel || !isVoiceChannel(targetChannel)) {
        await fail(interaction, "Voice Channel Required", "Join a voice channel or provide a valid voice channel.");
        return true;
      }

      if (
        requestedChannel &&
        userVoice &&
        requestedChannel.id !== userVoice.id &&
        !interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)
      ) {
        await fail(interaction, "Permission Denied", "You can only make me join your own voice channel.");
        return true;
      }

      if (
        botVoice &&
        botVoice.id !== targetChannel.id &&
        userVoice &&
        botVoice.id !== userVoice.id &&
        !interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)
      ) {
        await fail(interaction, "Wrong Voice Channel", `Join ${botVoice} to move the bot.`);
        return true;
      }

      if (botVoice && botVoice.id === targetChannel.id) {
        await send(
          interaction,
          makeMusicEmbed("Already Connected", `I am already in ${targetChannel}.`, COLORS.WARNING),
          false,
        );
        return true;
      }

      if (!(await requireBotVoicePerms(interaction, botMember, targetChannel))) return true;
      await distube.voices.join(targetChannel);
      await send(interaction, makeMusicEmbed("Voice Connected", `Joined ${targetChannel}.`, COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "play") {
      const { queue: queueBefore, userVoice, botVoice } = refreshState();
      if (!userVoice || !isVoiceChannel(userVoice)) {
        await fail(interaction, "Voice Channel Required", "Join a voice channel before starting playback.");
        return true;
      }
      if (botVoice && botVoice.id !== userVoice.id) {
        await fail(interaction, "Wrong Voice Channel", `Join ${botVoice} to control playback.`);
        return true;
      }
      if (!(await requireBotVoicePerms(interaction, botMember, userVoice))) return true;

      const rawQuery = interaction.options.getString("query", true).trim();
      const fallbackLabel = shorten(rawQuery, 80);

      const beforeCount = queueBefore?.songs?.length || 0;
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply().catch(() => null);
      }

      const resolved = await resolveMusicQueryToPlayable(rawQuery);
      if (resolved.error) {
        await sendMusicResponse(interaction, makeMusicEmbed("Playback Failed", shorten(resolved.error, 300), COLORS.ERROR));
        return true;
      }

      const playOptions = {
        member: interaction.member,
        textChannel: interaction.channel && typeof interaction.channel.send === "function" ? interaction.channel : undefined,
      };
      let playbackError = null;
      try {
        await distube.play(userVoice, resolved.query, playOptions);
      } catch (error) {
        playbackError = error;
      }

      if (playbackError) {
        console.error(`Playback failed for ${interaction.commandName}:`, playbackError);
        await sendMusicResponse(
          interaction,
          makeMusicEmbed(
            "Playback Failed",
            shorten(playbackError?.message || "Could not start playback. Check source, ffmpeg, and voice permissions.", 300),
            COLORS.ERROR,
          ),
        );
        return true;
      }

      const queueAfter = distube.getQueue(interaction.guild);
      const afterCount = queueAfter?.songs?.length || 0;
      let song = queueAfter?.songs?.[0] || null;

      if (beforeCount > 0) {
        song = queueAfter?.songs?.[afterCount - 1] || queueAfter?.songs?.[0] || null;
      }

      const title = beforeCount ? "Added to Queue" : "Now Playing";

      const description = song
        ? `${musicSongTitle(song)} \`${musicSongDuration(song)}\``
        : `Input: \`${fallbackLabel}\``;

      const embed = makeMusicEmbed(title, description, COLORS.SUCCESS, [
        { name: "Voice", value: `${userVoice}`, inline: true },
        { name: "Up Next", value: `${Math.max((queueAfter?.songs?.length || 1) - 1, 0)} song(s)`, inline: true },
      ]);
      await sendMusicResponse(interaction, embed);
      return true;
    }

    if (interaction.commandName === "queue") {
      const queue = await ensureQueue();
      if (!queue) return true;

      const requestedPage = interaction.options.getInteger("page") || 1;
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const rendered = buildQueuePage(queue, page, 8);
      const embed = makeMusicEmbed("Music Queue", rendered.description, MUSIC_COLOR, [
        { name: "Up Next", value: `${rendered.upcomingTotal}`, inline: true },
        { name: "Volume", value: `${queue.volume}%`, inline: true },
        { name: "Loop", value: musicModeLabel(queue.repeatMode), inline: true },
        { name: "Autoplay", value: queue.autoplay ? "On" : "Off", inline: true },
      ]);
      setEmbedFooterSafe(embed, `Page ${rendered.page}/${rendered.totalPages}`);
      await send(interaction, embed, false);
      return true;
    }

    if (interaction.commandName === "back") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      if (!context.queue.previousSongs?.length) {
        await send(interaction, makeMusicEmbed("No Previous Song", "There is no previous song to play.", COLORS.WARNING), false);
        return true;
      }
      const song = await context.queue.previous();
      await send(interaction, makeMusicEmbed("Playing Previous", `${musicSongTitle(song)} \`${musicSongDuration(song)}\``, COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "addprevious") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const indexInput = interaction.options.getInteger("index") || 1;
      if (!Number.isInteger(indexInput) || indexInput < 1) {
        await fail(interaction, "Invalid Index", "`index` must be a positive integer.");
        return true;
      }
      const previousList = context.queue.previousSongs || [];
      if (!previousList.length || indexInput > previousList.length) {
        await fail(interaction, "Previous Song Not Found", "That previous-song index does not exist.");
        return true;
      }
      const song = previousList[previousList.length - indexInput];
      context.queue.addToQueue(song, 1);
      await send(
        interaction,
        makeMusicEmbed("Added Previous Song", `${musicSongTitle(song)} was added as next track.`, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "autoplay") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const desired = interaction.options.getBoolean("enabled");
      let enabled = context.queue.autoplay;
      if (desired === null) {
        enabled = context.queue.toggleAutoplay();
      } else if (desired !== enabled) {
        enabled = context.queue.toggleAutoplay();
      }
      await send(
        interaction,
        makeMusicEmbed(enabled ? "Autoplay Enabled" : "Autoplay Disabled", `Autoplay is now **${enabled ? "On" : "Off"}**.`, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "pause") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      if (context.queue.paused) {
        await send(interaction, makeMusicEmbed("Already Paused", "Playback is already paused.", COLORS.WARNING), false);
        return true;
      }
      await context.queue.pause();
      await send(interaction, makeMusicEmbed("Playback Paused", "Music is now paused.", COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "resume") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      if (!context.queue.paused) {
        await send(interaction, makeMusicEmbed("Already Playing", "Playback is already active.", COLORS.WARNING), false);
        return true;
      }
      await context.queue.resume();
      await send(interaction, makeMusicEmbed("Playback Resumed", "Music has resumed.", COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "stop") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      await context.queue.stop();
      await send(interaction, makeMusicEmbed("Playback Stopped", "Queue cleared and playback stopped.", COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "disconnect") {
      const { queue, userVoice, botVoice } = refreshState();
      if (!botVoice) {
        await send(interaction, makeMusicEmbed("Not Connected", "I am not connected to a voice channel.", COLORS.WARNING), false);
        return true;
      }
      if (!userVoice || !isVoiceChannel(userVoice)) {
        await fail(interaction, "Voice Channel Required", "Join the bot's voice channel to disconnect it.");
        return true;
      }
      if (botVoice.id !== userVoice.id) {
        await fail(interaction, "Wrong Voice Channel", `Join ${botVoice} to disconnect the bot.`);
        return true;
      }
      if (queue) await queue.stop().catch(() => null);
      else distube.voices.leave(interaction.guild);
      await send(interaction, makeMusicEmbed("Disconnected", `Left ${botVoice}.`, COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "clear") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      if (context.queue.songs.length <= 1) {
        await send(interaction, makeMusicEmbed("Queue Already Clear", "There are no upcoming songs to clear.", COLORS.WARNING), false);
        return true;
      }
      const removed = context.queue.songs.length - 1;
      context.queue.songs.splice(1);
      await send(
        interaction,
        makeMusicEmbed("Queue Cleared", `Removed ${removed} queued song(s).`, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "shuffle") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      if (context.queue.songs.length <= 2) {
        await send(interaction, makeMusicEmbed("Not Enough Songs", "Add at least 2 songs in queue to shuffle.", COLORS.WARNING), false);
        return true;
      }
      await context.queue.shuffle();
      await send(interaction, makeMusicEmbed("Queue Shuffled", "Upcoming songs were shuffled.", COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "removedupes") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const current = context.queue.songs[0];
      const upcoming = context.queue.songs.slice(1);
      if (upcoming.length < 2) {
        await send(interaction, makeMusicEmbed("Nothing to Deduplicate", "Queue needs at least 2 upcoming songs.", COLORS.WARNING), false);
        return true;
      }

      const seen = new Set();
      const unique = [];
      let removed = 0;
      for (const song of upcoming) {
        const key = song?.url ? `url:${song.url}` : `name:${String(song?.name || "").toLowerCase()}|dur:${song?.duration || 0}`;
        if (seen.has(key)) {
          removed += 1;
          continue;
        }
        seen.add(key);
        unique.push(song);
      }

      context.queue.songs = [current, ...unique];
      if (!removed) {
        await send(interaction, makeMusicEmbed("No Duplicates Found", "Queue already has unique upcoming songs.", COLORS.WARNING), false);
        return true;
      }

      await send(interaction, makeMusicEmbed("Duplicates Removed", `Removed ${removed} duplicate song(s).`, COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "replay") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      await context.queue.seek(0);
      await send(interaction, makeMusicEmbed("Track Restarted", "Current song restarted from the beginning.", COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "loop") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const mode = interaction.options.getString("mode") || "toggle";
      let nextMode = RepeatMode.DISABLED;

      if (mode === "toggle") {
        nextMode = context.queue.setRepeatMode();
      } else if (mode === "off") {
        nextMode = context.queue.setRepeatMode(RepeatMode.DISABLED);
      } else if (mode === "song") {
        nextMode = context.queue.setRepeatMode(RepeatMode.SONG);
      } else if (mode === "queue") {
        nextMode = context.queue.setRepeatMode(RepeatMode.QUEUE);
      }

      await send(interaction, makeMusicEmbed("Loop Mode Updated", `Loop mode: **${musicModeLabel(nextMode)}**.`, COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "jump") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const position = interaction.options.getInteger("position", true);
      const maxPosition = context.queue.songs.length - 1;
      if (!Number.isInteger(position) || position < 1 || position > maxPosition) {
        await fail(interaction, "Invalid Position", `Position must be between 1 and ${Math.max(maxPosition, 1)}.`);
        return true;
      }
      const song = await context.queue.jump(position);
      await send(interaction, makeMusicEmbed("Jumped", `Now playing ${musicSongTitle(song)}.`, COLORS.SUCCESS), false);
      return true;
    }

    if (interaction.commandName === "move") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const from = interaction.options.getInteger("from", true);
      const to = interaction.options.getInteger("to", true);
      const maxPosition = context.queue.songs.length - 1;

      if (maxPosition < 2) {
        await send(interaction, makeMusicEmbed("Not Enough Songs", "Queue needs at least 2 upcoming songs to move.", COLORS.WARNING), false);
        return true;
      }
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > maxPosition || to > maxPosition) {
        await fail(interaction, "Invalid Position", `Use positions between 1 and ${maxPosition}.`);
        return true;
      }
      if (from === to) {
        await send(interaction, makeMusicEmbed("No Change", "Source and target positions are the same.", COLORS.WARNING), false);
        return true;
      }

      const [song] = context.queue.songs.splice(from, 1);
      context.queue.songs.splice(to, 0, song);
      await send(
        interaction,
        makeMusicEmbed("Song Moved", `${musicSongTitle(song)} moved to position ${to}.`, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "remove") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const position = interaction.options.getInteger("position", true);
      const maxPosition = context.queue.songs.length - 1;
      if (!Number.isInteger(position) || position < 1 || position > maxPosition) {
        await fail(interaction, "Invalid Position", `Position must be between 1 and ${Math.max(maxPosition, 1)}.`);
        return true;
      }
      const [song] = context.queue.songs.splice(position, 1);
      await send(
        interaction,
        makeMusicEmbed("Song Removed", `${musicSongTitle(song)} removed from queue.`, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "seek") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const parsed = parseMusicTimeInput(interaction.options.getString("time", true));
      if (parsed.error) {
        await fail(interaction, "Invalid Time", parsed.error);
        return true;
      }
      const duration = context.queue.songs[0]?.duration || 0;
      if (duration > 0 && parsed.seconds >= duration) {
        await fail(interaction, "Invalid Time", `Seek time must be below track duration (${musicSongDuration(context.queue.songs[0])}).`);
        return true;
      }
      await context.queue.seek(parsed.seconds);
      await send(
        interaction,
        makeMusicEmbed("Seek Updated", `Moved playback to \`${formatSeconds(parsed.seconds)}\`.`, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "fastforward") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const seconds = interaction.options.getInteger("seconds", true);
      if (!Number.isInteger(seconds) || seconds <= 0) {
        await fail(interaction, "Invalid Seconds", "`seconds` must be a positive integer.");
        return true;
      }
      const currentTime = Math.max(0, Math.floor(context.queue.currentTime || 0));
      const duration = context.queue.songs[0]?.duration || 0;
      let targetTime = currentTime + seconds;
      if (duration > 0) targetTime = Math.min(duration - 1, targetTime);
      if (targetTime === currentTime) {
        await send(interaction, makeMusicEmbed("No Change", "Track is already near its end.", COLORS.WARNING), false);
        return true;
      }
      await context.queue.seek(targetTime);
      await send(
        interaction,
        makeMusicEmbed("Fast Forwarded", `\`${formatSeconds(currentTime)}\` -> \`${formatSeconds(targetTime)}\``, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "rewind") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const seconds = interaction.options.getInteger("seconds", true);
      if (!Number.isInteger(seconds) || seconds <= 0) {
        await fail(interaction, "Invalid Seconds", "`seconds` must be a positive integer.");
        return true;
      }
      const currentTime = Math.max(0, Math.floor(context.queue.currentTime || 0));
      const targetTime = Math.max(0, currentTime - seconds);
      if (targetTime === currentTime) {
        await send(interaction, makeMusicEmbed("No Change", "Track is already at the beginning.", COLORS.WARNING), false);
        return true;
      }
      await context.queue.seek(targetTime);
      await send(
        interaction,
        makeMusicEmbed("Rewinded", `\`${formatSeconds(currentTime)}\` -> \`${formatSeconds(targetTime)}\``, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "skip") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const amount = interaction.options.getInteger("amount") || 1;
      if (!Number.isInteger(amount) || amount < 1) {
        await fail(interaction, "Invalid Amount", "`amount` must be a positive integer.");
        return true;
      }
      const maxSkippable = context.queue.songs.length - 1;
      if (maxSkippable < 1) {
        await send(interaction, makeMusicEmbed("No Next Song", "There is no next song to skip to.", COLORS.WARNING), false);
        return true;
      }
      if (amount > maxSkippable) {
        await fail(interaction, "Skip Too Large", `You can skip at most ${maxSkippable} song(s) right now.`);
        return true;
      }

      const song = amount === 1 ? await context.queue.skip() : await context.queue.jump(amount);
      await send(
        interaction,
        makeMusicEmbed("Skipped", `Now playing ${musicSongTitle(song)}.`, COLORS.SUCCESS),
        false,
      );
      return true;
    }

    if (interaction.commandName === "volume") {
      const context = await ensurePlaybackControl();
      if (!context) return true;
      const percent = interaction.options.getInteger("percent");
      if (percent === null || percent === undefined) {
        await send(interaction, makeMusicEmbed("Current Volume", `Volume is **${context.queue.volume}%**.`, MUSIC_COLOR), false);
        return true;
      }
      if (!Number.isInteger(percent) || percent < 0 || percent > 200) {
        await fail(interaction, "Invalid Volume", "Volume must be between 0 and 200.");
        return true;
      }
      context.queue.setVolume(percent);
      await send(interaction, makeMusicEmbed("Volume Updated", `Volume set to **${percent}%**.`, COLORS.SUCCESS), false);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`Music command failed: ${interaction.commandName}`, error);
    if (interaction.deferred || interaction.replied) {
      await sendMusicResponse(
        interaction,
        makeMusicEmbed(
          "Music Command Failed",
          "An unexpected error occurred while processing this music command.",
          COLORS.ERROR,
        ),
      ).catch(() => null);
      return true;
    }
    await fail(interaction, "Music Command Failed", "An unexpected error occurred while processing this music command.");
    return true;
  }
}

async function registerCommands(guild) {
  try {
    await guild.commands.set(COMMANDS);
    console.log(`Registered commands for ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error(`Failed to register commands for guild ${guild.id}:`, error);
  }
}

registerLifecycleEvents(client, {
  registerCommands,
  primeAeonAgentRuntime: ENABLE_AEON_AI ? primeAeonAgentRuntime : null,
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
});
client.on("interactionCreate", async (interaction) => {
  const isButtonInteraction = typeof interaction.isButton === "function" && interaction.isButton();
  const isStringSelectInteraction =
    typeof interaction.isStringSelectMenu === "function" && interaction.isStringSelectMenu();
  const isModalInteraction = typeof interaction.isModalSubmit === "function" && interaction.isModalSubmit();
  const isAutocompleteInteraction = typeof interaction.isAutocomplete === "function" && interaction.isAutocomplete();

  if (isAutocompleteInteraction) {
    if (!MUSIC_AUTOCOMPLETE_COMMANDS.has(interaction.commandName)) {
      await safeAutocompleteRespond(interaction, []);
      return;
    }

    const focused = typeof interaction.options?.getFocused === "function" ? interaction.options.getFocused(true) : null;
    if (!focused || focused.name !== "query") {
      await safeAutocompleteRespond(interaction, []);
      return;
    }

    const choices = await buildMusicAutocompleteChoices(focused.value);
    await safeAutocompleteRespond(interaction, choices);
    return;
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("rr:toggle:")) {
    if (!interaction.guild) return;
    const [, , roleId] = interaction.customId.split(":");
    if (!/^\d{17,20}$/.test(String(roleId || ""))) {
      return interaction.reply({
        embeds: [makeEmbed("Invalid Panel", "This reaction-role button is malformed.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const role =
      interaction.guild.roles.cache.get(roleId) ||
      (await interaction.guild.roles.fetch(roleId).catch(() => null));
    if (!role || role.id === interaction.guild.id) {
      return interaction.reply({
        embeds: [makeEmbed("Role Unavailable", "This role no longer exists.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const member =
      interaction.member?.roles?.cache
        ? interaction.member
        : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      return interaction.reply({
        embeds: [makeEmbed("Member Not Found", "Could not resolve your member record.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const rrBotMember = await getBotMember(interaction.guild).catch(() => null);
    if (!rrBotMember?.permissions?.has(Permissions.FLAGS.MANAGE_ROLES)) {
      return interaction.reply({
        embeds: [makeEmbed("Bot Permission Missing", "I need `Manage Roles` to toggle this role.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (role.managed || rrBotMember.roles.highest.comparePositionTo(role) <= 0) {
      return interaction.reply({
        embeds: [makeEmbed("Role Hierarchy Blocked", "I cannot manage this role due to hierarchy or integration lock.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const hasRole = member.roles.cache.has(role.id);
    try {
      if (hasRole) {
        await member.roles.remove(role, `Reaction role toggle by ${interaction.user.tag} (${interaction.user.id})`);
      } else {
        await member.roles.add(role, `Reaction role toggle by ${interaction.user.tag} (${interaction.user.id})`);
      }
    } catch (_) {
      return interaction.reply({
        embeds: [makeEmbed("Role Toggle Failed", "Could not update your role. Check role hierarchy and permissions.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    return interaction.reply({
      embeds: [
        makeEmbed(
          hasRole ? "Role Removed" : "Role Added",
          hasRole ? `${role} was removed.` : `${role} was added.`,
          hasRole ? COLORS.WARNING : COLORS.SUCCESS,
        ),
      ],
      flags: EPHEMERAL_FLAG,
    });
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("aeonaction:plan:")) {
    if (!interaction.guild) return;
    const [, , ownerId, planIdRaw, action] = interaction.customId.split(":");
    const planId = parseAeonActionPlanId(planIdRaw);
    if (!planId) {
      return interaction.reply({
        embeds: [makeEmbed("Invalid Plan", "This action plan is invalid or expired.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        embeds: [makeEmbed("Private Plan", "This action plan belongs to another user.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    if (!interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        embeds: [makeEmbed("Permission Denied", "You need `Manage Server` to execute AI action plans.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    const plan = getAeonActionPlan(interaction.guild.id, planId);
    if (!plan) {
      return interaction.reply({
        embeds: [makeEmbed("Session Expired", "Run `/aeon action run` again to create a fresh plan.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    if (action === "deny") {
      deleteAeonActionPlan(interaction.guild.id, plan.id);
      appendGuildAeonActionAudit(interaction.guild.id, {
        id: makeAeonRunId(),
        planId: plan.id,
        request: plan.request,
        summary: "Plan was cancelled by user.",
        status: "cancelled",
        risk: plan.risk || "low",
        dryRun: false,
        createdBy: interaction.user.id,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actions: [],
        warnings: plan.warnings || [],
        rollbackSteps: [],
      });
      const closed = makeEmbed("Action Plan Cancelled", "No changes were made.", COLORS.INFO);
      setEmbedFooterSafe(closed, `Plan ID: ${plan.id}`);
      return interaction.update({ embeds: [closed], components: [] }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    const dryRun = action === "dryrun";
    try {
      const { runResult } = await executePendingAeonActionPlan(plan, interaction, dryRun);
      const resultEmbed = buildAeonActionResultEmbed(
        runResult,
        interaction.user,
        dryRun ? "AEON AI Dry Run Result" : "AEON AI Action Executed",
      );
      if (dryRun) {
        return interaction.update({
          embeds: [resultEmbed],
          components: buildAeonActionPlanComponents(ownerId, plan.id, false),
        }).catch((error) => {
          if (!isUnknownInteractionError(error)) throw error;
          return null;
        });
      }
      deleteAeonActionPlan(interaction.guild.id, plan.id);
      return interaction.update({ embeds: [resultEmbed], components: [] }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    } catch (error) {
      const message = shorten(error?.message || "Action execution failed.", 1000);
      return interaction.reply({
        embeds: [makeEmbed("Execution Failed", message, COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      }).catch((replyError) => {
        if (!isUnknownInteractionError(replyError)) throw replyError;
        return null;
      });
    }
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("setup:")) {
    const [, ownerId, action, key] = interaction.customId.split(":");
    const setupMessageId = interaction.message?.id || "";
    const setupTimerKey = makePanelTimerKey("setup", ownerId, setupMessageId);
    const scheduleSetupAutoClose = () => {
      if (!setupMessageId) return;
      schedulePanelInactivityClose(setupTimerKey, SETUP_PANEL_IDLE_CLOSE_MS, async () => {
        const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Setup Panel`,
          "Run `/setup` again whenever you need.",
          SETUP_PANEL_IDLE_CLOSE_MS,
        );
        if (interaction.message?.editable && typeof interaction.message.edit === "function") {
          return interaction.message.edit({ embeds: [closed], components: [] });
        }
        return interaction.editReply({ embeds: [closed], components: [] });
      });
    };

    if (interaction.user.id !== ownerId) {
      try {
        return await interaction.reply({
          embeds: [makeEmbed("Private Setup Panel", "This setup panel was opened by another user.", COLORS.WARNING)],
          flags: EPHEMERAL_FLAG,
        });
      } catch (_) {
        return;
      }
    }

    if (!interaction.guild || !interaction.channel || !isTextChannel(interaction.channel)) {
      return interaction.update({
        embeds: [makeEmbed("Setup Error", "Run `/setup` in a server text channel.", COLORS.ERROR)],
        components: [],
      });
    }

    if (!interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        embeds: [makeEmbed("Permission Denied", "You need `Manage Server` to use setup controls.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (action === "close") {
      clearPanelInactivityTimer(setupTimerKey);
      const closed = makeEmbed("Setup Closed", "Run `/setup` again whenever you need.", COLORS.INFO);
      setEmbedFooterSafe(closed, `Closed by ${interaction.user.tag}`);
      return interaction.update({ embeds: [closed], components: [] });
    }

    if (action === "botprofile") {
      clearPanelInactivityTimer(setupTimerKey);
      if (!interaction.member?.permissions?.has(Permissions.FLAGS.ADMINISTRATOR)) {
        return interaction.reply({
          embeds: [makeEmbed("Permission Denied", "You need `Administrator` to manage bot profile branding.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      const profileEmbed = buildBotProfileEmbed(interaction.guild, interaction.user);
      const response = await interaction.update({
        embeds: [profileEmbed],
        components: buildBotProfileComponents(ownerId),
      });
      schedulePanelInactivityClose(makePanelTimerKey("botprofile", ownerId, setupMessageId), BOTPROFILE_PANEL_IDLE_CLOSE_MS, async () => {
        const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Profile Panel`,
          "Run `/botprofile` to open it again.",
          BOTPROFILE_PANEL_IDLE_CLOSE_MS,
        );
        if (interaction.message?.editable && typeof interaction.message.edit === "function") {
          return interaction.message.edit({ embeds: [closed], components: [] });
        }
        return interaction.editReply({ embeds: [closed], components: [] });
      });
      return response;
    }

    if (action === "refresh") {
      const refreshed = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const updated = await interaction.update({ embeds: [refreshed], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return updated;
    }

    if (action === "set" && key === "logs") {
      const current = getGuildLogConfig(interaction.guild.id);
      setGuildLogConfig(interaction.guild.id, {
        channelId: interaction.channel.id,
        events: current.events,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      const updated = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [updated], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }

    if (action === "set" && key === "reports") {
      setGuildSetupConfig(interaction.guild.id, {
        reportChannelId: interaction.channel.id,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      const updated = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [updated], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }

    if (action === "set" && key === "welcome") {
      const setupBotMember = await getBotMember(interaction.guild).catch(() => null);
      if (!setupBotMember || !interaction.channel.permissionsFor(setupBotMember)?.has(Permissions.FLAGS.SEND_MESSAGES)) {
        return interaction.reply({
          embeds: [makeEmbed("Bot Permission Missing", "I need `Send Messages` in this channel for welcome embeds.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      setGuildSetupConfig(interaction.guild.id, {
        welcomeChannelId: interaction.channel.id,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      const updated = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [updated], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }

    if (action === "set" && key === "levelup") {
      const setupBotMember = await getBotMember(interaction.guild).catch(() => null);
      if (!setupBotMember || !interaction.channel.permissionsFor(setupBotMember)?.has(Permissions.FLAGS.SEND_MESSAGES)) {
        return interaction.reply({
          embeds: [makeEmbed("Bot Permission Missing", "I need `Send Messages` in this channel for level-up announcements.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      await setLevelUpChannelId(interaction.guild.id, interaction.channel.id);
      const updated = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [updated], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }

    if (action === "set" && key === "halloffame") {
      const setupBotMember = await getBotMember(interaction.guild).catch(() => null);
      if (!setupBotMember || !interaction.channel.permissionsFor(setupBotMember)?.has(Permissions.FLAGS.SEND_MESSAGES)) {
        return interaction.reply({
          embeds: [makeEmbed("Bot Permission Missing", "I need `Send Messages` in this channel for Hall of Fame posts.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      if (
        Permissions.FLAGS.EMBED_LINKS !== undefined &&
        !interaction.channel.permissionsFor(setupBotMember)?.has(Permissions.FLAGS.EMBED_LINKS)
      ) {
        return interaction.reply({
          embeds: [makeEmbed("Bot Permission Missing", "I need `Embed Links` in this channel for Hall of Fame embeds.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      setGuildSetupConfig(interaction.guild.id, {
        hallOfFameChannelId: interaction.channel.id,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      const updated = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [updated], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }

    if (action === "set" && key === "jtcinterface") {
      const setupBotMember = await getBotMember(interaction.guild).catch(() => null);
      if (!setupBotMember || !interaction.channel.permissionsFor(setupBotMember)?.has(Permissions.FLAGS.SEND_MESSAGES)) {
        return interaction.reply({
          embeds: [makeEmbed("Bot Permission Missing", "I need `Send Messages` in this channel for JTC interface panels.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      const current = getGuildJtcConfig(interaction.guild.id);
      setGuildJtcConfig(interaction.guild.id, {
        triggers: current.triggers,
        interfaceChannelId: interaction.channel.id,
        channels: current.channels,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      const updated = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [updated], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }

    if (action === "set" && key === "statsparent") {
      if (!interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)) {
        return interaction.reply({
          embeds: [makeEmbed("Permission Denied", "You need `Manage Channels` to set the stats category.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      const setupBotMember = await getBotMember(interaction.guild).catch(() => null);
      if (!setupBotMember?.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)) {
        return interaction.reply({
          embeds: [makeEmbed("Bot Permission Missing", "I need `Manage Channels` to create and update stats channels.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      const parentId = interaction.channel.parentId;
      if (!parentId) {
        return interaction.reply({
          embeds: [makeEmbed("Missing Category", "This channel has no parent category.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      const category = interaction.guild.channels.cache.get(parentId);
      if (!isCategoryChannel(category)) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Category", "Parent is not a valid category channel.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      setGuildSetupConfig(interaction.guild.id, {
        statsCategoryId: category.id,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      const statsResult = await updateGuildStatsChannels(interaction.guild, interaction.user.id);
      if (!statsResult) {
        return interaction.reply({
          embeds: [
            makeEmbed(
              "Stats Setup Failed",
              "Could not create or update stats channels. Check my category access and channel permissions.",
              COLORS.ERROR,
            ),
          ],
          flags: EPHEMERAL_FLAG,
        });
      }

      const updated = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [updated], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("botprofile:")) {
    if (!interaction.guild) return;
    const [, ownerId, action, key] = interaction.customId.split(":");
    const botProfileMessageId = interaction.message?.id || "";
    const botProfileTimerKey = makePanelTimerKey("botprofile", ownerId, botProfileMessageId);
    const setupTimerKey = makePanelTimerKey("setup", ownerId, botProfileMessageId);
    const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
    const scheduleBotProfileAutoClose = () => {
      if (!botProfileMessageId) return;
      schedulePanelInactivityClose(botProfileTimerKey, BOTPROFILE_PANEL_IDLE_CLOSE_MS, async () => {
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Profile Panel`,
          "Run `/botprofile` to open it again.",
          BOTPROFILE_PANEL_IDLE_CLOSE_MS,
        );
        if (interaction.message?.editable && typeof interaction.message.edit === "function") {
          return interaction.message.edit({ embeds: [closed], components: [] });
        }
        return interaction.editReply({ embeds: [closed], components: [] });
      });
    };
    const scheduleSetupAutoClose = () => {
      if (!botProfileMessageId) return;
      schedulePanelInactivityClose(setupTimerKey, SETUP_PANEL_IDLE_CLOSE_MS, async () => {
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Setup Panel`,
          "Run `/setup` again whenever you need.",
          SETUP_PANEL_IDLE_CLOSE_MS,
        );
        if (interaction.message?.editable && typeof interaction.message.edit === "function") {
          return interaction.message.edit({ embeds: [closed], components: [] });
        }
        return interaction.editReply({ embeds: [closed], components: [] });
      });
    };

    if (interaction.user.id !== ownerId) {
      try {
        return await interaction.reply({
          embeds: [makeEmbed("Private Bot Profile", "This bot profile panel was opened by another admin.", COLORS.WARNING)],
          flags: EPHEMERAL_FLAG,
        });
      } catch (_) {
        return;
      }
    }

    if (!interaction.member?.permissions?.has(Permissions.FLAGS.ADMINISTRATOR)) {
      return interaction.reply({
        embeds: [makeEmbed("Permission Denied", "You need `Administrator` to manage bot profile branding.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const profile = getGuildBotProfile(interaction.guild.id);

    if (action === "close") {
      clearPanelInactivityTimer(botProfileTimerKey);
      const closed = makeEmbed(`${botName} Profile Closed`, "Run `/botprofile` to open it again.", COLORS.INFO);
      setEmbedFooterSafe(closed, `Closed by ${interaction.user.tag}`);
      return interaction.update({ embeds: [closed], components: [] });
    }

    if (action === "setup") {
      clearPanelInactivityTimer(botProfileTimerKey);
      const setupEmbed = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const response = await interaction.update({ embeds: [setupEmbed], components: buildSetupComponents(ownerId) });
      scheduleSetupAutoClose();
      return response;
    }

    if (action === "refresh") {
      const refreshed = buildBotProfileEmbed(interaction.guild, interaction.user);
      const response = await interaction.update({ embeds: [refreshed], components: buildBotProfileComponents(ownerId) });
      scheduleBotProfileAutoClose();
      return response;
    }

    if (action === "reset") {
      clearGuildBotProfile(interaction.guild.id, interaction.user.id);
      const resetProfile = getGuildBotProfile(interaction.guild.id);
      const syncResult = await syncGuildBotMemberProfile(
        interaction.guild,
        resetProfile,
        interaction.user,
        ["name", "description", "icon", "banner"],
      );
      const updated = buildBotProfileEmbed(interaction.guild, interaction.user);
      appendBotProfileSyncField(updated, syncResult);
      const response = await interaction.update({ embeds: [updated], components: buildBotProfileComponents(ownerId) });
      scheduleBotProfileAutoClose();
      return response;
    }

    if (action === "clear") {
      const clearPatch = {};
      const syncFields = [];
      if (key === "icon") clearPatch.iconUrl = null;
      else if (key === "banner") clearPatch.bannerUrl = null;
      else if (key === "description") clearPatch.description = null;
      else return interaction.reply({ embeds: [makeEmbed("Invalid Option", "Unknown clear option.", COLORS.WARNING)], flags: EPHEMERAL_FLAG });
      if (key === "icon") syncFields.push("icon");
      if (key === "banner") syncFields.push("banner");
      if (key === "description") syncFields.push("description");

      setGuildBotProfile(interaction.guild.id, {
        ...clearPatch,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      const nextProfile = getGuildBotProfile(interaction.guild.id);
      const syncResult = await syncGuildBotMemberProfile(
        interaction.guild,
        nextProfile,
        interaction.user,
        syncFields,
      );
      const updated = buildBotProfileEmbed(interaction.guild, interaction.user);
      appendBotProfileSyncField(updated, syncResult);
      const response = await interaction.update({ embeds: [updated], components: buildBotProfileComponents(ownerId) });
      scheduleBotProfileAutoClose();
      return response;
    }

    if (action === "set") {
      scheduleBotProfileAutoClose();
      if (key === "name") {
        return showBotProfileModal(interaction, ownerId, "name", {
          title: "Set Bot Display Name",
          label: "Display Name",
          placeholder: "Example: Enigma",
          value: profile.name || botName,
          style: "SHORT",
        });
      }
      if (key === "description") {
        return showBotProfileModal(interaction, ownerId, "description", {
          title: "Set Bot Description",
          label: "Description",
          placeholder: "Short description shown in guild interfaces",
          value: profile.description || "",
          style: "PARAGRAPH",
        });
      }
      if (key === "icon") {
        return showBotProfileModal(interaction, ownerId, "icon", {
          title: "Set Profile Icon URL",
          label: "Image URL",
          placeholder: "https://example.com/icon.png",
          value: profile.iconUrl || "",
          style: "SHORT",
        });
      }
      if (key === "banner") {
        return showBotProfileModal(interaction, ownerId, "banner", {
          title: "Set Profile Banner URL",
          label: "Image URL",
          placeholder: "https://example.com/banner.png",
          value: profile.bannerUrl || "",
          style: "SHORT",
        });
      }
      if (key === "color") {
        return showBotProfileModal(interaction, ownerId, "color", {
          title: "Set Accent Color",
          label: "Hex Color",
          placeholder: "#1F4E79",
          value: profile.accentColor || "",
          style: "SHORT",
        });
      }
      return interaction.reply({
        embeds: [makeEmbed("Invalid Option", "Unknown setup action.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      });
    }
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("help:")) {
    const parts = interaction.customId.split(":");
    const ownerId = parts[1];
    const action = parts[2];
    const pageKey = parts[3];
    const helpMessageId = interaction.message?.id || "";
    const helpTimerKey = makePanelTimerKey("help", ownerId, helpMessageId);
    const scheduleHelpAutoClose = () => {
      if (!helpMessageId) return;
      schedulePanelInactivityClose(helpTimerKey, HELP_PANEL_IDLE_CLOSE_MS, async () => {
        const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Help Panel`,
          "Run `/help` to open the panel again.",
          HELP_PANEL_IDLE_CLOSE_MS,
        );
        return interaction.editReply({ embeds: [closed], components: [] });
      });
    };

    if (interaction.user.id !== ownerId) {
      try {
        return await interaction.reply({
          embeds: [makeEmbed("Private Help Panel", "This help panel was opened by another user.", COLORS.WARNING)],
          flags: EPHEMERAL_FLAG,
        });
      } catch (_) {
        return;
      }
    }

    if (action === "close") {
      clearPanelInactivityTimer(helpTimerKey);
      const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
      const closedEmbed = makeEmbed(
        `${botName} Help Panel Closed`,
        "Run `/help` to open the panel again.",
        COLORS.INFO,
      );
      setEmbedFooterSafe(closedEmbed, `Closed by ${interaction.user.tag}`);
      return interaction.update({ embeds: [closedEmbed], components: [] });
    }

    const helpMember =
      interaction.member?.permissions?.has
        ? interaction.member
        : await interaction.guild?.members?.fetch?.(interaction.user.id).catch(() => interaction.member);
    const helpContext = buildHelpAccessContext(helpMember, interaction.guild, interaction.client?.user || client.user);

    let nextPage = normalizeHelpPageKeyForContext(helpContext, pageKey);
    if (action === "prev") nextPage = getAdjacentHelpPageForContext(helpContext, pageKey, -1);
    if (action === "next") nextPage = getAdjacentHelpPageForContext(helpContext, pageKey, 1);
    if (action === "page") nextPage = normalizeHelpPageKeyForContext(helpContext, pageKey);
    const embed = buildHelpEmbed(nextPage, interaction.user, interaction.client.user, helpContext);
    const components = buildHelpComponents(ownerId, nextPage, helpContext);
    const updated = await interaction.update({ embeds: [embed], components });
    scheduleHelpAutoClose();
    return updated;
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("aeonevents:nav:")) {
    if (!interaction.guild) return;
    const [, , ownerId, panelId, action] = interaction.customId.split(":");

    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        embeds: [makeEmbed("Private Event Panel", "This events panel was opened by another user.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    const panel = getAeonEventsPanel(interaction.guild.id, ownerId, panelId);
    if (!panel) {
      return interaction.reply({
        embeds: [makeEmbed("Session Expired", "Run `/aeon events` to open a fresh events panel.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    const totalPages = Math.max(1, panel.events.length + 1);
    let nextIndex = Math.max(0, Math.min(totalPages - 1, Number(panel.pageIndex || 0)));

    if (action === "close") {
      clearAeonEventsPanel(panel.id);
      const closedEmbed = makeEmbed("Events Panel Closed", "Run `/aeon events` anytime to open it again.", COLORS.INFO);
      setEmbedFooterSafe(closedEmbed, `Closed by ${interaction.user.tag}`);
      return interaction.update({ embeds: [closedEmbed], components: [] }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    if (action === "first") nextIndex = 0;
    if (action === "prev") nextIndex = Math.max(0, nextIndex - 1);
    if (action === "next") nextIndex = Math.min(totalPages - 1, nextIndex + 1);
    if (action === "last") nextIndex = totalPages - 1;

    panel.pageIndex = nextIndex;
    saveAeonEventsPanel(panel);

    return interaction.update({
      embeds: [buildAeonEventsEmbed(panel, interaction.user, interaction.client.user)],
      components: buildAeonEventsComponents(ownerId, panel.id, panel.pageIndex, panel.events),
    }).catch((error) => {
      if (!isUnknownInteractionError(error)) throw error;
      return null;
    });
  }

  if (
    isStringSelectInteraction &&
    typeof interaction.customId === "string" &&
    interaction.customId.startsWith("aeonevents:jump:")
  ) {
    if (!interaction.guild) return;
    const [, , ownerId, panelId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        embeds: [makeEmbed("Private Event Panel", "This events panel was opened by another user.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    const panel = getAeonEventsPanel(interaction.guild.id, ownerId, panelId);
    if (!panel) {
      return interaction.reply({
        embeds: [makeEmbed("Session Expired", "Run `/aeon events` to open a fresh events panel.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    const selected = interaction.values?.[0];
    const totalPages = Math.max(1, panel.events.length + 1);
    const parsed = Number.parseInt(String(selected || "0"), 10);
    if (Number.isFinite(parsed)) {
      panel.pageIndex = Math.max(0, Math.min(totalPages - 1, parsed));
    }
    saveAeonEventsPanel(panel);

    return interaction.update({
      embeds: [buildAeonEventsEmbed(panel, interaction.user, interaction.client.user)],
      components: buildAeonEventsComponents(ownerId, panel.id, panel.pageIndex, panel.events),
    }).catch((error) => {
      if (!isUnknownInteractionError(error)) throw error;
      return null;
    });
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("aeontrain:act:")) {
    return interaction.reply({
      embeds: [
        makeEmbed(
          "Training Moved to CLI",
          "AEON training is now CLI-only. Use `python agentic_ai/train_cli.py --help` from terminal.",
          COLORS.WARNING,
        ),
      ],
      flags: EPHEMERAL_FLAG,
    }).catch((error) => {
      if (!isUnknownInteractionError(error)) throw error;
      return null;
    });

    if (!interaction.guild) return;
    if (!interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        embeds: [makeEmbed("Permission Denied", "You need `Manage Server` to use AEON training.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }
    const [, , ownerId, sessionId, action] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        embeds: [makeEmbed("Private Session", "This training session belongs to another admin.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }
    const session = getAeonTrainSession(interaction.guild.id, interaction.user.id, sessionId);
    if (!session) {
      return interaction.reply({
        embeds: [makeEmbed("Session Expired", "Run `/aeon train interactive` to start again.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    const current = session.unknownFields?.[session.pointer] || null;
    if (!current || action === "stop") {
      try {
        await interaction.deferUpdate();
      } catch (error) {
        if (isUnknownInteractionError(error)) return;
        throw error;
      }
      let note = "Interactive session closed.";
      if (session.appliedFacts.length) {
        try {
          await rewriteAeonKnowledgeFromInput(session.appliedFacts.join("\n"), {
            mode: "interactive",
            username: interaction.user.tag,
            userId: interaction.user.id,
          });
          note = "Session closed and knowledge was normalized using AI rewrite.";
        } catch (_) {
          // deterministic updates are already persisted
        }
        await reloadAeonAgentKnowledge().catch(() => null);
      }
      clearAeonTrainSession(interaction.guild.id, interaction.user.id);
      return interaction.editReply({
        embeds: [buildAeonTrainInteractiveEmbed(session, "complete", note)],
        components: [],
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    if (action === "skip") {
      session.pointer += 1;
      session.skippedCount += 1;
      saveAeonTrainSession(session);
      const next = session.unknownFields?.[session.pointer] || null;
      if (!next) {
        if (session.appliedFacts.length) {
          reloadAeonAgentKnowledge().catch(() => null);
        }
        clearAeonTrainSession(interaction.guild.id, interaction.user.id);
        return interaction.update({
          embeds: [buildAeonTrainInteractiveEmbed(session, "complete", "Reached the end of unknown fields.")],
          components: [],
        }).catch((error) => {
          if (!isUnknownInteractionError(error)) throw error;
          return null;
        });
      }
      return interaction.update({
        embeds: [buildAeonTrainInteractiveEmbed(session, "in_progress", "Skipped current field.")],
        components: buildAeonTrainInteractiveComponents(interaction.user.id, session.id),
      }).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });
    }

    if (action === "answer") {
      return showAeonTrainInteractiveAnswerModal(
        interaction,
        interaction.user.id,
        session.id,
        current.field,
        current.section || current.subsection || "General",
      );
    }
  }

  if (isButtonInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("jtc:button:")) {
    if (!interaction.guild) return;
    const [, , action, voiceChannelId] = interaction.customId.split(":");
    const access = canManageTempVoice(interaction, voiceChannelId);
    if (!access.ok) {
      return interaction.reply({
        embeds: [makeEmbed("Access Denied", access.reason, COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (action === "refresh") {
      const state = getTempVoiceState(interaction.guild.id, voiceChannelId);
      if (!state) {
        return interaction.reply({
          embeds: [makeEmbed("Not Found", "Temporary channel state no longer exists.", COLORS.WARNING)],
          flags: EPHEMERAL_FLAG,
        });
      }
      const embed = buildTempVoiceInterfaceEmbed(interaction.guild, access.voiceChannel, state);
      return interaction.update({
        embeds: [embed],
        components: buildTempVoiceInterfaceComponents(voiceChannelId),
      });
    }

    if (action === "close") {
      const closed = makeEmbed("Control Panel Closed", "Run `/interface` to open it again.", COLORS.INFO);
      return interaction.update({ embeds: [closed], components: [] });
    }
  }

  if (isStringSelectInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("jtc:")) {
    if (!interaction.guild) return;
    const [, section, voiceChannelId] = interaction.customId.split(":");
    const selected = interaction.values?.[0];
    if (!selected) return;

    const access = canManageTempVoice(interaction, voiceChannelId, selected === "claim");
    if (!access.ok) {
      return interaction.reply({
        embeds: [makeEmbed("Access Denied", access.reason, COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const voiceChannel = access.voiceChannel;
    const state = access.state;
    const jtcBotMember = await getBotMember(interaction.guild).catch(() => null);
    if (!jtcBotMember?.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS) && selected !== "invite") {
      return interaction.reply({
        embeds: [makeEmbed("Bot Permission Missing", "I need `Manage Channels` to manage temporary channels.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (selected === "rename") {
      return showTempVoiceModal(interaction, "rename", voiceChannelId, {
        title: "Rename Channel",
        label: "New Channel Name",
        placeholder: "Enter a new name",
        value: voiceChannel.name || "",
      });
    }

    if (selected === "limit") {
      return showTempVoiceModal(interaction, "limit", voiceChannelId, {
        title: "Set User Limit",
        label: "Limit (0-99)",
        placeholder: "0 for unlimited",
        value: `${voiceChannel.userLimit || 0}`,
      });
    }

    if (selected === "status") {
      return showTempVoiceModal(interaction, "status", voiceChannelId, {
        title: "Channel Status",
        label: "Status Text",
        placeholder: "e.g. Chilling / Study / Team Meeting",
        value: state.status || "",
      });
    }

    if (selected === "game") {
      return showTempVoiceModal(interaction, "game", voiceChannelId, {
        title: "Channel Game",
        label: "Game Text",
        placeholder: "e.g. Valorant / Coding Sprint",
        value: state.game || "",
      });
    }

    if (selected === "permit") {
      return showTempVoiceModal(interaction, "permit", voiceChannelId, {
        title: "Permit User / Role",
        label: "User or Role",
        placeholder: "Mention or ID",
      });
    }

    if (selected === "reject") {
      return showTempVoiceModal(interaction, "reject", voiceChannelId, {
        title: "Reject User / Role",
        label: "User or Role",
        placeholder: "Mention or ID",
      });
    }

    if (selected === "transfer") {
      return showTempVoiceModal(interaction, "transfer", voiceChannelId, {
        title: "Transfer Ownership",
        label: "New Owner",
        placeholder: "Mention or ID of a member",
      });
    }

    if (selected === "claim") {
      if (
        interaction.member?.voice?.channelId !== voiceChannel.id &&
        !interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)
      ) {
        return interaction.reply({
          embeds: [makeEmbed("Claim Denied", "Join the channel first to claim ownership.", COLORS.WARNING)],
          flags: EPHEMERAL_FLAG,
        });
      }
      const ownerStillIn = voiceChannel.members?.has(state.ownerId);
      if (ownerStillIn && state.ownerId !== interaction.user.id) {
        return interaction.reply({
          embeds: [makeEmbed("Claim Denied", "Current owner is still in the channel.", COLORS.WARNING)],
          flags: EPHEMERAL_FLAG,
        });
      }

      const previousOwner = state.ownerId;
      updateTempVoiceInterfaceState(interaction.guild.id, voiceChannelId, { ownerId: interaction.user.id });
      await voiceChannel.permissionOverwrites.edit(interaction.user.id, ownerVoicePermissionMap()).catch(() => null);
      if (previousOwner && previousOwner !== interaction.user.id) {
        await voiceChannel.permissionOverwrites.edit(previousOwner, { [MANAGE_CHANNELS_PERMISSION_KEY]: null }).catch(() => null);
      }
      await postTempVoiceInterface(interaction.guild, voiceChannelId).catch(() => null);
      return interaction.reply({
        embeds: [makeEmbed("Ownership Claimed", `You are now the owner of ${voiceChannel}.`, COLORS.SUCCESS)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (selected === "text") {
      if (state.textChannelId) {
        const existing =
          interaction.guild.channels.cache.get(state.textChannelId) ||
          (await interaction.guild.channels.fetch(state.textChannelId).catch(() => null));
        if (existing) {
          return interaction.reply({
            embeds: [makeEmbed("Temp Text Exists", `Use ${existing} for this channel.`, COLORS.INFO)],
            flags: EPHEMERAL_FLAG,
          });
        }
      }

      const textChannel = await createTempTextChannel(interaction.guild, voiceChannel, state.ownerId).catch(() => null);
      if (!textChannel) {
        return interaction.reply({
          embeds: [makeEmbed("Creation Failed", "Could not create temp text channel.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      updateTempVoiceInterfaceState(interaction.guild.id, voiceChannelId, { textChannelId: textChannel.id });
      return interaction.reply({
        embeds: [makeEmbed("Temp Text Created", `Created ${textChannel} for ${voiceChannel}.`, COLORS.SUCCESS)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (selected === "lock" || selected === "unlock") {
      const value = selected === "lock" ? false : null;
      await voiceChannel.permissionOverwrites
        .edit(interaction.guild.roles.everyone, { [CONNECT_PERMISSION_KEY]: value })
        .catch(() => null);
      return interaction.reply({
        embeds: [makeEmbed(selected === "lock" ? "Channel Locked" : "Channel Unlocked", `${voiceChannel}`, COLORS.SUCCESS)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (selected === "ghost" || selected === "unghost") {
      const value = selected === "ghost" ? false : null;
      await voiceChannel.permissionOverwrites
        .edit(interaction.guild.roles.everyone, { [VIEW_CHANNEL_PERMISSION_KEY]: value })
        .catch(() => null);
      return interaction.reply({
        embeds: [makeEmbed(selected === "ghost" ? "Channel Hidden" : "Channel Visible", `${voiceChannel}`, COLORS.SUCCESS)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (selected === "invite") {
      if (typeof voiceChannel.createInvite !== "function") {
        return interaction.reply({
          embeds: [makeEmbed("Unavailable", "Cannot create invite for this channel.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      const invite = await voiceChannel
        .createInvite({
          maxAge: 3600,
          maxUses: 20,
          unique: true,
          reason: `Temp channel invite by ${interaction.user.tag} (${interaction.user.id})`,
        })
        .catch(() => null);
      if (!invite) {
        return interaction.reply({
          embeds: [makeEmbed("Invite Failed", "Could not create invite link.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      return interaction.reply({
        embeds: [makeEmbed("Invite Link", invite.url, COLORS.INFO)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (section === "settings" || section === "permissions") {
      return interaction.reply({
        embeds: [makeEmbed("Not Implemented", "This action is not available yet.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      });
    }
  }

  if (isModalInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("botprofile:modal:")) {
    if (!interaction.guild) return;
    const [, , ownerId, field] = interaction.customId.split(":");

    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        embeds: [makeEmbed("Private Bot Profile", "This bot profile panel belongs to another admin.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      });
    }
    if (!interaction.member?.permissions?.has(Permissions.FLAGS.ADMINISTRATOR)) {
      return interaction.reply({
        embeds: [makeEmbed("Permission Denied", "You need `Administrator` to manage bot profile branding.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const rawValue = getModalInputValue(interaction, "value");
    const value = String(rawValue || "").trim();
    const patch = {};

    if (field === "name") {
      if (!value) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Name", "Name cannot be empty.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      if (value.length > 32) {
        return interaction.reply({
          embeds: [makeEmbed("Name Too Long", "Name must be 32 characters or fewer.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      patch.name = normalizeBotProfileName(value, "");
    } else if (field === "description") {
      if (!value) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Description", "Description cannot be empty.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      patch.description = normalizeBotProfileDescription(value, "");
    } else if (field === "icon") {
      if (!isValidHttpUrl(value)) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid URL", "Icon URL must be a valid `http` or `https` URL.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      patch.iconUrl = normalizeBotProfileImageUrl(value, "");
    } else if (field === "banner") {
      if (!isValidHttpUrl(value)) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid URL", "Banner URL must be a valid `http` or `https` URL.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      patch.bannerUrl = normalizeBotProfileImageUrl(value, "");
    } else if (field === "color") {
      const normalizedColor = normalizeBotProfileColor(value, "");
      if (!normalizedColor) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Color", "Use a hex color like `#1F4E79`.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      patch.accentColor = normalizedColor;
    } else {
      return interaction.reply({
        embeds: [makeEmbed("Invalid Field", "Unknown bot profile field.", COLORS.WARNING)],
        flags: EPHEMERAL_FLAG,
      });
    }

    setGuildBotProfile(interaction.guild.id, {
      ...patch,
      updatedBy: interaction.user.id,
      updatedAt: new Date().toISOString(),
    });

    const nextProfile = getGuildBotProfile(interaction.guild.id);
    const syncFields = normalizeBotProfileSyncFields([field]);
    const syncResult = await syncGuildBotMemberProfile(
      interaction.guild,
      nextProfile,
      interaction.user,
      syncFields,
    );
    const embed = buildBotProfileEmbed(interaction.guild, interaction.user);
    appendBotProfileSyncField(embed, syncResult);
    const components = buildBotProfileComponents(interaction.user.id);

    if (interaction.message?.editable && typeof interaction.deferUpdate === "function") {
      await interaction.deferUpdate().catch(() => null);
      await interaction.message.edit({ embeds: [embed], components }).catch(() => null);
      const panelMessageId = interaction.message.id;
      const panelTimerKey = makePanelTimerKey("botprofile", interaction.user.id, panelMessageId);
      schedulePanelInactivityClose(panelTimerKey, BOTPROFILE_PANEL_IDLE_CLOSE_MS, async () => {
        const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Profile Panel`,
          "Run `/botprofile` to open it again.",
          BOTPROFILE_PANEL_IDLE_CLOSE_MS,
        );
        await interaction.message.edit({ embeds: [closed], components: [] }).catch(() => null);
      });

      if (syncResult?.errors?.length) {
        await interaction
          .followUp({
            embeds: [
              makeEmbed(
                "Profile Saved with Sync Warning",
                shorten(syncResult.errors.join("\n"), 1500),
                COLORS.WARNING,
              ),
            ],
            flags: EPHEMERAL_FLAG,
          })
          .catch(() => null);
      }
      return;
    }

    const responseMessage = await interaction.reply({
      embeds: [embed],
      components,
      flags: EPHEMERAL_FLAG,
      fetchReply: true,
    });

    const panelMessageId = responseMessage?.id || interaction.id;
    const panelTimerKey = makePanelTimerKey("botprofile", interaction.user.id, panelMessageId);
    schedulePanelInactivityClose(panelTimerKey, BOTPROFILE_PANEL_IDLE_CLOSE_MS, async () => {
      const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
      const closed = buildPanelAutoClosedEmbed(
        `${botName} Profile Panel`,
        "Run `/botprofile` to open it again.",
        BOTPROFILE_PANEL_IDLE_CLOSE_MS,
      );
      await interaction.editReply({ embeds: [closed], components: [] });
    });
    return;
  }

  if (isModalInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("jtc:modal:")) {
    if (!interaction.guild) return;
    const [, , action, voiceChannelId] = interaction.customId.split(":");
    const access = canManageTempVoice(interaction, voiceChannelId);
    if (!access.ok) {
      return interaction.reply({
        embeds: [makeEmbed("Access Denied", access.reason, COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    const voiceChannel = access.voiceChannel;
    const state = access.state;
    const rawValue = getModalInputValue(interaction, "value");
    const jtcBotMember = await getBotMember(interaction.guild).catch(() => null);
    if (!jtcBotMember?.permissions?.has(Permissions.FLAGS.MANAGE_CHANNELS)) {
      return interaction.reply({
        embeds: [makeEmbed("Bot Permission Missing", "I need `Manage Channels` for this action.", COLORS.ERROR)],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (action === "rename") {
      const nextName = sanitizeChannelBaseName(rawValue);
      if (!nextName) return interaction.reply({ embeds: [makeEmbed("Invalid Name", "Name cannot be empty.", COLORS.ERROR)], flags: EPHEMERAL_FLAG });
      await voiceChannel.setName(nextName).catch(() => null);
      await postTempVoiceInterface(interaction.guild, voiceChannelId).catch(() => null);
      return interaction.reply({ embeds: [makeEmbed("Channel Renamed", `${voiceChannel}`, COLORS.SUCCESS)], flags: EPHEMERAL_FLAG });
    }

    if (action === "limit") {
      const limit = Number(rawValue);
      if (!Number.isInteger(limit) || limit < 0 || limit > 99) {
        return interaction.reply({ embeds: [makeEmbed("Invalid Limit", "Enter a number between 0 and 99.", COLORS.ERROR)], flags: EPHEMERAL_FLAG });
      }
      await voiceChannel.setUserLimit(limit).catch(() => null);
      await postTempVoiceInterface(interaction.guild, voiceChannelId).catch(() => null);
      return interaction.reply({ embeds: [makeEmbed("Limit Updated", `User limit set to **${limit}**.`, COLORS.SUCCESS)], flags: EPHEMERAL_FLAG });
    }

    if (action === "status") {
      const status = rawValue.slice(0, 80);
      updateTempVoiceInterfaceState(interaction.guild.id, voiceChannelId, { status });
      if (typeof voiceChannel.setStatus === "function") await voiceChannel.setStatus(status).catch(() => null);
      await postTempVoiceInterface(interaction.guild, voiceChannelId).catch(() => null);
      return interaction.reply({ embeds: [makeEmbed("Status Updated", status || "Cleared.", COLORS.SUCCESS)], flags: EPHEMERAL_FLAG });
    }

    if (action === "game") {
      const game = rawValue.slice(0, 80);
      updateTempVoiceInterfaceState(interaction.guild.id, voiceChannelId, { game });
      await postTempVoiceInterface(interaction.guild, voiceChannelId).catch(() => null);
      return interaction.reply({ embeds: [makeEmbed("Game Updated", game || "Cleared.", COLORS.SUCCESS)], flags: EPHEMERAL_FLAG });
    }

    if (action === "permit" || action === "reject") {
      const resolved = await resolveMemberOrRoleFromInput(interaction.guild, rawValue);
      if (!resolved) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Target", "Provide a valid user or role mention/ID.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      const allow = action === "permit";
      const overwriteTarget = resolved.target;
      await voiceChannel.permissionOverwrites
        .edit(overwriteTarget.id, {
          [VIEW_CHANNEL_PERMISSION_KEY]: allow ? true : false,
          [CONNECT_PERMISSION_KEY]: allow ? true : false,
        })
        .catch(() => null);

      if (!allow && resolved.type === "member") {
        const member = resolved.target;
        if (member.voice?.channelId === voiceChannel.id) {
          await member.voice.setChannel(null, "Rejected from temporary voice channel").catch(() => null);
        }
      }
      if (!allow && resolved.type === "role") {
        for (const member of voiceChannel.members.values()) {
          if (!member.roles?.cache?.has(overwriteTarget.id)) continue;
          await member.voice.setChannel(null, "Rejected from temporary voice channel").catch(() => null);
        }
      }
      await postTempVoiceInterface(interaction.guild, voiceChannelId).catch(() => null);
      return interaction.reply({
        embeds: [
          makeEmbed(
            allow ? "Access Permitted" : "Access Rejected",
            `${resolved.type === "role" ? `<@&${overwriteTarget.id}>` : `<@${overwriteTarget.id}>`}`,
            COLORS.SUCCESS,
          ),
        ],
        flags: EPHEMERAL_FLAG,
      });
    }

    if (action === "transfer") {
      const targetId = mentionToId(rawValue);
      if (!targetId) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Target", "Provide a valid member mention or ID.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      const targetMember =
        interaction.guild.members.cache.get(targetId) ||
        (await interaction.guild.members.fetch(targetId).catch(() => null));
      if (!targetMember || targetMember.user.bot) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Target", "Target member was not found.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }
      if (targetMember.voice?.channelId !== voiceChannel.id) {
        return interaction.reply({
          embeds: [makeEmbed("Invalid Target", "Target member must be in the same temporary channel.", COLORS.ERROR)],
          flags: EPHEMERAL_FLAG,
        });
      }

      const previousOwner = state.ownerId;
      updateTempVoiceInterfaceState(interaction.guild.id, voiceChannelId, { ownerId: targetMember.id });
      await voiceChannel.permissionOverwrites.edit(targetMember.id, ownerVoicePermissionMap()).catch(() => null);
      if (previousOwner && previousOwner !== targetMember.id) {
        await voiceChannel.permissionOverwrites.edit(previousOwner, { [MANAGE_CHANNELS_PERMISSION_KEY]: null }).catch(() => null);
      }
      await postTempVoiceInterface(interaction.guild, voiceChannelId).catch(() => null);
      return interaction.reply({
        embeds: [makeEmbed("Ownership Transferred", `New owner: <@${targetMember.id}>`, COLORS.SUCCESS)],
        flags: EPHEMERAL_FLAG,
      });
    }
  }

  if (isModalInteraction && typeof interaction.customId === "string" && interaction.customId.startsWith("aeontrain:")) {
    return interaction.reply({
      embeds: [
        makeEmbed(
          "Training Moved to CLI",
          "AEON training is now CLI-only. Use `python agentic_ai/train_cli.py --help` from terminal.",
          COLORS.WARNING,
        ),
      ],
      flags: EPHEMERAL_FLAG,
    }).catch((error) => {
      if (!isUnknownInteractionError(error)) throw error;
      return null;
    });

    if (!interaction.guild) return;
    try {
      await interaction.deferReply({ flags: EPHEMERAL_FLAG });
    } catch (error) {
      if (isUnknownInteractionError(error)) return;
      throw error;
    }
    const safeEditReply = (payload) =>
      interaction.editReply(payload).catch((error) => {
        if (!isUnknownInteractionError(error)) throw error;
        return null;
      });

    if (!interaction.member?.permissions?.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return safeEditReply({
        embeds: [makeEmbed("Permission Denied", "You need `Manage Server` to use AEON training.", COLORS.ERROR)],
      });
    }
    const parts = interaction.customId.split(":");
    const mode = parts[1];
    const ownerId = parts[2];
    const sessionId = parts[3];

    if (interaction.user.id !== ownerId) {
      return safeEditReply({
        embeds: [makeEmbed("Private Session", "This training session belongs to another admin.", COLORS.WARNING)],
      });
    }

    if (mode === "input") {
      const rawInput = getModalInputValue(interaction, "value");
      if (!rawInput || rawInput.length < 5) {
        clearAeonTrainSession(interaction.guild.id, interaction.user.id);
        return safeEditReply({
          embeds: [makeEmbed("Invalid Input", "Please provide valid training data.", COLORS.ERROR)],
        });
      }

      let aiRewrite = null;
      let deterministic = null;
      try {
        aiRewrite = await rewriteAeonKnowledgeFromInput(rawInput, {
          mode: "input",
          username: interaction.user.tag,
          userId: interaction.user.id,
        });
      } catch (error) {
        deterministic = applyAeonTrainingInputDeterministic(rawInput);
        if (!deterministic?.ok) {
          clearAeonTrainSession(interaction.guild.id, interaction.user.id);
          return safeEditReply({
            embeds: [
              makeEmbed(
                "Training Failed",
                shorten(
                  deterministic?.error ||
                    error?.message ||
                    "Could not process training input.",
                  1200,
                ),
                COLORS.ERROR,
              ),
            ],
          });
        }
      }

      await reloadAeonAgentKnowledge().catch(() => null);
      clearAeonTrainSession(interaction.guild.id, interaction.user.id);

      if (aiRewrite?.ok) {
        const train = aiRewrite.train || {};
        const aiStats = [];
        if (Number.isFinite(Number(train.merged_facts))) {
          aiStats.push({ name: "Facts", value: `${train.merged_facts}`, inline: true });
        }
        if (Number.isFinite(Number(train.llm_classified_facts))) {
          aiStats.push({ name: "Classified", value: `${train.llm_classified_facts}`, inline: true });
        }
        if (Number.isFinite(Number(train.index_entry_count))) {
          aiStats.push({ name: "Indexed", value: `${train.index_entry_count}`, inline: true });
        }
        if (Number.isFinite(Number(train.unresolved_lines))) {
          aiStats.push({ name: "Unresolved", value: `${train.unresolved_lines}`, inline: true });
        }
        return safeEditReply({
          embeds: [
            makeEmbed(
              "AEON Training Applied",
              "Knowledge base was rewritten, classified, and re-indexed for better retrieval.",
              COLORS.SUCCESS,
              [
                { name: "Mode", value: "AI Rewrite", inline: true },
                { name: "Lines", value: `${train.lines || "Unknown"}`, inline: true },
                { name: "Chunks", value: `${train.chunk_count || "Unknown"}`, inline: true },
                ...aiStats.slice(0, 5),
              ],
            ),
          ],
        });
      }

      const counts = deterministic.priorityCounts || {};
      return safeEditReply({
        embeds: [
          makeEmbed(
            "AEON Training Applied",
            "Input was parsed, classified, sorted by priority, and applied with deterministic updates (AI rewrite unavailable).",
            COLORS.SUCCESS,
            [
              { name: "Updated", value: `${deterministic.updatedCount || 0}`, inline: true },
              { name: "Added", value: `${deterministic.addedCount || 0}`, inline: true },
              { name: "Parsed", value: `${deterministic.totalParsed || 0}`, inline: true },
              { name: "Critical", value: `${counts.Critical || 0}`, inline: true },
              { name: "High", value: `${counts.High || 0}`, inline: true },
            ],
          ),
        ],
      });
    }

    if (mode === "answer") {
      const session = getAeonTrainSession(interaction.guild.id, interaction.user.id, sessionId);
      if (!session) {
        return safeEditReply({
          embeds: [makeEmbed("Session Expired", "Run `/aeon train interactive` to start again.", COLORS.WARNING)],
        });
      }

      const current = session.unknownFields?.[session.pointer] || null;
      if (!current) {
        clearAeonTrainSession(interaction.guild.id, interaction.user.id);
        return safeEditReply({
          embeds: [buildAeonTrainInteractiveEmbed(session, "complete", "No more unknown fields.")],
        });
      }

      const value = getModalInputValue(interaction, "value");
      if (!value) {
        return safeEditReply({
          embeds: [makeEmbed("Invalid Value", "Value cannot be empty.", COLORS.ERROR)],
        });
      }

      const content = safeReadAeonKnowledge();
      if (!content) {
        return safeEditReply({
          embeds: [makeEmbed("Knowledge Missing", "Could not read the knowledge file.", COLORS.ERROR)],
        });
      }
      const lines = content.split(/\r?\n/);
      const updateResult = updateAeonKnowledgeField(
        lines,
        current.field,
        value,
        current.subsection || current.section,
      );
      if (!updateResult.ok) {
        return safeEditReply({
          embeds: [makeEmbed("Update Failed", shorten(updateResult.reason || "Could not update field.", 500), COLORS.ERROR)],
        });
      }
      const nextText = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
      if (!safeWriteAeonKnowledge(nextText)) {
        return safeEditReply({
          embeds: [makeEmbed("Write Failed", "Could not persist knowledge updates.", COLORS.ERROR)],
        });
      }

      session.updatedCount += 1;
      session.pointer += 1;
      session.appliedFacts.push(
        `${current.section || "General"} | ${current.field} | ${String(value).trim()}`,
      );
      saveAeonTrainSession(session);

      const next = session.unknownFields?.[session.pointer] || null;
      if (!next) {
        await reloadAeonAgentKnowledge().catch(() => null);
        clearAeonTrainSession(interaction.guild.id, interaction.user.id);
        return safeEditReply({
          embeds: [buildAeonTrainInteractiveEmbed(session, "complete", "All prompted unknown fields were processed.")],
        });
      }

      return safeEditReply({
        embeds: [buildAeonTrainInteractiveEmbed(session, "in_progress", "Value saved.")],
        components: buildAeonTrainInteractiveComponents(interaction.user.id, session.id),
      });
    }

    return safeEditReply({
      embeds: [makeEmbed("Invalid Session", "Unknown AEON training modal action.", COLORS.WARNING)],
    });
  }

  const isSlashCommand =
    (typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand()) ||
    (typeof interaction.isCommand === "function" && interaction.isCommand());
  if (!isSlashCommand) return;
  if (!COMMANDS.some((c) => c.name === interaction.commandName)) return;
  if (!interaction.inGuild()) return fail(interaction, "Invalid Context", "This command can only be used in a server.");
  markCommandInvocation(interaction.commandName);

  try {
    const botMember = await getBotMember(interaction.guild);

    if (await handleMusicCommand(interaction, botMember)) return;
    if (
      await handleMuCommand({
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
        getGuildSetupConfig,
        isTextChannel,
        validateTarget,
        Permissions,
        ActionRowClass,
        ButtonClass,
        resolveButtonStyle,
      })
    ) {
      return;
    }

    if (interaction.commandName === "help") {
      const helpContext = buildHelpAccessContext(
        interaction.member,
        interaction.guild,
        interaction.client?.user || client.user,
      );
      const page = "overview";
      const embed = buildHelpEmbed(page, interaction.user, interaction.client.user, helpContext);
      const components = buildHelpComponents(interaction.user.id, page, helpContext);
      const replyMessage = await interaction.reply({
        embeds: [embed],
        components,
        flags: EPHEMERAL_FLAG,
        fetchReply: true,
      });
      const helpMessageId = replyMessage?.id || interaction.id;
      const helpTimerKey = makePanelTimerKey("help", interaction.user.id, helpMessageId);
      schedulePanelInactivityClose(helpTimerKey, HELP_PANEL_IDLE_CLOSE_MS, async () => {
        const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Help Panel`,
          "Run `/help` to open the panel again.",
          HELP_PANEL_IDLE_CLOSE_MS,
        );
        await interaction.editReply({ embeds: [closed], components: [] });
      });
      return replyMessage;
    }

    if (interaction.commandName === "setup") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;
      const embed = await buildSetupEmbed(interaction.guild, interaction.user, interaction.channel);
      const components = buildSetupComponents(interaction.user.id);
      const replyMessage = await interaction.reply({ embeds: [embed], components, fetchReply: true });
      const setupMessageId = replyMessage?.id || interaction.id;
      const setupTimerKey = makePanelTimerKey("setup", interaction.user.id, setupMessageId);
      schedulePanelInactivityClose(setupTimerKey, SETUP_PANEL_IDLE_CLOSE_MS, async () => {
        const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Setup Panel`,
          "Run `/setup` again whenever you need.",
          SETUP_PANEL_IDLE_CLOSE_MS,
        );
        if (replyMessage?.editable && typeof replyMessage.edit === "function") {
          await replyMessage.edit({ embeds: [closed], components: [] });
          return;
        }
        await interaction.editReply({ embeds: [closed], components: [] });
      });
      return replyMessage;
    }

    if (interaction.commandName === "botprofile") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.ADMINISTRATOR, "Administrator"))) return;
      const embed = buildBotProfileEmbed(interaction.guild, interaction.user);
      const components = buildBotProfileComponents(interaction.user.id);
      const replyMessage = await interaction.reply({ embeds: [embed], components, fetchReply: true });
      const panelMessageId = replyMessage?.id || interaction.id;
      const panelTimerKey = makePanelTimerKey("botprofile", interaction.user.id, panelMessageId);
      schedulePanelInactivityClose(panelTimerKey, BOTPROFILE_PANEL_IDLE_CLOSE_MS, async () => {
        const botName = getGuildBotDisplayName(interaction.guild, interaction.client?.user || client.user);
        const closed = buildPanelAutoClosedEmbed(
          `${botName} Profile Panel`,
          "Run `/botprofile` to open it again.",
          BOTPROFILE_PANEL_IDLE_CLOSE_MS,
        );
        if (replyMessage?.editable && typeof replyMessage.edit === "function") {
          await replyMessage.edit({ embeds: [closed], components: [] });
          return;
        }
        await interaction.editReply({ embeds: [closed], components: [] });
      });
      return replyMessage;
    }

    if (interaction.commandName === "interface") {
      const optionChannel = interaction.options.getChannel("channel");
      const channel = optionChannel || interaction.member?.voice?.channel || null;
      if (!channel || !isVoiceChannel(channel)) {
        return fail(interaction, "Channel Required", "Join your temporary voice channel or provide one with `channel`.");
      }
      const access = canManageTempVoice(interaction, channel.id, true);
      if (!access.ok) return fail(interaction, "Access Denied", access.reason);

      const posted = await postTempVoiceInterface(interaction.guild, channel.id);
      if (!posted) {
        return fail(
          interaction,
          "Interface Failed",
          "Could not send the control interface. Set a fallback channel with `/config jtc_interface`.",
        );
      }
      return send(
        interaction,
        makeEmbed("Interface Sent", `Control interface posted for ${channel}.`, COLORS.SUCCESS),
      );
    }

    if (interaction.commandName === "config") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;
      const sub = interaction.options.getSubcommand();
      if (sub === "jtc_trigger") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;
        if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;
        const channel = interaction.options.getChannel("trigger", true);
        const category = interaction.options.getChannel("category");
        if (!isVoiceChannel(channel)) {
          return fail(interaction, "Invalid Channel", "Please provide a voice channel.");
        }
        if (category && !isCategoryChannel(category)) {
          return fail(interaction, "Invalid Category", "Optional category must be a category channel.");
        }

        const current = getGuildJtcConfig(interaction.guild.id);
        const currentTrigger = current.triggers[channel.id];
        const resolvedCategoryId =
          category?.id || currentTrigger?.categoryId || channel.parentId || "";
        const nextTriggers = {
          ...current.triggers,
          [channel.id]: { categoryId: resolvedCategoryId },
        };
        const configured = setGuildJtcConfig(interaction.guild.id, {
          triggers: nextTriggers,
          interfaceChannelId: current.interfaceChannelId,
          channels: current.channels,
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        return send(
          interaction,
          makeEmbed("Join-to-Create Set", `Members joining ${channel} will get a private temporary VC.`, COLORS.SUCCESS, [
            { name: "Trigger Channel", value: `${channel}`, inline: true },
            {
              name: "Create Category",
              value: resolvedCategoryId ? `<#${resolvedCategoryId}>` : "Same as trigger",
              inline: true,
            },
            { name: "Total Triggers", value: `${Object.keys(configured.triggers).length}`, inline: true },
          ]),
        );
      }

      if (sub === "jtc_interface") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;
        const channel = interaction.options.getChannel("channel", true);
        if (!isTextChannel(channel)) {
          return fail(interaction, "Invalid Channel", "Please provide a text channel.");
        }
        if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.SEND_MESSAGES, "Send Messages", channel))) return;

        const current = getGuildJtcConfig(interaction.guild.id);
        setGuildJtcConfig(interaction.guild.id, {
          triggers: current.triggers,
          interfaceChannelId: channel.id,
          channels: current.channels,
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        return send(
          interaction,
          makeEmbed("Interface Channel Set", `Temp voice interfaces will also be posted in ${channel}.`, COLORS.SUCCESS),
        );
      }

      if (sub === "stats_category") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;
        if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;

        const category = interaction.options.getChannel("category", true);
        if (!isCategoryChannel(category)) {
          return fail(interaction, "Invalid Category", "Please provide a valid category channel.");
        }

        setGuildSetupConfig(interaction.guild.id, {
          statsCategoryId: category.id,
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });
        const result = await updateGuildStatsChannels(interaction.guild, interaction.user.id);
        if (!result) {
          return fail(
            interaction,
            "Stats Setup Failed",
            "Could not create or update stats channels. Check bot permissions and category access.",
          );
        }

        return send(
          interaction,
          makeEmbed(
            "Stats Category Set",
            `Stats channels are now managed under <#${result.categoryId}>.`,
            COLORS.SUCCESS,
            [
              { name: "All", value: `<#${result.channels.all}>` },
              { name: "Members", value: `<#${result.channels.members}>` },
              { name: "Bots", value: `<#${result.channels.bots}>` },
            ],
          ),
        );
      }

      if (sub === "welcome_channel") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;
        const channel = interaction.options.getChannel("channel", true);
        if (!isTextChannel(channel)) {
          return fail(interaction, "Invalid Channel", "Please choose a standard text channel.");
        }
        if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.SEND_MESSAGES, "Send Messages", channel))) return;

        setGuildSetupConfig(interaction.guild.id, {
          welcomeChannelId: channel.id,
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        return send(
          interaction,
          makeEmbed("Welcome Channel Set", `Welcome embeds will be sent in ${channel}.`, COLORS.SUCCESS),
        );
      }

      return fail(interaction, "Invalid Option", "Unknown config option.");
    }

    if (interaction.commandName === "autorole") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) return;
      const sub = interaction.options.getSubcommand();
      const currentConfig = getGuildAutoRoleConfig(interaction.guild.id);

      if (sub === "list") {
        if (!currentConfig.roleIds.length) {
          return send(
            interaction,
            makeEmbed("Autorole List", "No autoroles are configured.", COLORS.INFO),
          );
        }

        const lines = currentConfig.roleIds.map((roleId, index) => {
          const role = interaction.guild.roles.cache.get(roleId);
          return role ? `**${index + 1}.** ${role}` : `**${index + 1}.** Deleted role`;
        });
        return send(
          interaction,
          makeEmbed(
            "Autorole List",
            lines.join("\n"),
            COLORS.INFO,
            [{ name: "Total Roles", value: `${currentConfig.roleIds.length}` }],
          ),
        );
      }

      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) return;

      if (sub === "add") {
        const role = interaction.options.getRole("role", true);
        if (role.id === interaction.guild.id) return fail(interaction, "Invalid Role", "The @everyone role cannot be used.");
        if (role.managed) return fail(interaction, "Role Locked", "Managed roles cannot be assigned by autorole.");
        if (!canManageRoleByHierarchy(interaction.member, role, interaction.guild.ownerId)) {
          return fail(interaction, "Role Hierarchy Blocked", "Your highest role must be above the selected role.");
        }
        if (botMember.roles.highest.comparePositionTo(role) <= 0) {
          return fail(interaction, "Role Hierarchy Blocked", "My highest role must be above the selected role.");
        }
        if (currentConfig.roleIds.includes(role.id)) {
          return send(interaction, makeEmbed("Autorole Exists", `${role} is already in the autorole list.`, COLORS.WARNING));
        }
        if (currentConfig.roleIds.length >= 20) {
          return fail(interaction, "Limit Reached", "Autorole supports up to 20 roles.");
        }

        const nextRoles = [...currentConfig.roleIds, role.id];
        setGuildAutoRoleConfig(interaction.guild.id, {
          roleIds: nextRoles,
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        await logModerationAction(interaction.guild, "Autorole Added", [
          { name: "Role", value: `${role}` },
          { name: "Updated By", value: `<@${interaction.user.id}>` },
          { name: "Total Roles", value: `${nextRoles.length}` },
        ], COLORS.SUCCESS);

        return send(
          interaction,
          makeEmbed("Autorole Added", `${role} will now be assigned to new members.`, COLORS.SUCCESS),
        );
      }

      if (sub === "remove") {
        const role = interaction.options.getRole("role", true);
        if (!canManageRoleByHierarchy(interaction.member, role, interaction.guild.ownerId)) {
          return fail(interaction, "Role Hierarchy Blocked", "Your highest role must be above the selected role.");
        }
        if (botMember.roles.highest.comparePositionTo(role) <= 0) {
          return fail(interaction, "Role Hierarchy Blocked", "My highest role must be above the selected role.");
        }

        if (!currentConfig.roleIds.includes(role.id)) {
          return send(interaction, makeEmbed("Not Found", `${role} is not in the autorole list.`, COLORS.WARNING));
        }

        const nextRoles = currentConfig.roleIds.filter((id) => id !== role.id);
        setGuildAutoRoleConfig(interaction.guild.id, {
          roleIds: nextRoles,
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        await logModerationAction(interaction.guild, "Autorole Removed", [
          { name: "Role", value: `${role}` },
          { name: "Updated By", value: `<@${interaction.user.id}>` },
          { name: "Remaining Roles", value: `${nextRoles.length}` },
        ], COLORS.WARNING);

        return send(
          interaction,
          makeEmbed("Autorole Removed", `${role} was removed from autorole.`, COLORS.SUCCESS),
        );
      }

      if (sub === "clear") {
        if (!currentConfig.roleIds.length) {
          return send(interaction, makeEmbed("Autorole Clear", "Autorole list is already empty.", COLORS.WARNING));
        }

        setGuildAutoRoleConfig(interaction.guild.id, {
          roleIds: [],
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        await logModerationAction(interaction.guild, "Autorole Cleared", [
          { name: "Updated By", value: `<@${interaction.user.id}>` },
          { name: "Removed Roles", value: `${currentConfig.roleIds.length}` },
        ], COLORS.WARNING);

        return send(
          interaction,
          makeEmbed("Autorole Cleared", "All autoroles were removed.", COLORS.SUCCESS),
        );
      }

      return fail(interaction, "Invalid Option", "Unknown autorole option.");
    }

    if (interaction.commandName === "ping") {
      const wsPing = Math.round(interaction.client.ws?.ping ?? 0);
      const responseMs = Date.now() - interaction.createdTimestamp;
      return send(
        interaction,
        makeEmbed("Pong", `Response: **${responseMs}ms**\nGateway: **${wsPing}ms**`, COLORS.INFO),
      );
    }

    if (interaction.commandName === "serverinfo") {
      const guild = interaction.guild;
      const textChannels = guild.channels.cache.filter((ch) => isTextChannel(ch)).size;
      const voiceChannels = guild.channels.cache.filter((ch) => isVoiceChannel(ch)).size;
      const categories = guild.channels.cache.filter((ch) => isCategoryChannel(ch)).size;
      const embed = makeEmbed(
        `${guild.name}`,
        guild.description || "Community server overview",
        COLORS.INFO,
        [
          { name: "Owner", value: `<@${guild.ownerId}>`, inline: true },
          { name: "Members", value: `${guild.memberCount}`, inline: true },
          { name: "Roles", value: `${guild.roles.cache.size}`, inline: true },
          { name: "Text", value: `${textChannels}`, inline: true },
          { name: "Voice", value: `${voiceChannels}`, inline: true },
          { name: "Categories", value: `${categories}`, inline: true },
          { name: "Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          { name: "Boost Level", value: `${guild.premiumTier}`, inline: true },
          { name: "Boost Count", value: `${guild.premiumSubscriptionCount || 0}`, inline: true },
        ],
      );
      if (guild.iconURL) setEmbedThumbnailSafe(embed, guild.iconURL({ dynamic: true, size: 1024 }));
      const guildBanner =
        typeof guild.bannerURL === "function"
          ? guild.bannerURL({ dynamic: true, size: 2048 })
          : null;
      const serverInfoImage = guildBanner || SERVERINFO_BANNER_URL;
      if (serverInfoImage && typeof embed.setImage === "function") {
        try {
          embed.setImage(serverInfoImage);
        } catch (_) {
          // ignore invalid banner URL
        }
      }
      setEmbedFooterSafe(embed, "Use /roleinfo and /userinfo for deeper details");
      return send(interaction, embed, false);
    }

    if (interaction.commandName === "userinfo") {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      const roles =
        targetMember && targetMember.roles?.cache
          ? targetMember.roles.cache
              .filter((role) => role.id !== interaction.guild.id)
              .map((role) => role.toString())
              .slice(0, 8)
              .join(", ") || "None"
          : "None";
      const highestRole = targetMember?.roles?.highest && targetMember.roles.highest.id !== interaction.guild.id
        ? `${targetMember.roles.highest}`
        : "None";

      const embed = makeEmbed(
        "User Profile",
        `${targetUser}\n${targetMember?.nickname ? `Nickname: **${targetMember.nickname}**` : "Nickname: Not set"}`,
        COLORS.INFO,
        [
          { name: "Bot", value: targetUser.bot ? "Yes" : "No", inline: true },
          { name: "Highest Role", value: highestRole, inline: true },
          { name: "Top Roles", value: roles, inline: false },
          { name: "Account Created", value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:f>` },
          {
            name: "Joined Server",
            value: targetMember?.joinedTimestamp
              ? `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:f>`
              : "Not available",
          },
        ],
      );
      setEmbedAuthorSafe(
        embed,
        targetUser.tag || "User",
        targetUser.displayAvatarURL ? targetUser.displayAvatarURL({ dynamic: true }) : null,
      );
      if (targetUser.displayAvatarURL) setEmbedThumbnailSafe(embed, targetUser.displayAvatarURL({ dynamic: true, size: 1024 }));
      return send(interaction, embed, false);
    }

    if (interaction.commandName === "avatar") {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const fetchedUser = await targetUser.fetch(true).catch(() => targetUser);
      const avatarImage = fetchedUser?.displayAvatarURL
        ? fetchedUser.displayAvatarURL({ dynamic: true, size: 2048 })
        : null;
      const bannerImage = fetchedUser?.bannerURL
        ? fetchedUser.bannerURL({ dynamic: true, size: 2048 })
        : null;
      const embed = makeEmbed(
        "Avatar & Banner",
        `${targetUser}\nAvatar: ${avatarImage ? `[Open Original](${avatarImage})` : "Unavailable"}\nBanner: ${bannerImage ? `[Open Original](${bannerImage})` : "Not set"}`,
        COLORS.INFO,
      );
      setEmbedAuthorSafe(
        embed,
        fetchedUser?.tag || targetUser.tag || "User",
        avatarImage || null,
      );
      if (avatarImage) setEmbedThumbnailSafe(embed, avatarImage);
      if (bannerImage && typeof embed.setImage === "function") embed.setImage(bannerImage);
      else if (avatarImage && typeof embed.setImage === "function") embed.setImage(avatarImage);
      setEmbedFooterSafe(embed, bannerImage ? "Banner shown below, avatar in thumbnail" : "No banner set for this user");
      return send(interaction, embed, false);
    }

    if (interaction.commandName === "roleinfo") {
      const role = interaction.options.getRole("role", true);
      const rolePerms = role.permissions?.toArray?.() || [];
      const permPreview = rolePerms.length
        ? rolePerms.slice(0, 8).map((perm) => perm.replace(/_/g, " ")).join(", ")
        : "None";
      const embed = makeEmbed(
        "Role Info",
        `${role}`,
        COLORS.INFO,
        [
          { name: "Color", value: role.hexColor || "Default", inline: true },
          { name: "Members", value: `${role.members?.size ?? 0}`, inline: true },
          { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
          { name: "Hoisted", value: role.hoist ? "Yes" : "No", inline: true },
          { name: "Position", value: `${role.position}`, inline: true },
          { name: "Created", value: `<t:${Math.floor(role.createdTimestamp / 1000)}:f>`, inline: true },
          { name: "Permissions", value: shorten(permPreview, 900), inline: false },
        ],
      );
      setEmbedFooterSafe(embed, rolePerms.length > 8 ? `+${rolePerms.length - 8} more permissions` : "Role permission preview");
      return send(interaction, embed, false);
    }

    if (interaction.commandName === "timestamp") {
      const parsed = parseDateTimeToUnix(
        interaction.options.getString("date", true),
        interaction.options.getString("time", true),
      );
      if (!parsed.unix) return fail(interaction, "Invalid Date/Time", parsed.error);

      const unix = parsed.unix;
      return send(
        interaction,
        makeEmbed(
          "Discord Timestamp",
          [
            `Default: <t:${unix}>  \`<t:${unix}>\``,
            `Short Time: <t:${unix}:t>  \`<t:${unix}:t>\``,
            `Long Time: <t:${unix}:T>  \`<t:${unix}:T>\``,
            `Short Date: <t:${unix}:d>  \`<t:${unix}:d>\``,
            `Long Date: <t:${unix}:D>  \`<t:${unix}:D>\``,
            `Relative: <t:${unix}:R>  \`<t:${unix}:R>\``,
          ].join("\n"),
          COLORS.INFO,
        ),
      );
    }

    if (ENABLE_AEON_AI && interaction.commandName === "aeon") {
      let subGroup = null;
      if (typeof interaction.options.getSubcommandGroup === "function") {
        try {
          subGroup = interaction.options.getSubcommandGroup(false);
        } catch (_) {
          subGroup = null;
        }
      }
      const sub = interaction.options.getSubcommand();

      const dispatchAeonActionPlan = async (requestText, options = {}) => {
        const dryRunOption = options.dryRun === true;
        const policy = getGuildAeonActionPolicy(interaction.guild.id);
        if (!policy.enabled) {
          return fail(
            interaction,
            "AI Manager Disabled",
            "AI action execution is disabled. Use `/aeon policy toggle enabled:true` to enable it.",
          );
        }

        const plan = createAeonActionPlanObject(interaction.guild, interaction.user.id, requestText, {
          source: options.source || "manual",
          workflowName: options.workflowName || "",
          dryRun: dryRunOption,
        });
        if (!plan.actions.length) {
          const hint = plan.unsupportedClauses?.length
            ? `Unsupported clauses:\n${plan.unsupportedClauses.slice(0, 5).map((item, idx) => `${idx + 1}. ${item}`).join("\n")}`
            : "Try requests like: `create channel announcements then create role Moderators`.";
          return fail(interaction, "No Actions Parsed", hint);
        }
        if (!plan.policyCheck.ok) {
          return fail(
            interaction,
            "Blocked By Policy",
            shorten(plan.policyCheck.warnings.join("\n") || "Plan violates current policy settings.", 1000),
          );
        }

        const botActionMember = await getBotMember(interaction.guild).catch(() => null);
        const actionInvokerMember =
          interaction.member?.permissions?.has
            ? interaction.member
            : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const permissionCheck = checkAeonActionPermissionBaseline(actionInvokerMember, botActionMember, plan.actions);
        if (!permissionCheck.ok) {
          const lines = [];
          if (permissionCheck.missingMember.length) {
            lines.push(`You are missing: ${permissionCheck.missingMember.join(", ")}`);
          }
          if (permissionCheck.missingBot.length) {
            lines.push(`Bot is missing: ${permissionCheck.missingBot.join(", ")}`);
          }
          return fail(interaction, "Permission Check Failed", lines.join("\n"));
        }

        saveAeonActionPlan(plan);
        const permLabels = actionPermLabelsForActions(plan.actions);
        const noteParts = [];
        if (permLabels.length) noteParts.push(`Required: ${permLabels.join(", ")}`);
        if (policy.requireApproval) noteParts.push("Manual approval required.");
        if (dryRunOption) noteParts.push("Dry run requested.");
        if (options.workflowName) noteParts.push(`Workflow: ${options.workflowName}`);
        const previewEmbed = buildAeonActionPlanEmbed(plan, interaction.user, "preview", noteParts.join(" "));

        if (!policy.requireApproval && !dryRunOption) {
          try {
            const { runResult } = await executePendingAeonActionPlan(plan, interaction, false);
            deleteAeonActionPlan(interaction.guild.id, plan.id);
            return send(interaction, buildAeonActionResultEmbed(runResult, interaction.user, "AEON AI Action Executed"));
          } catch (error) {
            deleteAeonActionPlan(interaction.guild.id, plan.id);
            return fail(interaction, "Execution Failed", shorten(error?.message || "Could not execute action plan.", 900));
          }
        }

        return interaction.reply({
          embeds: [previewEmbed],
          components: buildAeonActionPlanComponents(interaction.user.id, plan.id, false),
          flags: EPHEMERAL_FLAG,
        });
      };

      if (subGroup === "train") {
        return fail(
          interaction,
          "Training Moved to CLI",
          "AEON training is now CLI-only. Use `python agentic_ai/train_cli.py --help` from terminal.",
        );
      }

      if (subGroup === "activation") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;

        const disableKeyword = /^(off|none|disable|disabled|clear)$/i;
        const currentSetup = getGuildSetupConfig(interaction.guild.id);
        const currentActivations = getAeonActivationTexts(currentSetup);

        if (sub === "list") {
          const lines = currentActivations.length
            ? currentActivations.map((value, index) => `${index + 1}. \`${value}\``)
            : ["No activation texts configured."];
          return send(
            interaction,
            makeEmbed(
              "AEON Activation Texts",
              lines.join("\n"),
              COLORS.INFO,
              [
                { name: "Total", value: `${currentActivations.length}`, inline: true },
                { name: "Limit", value: `${MAX_AEON_ACTIVATION_TEXTS}`, inline: true },
              ],
            ),
          );
        }

        if (sub === "clear") {
          setGuildSetupConfig(interaction.guild.id, {
            aeonActivationTexts: [],
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(
            interaction,
            makeEmbed(
              "AEON Activation Cleared",
              "All activation texts were removed. Auto-activation is now disabled.",
              COLORS.SUCCESS,
            ),
          );
        }

        if (sub === "add") {
          const rawText = interaction.options.getString("text", true).trim();
          if (disableKeyword.test(rawText)) {
            return fail(interaction, "Invalid Text", "Use `/aeon activation clear` to disable all activations.");
          }
          const text = normalizeAeonActivationTexts([rawText], 1)[0] || "";
          if (!text) {
            return fail(interaction, "Invalid Text", "Activation text must be at least 2 characters.");
          }
          if (currentActivations.some((entry) => entry.toLowerCase() === text.toLowerCase())) {
            return send(interaction, makeEmbed("No Change Needed", `\`${text}\` is already configured.`, COLORS.WARNING));
          }
          if (currentActivations.length >= MAX_AEON_ACTIVATION_TEXTS) {
            return fail(
              interaction,
              "Activation Limit Reached",
              `You can configure up to ${MAX_AEON_ACTIVATION_TEXTS} activation texts.`,
            );
          }
          const next = [...currentActivations, text];
          setGuildSetupConfig(interaction.guild.id, {
            aeonActivationTexts: next,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(
            interaction,
            makeEmbed(
              "AEON Activation Added",
              `Added \`${text}\`.\n\nNow tracking ${next.length} activation text${next.length === 1 ? "" : "s"}.`,
              COLORS.SUCCESS,
            ),
          );
        }

        if (sub === "remove") {
          const rawText = interaction.options.getString("text", true).trim();
          const text = normalizeAeonActivationTexts([rawText], 1)[0] || rawText;
          const next = currentActivations.filter((entry) => entry.toLowerCase() !== String(text).toLowerCase());
          if (next.length === currentActivations.length) {
            return send(interaction, makeEmbed("Not Found", `\`${rawText}\` is not in the activation list.`, COLORS.WARNING));
          }
          setGuildSetupConfig(interaction.guild.id, {
            aeonActivationTexts: next,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(
            interaction,
            makeEmbed(
              "AEON Activation Removed",
              `Removed \`${rawText}\`.\n\nRemaining: ${next.length} activation text${next.length === 1 ? "" : "s"}.`,
              COLORS.SUCCESS,
            ),
          );
        }

        if (sub === "update") {
          const oldRaw = interaction.options.getString("old_text", true).trim();
          const newRaw = interaction.options.getString("new_text", true).trim();
          if (disableKeyword.test(newRaw)) {
            return fail(interaction, "Invalid New Text", "Use `/aeon activation remove` or `/aeon activation clear`.");
          }
          const newText = normalizeAeonActivationTexts([newRaw], 1)[0] || "";
          if (!newText) {
            return fail(interaction, "Invalid New Text", "New activation text must be at least 2 characters.");
          }

          const oldIndex = currentActivations.findIndex((entry) => entry.toLowerCase() === oldRaw.toLowerCase());
          if (oldIndex < 0) {
            return send(interaction, makeEmbed("Not Found", `\`${oldRaw}\` is not in the activation list.`, COLORS.WARNING));
          }

          const duplicateIndex = currentActivations.findIndex((entry) => entry.toLowerCase() === newText.toLowerCase());
          if (duplicateIndex >= 0 && duplicateIndex !== oldIndex) {
            return send(
              interaction,
              makeEmbed("No Change Needed", `\`${newText}\` already exists in the activation list.`, COLORS.WARNING),
            );
          }

          const next = [...currentActivations];
          next[oldIndex] = newText;
          setGuildSetupConfig(interaction.guild.id, {
            aeonActivationTexts: next,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(
            interaction,
            makeEmbed(
              "AEON Activation Updated",
              `Updated \`${oldRaw}\` to \`${newText}\`.`,
              COLORS.SUCCESS,
            ),
          );
        }
      }

      if (subGroup === "action") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;

        if (sub === "run") {
          const request = shorten(String(interaction.options.getString("request", true) || "").trim(), AEON_ACTION_REQUEST_MAX);
          if (!request || request.length < 5) {
            return fail(interaction, "Invalid Request", "Please provide a clear natural-language action request.");
          }
          const dryRun = interaction.options.getBoolean("dry_run") === true;
          return dispatchAeonActionPlan(request, { dryRun, source: "manual" });
        }

        if (sub === "approve") {
          const planId = parseAeonActionPlanId(interaction.options.getString("plan_id", true));
          if (!planId) return fail(interaction, "Invalid Plan ID", "Provide a valid plan ID from `/aeon action run`.");
          const plan = getAeonActionPlan(interaction.guild.id, planId);
          if (!plan) return fail(interaction, "Plan Not Found", "This plan is missing or expired.");
          if (plan.ownerId !== interaction.user.id) {
            return fail(interaction, "Private Plan", "Only the plan creator can approve this plan.");
          }
          try {
            const { runResult } = await executePendingAeonActionPlan(plan, interaction, false);
            deleteAeonActionPlan(interaction.guild.id, plan.id);
            return send(interaction, buildAeonActionResultEmbed(runResult, interaction.user, "AEON AI Action Executed"));
          } catch (error) {
            return fail(interaction, "Execution Failed", shorten(error?.message || "Could not execute action plan.", 900));
          }
        }

        if (sub === "deny") {
          const planId = parseAeonActionPlanId(interaction.options.getString("plan_id", true));
          if (!planId) return fail(interaction, "Invalid Plan ID", "Provide a valid plan ID from `/aeon action run`.");
          const plan = getAeonActionPlan(interaction.guild.id, planId);
          if (!plan) return fail(interaction, "Plan Not Found", "This plan is missing or expired.");
          if (plan.ownerId !== interaction.user.id) {
            return fail(interaction, "Private Plan", "Only the plan creator can cancel this plan.");
          }
          deleteAeonActionPlan(interaction.guild.id, plan.id);
          appendGuildAeonActionAudit(interaction.guild.id, {
            id: makeAeonRunId(),
            planId: plan.id,
            request: plan.request,
            summary: "Plan was cancelled by user command.",
            status: "cancelled",
            risk: plan.risk || "low",
            dryRun: false,
            createdBy: interaction.user.id,
            createdAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            actions: [],
            warnings: plan.warnings || [],
            rollbackSteps: [],
          });
          return send(interaction, makeEmbed("Action Plan Cancelled", `Plan \`${plan.id}\` was cancelled.`, COLORS.INFO));
        }

        if (sub === "history") {
          const limitRaw = interaction.options.getInteger("limit");
          const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, limitRaw)) : 10;
          return send(interaction, buildAeonActionHistoryEmbed(interaction.guild.id, limit));
        }

        if (sub === "rollback") {
          const runId = parseAeonRunId(interaction.options.getString("run_id", true));
          if (!runId) return fail(interaction, "Invalid Run ID", "Provide a valid run ID from `/aeon action history`.");
          const allEntries = Array.isArray(aeonActionAuditStore[interaction.guild.id]) ? aeonActionAuditStore[interaction.guild.id] : [];
          const entry = allEntries.find((item) => item && item.id === runId);
          if (!entry) return fail(interaction, "Run Not Found", "No audit entry was found for that run ID.");
          if (!Array.isArray(entry.rollbackSteps) || !entry.rollbackSteps.length) {
            return fail(interaction, "Rollback Unavailable", "This run has no rollback snapshot.");
          }
          if (String(entry.rollbackStatus || "").startsWith("manual")) {
            return fail(interaction, "Already Rolled Back", "Manual rollback has already been executed for this run.");
          }
          const rollbackSummary = await rollbackAeonActionSteps(
            interaction.guild,
            entry.rollbackSteps,
            `Manual rollback requested by ${interaction.user.tag} (${interaction.user.id})`,
          );
          updateGuildAeonActionAudit(interaction.guild.id, runId, {
            rollbackStatus: `manual:${new Date().toISOString()}`,
          });
          const description = rollbackSummary.length
            ? rollbackSummary.slice(0, 12).join("\n")
            : "Rollback attempted. No restorable resources were found.";
          return send(interaction, makeEmbed("Rollback Completed", shorten(description, 1200), COLORS.SUCCESS));
        }
      }

      if (subGroup === "policy") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;
        const policy = getGuildAeonActionPolicy(interaction.guild.id);

        if (sub === "view") {
          return send(interaction, buildAeonActionPolicyEmbed(policy));
        }
        if (sub === "toggle") {
          const enabled = interaction.options.getBoolean("enabled", true);
          const next = setGuildAeonActionPolicy(interaction.guild.id, {
            enabled,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(interaction, buildAeonActionPolicyEmbed(next));
        }
        if (sub === "approval") {
          const required = interaction.options.getBoolean("required", true);
          const next = setGuildAeonActionPolicy(interaction.guild.id, {
            requireApproval: required,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(interaction, buildAeonActionPolicyEmbed(next));
        }
        if (sub === "allow") {
          const actionType = normalizeAeonActionType(interaction.options.getString("action", true));
          if (!actionType) return fail(interaction, "Invalid Action", "Unsupported action type.");
          const allowed = normalizeAeonActionTypeList([...(policy.allowedActions || []), actionType]);
          const next = setGuildAeonActionPolicy(interaction.guild.id, {
            allowedActions: allowed,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(interaction, buildAeonActionPolicyEmbed(next));
        }
        if (sub === "deny") {
          const actionType = normalizeAeonActionType(interaction.options.getString("action", true));
          if (!actionType) return fail(interaction, "Invalid Action", "Unsupported action type.");
          const allowed = normalizeAeonActionTypeList((policy.allowedActions || []).filter((item) => item !== actionType));
          const next = setGuildAeonActionPolicy(interaction.guild.id, {
            allowedActions: allowed,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(interaction, buildAeonActionPolicyEmbed(next));
        }
        if (sub === "maxactions") {
          const countRaw = interaction.options.getInteger("count", true);
          const count = Math.max(1, Math.min(12, Number(countRaw || 8)));
          const next = setGuildAeonActionPolicy(interaction.guild.id, {
            maxActionsPerRun: count,
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(interaction, buildAeonActionPolicyEmbed(next));
        }
        if (sub === "reset") {
          const next = setGuildAeonActionPolicy(interaction.guild.id, {
            ...defaultAeonActionPolicy(),
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
          return send(interaction, buildAeonActionPolicyEmbed(next));
        }
      }

      if (subGroup === "workflow") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;

        if (sub === "list") {
          const workflows = getGuildAeonActionWorkflows(interaction.guild.id);
          return send(interaction, buildAeonActionWorkflowListEmbed(workflows));
        }

        if (sub === "save") {
          const rawName = interaction.options.getString("name", true);
          const request = shorten(String(interaction.options.getString("request", true) || "").trim(), AEON_ACTION_REQUEST_MAX);
          const name = normalizeWorkflowName(rawName);
          if (!name) return fail(interaction, "Invalid Name", "Workflow name must contain letters or numbers.");
          if (!request || request.length < 5) return fail(interaction, "Invalid Request", "Workflow request is too short.");
          const parsed = parseAeonActionRequest(request);
          if (!parsed.actions.length) {
            return fail(interaction, "Invalid Workflow", "No executable actions were detected in that workflow request.");
          }
          const workflow = upsertGuildAeonActionWorkflow(
            interaction.guild.id,
            { name, request, createdBy: interaction.user.id },
            interaction.user.id,
          );
          if (!workflow) return fail(interaction, "Save Failed", "Could not save this workflow.");
          return send(
            interaction,
            makeEmbed(
              "Workflow Saved",
              `Saved \`${workflow.name}\` with ${parsed.actions.length} action(s).`,
              COLORS.SUCCESS,
            ),
          );
        }

        if (sub === "show") {
          const rawName = interaction.options.getString("name", true);
          const workflow = getGuildAeonActionWorkflow(interaction.guild.id, rawName);
          if (!workflow) return fail(interaction, "Workflow Not Found", "No workflow matches that name.");
          const parsed = parseAeonActionRequest(workflow.request);
          const lines = parsed.actions.map((item, index) => `${index + 1}. ${humanizeAeonAction(item)}`);
          return send(
            interaction,
            makeEmbed(
              `Workflow: ${workflow.name}`,
              shorten(workflow.request, 1600),
              COLORS.INFO,
              [
                { name: "Actions", value: `${parsed.actions.length}`, inline: true },
                { name: "Updated", value: workflow.updatedAt ? `<t:${Math.floor(new Date(workflow.updatedAt).getTime() / 1000)}:R>` : "Unknown", inline: true },
                { name: "Preview", value: shorten(lines.join("\n") || "No actions.", 1000), inline: false },
              ],
            ),
          );
        }

        if (sub === "remove") {
          const rawName = interaction.options.getString("name", true);
          const removed = removeGuildAeonActionWorkflow(interaction.guild.id, rawName, interaction.user.id);
          if (!removed) return fail(interaction, "Workflow Not Found", "No workflow matches that name.");
          return send(interaction, makeEmbed("Workflow Removed", `Removed workflow \`${normalizeWorkflowName(rawName)}\`.`, COLORS.SUCCESS));
        }

        if (sub === "run") {
          const rawName = interaction.options.getString("name", true);
          const workflow = getGuildAeonActionWorkflow(interaction.guild.id, rawName);
          if (!workflow) return fail(interaction, "Workflow Not Found", "No workflow matches that name.");
          const dryRun = interaction.options.getBoolean("dry_run") === true;
          return dispatchAeonActionPlan(workflow.request, {
            dryRun,
            source: "workflow",
            workflowName: workflow.name,
          });
        }
      }

      if (sub === "events") {
        const events = loadAeonEventsForPanel();
        if (!events.length) {
          return send(
            interaction,
            makeEmbed(
              "No Events Found",
              "Event data is not available in the knowledge base yet.",
              COLORS.WARNING,
            ),
            false,
          );
        }

        const panel = createAeonEventsPanel(interaction.guild.id, interaction.user.id, events);
        return interaction.reply({
          embeds: [buildAeonEventsEmbed(panel, interaction.user, interaction.client.user)],
          components: buildAeonEventsComponents(interaction.user.id, panel.id, panel.pageIndex, panel.events),
        });
      }

      if (sub === "ask") {
        const question = interaction.options.getString("question", true).trim();
        if (!question || question.length < 3) {
          return fail(interaction, "Invalid Question", "Please ask a clear question with at least 3 characters.");
        }
        const parsedActionPlan = parseAeonActionRequest(question);
        const requesterCanManageGuild =
          typeof interaction.member?.permissions?.has === "function" &&
          interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD);
        if (requesterCanManageGuild && isLikelyAeonActionRequest(question, parsedActionPlan)) {
          return dispatchAeonActionPlan(question, {
            dryRun: inferActionDryRunFromText(question),
            source: "ask",
          });
        }
        const useEmbed = interaction.options.getBoolean("embed") === true;
        const includeMetrics = interaction.options.getBoolean("metrics") === true;
        const selectedMode = interaction.options.getString("mode");
        const responseMode = inferAeonResponseModeFromQuestion(question, selectedMode || "normal");

        await interaction.deferReply();
        try {
          const history = getAeonConversationHistory(interaction);
          const discordContext = await collectAeonDiscordContextFromInteraction(interaction);
          const contextualQuestion = buildAeonContextualQuestion(question, discordContext);
          const result = await askAeonAgent(contextualQuestion, {
            username: interaction.user.username || interaction.user.tag || "Attendee",
            history,
            mode: responseMode,
          });

          const snapshot = getAeonAgentStatusSnapshot();
          const answer = sanitizeAeonVisibleAnswer(result?.answer);
          recordAeonAskTelemetry(question, result, { auto: false, mode: responseMode });
          const metrics = includeMetrics ? formatAeonAskMetrics(result, snapshot) : null;
          pushAeonConversationHistoryTurn(interaction, question, answer);

          if (useEmbed) {
            const fields = metrics?.fields || [];
            const embed = makeEmbed("AEON'26 Assistant", shorten(answer, 3200), "#1F7A5C", fields);
            if (interaction.client.user?.displayAvatarURL) {
              setEmbedThumbnailSafe(
                embed,
                interaction.client.user.displayAvatarURL({ dynamic: true, size: 1024 }),
              );
            }
            if (metrics?.footer) setEmbedFooterSafe(embed, metrics.footer);
            return interaction.editReply({ embeds: [embed], content: null });
          }

          const metricText = includeMetrics && metrics?.text ? shorten(metrics.text, 320) : "";
          const plainBody = metricText ? `${answer}\n\n${metricText}` : answer;
          const chunks = splitTextForDiscord(plainBody, 1900);
          const first = chunks[0] || "No answer was generated.";
          await interaction.editReply({ content: first, embeds: [] });
          for (let i = 1; i < chunks.length; i += 1) {
            await interaction.followUp({ content: chunks[i] });
          }
          return;
        } catch (error) {
          console.error("AEON assistant ask failed:", error);
          const message = shorten(error?.message || "The assistant failed to respond.", 1500);
          if (!useEmbed) {
            return interaction.editReply({ content: `AEON Assistant Error: ${message}`, embeds: [] });
          }
          return interaction.editReply({
            embeds: [
              makeEmbed(
                "AEON Assistant Error",
                shorten(message, 1000),
                COLORS.ERROR,
              ),
            ],
          });
        }
      }

      if (sub === "setactivation") {
        if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;
        const rawText = interaction.options.getString("text", true).trim();
        const disable = /^(off|none|disable|disabled|clear)$/i.test(rawText);
        const activationText = disable ? "" : (normalizeAeonActivationTexts([rawText], 1)[0] || "");

        if (!disable && activationText.length < 2) {
          return fail(interaction, "Invalid Text", "Activation text must be at least 2 characters.");
        }

        setGuildSetupConfig(interaction.guild.id, {
          aeonActivationTexts: disable ? [] : [activationText],
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        return send(
          interaction,
          makeEmbed(
            "AEON Activation Updated",
            disable
              ? "Auto-activation is now disabled."
              : `Activation list was replaced with \`${activationText}\`.`,
            COLORS.SUCCESS,
          ),
        );
      }

      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;

      if (sub === "status") {
        await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        const status = await getAeonAgentRuntimeStatus();
        const statusColor = status.ok ? COLORS.SUCCESS : COLORS.WARNING;
        const routerModel = status.router_model || status.routerModel || "unknown";
        const answerModel = status.answer_model || status.answerModel || status.model || "unknown";
        const routerReady =
          typeof status.router_ready === "boolean"
            ? status.router_ready
            : Boolean(status.groqConfigured || status.groq_configured);
        const answerReady =
          typeof status.answer_ready === "boolean"
            ? status.answer_ready
            : Boolean(status.groqConfigured || status.groq_configured);
        const retrievalMode = status.retrieval_mode || "Unknown";
        const contextAware =
          typeof status.context_awareness === "boolean"
            ? status.context_awareness
            : true;
        const bridgeMetrics = status.bridge || {};
        const askLatency = bridgeMetrics.ask_latency_ms || {};
        const askQueue = bridgeMetrics.queue || {};
        const workerBridge = bridgeMetrics.worker || {};
        const cacheHitRate =
          typeof bridgeMetrics.cache_hit_rate === "number"
            ? `${(bridgeMetrics.cache_hit_rate * 100).toFixed(1)}%`
            : "Unknown";
        const runtimeStore = getRuntimeStoreStatus();
        const commandTotal = Number.isFinite(observabilityStore.totalCommands) ? observabilityStore.totalCommands : 0;
        const commandErrors = Number.isFinite(observabilityStore.totalErrors) ? observabilityStore.totalErrors : 0;
        const botStartedAt = observabilityStore.startedAt ? Math.floor(new Date(observabilityStore.startedAt).getTime() / 1000) : null;
        const keyPoolSize = Number.isFinite(status.groq_key_pool_size)
          ? Number(status.groq_key_pool_size)
          : 1;
        const activeKeyIndex = Number.isFinite(status.groq_active_key_index)
          ? Number(status.groq_active_key_index)
          : 0;
        const failoverCount = Number.isFinite(status.groq_failovers)
          ? Number(status.groq_failovers)
          : 0;

        const fields = [
          { name: "Groq API", value: status.groqConfigured || status.groq_configured ? "Configured" : "Missing", inline: true },
          {
            name: "Models",
            value: `Router: ${shorten(routerModel, 80)}\nAnswer: ${shorten(answerModel, 80)}`,
            inline: false,
          },
          {
            name: "LLM Ready",
            value: `Router ${routerReady ? "Yes" : "No"} | Answer ${answerReady ? "Yes" : "No"}`,
            inline: true,
          },
          {
            name: "Key Failover",
            value: `Pool ${Math.max(0, keyPoolSize)} | Active ${activeKeyIndex > 0 ? activeKeyIndex : "None"} | Failovers ${Math.max(0, failoverCount)}`,
            inline: false,
          },
          { name: "Python", value: `\`${shorten(status.pythonBin || "python", 50)}\``, inline: true },
          {
            name: "Paths",
            value: `Agent ${status.scriptExists ? "Found" : "Missing"} | Knowledge ${status.knowledgeDirExists ? "Found" : "Missing"}`,
            inline: true,
          },
          { name: "Embedding", value: shorten(status.embedding_model || status.embeddingModel || "Unknown", 100), inline: false },
          { name: "Chroma Dir", value: shorten(status.chroma_dir || status.chromaDir || "Unknown", 100), inline: false },
          {
            name: "Vector DB",
            value:
              status.vector_db_ready || status.vectorDbReady
                ? "Ready"
                : status.vector_db_enabled || status.vectorDbEnabled
                  ? "Unavailable"
                  : "Disabled",
            inline: true,
          },
          { name: "Context Aware", value: contextAware ? "Yes" : "No", inline: true },
          { name: "Retrieval", value: shorten(retrievalMode, 100), inline: false },
          {
            name: "Knowledge Chunks",
            value: Number.isFinite(status.knowledge_chunks) ? `${status.knowledge_chunks}` : "Unknown",
            inline: true,
          },
          {
            name: "Retrieval Index",
            value: Number.isFinite(status.retrieval_index_entries)
              ? `${status.retrieval_index_entries} entries | ${Number.isFinite(status.retrieval_index_sections) ? status.retrieval_index_sections : "?"} sections`
              : "Unknown",
            inline: true,
          },
          {
            name: "Ask Latency",
            value:
              askLatency && (askLatency.p50_ms || askLatency.p95_ms || askLatency.avg_ms)
                ? `p50 ${askLatency.p50_ms || "?"}ms | p95 ${askLatency.p95_ms || "?"}ms`
                : "No samples yet",
            inline: true,
          },
          {
            name: "Ask Queue",
            value: `active ${askQueue.active || 0} | pending ${askQueue.pending || 0} | dropped ${askQueue.dropped || 0}`,
            inline: true,
          },
          { name: "Ask Cache Hit", value: cacheHitRate, inline: true },
          {
            name: "AI Backend Errors",
            value: `${bridgeMetrics.failed_requests || 0}/${bridgeMetrics.backend_requests || 0}`,
            inline: true,
          },
          {
            name: "AI Worker",
            value: workerBridge.connected ? `Connected (PID ${workerBridge.pid || "?"})` : "Disconnected",
            inline: true,
          },
          {
            name: "Runtime DB",
            value: `${runtimeStore.namespace_count} namespaces | ${Math.max(1, Math.round((runtimeStore.size_bytes || 0) / 1024))} KB`,
            inline: true,
          },
          {
            name: "Command Health",
            value: `${commandErrors} errors / ${commandTotal} commands`,
            inline: true,
          },
          { name: "Observability Since", value: botStartedAt ? `<t:${botStartedAt}:R>` : "Unknown", inline: true },
          {
            name: "Top Commands",
            value: shorten(formatTopCommandUsage(4), 1000),
            inline: false,
          },
        ];

        if (status.error) {
          fields.push({
            name: "Status Detail",
            value: shorten(status.error, 1000),
            inline: false,
          });
        }
        if (status.vector_error) {
          fields.push({
            name: "Vector Detail",
            value: shorten(status.vector_error, 1000),
            inline: false,
          });
        }
        if (status.groq_last_failover_reason) {
          fields.push({
            name: "Last Failover Reason",
            value: shorten(String(status.groq_last_failover_reason), 1000),
            inline: false,
          });
        }

        return interaction.editReply({
          embeds: [
            makeEmbed(
              "AEON Assistant Status",
              status.ok
                ? "Assistant runtime is healthy."
                : "Assistant has configuration/runtime issues.",
              statusColor,
              fields,
            ),
          ],
        });
      }

      if (sub === "analytics") {
        await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        const status = await getAeonAgentRuntimeStatus();
        const bridgeMetrics = status.bridge || {};
        const askLatency = bridgeMetrics.ask_latency_ms || {};
        const askQueue = bridgeMetrics.queue || {};
        const cacheHitRate =
          typeof bridgeMetrics.cache_hit_rate === "number"
            ? `${(bridgeMetrics.cache_hit_rate * 100).toFixed(1)}%`
            : "Unknown";

        const aeonObs = observabilityStore?.aeon || {};
        const asks = Number.isFinite(aeonObs.asks) ? aeonObs.asks : 0;
        const autoAsks = Number.isFinite(aeonObs.autoAsks) ? aeonObs.autoAsks : 0;
        const slashAsks = Math.max(0, asks - autoAsks);

        return interaction.editReply({
          embeds: [
            makeEmbed(
              "AEON AI Analytics",
              "Operational analytics for AEON ask traffic and retrieval quality.",
              COLORS.INFO,
              [
                { name: "AEON Ask Volume", value: `Total ${asks} | Slash ${slashAsks} | Auto ${autoAsks}`, inline: true },
                { name: "Top Asked Topics", value: shorten(formatTopAeonTopics(6), 1000), inline: false },
                { name: "Recent No-Result Queries", value: shorten(formatRecentAeonNoResult(5), 1000), inline: false },
                {
                  name: "Ask Latency",
                  value:
                    askLatency && (askLatency.avg_ms || askLatency.p50_ms || askLatency.p95_ms)
                      ? `avg ${askLatency.avg_ms || "?"}ms | p50 ${askLatency.p50_ms || "?"}ms | p95 ${askLatency.p95_ms || "?"}ms`
                      : "No samples yet",
                  inline: true,
                },
                { name: "Ask Cache Hit Rate", value: cacheHitRate, inline: true },
                {
                  name: "Queue Health",
                  value: `active ${askQueue.active || 0} | pending ${askQueue.pending || 0} | dropped ${askQueue.dropped || 0} | timeouts ${askQueue.timeouts || 0}`,
                  inline: true,
                },
              ],
            ),
          ],
        });
      }

      if (sub === "reload") {
        await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        try {
          const response = await reloadAeonAgentKnowledge();
          const reloaded = response?.reloaded || {};
          const runtime = response?.status || {};

          return interaction.editReply({
            embeds: [
              makeEmbed(
                "AEON Knowledge Reloaded",
                "Knowledge files were reloaded successfully.",
                COLORS.SUCCESS,
                [
                  {
                    name: "Sources",
                    value: Number.isFinite(reloaded.source_count) ? `${reloaded.source_count}` : "Unknown",
                    inline: true,
                  },
                  {
                    name: "Chunks",
                    value: Number.isFinite(reloaded.chunk_count) ? `${reloaded.chunk_count}` : "Unknown",
                    inline: true,
                  },
                  {
                    name: "Router Model",
                    value: shorten(
                      runtime.router_model ||
                        runtime.routerModel ||
                        getAeonAgentStatusSnapshot().routerModel ||
                        "unknown",
                      100,
                    ),
                    inline: true,
                  },
                  {
                    name: "Answer Model",
                    value: shorten(
                      runtime.answer_model ||
                        runtime.answerModel ||
                        runtime.model ||
                        getAeonAgentStatusSnapshot().answerModel ||
                        getAeonAgentStatusSnapshot().model ||
                        "unknown",
                      100,
                    ),
                    inline: true,
                  },
                  {
                    name: "Vector DB",
                    value:
                      runtime.vector_db_ready || runtime.vectorDbReady
                        ? "Ready"
                        : runtime.vector_db_enabled || runtime.vectorDbEnabled
                          ? "Unavailable"
                          : "Disabled",
                    inline: true,
                  },
                ],
              ),
            ],
          });
        } catch (error) {
          console.error("AEON assistant reload failed:", error);
          return interaction.editReply({
            embeds: [
              makeEmbed(
                "Reload Failed",
                shorten(error?.message || "Could not reload assistant knowledge.", 1000),
                COLORS.ERROR,
              ),
            ],
          });
        }
      }

      return fail(interaction, "Invalid Option", "Unknown AEON assistant subcommand.");
    }

    if (interaction.commandName === "reactionroles") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) return;

      const channel = interaction.options.getChannel("channel", true);
      if (!isTextChannel(channel)) {
        return fail(interaction, "Invalid Channel", "Please choose a text or announcement channel.");
      }
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.SEND_MESSAGES, "Send Messages", channel))) return;
      if (
        Permissions.FLAGS.EMBED_LINKS !== undefined &&
        !(await requireBotPerm(interaction, botMember, Permissions.FLAGS.EMBED_LINKS, "Embed Links", channel))
      ) {
        return;
      }

      const title = shorten(interaction.options.getString("title", true).trim(), 120);
      await interaction.guild.emojis.fetch().catch(() => null);
      const messageInput = interaction.options.getString("message", true).trim();
      const message = shorten(replaceCustomEmojiShortcodes(interaction.guild, messageInput), 3000);
      if (!title) return fail(interaction, "Invalid Title", "Panel title cannot be empty.");
      if (!message) return fail(interaction, "Invalid Message", "Panel message cannot be empty.");

      const entries = [];
      for (let i = 1; i <= 7; i += 1) {
        const emojiRaw = interaction.options.getString(`emoji${i}`);
        const optionRaw = interaction.options.getString(`option${i}`);
        const role = interaction.options.getRole(`role${i}`);

        if (!emojiRaw && !optionRaw && !role) continue;
        if (!emojiRaw || !optionRaw || !role) {
          return fail(
            interaction,
            "Invalid Pair",
            `\`emoji${i}\`, \`option${i}\`, and \`role${i}\` must be provided together.`,
          );
        }

        const label = String(optionRaw || "").trim();
        if (!label) {
          return fail(interaction, "Invalid Option", `option${i}: label cannot be empty.`);
        }
        if (label.length > 80) {
          return fail(interaction, "Invalid Option", `option${i}: label must be 80 characters or fewer.`);
        }

        const parsedEmoji = parseReactionRoleEmoji(emojiRaw);
        if (!parsedEmoji.emoji) {
          return fail(interaction, "Invalid Emoji", `emoji${i}: ${parsedEmoji.error}`);
        }
        const resolvedEmoji = await resolveReactionRoleEmoji(interaction.guild, parsedEmoji.emoji);
        if (!resolvedEmoji.emoji) {
          return fail(interaction, "Invalid Emoji", `emoji${i}: ${resolvedEmoji.error}`);
        }

        if (role.id === interaction.guild.id) {
          return fail(interaction, "Invalid Role", `role${i} cannot be @everyone.`);
        }
        if (role.managed) {
          return fail(interaction, "Invalid Role", `role${i} is managed by an integration and cannot be self-assigned.`);
        }
        if (!canManageRoleByHierarchy(interaction.member, role, interaction.guild.ownerId)) {
          return fail(interaction, "Role Hierarchy Blocked", `Your highest role must be above ${role}.`);
        }
        if (botMember.roles.highest.comparePositionTo(role) <= 0) {
          return fail(interaction, "Role Hierarchy Blocked", `My highest role must be above ${role}.`);
        }

        entries.push({
          label,
          emoji: resolvedEmoji.emoji,
          role,
        });
      }

      if (!entries.length) {
        return fail(interaction, "No Options", "Provide at least one option/role pair.");
      }

      const uniqueRoleIds = new Set(entries.map((entry) => entry.role.id));
      if (uniqueRoleIds.size !== entries.length) {
        return fail(interaction, "Duplicate Roles", "Each option must target a unique role.");
      }

      const lines = entries.map(
        (entry) => `${formatReactionRoleEmoji(entry.emoji)} **${entry.label}**\n${entry.role}`,
      );
      const body = `${message}\n\n${lines.join("\n\n")}`;
      if (body.length > 4000) {
        return fail(interaction, "Message Too Long", "Reduce title/message/options so embed description stays within Discord limits.");
      }

      const panel = makeEmbed(title, body, "#2C3E50");
      setEmbedAuthorSafe(
        panel,
        interaction.guild.name,
        interaction.guild.iconURL ? interaction.guild.iconURL({ dynamic: true }) : null,
      );
      setEmbedFooterSafe(panel, "Tap a button below to add or remove the matching role");

      let posted = null;
      try {
        posted = await channel.send({
          embeds: [panel],
          components: buildReactionRoleComponents(entries),
        });
      } catch (error) {
        console.error("Failed to post reaction-role panel:", error);
        return fail(
          interaction,
          "Panel Send Failed",
          "Could not post the panel. Check channel permissions and emoji format.",
        );
      }

      await logModerationAction(interaction.guild, "Reaction Role Panel Created", [
        { name: "Channel", value: `${channel}` },
        { name: "Options", value: `${entries.length}` },
        { name: "Created By", value: `<@${interaction.user.id}>` },
      ], COLORS.INFO);

      return send(
        interaction,
        makeEmbed(
          "Reaction Roles Created",
          `Panel posted in ${channel}.`,
          COLORS.SUCCESS,
          [
            { name: "Channel", value: `${channel}`, inline: true },
            { name: "Options", value: `${entries.length}`, inline: true },
            { name: "Jump", value: posted?.url || "Posted", inline: false },
          ],
        ),
      );
    }

    if (interaction.commandName === "remind") {
      const parsed = parseReminderDurationMs(interaction.options.getString("time", true));
      if (!parsed.ms) return fail(interaction, "Invalid Reminder Time", parsed.error);
      const rawText = String(interaction.options.getString("text", true) || "").trim();
      const text = shorten(rawText, 1000);
      if (!text) return fail(interaction, "Invalid Reminder Text", "Reminder text cannot be empty.");

      const reminder = createReminder({
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        userId: interaction.user.id,
        text,
        ms: parsed.ms,
      });
      return send(
        interaction,
        makeEmbed(
          "Reminder Scheduled",
          `> ${text}\n\nI will remind you <t:${Math.floor(new Date(reminder.remindAt).getTime() / 1000)}:R>.`,
          COLORS.SUCCESS,
          [
            { name: "For", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Due", value: `<t:${Math.floor(new Date(reminder.remindAt).getTime() / 1000)}:f>`, inline: true },
          ],
        ),
      );
    }

    if (interaction.commandName === "report") {
      const targetUser = interaction.options.getUser("user", true);
      const reason = normalizeReason(interaction.options.getString("reason", true), "No reason provided.");
      if (targetUser.id === interaction.user.id) return fail(interaction, "Invalid Report", "You cannot report yourself.");
      if (targetUser.id === interaction.client.user.id) return fail(interaction, "Invalid Report", "You cannot report the bot.");

      const setup = getGuildSetupConfig(interaction.guild.id);
      if (!setup.reportChannelId) {
        return fail(
          interaction,
          "Reports Channel Not Set",
          "Admins need to run `/setup` and click **Set Reports Here** in the target channel.",
        );
      }

      const reportChannel = interaction.guild.channels.cache.get(setup.reportChannelId);
      if (!reportChannel || !isTextChannel(reportChannel)) {
        return fail(interaction, "Reports Channel Invalid", "Configured reports channel no longer exists.");
      }
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.SEND_MESSAGES, "Send Messages", reportChannel))) return;
      if (
        Permissions.FLAGS.EMBED_LINKS !== undefined &&
        !(await requireBotPerm(interaction, botMember, Permissions.FLAGS.EMBED_LINKS, "Embed Links", reportChannel))
      ) {
        return;
      }

      const reporterAvatar =
        interaction.user && typeof interaction.user.displayAvatarURL === "function"
          ? interaction.user.displayAvatarURL({ dynamic: true })
          : null;
      const reportEmbed = makeEmbed(
        "New User Report",
        `**Report Statement**\n> ${shorten(reason, 1800)}`,
        COLORS.WARNING,
        [
          {
            name: "Users",
            value: `Reported: ${targetUser}  |  Reporter: ${interaction.user}`,
            inline: false,
          },
          {
            name: "Source",
            value: `${interaction.channel}`,
            inline: false,
          },
        ],
      );
      setEmbedAuthorSafe(reportEmbed, interaction.user.tag || "Reporter", reporterAvatar);
      if (targetUser.displayAvatarURL) setEmbedThumbnailSafe(reportEmbed, targetUser.displayAvatarURL({ dynamic: true, size: 1024 }));
      setEmbedFooterSafe(reportEmbed, "User report submitted");

      await reportChannel.send({ embeds: [reportEmbed] });
      return send(
        interaction,
        makeEmbed(
          "Report Submitted",
          `Your report has been sent to ${reportChannel}.`,
          COLORS.SUCCESS,
          [{ name: "Reported User", value: `${targetUser}`, inline: true }],
        ),
      );
    }

    if (interaction.commandName === "log") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_GUILD, "Manage Server"))) return;

      const sub = interaction.options.getSubcommand();
      const current = getGuildLogConfig(interaction.guild.id);

      if (sub === "channel") {
        const channel = interaction.options.getChannel("channel", true);
        if (!isTextChannel(channel)) {
          return fail(interaction, "Invalid Channel", "Please choose a standard text or announcement channel.");
        }

        const botCanSend = channel.permissionsFor(botMember)?.has(Permissions.FLAGS.SEND_MESSAGES);
        if (!botCanSend) {
          return fail(interaction, "Permission Error", "I need Send Messages permission in that channel.");
        }
        if (Permissions.FLAGS.EMBED_LINKS !== undefined) {
          const botCanEmbed = channel.permissionsFor(botMember)?.has(Permissions.FLAGS.EMBED_LINKS);
          if (!botCanEmbed) {
            return fail(interaction, "Permission Error", "I need Embed Links permission in that channel.");
          }
        }

        const next = setGuildLogConfig(interaction.guild.id, {
          channelId: channel.id,
          events: current.events,
          updatedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        });

        return send(
          interaction,
          makeEmbed("Log Channel Updated", `Logging channel set to ${channel}.`, COLORS.SUCCESS, [
            { name: "Channel", value: `${channel}` },
            { name: "Updated By", value: `<@${interaction.user.id}>` },
            { name: "Updated At", value: `<t:${Math.floor(new Date(next.updatedAt).getTime() / 1000)}:f>` },
          ]),
        );
      }

      if (sub === "config") {
        const memberEvents = interaction.options.getBoolean("member_events");
        const roleEvents = interaction.options.getBoolean("role_events");
        const channelEvents = interaction.options.getBoolean("channel_events");
        const messageEvents = interaction.options.getBoolean("message_events");
        const moderationEvents = interaction.options.getBoolean("moderation_events");

        const hasUpdates =
          memberEvents !== null ||
          roleEvents !== null ||
          channelEvents !== null ||
          messageEvents !== null ||
          moderationEvents !== null;

        let next = current;
        if (hasUpdates) {
          next = setGuildLogConfig(interaction.guild.id, {
            channelId: current.channelId,
            events: {
              member: memberEvents === null ? current.events.member : memberEvents,
              role: roleEvents === null ? current.events.role : roleEvents,
              channel: channelEvents === null ? current.events.channel : channelEvents,
              message: messageEvents === null ? current.events.message : messageEvents,
              moderation: moderationEvents === null ? current.events.moderation : moderationEvents,
            },
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString(),
          });
        }

        const channelMention = next.channelId ? `<#${next.channelId}>` : "Not Set";
        return send(
          interaction,
          makeEmbed(hasUpdates ? "Log Config Updated" : "Log Config", "Current logging configuration.", COLORS.INFO, [
            { name: "Log Channel", value: channelMention },
            { name: "Member Events", value: next.events.member ? "Enabled" : "Disabled", inline: true },
            { name: "Role Events", value: next.events.role ? "Enabled" : "Disabled", inline: true },
            { name: "Channel Events", value: next.events.channel ? "Enabled" : "Disabled", inline: true },
            { name: "Message Events", value: next.events.message ? "Enabled" : "Disabled", inline: true },
            { name: "Moderation Events", value: next.events.moderation ? "Enabled" : "Disabled", inline: true },
            { name: "Updated By", value: next.updatedBy ? `<@${next.updatedBy}>` : "Unknown" },
          ]),
        );
      }

    }

    if (interaction.commandName === "kick") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.KICK_MEMBERS, "Kick Members"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.KICK_MEMBERS, "Kick Members"))) return;
      const target = interaction.options.getMember("user");
      if (!(await validateTarget(interaction, botMember, target))) return;
      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Kicked by ${interaction.user.tag} (${interaction.user.id})`,
      );
      await target.kick(reason);
      await logModerationAction(interaction.guild, "Member Kicked", [
        { name: "User", value: `${target}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason },
      ], COLORS.WARNING);
      recordModerationHistory(interaction.guild.id, target.id, {
        action: "kick",
        moderatorId: interaction.user.id,
        reason,
      });
      return send(
        interaction,
        makeEmbed("Member Kicked", `${target} has been removed from the server.`, COLORS.SUCCESS, [
          { name: "User", value: `${target}` },
          { name: "Moderator", value: `<@${interaction.user.id}>` },
          { name: "Reason", value: reason },
        ]),
      );
    }

    if (interaction.commandName === "ban") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.BAN_MEMBERS, "Ban Members"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.BAN_MEMBERS, "Ban Members"))) return;
      const targetUser = interaction.options.getUser("user", true);
      const deleteDays = interaction.options.getInteger("delete_days") ?? 0;
      if (!Number.isInteger(deleteDays) || deleteDays < 0 || deleteDays > 7) {
        return fail(interaction, "Invalid Input", "`delete_days` must be an integer between 0 and 7.");
      }
      if (targetUser.id === interaction.user.id) return fail(interaction, "Invalid Target", "You cannot ban yourself.");
      if (targetUser.id === client.user.id) return fail(interaction, "Invalid Target", "This action cannot target the bot account.");
      if (targetUser.id === interaction.guild.ownerId) return fail(interaction, "Invalid Target", "The server owner cannot be banned.");
      const existingBan = await interaction.guild.bans.fetch(targetUser.id).catch(() => null);
      if (existingBan) return send(interaction, makeEmbed("Already Banned", `${targetUser} is already banned.`, COLORS.WARNING));
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      if (targetMember && !(await validateTarget(interaction, botMember, targetMember))) return;
      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Banned by ${interaction.user.tag} (${interaction.user.id})`,
      );
      await interaction.guild.members.ban(targetUser.id, { days: deleteDays, reason });
      await logModerationAction(interaction.guild, "User Banned", [
        { name: "User", value: `${targetUser}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Delete Message Days", value: `${deleteDays}` },
        { name: "Reason", value: reason },
      ], COLORS.WARNING);
      recordModerationHistory(interaction.guild.id, targetUser.id, {
        action: "ban",
        moderatorId: interaction.user.id,
        reason,
        meta: `delete_days:${deleteDays}`,
      });
      return send(
        interaction,
        makeEmbed("User Banned", `${targetUser} has been banned.`, COLORS.SUCCESS, [
          { name: "User", value: `${targetUser}` },
          { name: "Moderator", value: `<@${interaction.user.id}>` },
          { name: "Delete Message Days", value: `${deleteDays}` },
          { name: "Reason", value: reason },
        ]),
      );
    }

    if (interaction.commandName === "unban") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.BAN_MEMBERS, "Ban Members"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.BAN_MEMBERS, "Ban Members"))) return;
      const userId = interaction.options.getString("user_id", true).trim();
      if (!/^\d{17,20}$/.test(userId)) return fail(interaction, "Invalid Input", "Please provide a valid Discord user ID.");
      const banEntry = await interaction.guild.bans.fetch(userId).catch(() => null);
      if (!banEntry) return send(interaction, makeEmbed("Not Banned", `No active ban was found for <@${userId}>.`, COLORS.WARNING));
      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Unbanned by ${interaction.user.tag} (${interaction.user.id})`,
      );
      await interaction.guild.members.unban(userId, reason);
      await logModerationAction(interaction.guild, "User Unbanned", [
        { name: "User", value: `<@${userId}>` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason },
      ], COLORS.SUCCESS);
      recordModerationHistory(interaction.guild.id, userId, {
        action: "unban",
        moderatorId: interaction.user.id,
        reason,
      });
      return send(
        interaction,
        makeEmbed("User Unbanned", `<@${userId}> has been unbanned.`, COLORS.SUCCESS, [
          { name: "User", value: `<@${userId}>` },
          { name: "Moderator", value: `<@${interaction.user.id}>` },
          { name: "Reason", value: reason },
        ]),
      );
    }

    if (interaction.commandName === "nick") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_NICKNAMES, "Manage Nicknames"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_NICKNAMES, "Manage Nicknames"))) return;

      const target = interaction.options.getMember("user", true);
      if (!(await validateTarget(interaction, botMember, target))) return;

      const nicknameInput = interaction.options.getString("nickname");
      const nickname = nicknameInput && nicknameInput.trim() ? nicknameInput.trim() : null;
      if (nickname && nickname.length > 32) {
        return fail(interaction, "Invalid Nickname", "Nickname cannot exceed 32 characters.");
      }

      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Nickname updated by ${interaction.user.tag} (${interaction.user.id})`,
      );
      await target.setNickname(nickname, reason);

      await logModerationAction(interaction.guild, "Nickname Updated", [
        { name: "User", value: `${target}` },
        { name: "New Nickname", value: nickname || "Cleared" },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason },
      ], COLORS.INFO);
      recordModerationHistory(interaction.guild.id, target.id, {
        action: "nick",
        moderatorId: interaction.user.id,
        reason,
        meta: nickname || "cleared",
      });

      return send(
        interaction,
        makeEmbed(
          "Nickname Updated",
          `${target} nickname is now ${nickname ? `**${nickname}**` : "**cleared**"}.`,
          COLORS.SUCCESS,
        ),
      );
    }

    if (interaction.commandName === "softban") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.BAN_MEMBERS, "Ban Members"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.BAN_MEMBERS, "Ban Members"))) return;
      const target = interaction.options.getMember("user", true);
      if (!(await validateTarget(interaction, botMember, target))) return;

      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Softban by ${interaction.user.tag} (${interaction.user.id})`,
      );
      await interaction.guild.members.ban(target.id, { days: 1, reason });
      await interaction.guild.members.unban(target.id, reason);

      await logModerationAction(interaction.guild, "Member Softbanned", [
        { name: "User", value: `${target}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason },
      ], COLORS.WARNING);
      recordModerationHistory(interaction.guild.id, target.id, {
        action: "softban",
        moderatorId: interaction.user.id,
        reason,
      });

      return send(
        interaction,
        makeEmbed(
          "Member Softbanned",
          `${target} was banned and immediately unbanned.`,
          COLORS.SUCCESS,
        ),
      );
    }

    if (interaction.commandName === "massrole") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_ROLES, "Manage Roles"))) return;

      const action = interaction.options.getString("action", true);
      const role = interaction.options.getRole("role", true);
      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Mass role ${action} by ${interaction.user.tag} (${interaction.user.id})`,
      );

      if (role.managed) return fail(interaction, "Role Locked", "Managed roles cannot be assigned manually.");
      if (
        interaction.user.id !== interaction.guild.ownerId &&
        interaction.member.roles.highest.comparePositionTo(role) <= 0
      ) {
        return fail(interaction, "Role Hierarchy Blocked", "Your highest role must be above the target role.");
      }
      if (botMember.roles.highest.comparePositionTo(role) <= 0) {
        return fail(interaction, "Role Hierarchy Blocked", "My highest role must be above the target role.");
      }

      const targets = [];
      for (const key of ["user1", "user2", "user3", "user4", "user5"]) {
        const member = interaction.options.getMember(key);
        if (member && !targets.find((t) => t.id === member.id)) targets.push(member);
      }
      if (!targets.length) return fail(interaction, "No Members", "Provide at least one valid member.");

      let success = 0;
      let skipped = 0;
      const failed = [];

      for (const target of targets) {
        const invalidTarget =
          target.id === interaction.user.id ||
          target.id === interaction.guild.ownerId ||
          target.id === interaction.client.user.id ||
          (interaction.user.id !== interaction.guild.ownerId &&
            interaction.member.roles.highest.comparePositionTo(target.roles.highest) <= 0) ||
          botMember.roles.highest.comparePositionTo(target.roles.highest) <= 0;
        if (invalidTarget) {
          failed.push(`<@${target.id}>`);
          continue;
        }

        const hasRole = target.roles.cache.has(role.id);
        if ((action === "add" && hasRole) || (action === "remove" && !hasRole)) {
          skipped += 1;
          continue;
        }

        try {
          if (action === "add") {
            await target.roles.add(role, reason);
          } else {
            await target.roles.remove(role, reason);
          }
          success += 1;
          recordModerationHistory(interaction.guild.id, target.id, {
            action: `massrole-${action}`,
            moderatorId: interaction.user.id,
            reason,
            meta: role.id,
          });
        } catch (_) {
          failed.push(`<@${target.id}>`);
        }
      }

      await logModerationAction(interaction.guild, "Mass Role Update", [
        { name: "Action", value: action },
        { name: "Role", value: `${role}` },
        { name: "Requested", value: `${targets.length}` },
        { name: "Success", value: `${success}`, inline: true },
        { name: "Skipped", value: `${skipped}`, inline: true },
        { name: "Failed", value: failed.length ? failed.join(", ") : "None" },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
      ], COLORS.INFO);

      return send(
        interaction,
        makeEmbed(
          "Mass Role Complete",
          `Action: **${action}** ${role}\nSuccess: **${success}** | Skipped: **${skipped}** | Failed: **${failed.length}**`,
          failed.length ? COLORS.WARNING : COLORS.SUCCESS,
        ),
      );
    }

    if (interaction.commandName === "timeout") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MODERATE_MEMBERS, "Moderate Members"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MODERATE_MEMBERS, "Moderate Members"))) return;
      const target = interaction.options.getMember("user");
      if (!(await validateTarget(interaction, botMember, target))) return;
      if (target.permissions.has(Permissions.FLAGS.ADMINISTRATOR)) {
        return fail(interaction, "Action Blocked", "Members with Administrator permission cannot be timed out.");
      }
      const parsed = parseDurationToMs(interaction.options.getString("duration", true));
      if (!parsed.ms) return fail(interaction, "Invalid Duration", parsed.error);
      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Timed out by ${interaction.user.tag} (${interaction.user.id})`,
      );
      await target.timeout(parsed.ms, reason);
      await logModerationAction(interaction.guild, "Member Timed Out", [
        { name: "User", value: `${target}` },
        { name: "Duration", value: formatSeconds(Math.floor(parsed.ms / 1000)) },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason },
      ], COLORS.WARNING);
      recordModerationHistory(interaction.guild.id, target.id, {
        action: "timeout",
        moderatorId: interaction.user.id,
        reason,
        meta: `${Math.floor(parsed.ms / 1000)}s`,
      });
      return send(
        interaction,
        makeEmbed("Member Timed Out", `${target} has been timed out.`, COLORS.SUCCESS, [
          { name: "User", value: `${target}` },
          { name: "Duration", value: formatSeconds(Math.floor(parsed.ms / 1000)) },
          { name: "Moderator", value: `<@${interaction.user.id}>` },
          { name: "Reason", value: reason },
        ]),
      );
    }

    if (interaction.commandName === "untimeout") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MODERATE_MEMBERS, "Moderate Members"))) return;
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MODERATE_MEMBERS, "Moderate Members"))) return;
      const target = interaction.options.getMember("user");
      if (!(await validateTarget(interaction, botMember, target))) return;
      const activeTimeout = target.communicationDisabledUntilTimestamp && target.communicationDisabledUntilTimestamp > Date.now();
      if (!activeTimeout) return send(interaction, makeEmbed("No Active Timeout", `${target} is not currently timed out.`, COLORS.WARNING));
      const reason = normalizeReason(
        interaction.options.getString("reason"),
        `Timeout removed by ${interaction.user.tag} (${interaction.user.id})`,
      );
      await target.timeout(null, reason);
      await logModerationAction(interaction.guild, "Timeout Removed", [
        { name: "User", value: `${target}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason },
      ], COLORS.SUCCESS);
      recordModerationHistory(interaction.guild.id, target.id, {
        action: "untimeout",
        moderatorId: interaction.user.id,
        reason,
      });
      return send(
        interaction,
        makeEmbed("Timeout Removed", `${target} can now speak again.`, COLORS.SUCCESS, [
          { name: "User", value: `${target}` },
          { name: "Moderator", value: `<@${interaction.user.id}>` },
          { name: "Reason", value: reason },
        ]),
      );
    }

    if (interaction.commandName === "purge") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_MESSAGES, "Manage Messages"))) return;
      const channel = interaction.channel;
      if (!isTextChannel(channel)) return fail(interaction, "Invalid Channel", "This command only works in standard text channels.");
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_MESSAGES, "Manage Messages", channel))) return;
      const amount = interaction.options.getInteger("amount", true);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
        return fail(interaction, "Invalid Input", "`amount` must be an integer between 1 and 100.");
      }
      const targetUser = interaction.options.getUser("user");
      let deletedCount = 0;
      if (targetUser) {
        const fetched = await channel.messages.fetch({ limit: 100 });
        const filtered = fetched.filter((m) => m.author.id === targetUser.id).first(amount);
        if (filtered.length === 0) {
          return send(interaction, makeEmbed("No Messages Found", `No recent messages from ${targetUser} matched the filter.`, COLORS.WARNING));
        }
        const deleted = await channel.bulkDelete(filtered, true);
        deletedCount = deleted.size;
      } else {
        const deleted = await channel.bulkDelete(amount, true);
        deletedCount = deleted.size;
      }
      await logModerationAction(interaction.guild, "Messages Purged", [
        { name: "Channel", value: `${channel}` },
        { name: "Deleted Count", value: `${deletedCount}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Filter User", value: targetUser ? `${targetUser}` : "None" },
      ], COLORS.WARNING);
      return send(
        interaction,
        makeEmbed(
          "Messages Deleted",
          deletedCount
            ? `Deleted ${deletedCount} message(s) from ${channel}.`
            : "No messages were deleted. Discord ignores messages older than 14 days.",
          deletedCount ? COLORS.SUCCESS : COLORS.WARNING,
        ),
      );
    }

    if (interaction.commandName === "warn") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_MESSAGES, "Manage Messages"))) return;
      const target = interaction.options.getMember("user");
      if (!(await validateTarget(interaction, botMember, target))) return;
      const reason = normalizeReason(interaction.options.getString("reason", true), "No reason provided.");
      const list = getWarnings(interaction.guild.id, target.id);
      list.push({
        id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        reason,
        moderatorId: interaction.user.id,
        createdAt: new Date().toISOString(),
      });
      setWarnings(interaction.guild.id, target.id, list);
      await logModerationAction(interaction.guild, "Member Warned", [
        { name: "User", value: `${target}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason },
        { name: "Total Warnings", value: `${list.length}` },
      ], COLORS.WARNING);
      recordModerationHistory(interaction.guild.id, target.id, {
        action: "warn",
        moderatorId: interaction.user.id,
        reason,
      });
      return send(
        interaction,
        makeEmbed("Warning Added", `A warning has been recorded for ${target}.`, COLORS.SUCCESS, [
          { name: "User", value: `${target}` },
          { name: "Moderator", value: `<@${interaction.user.id}>` },
          { name: "Reason", value: reason },
          { name: "Total Warnings", value: `${list.length}` },
        ]),
      );
    }

    if (interaction.commandName === "warnings") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_MESSAGES, "Manage Messages"))) return;
      const targetUser = interaction.options.getUser("user", true);
      const list = getWarnings(interaction.guild.id, targetUser.id);
      if (!list.length) return send(interaction, makeEmbed("Warnings", `${targetUser} has no recorded warnings.`, COLORS.INFO));
      const recent = list.slice(-10).reverse();
      let description = "";
      for (let i = 0; i < recent.length; i += 1) {
        const w = recent[i];
        const ts = Math.floor(new Date(w.createdAt).getTime() / 1000);
        const warningId = w.id || `legacy-${i + 1}`;
        const line = `**${i + 1}.** ${w.reason}\nID: \`${warningId}\` | Moderator: <@${w.moderatorId}> | Date: <t:${ts}:f>\n\n`;
        if ((description + line).length > 3500) break;
        description += line;
      }
      return send(
        interaction,
        makeEmbed("Warnings", `${targetUser}\n\n${description.trim()}`, COLORS.INFO, [
          { name: "Total", value: `${list.length}` },
        ]),
      );
    }

    if (interaction.commandName === "unwarn") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_MESSAGES, "Manage Messages"))) return;
      const targetUser = interaction.options.getUser("user", true);
      const warningId = interaction.options.getString("warning_id", true).trim();
      const list = getWarnings(interaction.guild.id, targetUser.id);
      if (!list.length) return send(interaction, makeEmbed("No Warnings Found", `${targetUser} has no warnings.`, COLORS.WARNING));

      let index = list.findIndex((item) => item.id === warningId);
      if (index === -1 && /^\d+$/.test(warningId)) {
        const pos = Number(warningId) - 1;
        if (pos >= 0 && pos < list.length) index = pos;
      }
      if (index === -1) {
        return fail(interaction, "Warning Not Found", "Use the exact warning ID from `/warnings`.");
      }

      const [removedWarning] = list.splice(index, 1);
      setWarnings(interaction.guild.id, targetUser.id, list);

      await logModerationAction(interaction.guild, "Warning Removed", [
        { name: "User", value: `${targetUser}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Warning ID", value: removedWarning.id || "Unknown" },
        { name: "Reason", value: removedWarning.reason || "No reason provided." },
      ], COLORS.INFO);
      recordModerationHistory(interaction.guild.id, targetUser.id, {
        action: "unwarn",
        moderatorId: interaction.user.id,
        reason: removedWarning.reason || "No reason provided.",
        meta: removedWarning.id || null,
      });

      return send(
        interaction,
        makeEmbed(
          "Warning Removed",
          `Removed warning \`${removedWarning.id}\` from ${targetUser}.`,
          COLORS.SUCCESS,
        ),
      );
    }

    if (interaction.commandName === "modlogs") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_MESSAGES, "Manage Messages"))) return;
      const targetUser = interaction.options.getUser("user", true);
      const entries = getModerationHistory(interaction.guild.id, targetUser.id);
      if (!entries.length) {
        return send(interaction, makeEmbed("No Moderation History", `${targetUser} has no stored moderation history.`, COLORS.INFO));
      }

      const recent = entries.slice(-12).reverse();
      let description = "";
      for (let i = 0; i < recent.length; i += 1) {
        const entry = recent[i];
        const ts = Math.floor(new Date(entry.createdAt).getTime() / 1000);
        const moderatorRef = entry.moderatorId ? `<@${entry.moderatorId}>` : "Unknown";
        const line = `**${i + 1}. ${entry.action}** | <t:${ts}:f>\nBy: ${moderatorRef} | Reason: ${shorten(entry.reason, 120)}${entry.meta ? ` | Meta: ${shorten(entry.meta, 80)}` : ""}\n\n`;
        if ((description + line).length > 3500) break;
        description += line;
      }

      return send(
        interaction,
        makeEmbed("Moderation History", `${targetUser}\n\n${description.trim()}`, COLORS.INFO, [
          { name: "Total Entries", value: `${entries.length}` },
        ]),
      );
    }

    if (interaction.commandName === "clearwarnings") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_MESSAGES, "Manage Messages"))) return;
      const targetUser = interaction.options.getUser("user", true);
      const removed = clearWarnings(interaction.guild.id, targetUser.id);
      if (!removed) return send(interaction, makeEmbed("No Warnings Found", `${targetUser} has no warnings to clear.`, COLORS.WARNING));
      await logModerationAction(interaction.guild, "Warnings Cleared", [
        { name: "User", value: `${targetUser}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
        { name: "Removed", value: `${removed}` },
      ], COLORS.WARNING);
      recordModerationHistory(interaction.guild.id, targetUser.id, {
        action: "clearwarnings",
        moderatorId: interaction.user.id,
        reason: `Removed ${removed} warnings`,
      });
      return send(
        interaction,
        makeEmbed("Warnings Cleared", `Cleared ${removed} warning(s) for ${targetUser}.`, COLORS.SUCCESS, [
          { name: "Moderator", value: `<@${interaction.user.id}>` },
        ]),
      );
    }

    if (interaction.commandName === "lock" || interaction.commandName === "unlock") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      if (!isTextChannel(channel)) return fail(interaction, "Invalid Channel", "Only standard text channels are supported.");
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels", channel))) return;

      const everyoneRole = interaction.guild.roles.everyone;
      const overwrite = channel.permissionOverwrites.cache.get(everyoneRole.id);
      const isLocked = overwrite?.deny?.has(Permissions.FLAGS.SEND_MESSAGES);

      if (interaction.commandName === "lock") {
        if (isLocked) return send(interaction, makeEmbed("Channel Already Locked", `${channel} is already locked for @everyone.`, COLORS.WARNING));
        await channel.permissionOverwrites.edit(
          everyoneRole,
          { [SEND_MESSAGES_PERMISSION_KEY]: false },
          { reason: `Locked by ${interaction.user.tag} (${interaction.user.id})` },
        );
        await logModerationAction(interaction.guild, "Channel Locked", [
          { name: "Channel", value: `${channel}` },
          { name: "Moderator", value: `<@${interaction.user.id}>` },
        ], COLORS.WARNING);
        return send(
          interaction,
          makeEmbed("Channel Locked", `${channel} is now locked for @everyone.`, COLORS.SUCCESS, [
            { name: "Moderator", value: `<@${interaction.user.id}>` },
          ]),
        );
      }

      if (!isLocked) return send(interaction, makeEmbed("Channel Already Unlocked", `${channel} does not have an explicit lock for @everyone.`, COLORS.WARNING));
      await channel.permissionOverwrites.edit(
        everyoneRole,
        { [SEND_MESSAGES_PERMISSION_KEY]: null },
        { reason: `Unlocked by ${interaction.user.tag} (${interaction.user.id})` },
      );
      await logModerationAction(interaction.guild, "Channel Unlocked", [
        { name: "Channel", value: `${channel}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
      ], COLORS.SUCCESS);
      return send(
        interaction,
        makeEmbed("Channel Unlocked", `${channel} has been unlocked for @everyone.`, COLORS.SUCCESS, [
          { name: "Moderator", value: `<@${interaction.user.id}>` },
        ]),
      );
    }

    if (interaction.commandName === "slowmode") {
      if (!(await requireMemberPerm(interaction, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels"))) return;
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      if (!isTextChannel(channel) || typeof channel.setRateLimitPerUser !== "function") {
        return fail(interaction, "Invalid Channel", "Slowmode can only be set on standard text channels.");
      }
      if (!(await requireBotPerm(interaction, botMember, Permissions.FLAGS.MANAGE_CHANNELS, "Manage Channels", channel))) return;
      const seconds = interaction.options.getInteger("seconds", true);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
        return fail(interaction, "Invalid Input", "`seconds` must be between 0 and 21600.");
      }
      if (channel.rateLimitPerUser === seconds) {
        return send(interaction, makeEmbed("No Change Needed", `${channel} already has slowmode set to ${formatSeconds(seconds)}.`, COLORS.WARNING));
      }
      await channel.setRateLimitPerUser(seconds, `Slowmode updated by ${interaction.user.tag} (${interaction.user.id})`);
      await logModerationAction(interaction.guild, "Slowmode Updated", [
        { name: "Channel", value: `${channel}` },
        { name: "Seconds", value: `${seconds}` },
        { name: "Moderator", value: `<@${interaction.user.id}>` },
      ], COLORS.INFO);
      return send(
        interaction,
        makeEmbed("Slowmode Updated", `${channel} slowmode is now ${formatSeconds(seconds)}.`, COLORS.SUCCESS, [
          { name: "Moderator", value: `<@${interaction.user.id}>` },
        ]),
      );
    }
  } catch (error) {
    console.error(`Command failed: ${interaction.commandName}`, error);
    markCommandFailure(interaction.commandName, error);
    await fail(
      interaction,
      "Action Failed",
      "An unexpected error occurred while processing this command. Check permissions and role hierarchy, then try again.",
    );
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message?.guild || !message?.author) return;
    if (!ENABLE_AEON_AI) return;
    if (message.author.bot) return;
    if (!String(message.content || "").trim()) return;

    const setup = getGuildSetupConfig(message.guild.id);
    const activationTexts = getAeonActivationTexts(setup);
    const botId = message.client?.user?.id || "";
    const mentionQuestion = extractAeonMentionQuestion(message.content, botId);
    const match = findAeonActivationMatch(message.content, activationTexts);
    const activationQuestion = String(match?.question || "").trim();
    const hasActivationMatch = Boolean(match?.activationText && activationQuestion);
    let question = hasActivationMatch ? activationQuestion : mentionQuestion;
    let triggerType = hasActivationMatch ? "activation" : (mentionQuestion ? "mention" : "");

    if (!triggerType) {
      const history = getAeonConversationHistory(message);
      const replyToBot = await isReplyingToBot(message);
      if (history.length && replyToBot && looksLikeAeonFollowupQuestion(message.content)) {
        question = normalizeText(message.content);
        triggerType = "followup";
      }
    }

    if (!triggerType) return;
    if (!question || question.length < 3) return;

    let responseChannel = message.channel;
    if (triggerType === "mention") {
      const routing = await resolveAeonThreadChannelForMessage(message);
      responseChannel = routing?.channel || message.channel;
      if (routing?.moved && responseChannel?.id && responseChannel.id !== message.channel.id) {
        const note = routing.created
          ? `Opened ${responseChannel} for your AEON AI session.`
          : `Continuing your AEON AI session in ${responseChannel}.`;
        await message.reply({
          content: note,
          allowedMentions: { repliedUser: false },
        }).catch(() => null);
      }
    }

    const messageMember =
      message.member?.permissions?.has
        ? message.member
        : await message.guild.members.fetch(message.author.id).catch(() => null);
    const canManageGuildFromMessage =
      typeof messageMember?.permissions?.has === "function" &&
      messageMember.permissions.has(Permissions.FLAGS.MANAGE_GUILD);
    const parsedMessageActionPlan = parseAeonActionRequest(question);

    if (canManageGuildFromMessage && isLikelyAeonActionRequest(question, parsedMessageActionPlan)) {
      const dryRunRequested = inferActionDryRunFromText(question);
      const policy = getGuildAeonActionPolicy(message.guild.id);

      const sendActionResponse = async (payload, replyMode = "normal") => {
        if (responseChannel?.id && responseChannel.id !== message.channel.id) {
          return responseChannel.send({
            content: `<@${message.author.id}>`,
            allowedMentions: { users: [message.author.id], repliedUser: false },
            ...payload,
          }).catch(() => null);
        }
        if (replyMode === "reply") {
          return message.reply({
            allowedMentions: { repliedUser: false },
            ...payload,
          }).catch(() => null);
        }
        return responseChannel.send(payload).catch(() => null);
      };

      if (!policy.enabled) {
        await sendActionResponse({
          embeds: [
            makeEmbed(
              "AI Manager Disabled",
              "AI action execution is disabled by policy. Use `/aeon policy toggle enabled:true`.",
              COLORS.WARNING,
            ),
          ],
        }, "reply");
        return;
      }

      const plan = createAeonActionPlanObject(message.guild, message.author.id, question, {
        source: "auto_ask",
        dryRun: dryRunRequested,
      });
      if (!plan.actions.length) {
        // fallback to normal AI answer if parsing produced no executable actions
      } else {
        if (!plan.policyCheck.ok) {
          await sendActionResponse({
            embeds: [
              makeEmbed(
                "Blocked By Policy",
                shorten(plan.policyCheck.warnings.join("\n") || "Plan violates current policy.", 1000),
                COLORS.WARNING,
              ),
            ],
          }, "reply");
          return;
        }

        const botMember = await getBotMember(message.guild).catch(() => null);
        const permissionCheck = checkAeonActionPermissionBaseline(messageMember, botMember, plan.actions);
        if (!permissionCheck.ok) {
          const lines = [];
          if (permissionCheck.missingMember.length) {
            lines.push(`You are missing: ${permissionCheck.missingMember.join(", ")}`);
          }
          if (permissionCheck.missingBot.length) {
            lines.push(`Bot is missing: ${permissionCheck.missingBot.join(", ")}`);
          }
          await sendActionResponse({
            embeds: [makeEmbed("Permission Check Failed", shorten(lines.join("\n"), 1000), COLORS.ERROR)],
          }, "reply");
          return;
        }

        saveAeonActionPlan(plan);
        const noteParts = [];
        const labels = actionPermLabelsForActions(plan.actions);
        if (labels.length) noteParts.push(`Required: ${labels.join(", ")}`);
        if (policy.requireApproval) noteParts.push("Manual approval required.");
        if (dryRunRequested) noteParts.push("Dry run requested.");
        const previewEmbed = buildAeonActionPlanEmbed(plan, message.author, "preview", noteParts.join(" "));

        if (!policy.requireApproval && !dryRunRequested) {
          try {
            const { runResult } = await executePendingAeonActionPlan(
              plan,
              {
                guild: message.guild,
                member: messageMember,
                user: message.author,
                channel: responseChannel,
              },
              false,
            );
            deleteAeonActionPlan(message.guild.id, plan.id);
            await sendActionResponse({
              embeds: [buildAeonActionResultEmbed(runResult, message.author, "AEON AI Action Executed")],
            }, "reply");
            return;
          } catch (error) {
            deleteAeonActionPlan(message.guild.id, plan.id);
            await sendActionResponse({
              embeds: [makeEmbed("Execution Failed", shorten(error?.message || "Action execution failed.", 1000), COLORS.ERROR)],
            }, "reply");
            return;
          }
        }

        await sendActionResponse({
          embeds: [previewEmbed],
          components: buildAeonActionPlanComponents(message.author.id, plan.id, false),
        }, "reply");
        return;
      }
    }

    const conversationRef = buildAeonConversationRef(message, responseChannel);
    const history = getAeonConversationHistory(conversationRef);
    const discordContext = await collectAeonDiscordContextFromMessage(message);
    const contextualQuestion = buildAeonContextualQuestion(question, discordContext);
    const autoResponseMode = inferAeonResponseModeFromQuestion(question, "normal");
    const result = await askAeonAgent(contextualQuestion, {
      username: message.member?.displayName || message.author.username || message.author.tag || "Attendee",
      history,
      mode: autoResponseMode,
    });

    const answer = sanitizeAeonVisibleAnswer(result?.answer);
    recordAeonAskTelemetry(question, result, { auto: true, mode: autoResponseMode });
    pushAeonConversationHistoryTurn(conversationRef, question, answer);
    const chunks = splitTextForDiscord(answer, 1900);
    if (!chunks.length) return;
    if (responseChannel?.id && responseChannel.id !== message.channel.id) {
      await responseChannel.send({
        content: `<@${message.author.id}> ${chunks[0]}`,
        allowedMentions: { repliedUser: false, users: [message.author.id] },
      });
    } else {
      await message.reply({
        content: chunks[0],
        allowedMentions: { repliedUser: false },
      });
    }
    for (let i = 1; i < chunks.length; i += 1) {
      await responseChannel.send({
        content: chunks[i],
        allowedMentions: { repliedUser: false },
      });
    }
  } catch (error) {
    console.error("AEON activation auto-ask failed:", error);
  }
});

registerLoggingEvents(client, {
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
});

registerMuMessageEvents(client, {
  makeEmbed,
  setEmbedAuthorSafe,
  setEmbedFooterSafe,
  setEmbedThumbnailSafe,
  getGuildSetupConfig,
  isTextChannel,
});

process.on("unhandledRejection", (reason) => {
  if (isUnknownInteractionError(reason)) {
    console.warn("Ignored stale interaction response (10062).");
    return;
  }
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  if (isUnknownInteractionError(error)) {
    console.warn("Ignored stale interaction response (10062).");
    return;
  }
  console.error("Uncaught exception:", error);
  shutdownBot(1);
});

if (!process.env.TOKEN) {
  console.error("Missing TOKEN in environment variables.");
  shutdownBot(1);
}

async function loginWithRetry() {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await client.login(process.env.TOKEN);
      return;
    } catch (error) {
      console.error("Failed to login:", error);
      if (!shouldRetryLogin(error)) {
        shutdownBot(1);
        return;
      }
      const waitMs = Math.min(LOGIN_RETRY_BASE_MS * Math.max(attempt, 1), LOGIN_RETRY_MAX_MS);
      logLoginDiagnostics(error, attempt, waitMs);
      await wait(waitMs);
    }
  }
}

loginWithRetry().catch((error) => {
  console.error("Login loop crashed:", error);
  shutdownBot(1);
});















