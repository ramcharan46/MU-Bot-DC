const MAX_REASON_LENGTH = 500;
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";
const LOG_FALLBACK_NAMES = ["mod-logs", "moderation-logs", "logs", "log"];

const MODERATION_COMMANDS = new Set([
  "kick",
  "ban",
  "unban",
  "timeout",
  "untimeout",
  "mute",
  "unmute",
  "purge",
  "warn",
  "warnings",
  "unwarn",
  "clearwarnings",
  "nick",
  "softban",
  "massrole",
  "modlogs",
  "lock",
  "unlock",
  "slowmode",
]);

const COLORS = {
  INFO: "#2F6DB3",
  SUCCESS: "#2D9D78",
  WARNING: "#B27A00",
  ERROR: "#C0392B",
};

const WELCOME_MESSAGES = [
  "{user} just hopped in! Everyone, look busy!",
  "Welcome {user}! Exciting things ahead!.",
  "Welcome {user}! Hope you enjoy your stay in our server.",
  "Welcome to the community, {user}!.",
  "Hello {user}! Glad to have you here.",
];

const JTC_SETTINGS_OPTIONS = [
  { label: "Rename", value: "rename", description: "Modify the channel name." },
  { label: "Limit", value: "limit", description: "Set user limit." },
  { label: "Status", value: "status", description: "Set channel status text." },
  { label: "Game", value: "game", description: "Set channel game text." },
  { label: "Claim", value: "claim", description: "Claim ownership if owner left." },
  { label: "Text", value: "text", description: "Create a private temp text channel." },
];

const JTC_PERMISSION_OPTIONS = [
  { label: "Lock", value: "lock", description: "Lock access for everyone." },
  { label: "Unlock", value: "unlock", description: "Unlock for everyone." },
  { label: "Permit", value: "permit", description: "Allow a user or role." },
  { label: "Reject", value: "reject", description: "Deny and disconnect target." },
  { label: "Invite", value: "invite", description: "Create an invite link." },
  { label: "Ghost", value: "ghost", description: "Hide the channel from everyone." },
  { label: "Unghost", value: "unghost", description: "Unhide the channel." },
  { label: "Transfer", value: "transfer", description: "Transfer channel ownership." },
];

module.exports = {
  MAX_REASON_LENGTH,
  MAX_TIMEOUT_MS,
  LOG_CHANNEL_ID,
  LOG_FALLBACK_NAMES,
  MODERATION_COMMANDS,
  COLORS,
  WELCOME_MESSAGES,
  JTC_SETTINGS_OPTIONS,
  JTC_PERMISSION_OPTIONS,
};
