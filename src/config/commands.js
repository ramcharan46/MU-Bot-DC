const { MU_COMMANDS } = require("./muCommands");

const BASE_COMMANDS = [
  {
    name: "kick",
    description: "Kick a member from the server.",
    options: [
      { name: "user", description: "Member to kick.", type: 6, required: true },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
    ],
  },
  {
    name: "ban",
    description: "Ban a user from the server.",
    options: [
      { name: "user", description: "User to ban.", type: 6, required: true },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
      {
        name: "delete_days",
        description: "Delete message history from the past 0 to 7 days.",
        type: 4,
        required: false,
      },
    ],
  },
  {
    name: "unban",
    description: "Unban a user by user ID.",
    options: [
      { name: "user_id", description: "Discord user ID to unban.", type: 3, required: true },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
    ],
  },
  {
    name: "timeout",
    description: "Timeout a member for a duration.",
    options: [
      { name: "user", description: "Member to timeout.", type: 6, required: true },
      { name: "duration", description: "Duration: 30m, 2h, 3d.", type: 3, required: true },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
    ],
  },
  {
    name: "untimeout",
    description: "Remove timeout from a member.",
    options: [
      { name: "user", description: "Member to remove timeout from.", type: 6, required: true },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
    ],
  },
  {
    name: "purge",
    description: "Bulk delete recent messages in this channel.",
    options: [
      { name: "amount", description: "How many messages to delete (1-100).", type: 4, required: true },
      { name: "user", description: "Optional user filter.", type: 6, required: false },
    ],
  },
  {
    name: "warn",
    description: "Warn a member and store the warning.",
    options: [
      { name: "user", description: "Member to warn.", type: 6, required: true },
      { name: "reason", description: "Reason for warning.", type: 3, required: true },
    ],
  },
  {
    name: "warnings",
    description: "View warnings for a user.",
    options: [{ name: "user", description: "User to view warnings for.", type: 6, required: true }],
  },
  {
    name: "clearwarnings",
    description: "Clear all warnings for a user.",
    options: [{ name: "user", description: "User to clear warnings for.", type: 6, required: true }],
  },
  {
    name: "lock",
    description: "Lock a text channel for @everyone.",
    options: [{ name: "channel", description: "Channel to lock.", type: 7, required: false }],
  },
  {
    name: "unlock",
    description: "Unlock a text channel for @everyone.",
    options: [{ name: "channel", description: "Channel to unlock.", type: 7, required: false }],
  },
  {
    name: "slowmode",
    description: "Set channel slowmode in seconds.",
    options: [
      { name: "seconds", description: "0 to 21600 seconds.", type: 4, required: true },
      { name: "channel", description: "Channel to update.", type: 7, required: false },
    ],
  },
  {
    name: "unwarn",
    description: "Remove a single warning from a user by warning ID.",
    options: [
      { name: "user", description: "User whose warning should be removed.", type: 6, required: true },
      { name: "warning_id", description: "Warning ID from /warnings output.", type: 3, required: true },
    ],
  },
  {
    name: "nick",
    description: "Set or clear a member nickname.",
    options: [
      { name: "user", description: "Member to update.", type: 6, required: true },
      { name: "nickname", description: "Leave empty to clear nickname.", type: 3, required: false },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
    ],
  },
  {
    name: "softban",
    description: "Ban and immediately unban a member to purge recent messages.",
    options: [
      { name: "user", description: "Member to softban.", type: 6, required: true },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
    ],
  },
  {
    name: "massrole",
    description: "Add or remove a role for multiple members.",
    options: [
      {
        name: "action",
        description: "Whether to add or remove the role.",
        type: 3,
        required: true,
        choices: [
          { name: "add", value: "add" },
          { name: "remove", value: "remove" },
        ],
      },
      { name: "role", description: "Role to update.", type: 8, required: true },
      { name: "user1", description: "First member.", type: 6, required: true },
      { name: "user2", description: "Second member.", type: 6, required: false },
      { name: "user3", description: "Third member.", type: 6, required: false },
      { name: "user4", description: "Fourth member.", type: 6, required: false },
      { name: "user5", description: "Fifth member.", type: 6, required: false },
      { name: "reason", description: "Reason for this action.", type: 3, required: false },
    ],
  },
  {
    name: "modlogs",
    description: "View moderation history for a user.",
    options: [{ name: "user", description: "User to inspect.", type: 6, required: true }],
  },
  {
    name: "avatar",
    description: "Show a user's avatar.",
    options: [{ name: "user", description: "Target user.", type: 6, required: false }],
  },
  {
    name: "userinfo",
    description: "Show detailed user profile information.",
    options: [{ name: "user", description: "Target user.", type: 6, required: false }],
  },
  {
    name: "serverinfo",
    description: "Show server information.",
  },
  {
    name: "roleinfo",
    description: "Show role details.",
    options: [{ name: "role", description: "Role to inspect.", type: 8, required: true }],
  },
  {
    name: "ping",
    description: "Show bot latency.",
  },
  {
    name: "report",
    description: "Report a user to moderators.",
    options: [
      { name: "user", description: "User to report.", type: 6, required: true },
      { name: "reason", description: "Report reason.", type: 3, required: true },
    ],
  },
  {
    name: "remind",
    description: "Set a reminder.",
    options: [
      { name: "time", description: "Duration like 10m, 2h, 1d.", type: 3, required: true },
      { name: "text", description: "Reminder text.", type: 3, required: true },
    ],
  },
  {
    name: "reactionroles",
    description: "Create an embedded self-role panel with buttons.",
    options: [
      { name: "channel", description: "Channel where panel should be posted.", type: 7, required: true },
      { name: "title", description: "Panel title.", type: 3, required: true },
      { name: "message", description: "Panel message/description.", type: 3, required: true },
      { name: "emoji1", description: "Emoji for option 1.", type: 3, required: true },
      { name: "option1", description: "Label for option 1.", type: 3, required: true },
      { name: "role1", description: "Role for option 1.", type: 8, required: true },
      { name: "emoji2", description: "Emoji for option 2.", type: 3, required: false },
      { name: "option2", description: "Label for option 2.", type: 3, required: false },
      { name: "role2", description: "Role for option 2.", type: 8, required: false },
      { name: "emoji3", description: "Emoji for option 3.", type: 3, required: false },
      { name: "option3", description: "Label for option 3.", type: 3, required: false },
      { name: "role3", description: "Role for option 3.", type: 8, required: false },
      { name: "emoji4", description: "Emoji for option 4.", type: 3, required: false },
      { name: "option4", description: "Label for option 4.", type: 3, required: false },
      { name: "role4", description: "Role for option 4.", type: 8, required: false },
      { name: "emoji5", description: "Emoji for option 5.", type: 3, required: false },
      { name: "option5", description: "Label for option 5.", type: 3, required: false },
      { name: "role5", description: "Role for option 5.", type: 8, required: false },
      { name: "emoji6", description: "Emoji for option 6.", type: 3, required: false },
      { name: "option6", description: "Label for option 6.", type: 3, required: false },
      { name: "role6", description: "Role for option 6.", type: 8, required: false },
      { name: "emoji7", description: "Emoji for option 7.", type: 3, required: false },
      { name: "option7", description: "Label for option 7.", type: 3, required: false },
      { name: "role7", description: "Role for option 7.", type: 8, required: false },
    ],
  },
  {
    name: "timestamp",
    description: "Generate Discord timestamps from date and time.",
    options: [
      { name: "date", description: "Date in YYYY-MM-DD format.", type: 3, required: true },
      { name: "time", description: "Time in HH:mm or HH:mm:ss (UTC).", type: 3, required: true },
    ],
  },
  {
    name: "aeon",
    description: "AEON'26 AI assistant commands.",
    options: [
      {
        type: 1,
        name: "ask",
        description: "Ask a question related to AEON'26 tech fest.",
        options: [
          {
            name: "question",
            description: "Your AEON'26 question.",
            type: 3,
            required: true,
          },
          {
            name: "embed",
            description: "Show response in an embed (default: false).",
            type: 5,
            required: false,
          },
          {
            name: "metrics",
            description: "Include AI metrics (default: false).",
            type: 5,
            required: false,
          },
          {
            name: "mode",
            description: "Response detail level.",
            type: 3,
            required: false,
            choices: [
              { name: "brief", value: "brief" },
              { name: "normal", value: "normal" },
              { name: "detailed", value: "detailed" },
            ],
          },
        ],
      },
      {
        type: 1,
        name: "events",
        description: "Browse AEON'26 events from the knowledge base.",
      },
      {
        type: 1,
        name: "setactivation",
        description: "Set a single activation text (replaces existing list).",
        options: [
          {
            name: "text",
            description: "Activation text to detect in messages (use 'off' to disable).",
            type: 3,
            required: true,
          },
        ],
      },
      {
        type: 2,
        name: "activation",
        description: "Manage activation texts for auto AEON replies.",
        options: [
          {
            type: 1,
            name: "add",
            description: "Add an activation text.",
            options: [
              {
                name: "text",
                description: "Activation text to add.",
                type: 3,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "update",
            description: "Update one activation text to a new value.",
            options: [
              {
                name: "old_text",
                description: "Existing activation text.",
                type: 3,
                required: true,
              },
              {
                name: "new_text",
                description: "New activation text.",
                type: 3,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "remove",
            description: "Remove an activation text.",
            options: [
              {
                name: "text",
                description: "Activation text to remove.",
                type: 3,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "list",
            description: "List configured activation texts.",
          },
          {
            type: 1,
            name: "clear",
            description: "Remove all activation texts.",
          },
        ],
      },
      {
        type: 2,
        name: "action",
        description: "Plan and execute AI-driven server management actions.",
        options: [
          {
            type: 1,
            name: "run",
            description: "Create an action plan from natural language.",
            options: [
              {
                name: "request",
                description: "Natural language admin request (channels, roles, permissions).",
                type: 3,
                required: true,
              },
              {
                name: "dry_run",
                description: "Preview execution without applying changes.",
                type: 5,
                required: false,
              },
            ],
          },
          {
            type: 1,
            name: "approve",
            description: "Approve and execute a pending action plan by ID.",
            options: [
              {
                name: "plan_id",
                description: "Pending plan ID from /aeon action run.",
                type: 3,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "deny",
            description: "Cancel a pending action plan by ID.",
            options: [
              {
                name: "plan_id",
                description: "Pending plan ID from /aeon action run.",
                type: 3,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "history",
            description: "Show recent AI action audit entries.",
            options: [
              {
                name: "limit",
                description: "How many entries to display (1-20).",
                type: 4,
                required: false,
              },
            ],
          },
          {
            type: 1,
            name: "rollback",
            description: "Rollback a completed action run by run ID.",
            options: [
              {
                name: "run_id",
                description: "Run ID from /aeon action history.",
                type: 3,
                required: true,
              },
            ],
          },
        ],
      },
      {
        type: 2,
        name: "policy",
        description: "Configure AI action guardrails and execution policy.",
        options: [
          {
            type: 1,
            name: "view",
            description: "View current AI action policy.",
          },
          {
            type: 1,
            name: "toggle",
            description: "Enable or disable AI action execution.",
            options: [
              {
                name: "enabled",
                description: "Whether AI action execution is enabled.",
                type: 5,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "approval",
            description: "Toggle mandatory human approval before execution.",
            options: [
              {
                name: "required",
                description: "Require approval before any action execution.",
                type: 5,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "allow",
            description: "Allow an action type in AI policy.",
            options: [
              {
                name: "action",
                description: "Action type to allow.",
                type: 3,
                required: true,
                choices: [
                  { name: "create_category", value: "create_category" },
                  { name: "create_channel", value: "create_channel" },
                  { name: "delete_channel", value: "delete_channel" },
                  { name: "rename_channel", value: "rename_channel" },
                  { name: "move_channel_category", value: "move_channel_category" },
                  { name: "set_channel_topic", value: "set_channel_topic" },
                  { name: "set_channel_nsfw", value: "set_channel_nsfw" },
                  { name: "set_channel_slowmode", value: "set_channel_slowmode" },
                  { name: "lock_channel", value: "lock_channel" },
                  { name: "unlock_channel", value: "unlock_channel" },
                  { name: "create_role", value: "create_role" },
                  { name: "delete_role", value: "delete_role" },
                  { name: "rename_role", value: "rename_role" },
                  { name: "set_role_color", value: "set_role_color" },
                  { name: "set_role_mentionable", value: "set_role_mentionable" },
                  { name: "set_role_hoist", value: "set_role_hoist" },
                  { name: "add_role_to_member", value: "add_role_to_member" },
                  { name: "remove_role_from_member", value: "remove_role_from_member" },
                  { name: "grant_channel_access", value: "grant_channel_access" },
                  { name: "revoke_channel_access", value: "revoke_channel_access" },
                ],
              },
            ],
          },
          {
            type: 1,
            name: "deny",
            description: "Block an action type in AI policy.",
            options: [
              {
                name: "action",
                description: "Action type to block.",
                type: 3,
                required: true,
                choices: [
                  { name: "create_category", value: "create_category" },
                  { name: "create_channel", value: "create_channel" },
                  { name: "delete_channel", value: "delete_channel" },
                  { name: "rename_channel", value: "rename_channel" },
                  { name: "move_channel_category", value: "move_channel_category" },
                  { name: "set_channel_topic", value: "set_channel_topic" },
                  { name: "set_channel_nsfw", value: "set_channel_nsfw" },
                  { name: "set_channel_slowmode", value: "set_channel_slowmode" },
                  { name: "lock_channel", value: "lock_channel" },
                  { name: "unlock_channel", value: "unlock_channel" },
                  { name: "create_role", value: "create_role" },
                  { name: "delete_role", value: "delete_role" },
                  { name: "rename_role", value: "rename_role" },
                  { name: "set_role_color", value: "set_role_color" },
                  { name: "set_role_mentionable", value: "set_role_mentionable" },
                  { name: "set_role_hoist", value: "set_role_hoist" },
                  { name: "add_role_to_member", value: "add_role_to_member" },
                  { name: "remove_role_from_member", value: "remove_role_from_member" },
                  { name: "grant_channel_access", value: "grant_channel_access" },
                  { name: "revoke_channel_access", value: "revoke_channel_access" },
                ],
              },
            ],
          },
          {
            type: 1,
            name: "maxactions",
            description: "Set maximum actions AI can execute per run.",
            options: [
              {
                name: "count",
                description: "Maximum actions per plan (1-12).",
                type: 4,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "reset",
            description: "Reset AI action policy to safe defaults.",
          },
        ],
      },
      {
        type: 2,
        name: "workflow",
        description: "Save and run reusable AI action workflows.",
        options: [
          {
            type: 1,
            name: "save",
            description: "Save a natural-language action workflow.",
            options: [
              {
                name: "name",
                description: "Workflow name.",
                type: 3,
                required: true,
              },
              {
                name: "request",
                description: "Natural-language action request to save.",
                type: 3,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "run",
            description: "Run a saved workflow (approval still required).",
            options: [
              {
                name: "name",
                description: "Saved workflow name.",
                type: 3,
                required: true,
              },
              {
                name: "dry_run",
                description: "Preview execution without applying changes.",
                type: 5,
                required: false,
              },
            ],
          },
          {
            type: 1,
            name: "list",
            description: "List saved workflows.",
          },
          {
            type: 1,
            name: "remove",
            description: "Remove a saved workflow.",
            options: [
              {
                name: "name",
                description: "Saved workflow name to remove.",
                type: 3,
                required: true,
              },
            ],
          },
          {
            type: 1,
            name: "show",
            description: "Show saved workflow details.",
            options: [
              {
                name: "name",
                description: "Saved workflow name.",
                type: 3,
                required: true,
              },
            ],
          },
        ],
      },
      {
        type: 1,
        name: "status",
        description: "Show agent status and model configuration.",
      },
      {
        type: 1,
        name: "analytics",
        description: "Show AEON AI usage analytics and queue/latency health.",
      },
      {
        type: 1,
        name: "reload",
        description: "Reload AEON'26 knowledge files for the assistant.",
      },
    ],
  },
  {
    name: "setup",
    description: "Open guided setup for bot channels.",
  },
  {
    name: "botprofile",
    description: "Customize guild-specific bot profile branding.",
  },
  {
    name: "interface",
    description: "Send the temporary voice channel control interface.",
    options: [
      {
        name: "channel",
        description: "Optional temporary voice channel.",
        type: 7,
        required: false,
      },
    ],
  },
  {
    name: "config",
    description: "Manage server configuration values.",
    options: [
      {
        type: 1,
        name: "jtc_trigger",
        description: "Add or update a join-to-create trigger channel.",
        options: [
          {
            name: "trigger",
            description: "Voice channel members join to create private channels.",
            type: 7,
            required: true,
          },
          {
            name: "category",
            description: "Optional category where temp channels should be created.",
            type: 7,
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: "jtc_interface",
        description: "Set fallback text channel for temp voice controls.",
        options: [
          {
            name: "channel",
            description: "Fallback text channel.",
            type: 7,
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "stats_category",
        description: "Set the stats voice category and create counters.",
        options: [
          {
            name: "category",
            description: "Target category channel.",
            type: 7,
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "welcome_channel",
        description: "Set the channel where welcome embeds are sent.",
        options: [
          {
            name: "channel",
            description: "Target text channel for welcome messages.",
            type: 7,
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "autorole",
    description: "Manage roles assigned automatically to new members.",
    options: [
      {
        type: 1,
        name: "add",
        description: "Add a role to the autorole list.",
        options: [
          {
            name: "role",
            description: "Role to assign automatically.",
            type: 8,
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "remove",
        description: "Remove a role from the autorole list.",
        options: [
          {
            name: "role",
            description: "Role to remove from autorole.",
            type: 8,
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "list",
        description: "Show configured autoroles.",
      },
      {
        type: 1,
        name: "clear",
        description: "Clear all configured autoroles.",
      },
    ],
  },
  {
    name: "join",
    description: "Join your current voice channel.",
    options: [
      { name: "channel", description: "Optional voice channel override.", type: 7, required: false },
    ],
  },
  {
    name: "play",
    description: "Play a track or add it to the queue.",
    options: [{ name: "query", description: "Song name or URL.", type: 3, required: true, autocomplete: true }],
  },
  {
    name: "queue",
    description: "Show the current music queue.",
    options: [{ name: "page", description: "Queue page number.", type: 4, required: false }],
  },
  {
    name: "skip",
    description: "Skip the current song.",
    options: [{ name: "amount", description: "How many songs to skip.", type: 4, required: false }],
  },
  {
    name: "pause",
    description: "Pause playback.",
  },
  {
    name: "resume",
    description: "Resume playback.",
  },
  {
    name: "stop",
    description: "Stop playback and clear queue.",
  },
  {
    name: "disconnect",
    description: "Disconnect from voice channel.",
  },
  {
    name: "clear",
    description: "Clear queued songs after current one.",
  },
  {
    name: "shuffle",
    description: "Shuffle queued songs.",
  },
  {
    name: "loop",
    description: "Set loop mode.",
    options: [
      {
        name: "mode",
        description: "Loop mode to apply.",
        type: 3,
        required: false,
        choices: [
          { name: "toggle", value: "toggle" },
          { name: "off", value: "off" },
          { name: "song", value: "song" },
          { name: "queue", value: "queue" },
        ],
      },
    ],
  },
  {
    name: "volume",
    description: "View or set playback volume.",
    options: [{ name: "percent", description: "Volume 1-200.", type: 4, required: false }],
  },
  {
    name: "help",
    description: "Open the interactive help panel.",
  },
  {
    name: "log",
    description: "Manage logging settings.",
    options: [
      {
        type: 1,
        name: "channel",
        description: "Set the channel where logs should be sent.",
        options: [
          {
            name: "channel",
            description: "Target text channel for logs.",
            type: 7,
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "config",
        description: "View or update logging event toggles.",
        options: [
          { name: "member_events", description: "Enable member logs.", type: 5, required: false },
          { name: "role_events", description: "Enable role logs.", type: 5, required: false },
          { name: "channel_events", description: "Enable channel/category logs.", type: 5, required: false },
          { name: "message_events", description: "Enable message edit/delete logs.", type: 5, required: false },
          { name: "moderation_events", description: "Enable moderation action logs.", type: 5, required: false },
        ],
      },
    ],
  },
];

const COMMANDS = [...BASE_COMMANDS.filter((cmd) => cmd.name !== "aeon")];
for (const command of MU_COMMANDS) {
  if (!COMMANDS.some((existing) => existing.name === command.name)) COMMANDS.push(command);
}

module.exports = { COMMANDS };


