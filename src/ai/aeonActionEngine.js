const ACTION_TYPES = [
  "create_category",
  "create_channel",
  "delete_channel",
  "rename_channel",
  "move_channel_category",
  "set_channel_topic",
  "set_channel_nsfw",
  "set_channel_slowmode",
  "lock_channel",
  "unlock_channel",
  "create_role",
  "delete_role",
  "rename_role",
  "set_role_color",
  "set_role_mentionable",
  "set_role_hoist",
  "add_role_to_member",
  "remove_role_from_member",
  "grant_channel_access",
  "revoke_channel_access",
];

const ACTION_LABELS = {
  create_category: "Create Category",
  create_channel: "Create Channel",
  delete_channel: "Delete Channel",
  rename_channel: "Rename Channel",
  move_channel_category: "Move Channel Category",
  set_channel_topic: "Set Channel Topic",
  set_channel_nsfw: "Set Channel NSFW",
  set_channel_slowmode: "Set Slowmode",
  lock_channel: "Lock Channel",
  unlock_channel: "Unlock Channel",
  create_role: "Create Role",
  delete_role: "Delete Role",
  rename_role: "Rename Role",
  set_role_color: "Set Role Color",
  set_role_mentionable: "Set Role Mentionable",
  set_role_hoist: "Set Role Hoist",
  add_role_to_member: "Add Role To Member",
  remove_role_from_member: "Remove Role From Member",
  grant_channel_access: "Grant Channel Access",
  revoke_channel_access: "Revoke Channel Access",
};

const DEFAULT_ALLOWED_ACTIONS = [
  "create_category",
  "create_channel",
  "delete_channel",
  "rename_channel",
  "move_channel_category",
  "set_channel_topic",
  "set_channel_nsfw",
  "set_channel_slowmode",
  "lock_channel",
  "unlock_channel",
  "create_role",
  "delete_role",
  "rename_role",
  "set_role_color",
  "set_role_mentionable",
  "set_role_hoist",
  "add_role_to_member",
  "remove_role_from_member",
  "grant_channel_access",
  "revoke_channel_access",
];

const LOW_RISK_ACTIONS = new Set([
  "rename_channel",
  "move_channel_category",
  "set_channel_topic",
  "set_channel_nsfw",
  "set_channel_slowmode",
  "lock_channel",
  "unlock_channel",
]);
const HIGH_RISK_ACTIONS = new Set([
  "delete_channel",
  "delete_role",
  "grant_channel_access",
  "revoke_channel_access",
]);

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRef(text) {
  let value = normalizeWhitespace(text);
  value = value.replace(/^[`"'#\s]+/, "").replace(/[`"'\s]+$/, "");
  return value.trim();
}

function parseBooleanToken(text) {
  const value = normalizeWhitespace(text).toLowerCase();
  if (!value) return null;
  if (["true", "yes", "on", "enable", "enabled", "1"].includes(value)) return true;
  if (["false", "no", "off", "disable", "disabled", "0"].includes(value)) return false;
  return null;
}

function parseDurationSeconds(text) {
  const raw = normalizeWhitespace(text).toLowerCase();
  const match = raw.match(/^(\d+)\s*([smhd]?)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2] || "s";
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  if (!factor) return null;
  return Math.floor(value * factor);
}

function normalizeChannelKind(input) {
  const value = normalizeWhitespace(input).toLowerCase();
  if (!value || value === "text") return "text";
  if (value === "voice") return "voice";
  if (value === "stage") return "stage";
  if (value === "forum") return "forum";
  if (value === "news" || value === "announcement") return "announcement";
  return "text";
}

function splitRequestClauses(request) {
  const normalized = String(request || "")
    .replace(/\r/g, "\n")
    .replace(
      /\band\s+(?=(?:create|make|add|delete|remove|rename|change|set|update|move|lock|unlock|allow|permit|grant|deny|reject|revoke|block)\b)/gi,
      "|",
    )
    .replace(/(?:\band then\b|\bthen\b|;|\n)+/gi, "|")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!normalized) return [];
  return normalized
    .split("|")
    .map((clause) => normalizeWhitespace(clause))
    .filter(Boolean);
}

function parseCreateCategory(clause) {
  const match = clause.match(/^(?:please\s+)?(?:create|make|add)\s+(?:a\s+)?category(?:\s+(?:named|called))?\s+(.+)$/i);
  if (!match) return null;
  const name = cleanRef(match[1]);
  if (!name) return null;
  return { type: "create_category", args: { name } };
}

function parseCreateChannel(clause) {
  const match = clause.match(
    /^(?:please\s+)?(?:create|make|add)\s+(?:a\s+)?(?:(text|voice|stage|forum|announcement|news)\s+)?channel(?:\s+(?:named|called))?\s+(.+)$/i,
  );
  if (!match) return null;

  let tail = normalizeWhitespace(match[2]);
  let topic = "";
  let categoryRef = "";

  const topicMatch = tail.match(/\s+with\s+topic\s+(.+)$/i);
  if (topicMatch) {
    topic = cleanRef(topicMatch[1]);
    tail = normalizeWhitespace(tail.slice(0, topicMatch.index));
  }

  const categoryMatch = tail.match(/\s+(?:in|under)\s+(?:category\s+)?(.+)$/i);
  if (categoryMatch) {
    categoryRef = cleanRef(categoryMatch[1]);
    tail = normalizeWhitespace(tail.slice(0, categoryMatch.index));
  }

  const name = cleanRef(tail.replace(/^#/, ""));
  if (!name) return null;

  return {
    type: "create_channel",
    args: {
      name,
      kind: normalizeChannelKind(match[1] || "text"),
      categoryRef,
      topic,
    },
  };
}

function parseRenameChannel(clause) {
  const match = clause.match(/^(?:rename|change)\s+channel\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
  if (!match) return null;
  const channelRef = cleanRef(match[1]);
  const newName = cleanRef(match[2]).replace(/^#/, "");
  if (!channelRef || !newName) return null;
  return { type: "rename_channel", args: { channelRef, newName } };
}

function parseDeleteChannel(clause) {
  const match = clause.match(/^(?:delete|remove)\s+channel\s+(.+)$/i);
  if (!match) return null;
  const channelRef = cleanRef(match[1]);
  if (!channelRef) return null;
  return { type: "delete_channel", args: { channelRef } };
}

function parseMoveChannelCategory(clause) {
  const match = clause.match(/^(?:move)\s+channel\s+(.+?)\s+(?:to|under)\s+(?:category\s+)?(.+)$/i);
  if (!match) return null;
  const channelRef = cleanRef(match[1]);
  const categoryRef = cleanRef(match[2]);
  if (!channelRef || !categoryRef) return null;
  return { type: "move_channel_category", args: { channelRef, categoryRef } };
}

function parseSetTopic(clause) {
  let match = clause.match(/^(?:set|change|update)\s+topic\s+(?:for|of)\s+channel\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
  if (match) {
    const channelRef = cleanRef(match[1]);
    const topic = cleanRef(match[2]);
    if (!topic) return null;
    return { type: "set_channel_topic", args: { channelRef, topic } };
  }

  match = clause.match(/^(?:set|change|update)\s+(?:channel\s+)?topic\s+(?:to|as)\s+(.+)$/i);
  if (!match) return null;
  const topic = cleanRef(match[1]);
  if (!topic) return null;
  return { type: "set_channel_topic", args: { channelRef: "", topic } };
}

function parseSetChannelNsfw(clause) {
  const match = clause.match(
    /^(?:set|change|update)\s+channel\s+(.+?)\s+nsfw\s+(?:to\s+)?(true|false|yes|no|on|off|1|0)$/i,
  );
  if (!match) return null;
  const channelRef = cleanRef(match[1]);
  const value = parseBooleanToken(match[2]);
  if (!channelRef || value === null) return null;
  return { type: "set_channel_nsfw", args: { channelRef, value } };
}

function parseSetSlowmode(clause) {
  const match = clause.match(
    /^(?:set|change|update)\s+(?:channel\s+)?slowmode(?:\s+for\s+channel\s+(.+?))?\s+(?:to\s+)?(\d+\s*[smhd]?)$/i,
  );
  if (!match) return null;
  const seconds = parseDurationSeconds(match[2]);
  if (!Number.isFinite(seconds)) return null;
  const channelRef = cleanRef(match[1] || "");
  return { type: "set_channel_slowmode", args: { channelRef, seconds } };
}

function parseLockUnlockChannel(clause) {
  const match = clause.match(/^(lock|unlock)\s+(?:channel\s+)?(.*)$/i);
  if (!match) return null;
  const action = String(match[1] || "").toLowerCase();
  const channelRef = cleanRef(match[2] || "");
  return { type: action === "lock" ? "lock_channel" : "unlock_channel", args: { channelRef } };
}

function parseCreateRole(clause) {
  const match = clause.match(/^(?:please\s+)?(?:create|make|add)\s+role(?:\s+(?:named|called))?\s+(.+)$/i);
  if (!match) return null;

  const tail = normalizeWhitespace(match[1]);
  const colorMatch = tail.match(/\bcolor\s*(?:=|:|to)?\s*(#?[0-9a-f]{3,6})\b/i);
  const mentionableMatch = tail.match(/\bmentionable\s*(?:=|:|to)?\s*(true|false|yes|no|on|off|1|0)\b/i);
  const hoistMatch = tail.match(/\bhoist(?:ed)?\s*(?:=|:|to)?\s*(true|false|yes|no|on|off|1|0)\b/i);

  let nameCandidate = tail
    .replace(/\bcolor\s*(?:=|:|to)?\s*#?[0-9a-f]{3,6}\b/gi, "")
    .replace(/\bmentionable\s*(?:=|:|to)?\s*(?:true|false|yes|no|on|off|1|0)\b/gi, "")
    .replace(/\bhoist(?:ed)?\s*(?:=|:|to)?\s*(?:true|false|yes|no|on|off|1|0)\b/gi, "")
    .replace(/\bwith\b/gi, "");
  nameCandidate = cleanRef(nameCandidate);
  if (!nameCandidate) return null;

  const color = colorMatch ? cleanRef(colorMatch[1]).replace(/^([^#])/, "#$1") : "";
  const mentionable = mentionableMatch ? parseBooleanToken(mentionableMatch[1]) : null;
  const hoist = hoistMatch ? parseBooleanToken(hoistMatch[1]) : null;
  return { type: "create_role", args: { name: nameCandidate, color, mentionable, hoist } };
}

function parseRenameRole(clause) {
  const match = clause.match(/^(?:rename|change)\s+role\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
  if (!match) return null;
  const roleRef = cleanRef(match[1]);
  const newName = cleanRef(match[2]);
  if (!roleRef || !newName) return null;
  return { type: "rename_role", args: { roleRef, newName } };
}

function parseDeleteRole(clause) {
  const match = clause.match(/^(?:delete|remove)\s+role\s+(.+)$/i);
  if (!match) return null;
  const roleRef = cleanRef(match[1]);
  if (!roleRef) return null;
  return { type: "delete_role", args: { roleRef } };
}

function parseSetRoleColor(clause) {
  const match = clause.match(/^(?:set|change|update)\s+role\s+(.+?)\s+color\s+(?:to|as)?\s*(#?[0-9a-f]{3,6})$/i);
  if (!match) return null;
  const roleRef = cleanRef(match[1]);
  const color = cleanRef(match[2]).replace(/^([^#])/, "#$1");
  if (!roleRef || !color) return null;
  return { type: "set_role_color", args: { roleRef, color } };
}

function parseRoleBooleanFlag(clause, flagName, actionType) {
  const match = clause.match(
    new RegExp(
      `^(?:set|change|update)\\s+role\\s+(.+?)\\s+${flagName}\\s+(?:to\\s+)?(true|false|yes|no|on|off|1|0)$`,
      "i",
    ),
  );
  if (!match) return null;
  const roleRef = cleanRef(match[1]);
  const value = parseBooleanToken(match[2]);
  if (!roleRef || value === null) return null;
  return { type: actionType, args: { roleRef, value } };
}

function parseAddRemoveRoleOnMember(clause) {
  let match = clause.match(/^(?:add|give)\s+role\s+(.+?)\s+(?:to|for)\s+(.+)$/i);
  if (match) {
    const roleRef = cleanRef(match[1]);
    const memberRef = cleanRef(match[2]);
    if (!roleRef || !memberRef) return null;
    return { type: "add_role_to_member", args: { roleRef, memberRef } };
  }

  match = clause.match(/^(?:remove|take)\s+role\s+(.+?)\s+from\s+(.+)$/i);
  if (!match) return null;
  const roleRef = cleanRef(match[1]);
  const memberRef = cleanRef(match[2]);
  if (!roleRef || !memberRef) return null;
  return { type: "remove_role_from_member", args: { roleRef, memberRef } };
}

function parseChannelAccess(clause) {
  let match = clause.match(/^(?:allow|permit|grant)\s+(.+?)\s+(?:access\s+)?(?:to|in|on)\s+(.+)$/i);
  if (match) {
    const targetRef = cleanRef(match[1]);
    const channelRef = cleanRef(match[2]);
    if (!targetRef || !channelRef) return null;
    return { type: "grant_channel_access", args: { targetRef, channelRef } };
  }

  match = clause.match(/^(?:deny|reject|revoke|block)\s+(.+?)\s+(?:access\s+)?(?:from|in|on)\s+(.+)$/i);
  if (!match) return null;
  const targetRef = cleanRef(match[1]);
  const channelRef = cleanRef(match[2]);
  if (!targetRef || !channelRef) return null;
  return { type: "revoke_channel_access", args: { targetRef, channelRef } };
}

function parseActionClause(clause) {
  const normalized = normalizeWhitespace(clause);
  if (!normalized) return { action: null };

  const parsers = [
    parseCreateCategory,
    parseCreateChannel,
    parseDeleteChannel,
    parseRenameChannel,
    parseMoveChannelCategory,
    parseSetTopic,
    parseSetChannelNsfw,
    parseSetSlowmode,
    parseLockUnlockChannel,
    parseCreateRole,
    parseDeleteRole,
    parseRenameRole,
    parseSetRoleColor,
    (value) => parseRoleBooleanFlag(value, "mentionable", "set_role_mentionable"),
    (value) => parseRoleBooleanFlag(value, "hoist(?:ed)?", "set_role_hoist"),
    parseAddRemoveRoleOnMember,
    parseChannelAccess,
  ];

  const variants = [normalized];
  const strippedPolite = normalized.replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, "");
  if (strippedPolite && strippedPolite !== normalized) variants.push(strippedPolite);

  for (const candidate of variants) {
    for (const parser of parsers) {
      const action = parser(candidate);
      if (action) return { action };
    }
  }

  return { action: null };
}

function humanizeAction(action) {
  const type = normalizeActionType(action?.type);
  const args = action?.args || {};
  if (type === "create_category") return `Create category "${args.name || "Unnamed"}"`;
  if (type === "create_channel") return `Create ${args.kind || "text"} channel "${args.name || "Unnamed"}"`;
  if (type === "delete_channel") return "Delete channel";
  if (type === "rename_channel") return `Rename channel to "${args.newName || "Unknown"}"`;
  if (type === "move_channel_category") return "Move channel category";
  if (type === "set_channel_topic") return "Update channel topic";
  if (type === "set_channel_nsfw") return `Set NSFW: ${args.value ? "on" : "off"}`;
  if (type === "set_channel_slowmode") return `Set slowmode to ${Number(args.seconds || 0)}s`;
  if (type === "lock_channel") return "Lock channel";
  if (type === "unlock_channel") return "Unlock channel";
  if (type === "create_role") return `Create role "${args.name || "Unnamed"}"`;
  if (type === "delete_role") return "Delete role";
  if (type === "rename_role") return `Rename role to "${args.newName || "Unknown"}"`;
  if (type === "set_role_color") return `Set role color to ${args.color || "default"}`;
  if (type === "set_role_mentionable") return `Set role mentionable: ${args.value ? "on" : "off"}`;
  if (type === "set_role_hoist") return `Set role hoist: ${args.value ? "on" : "off"}`;
  if (type === "add_role_to_member") return "Add role to member";
  if (type === "remove_role_from_member") return "Remove role from member";
  if (type === "grant_channel_access") return "Grant channel access";
  if (type === "revoke_channel_access") return "Revoke channel access";
  return "Unknown action";
}

function normalizeActionType(type) {
  const raw = normalizeWhitespace(type).toLowerCase();
  if (!raw) return "";
  return ACTION_TYPES.includes(raw) ? raw : "";
}

function inferRisk(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) return "low";
  let score = 0;
  for (const action of list) {
    const type = normalizeActionType(action?.type);
    if (!type) continue;
    if (HIGH_RISK_ACTIONS.has(type)) score += 3;
    else if (LOW_RISK_ACTIONS.has(type)) score += 1;
    else score += 2;
  }
  if (list.length >= 6) score += 2;
  if (score >= 9) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function parseActionRequest(request) {
  const source = normalizeWhitespace(request);
  const clauses = splitRequestClauses(source);
  const actions = [];
  const unsupported = [];
  const warnings = [];

  for (const clause of clauses) {
    const parsed = parseActionClause(clause);
    if (!parsed?.action) {
      unsupported.push(clause);
      continue;
    }
    actions.push(parsed.action);
  }

  if (unsupported.length) {
    warnings.push(`Skipped ${unsupported.length} unsupported clause(s).`);
  }

  const summary = actions.length
    ? actions.map((action, index) => `${index + 1}. ${humanizeAction(action)}`).join("\n")
    : "No executable actions detected in this request.";

  return {
    request: source,
    clauses,
    actions,
    unsupportedClauses: unsupported,
    warnings,
    risk: inferRisk(actions),
    summary,
  };
}

function actionTypeLabel(type) {
  const normalized = normalizeActionType(type);
  return ACTION_LABELS[normalized] || "Unknown";
}

module.exports = {
  ACTION_TYPES,
  ACTION_LABELS,
  DEFAULT_ALLOWED_ACTIONS,
  parseActionRequest,
  normalizeActionType,
  actionTypeLabel,
  humanizeAction,
};
