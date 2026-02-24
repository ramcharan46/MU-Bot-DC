function chunkArray(items, size) {
  if (!Array.isArray(items) || size <= 0) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const ADMIN_ONLY_COMMANDS = new Set([
  "kick",
  "ban",
  "unban",
  "softban",
  "timeout",
  "untimeout",
  "mute",
  "unmute",
  "purge",
  "warn",
  "warnings",
  "unwarn",
  "clearwarnings",
  "modlogs",
  "nick",
  "massrole",
  "lock",
  "unlock",
  "slowmode",
  "embed_send",
  "level_channel",
  "level_role_add",
  "level_role_remove",
  "level_role_clear",
  "level_xp_add",
  "level_set",
  "level_blacklist_add",
  "level_blacklist_remove",
  "autoreact_toggle",
  "setup",
  "botprofile",
  "config",
  "autorole",
  "reactionroles",
  "log",
  "say",
  "wordgame_start",
]);

function commandNameFromSyntax(syntax) {
  const match = String(syntax || "").trim().match(/^\/([a-z0-9_]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function isAdminEntry(entry) {
  if (entry?.admin === true) return true;
  const name = commandNameFromSyntax(entry?.syntax);
  return ADMIN_ONLY_COMMANDS.has(name);
}

function buildHelpFields(entries) {
  return entries.map((entry) => ({
    name: "\u200B",
    value: `${isAdminEntry(entry) ? "`[Admin]` " : ""}**${entry.syntax}**\n${entry.summary}`,
    inline: false,
  }));
}

const HELP_LIBRARY = {
  moderation: [
    { syntax: "/kick user:<member> [reason:<text>]", summary: "Kick a member." },
    { syntax: "/ban user:<member> [reason:<text>] [delete_days:<0-7>]", summary: "Ban a member." },
    { syntax: "/unban user_id:<id> [reason:<text>]", summary: "Unban by user ID." },
    { syntax: "/softban user:<member> [reason:<text>]", summary: "Ban then unban to clear recent messages." },
    { syntax: "/timeout user:<member> duration:<30m|2h|3d>", summary: "Timeout a member." },
    { syntax: "/untimeout user:<member>", summary: "Remove timeout." },
    { syntax: "/mute target:<member> duration:<10m|2h|1d>", summary: "MU alias for timeout." },
    { syntax: "/unmute target:<member>", summary: "MU alias for untimeout." },
    { syntax: "/purge amount:<1-100> [user:<member>]", summary: "Bulk delete messages." },
    { syntax: "/warn user:<member> reason:<text>", summary: "Issue warning." },
    { syntax: "/warnings user:<member>", summary: "List warnings." },
    { syntax: "/unwarn user:<member> warning_id:<id>", summary: "Remove one warning." },
    { syntax: "/clearwarnings user:<member>", summary: "Clear all warnings." },
    { syntax: "/modlogs user:<member>", summary: "Moderation history for a user." },
    { syntax: "/nick user:<member> [nickname:<text>]", summary: "Set or clear nickname." },
    { syntax: "/massrole action:<add|remove> role:<role> user1:<member> ...", summary: "Bulk role updates." },
    { syntax: "/lock [channel:<text-channel>]", summary: "Lock channel for @everyone." },
    { syntax: "/unlock [channel:<text-channel>]", summary: "Unlock channel." },
    { syntax: "/slowmode seconds:<0-21600> [channel:<text-channel>]", summary: "Set slowmode." },
  ],
  utility: [
    { syntax: "/help", summary: "Open interactive help panel." },
    { syntax: "/ping", summary: "Check response latency." },
    { syntax: "/avatar [user:<member>]", summary: "Show user avatar." },
    { syntax: "/userinfo [user:<member>]", summary: "User profile details." },
    { syntax: "/serverinfo", summary: "Server overview." },
    { syntax: "/roleinfo role:<role>", summary: "Role details." },
    { syntax: "/member_count", summary: "Human/bot member totals." },
    { syntax: "/hof_leaderboard [page:<number>]", summary: "Hall of Fame star rankings." },
    { syntax: "/timestamp date:<YYYY-MM-DD> time:<HH:mm[:ss]>", summary: "Generate Discord timestamps." },
    { syntax: "/report user:<member> reason:<text>", summary: "Send report to staff channel." },
    { syntax: "/remind time:<10m|2h|1d> text:<message>", summary: "Create reminder." },
    { syntax: "/calculate expression:<math>", summary: "Evaluate math expressions." },
    { syntax: "/embed_send channel:<text> [title] [description] [color]", summary: "Send custom embed." },
  ],
  leveling: [
    { syntax: "/level [user:<member>]", summary: "View level profile." },
    { syntax: "/leaderboard [page:<number>]", summary: "XP leaderboard." },
    { syntax: "/level_channel channel:<text>", summary: "Set level-up channel." },
    { syntax: "/level_role_add level:<number> role:<role>", summary: "Grant role at level." },
    { syntax: "/level_role_remove level:<number> role:<role>", summary: "Remove role at level." },
    { syntax: "/level_role_clear", summary: "Reset level role rules." },
    { syntax: "/level_xp_add user:<member> amount:<number>", summary: "Add XP manually." },
    { syntax: "/level_set user:<member> level:<number>", summary: "Set level manually." },
    { syntax: "/level_blacklist_add channel:<text>", summary: "Disable XP in channel." },
    { syntax: "/level_blacklist_remove channel:<text>", summary: "Remove XP blacklist entry." },
    { syntax: "/level_blacklist_list", summary: "List XP blacklisted channels." },
  ],
  fun: [
    { syntax: "/meme", summary: "Random meme." },
    { syntax: "/meme_mc", summary: "Minecraft meme." },
    { syntax: "/joke", summary: "Random joke." },
    { syntax: "/8ball question:<text>", summary: "Magic 8-ball answer." },
    { syntax: "/wholesome", summary: "Wholesome message." },
    { syntax: "/flip", summary: "Coin flip." },
    { syntax: "/rps choice:<rock|paper|scissors>", summary: "Rock paper scissors." },
    { syntax: "/say text:<text>", summary: "Bot says your text (staff only)." },
    { syntax: "/roast target:<member>", summary: "Roast command." },
    { syntax: "/kill target:<member>", summary: "Fake kill line." },
    { syntax: "/ship user1:<member> user2:<member>", summary: "Compatibility rating." },
    { syntax: "/hotrate [target:<member>]", summary: "Hotness score." },
    { syntax: "/gayrate [target:<member>]", summary: "Rainbow score." },
    { syntax: "/quote text:<text> [author]", summary: "Quote card." },
    { syntax: "/quote_style text:<text> [author] [theme]", summary: "Themed quote card." },
    { syntax: "/wordgame_start", summary: "Start quick WordCore lobby." },
    { syntax: "/pokeping <add|remove|list>", summary: "Poketwo spawn alerts." },
    { syntax: "/autoreact_toggle user:<member> emoji:<emoji>", summary: "Auto react config (admin)." },
  ],
  music: [
    { syntax: "/join [channel:<voice>]", summary: "Join voice channel." },
    { syntax: "/play query:<text|url>", summary: "Play or queue track." },
    { syntax: "/queue [page:<number>]", summary: "Show queue." },
    { syntax: "/skip [amount:<number>]", summary: "Skip tracks." },
    { syntax: "/pause", summary: "Pause playback." },
    { syntax: "/resume", summary: "Resume playback." },
    { syntax: "/stop", summary: "Stop and clear queue." },
    { syntax: "/disconnect", summary: "Leave voice channel." },
    { syntax: "/clear", summary: "Clear upcoming songs." },
    { syntax: "/shuffle", summary: "Shuffle queue." },
    { syntax: "/loop [mode:<toggle|off|song|queue>]", summary: "Set loop mode." },
    { syntax: "/volume [percent:<1-200>]", summary: "Set/get volume." },
  ],
  jtc: [
    { syntax: "/config jtc_trigger trigger:<voice> [category:<category>]", summary: "Set JTC trigger channel." },
    { syntax: "/config jtc_interface channel:<text>", summary: "Set JTC control channel." },
    { syntax: "/interface [channel:<voice>]", summary: "Send JTC interface." },
    { syntax: "/setup", summary: "Open setup panel." },
  ],
  config: [
    { syntax: "/setup", summary: "Guided setup buttons." },
    { syntax: "/botprofile", summary: "Customize guild-specific bot profile branding." },
    { syntax: "/config stats_category category:<category>", summary: "Configure stats channels." },
    { syntax: "/config welcome_channel channel:<text>", summary: "Configure welcome channel." },
    { syntax: "/autorole add role:<role>", summary: "Add autorole." },
    { syntax: "/autorole remove role:<role>", summary: "Remove autorole." },
    { syntax: "/autorole list", summary: "List autoroles." },
    { syntax: "/autorole clear", summary: "Clear autoroles." },
    { syntax: "/reactionroles ...", summary: "Create button role panel." },
    { syntax: "/log channel channel:<text>", summary: "Set log channel." },
    { syntax: "/log config ...", summary: "Toggle logging groups." },
    { syntax: "/rules", summary: "Show server rules." },
    { syntax: "/rules_dm", summary: "DM server rules." },
  ],
};

const HELP_PAGES = {
  overview: {
    category: "overview",
    color: "#1F4E79",
    title: "MU Bot Command Center",
    description: "Sleek slash-command reference.\n\nUse category buttons and Prev/Next to navigate.",
    fields: [
      { name: "Moderation", value: "19 commands\nWarnings, roles, channel controls, enforcement." },
      { name: "Utility", value: "13 commands\nInfo, tools, reminders, reports, calculator." },
      { name: "Leveling", value: "11 commands\nXP, leaderboard, reward rules, channel blacklist." },
      { name: "Fun", value: "18 commands\nMemes, games, quotes, ratings, pokeping, reactions." },
      { name: "Music", value: "12 commands\nPlayback and queue controls." },
      { name: "JTC", value: "4 commands\nJoin-to-create controls." },
      { name: "Setup & Config", value: "14 commands\nSetup panel, autoroles, logs, reaction roles." },
      { name: "Format", value: "Each item shows syntax and one-line purpose.\n`[Admin]` marks restricted commands." },
    ],
  },
};

const HELP_PAGE_ORDER = ["overview"];
const HELP_PAGE_CATEGORY = { overview: "overview" };
const HELP_CATEGORY_FIRST_PAGE = { overview: "overview" };

function registerHelpCategoryPages(categoryKey, title, color, description, entries, pageSize = 5) {
  const chunks = chunkArray(entries, pageSize);
  if (!chunks.length) return;
  HELP_CATEGORY_FIRST_PAGE[categoryKey] = `${categoryKey}_1`;

  for (let i = 0; i < chunks.length; i += 1) {
    const key = `${categoryKey}_${i + 1}`;
    HELP_PAGES[key] = {
      category: categoryKey,
      color,
      title: `${title} (${i + 1}/${chunks.length})`,
      description,
      fields: buildHelpFields(chunks[i]),
    };
    HELP_PAGE_ORDER.push(key);
    HELP_PAGE_CATEGORY[key] = categoryKey;
  }
}

registerHelpCategoryPages("moderation", "Moderation Commands", "#8B1E3F", "Moderation tools with hierarchy and permission checks.", HELP_LIBRARY.moderation, 5);
registerHelpCategoryPages("utility", "Utility Commands", "#1F7A5C", "General utility and info commands.", HELP_LIBRARY.utility, 5);
registerHelpCategoryPages("leveling", "Leveling Commands", "#1D4ED8", "XP progression and role rewards.", HELP_LIBRARY.leveling, 5);
registerHelpCategoryPages("fun", "Fun Commands", "#C026D3", "Fun and social commands.", HELP_LIBRARY.fun, 5);
registerHelpCategoryPages("music", "Music Commands", "#5A4FCF", "Voice playback controls.", HELP_LIBRARY.music, 5);
registerHelpCategoryPages("jtc", "JTC Commands", "#4A5D23", "Join-to-create setup and interface.", HELP_LIBRARY.jtc, 5);
registerHelpCategoryPages("config", "Setup & Config Commands", "#2C3E50", "Server setup, logging, and role panels.", HELP_LIBRARY.config, 5);

function normalizeHelpPageKey(pageKey) {
  return HELP_PAGES[pageKey] ? pageKey : "overview";
}

function getHelpCategoryKey(pageKey) {
  const key = normalizeHelpPageKey(pageKey);
  return HELP_PAGE_CATEGORY[key] || HELP_PAGES[key]?.category || "overview";
}

function getAdjacentHelpPage(pageKey, delta) {
  const key = normalizeHelpPageKey(pageKey);
  const index = HELP_PAGE_ORDER.indexOf(key);
  if (index === -1) return "overview";
  const next = Math.max(0, Math.min(HELP_PAGE_ORDER.length - 1, index + delta));
  return HELP_PAGE_ORDER[next];
}

module.exports = {
  ADMIN_ONLY_COMMANDS,
  commandNameFromSyntax,
  isAdminEntry,
  buildHelpFields,
  HELP_LIBRARY,
  HELP_PAGES,
  HELP_PAGE_ORDER,
  HELP_CATEGORY_FIRST_PAGE,
  normalizeHelpPageKey,
  getHelpCategoryKey,
  getAdjacentHelpPage,
};
