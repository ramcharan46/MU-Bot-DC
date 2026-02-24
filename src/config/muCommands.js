const MU_COMMANDS = [
  {
    name: "roast",
    description: "Roast someone to ashes.",
    options: [{ name: "target", description: "Target user.", type: 6, required: true }],
  },
  {
    name: "ship",
    description: "Ship two users and reveal compatibility.",
    options: [
      { name: "user1", description: "First user.", type: 6, required: true },
      { name: "user2", description: "Second user.", type: 6, required: true },
    ],
  },
  {
    name: "pokeping",
    description: "Manage your Poketwo spawn pings.",
    options: [
      { type: 1, name: "add", description: "Register for spawn alerts." },
      { type: 1, name: "remove", description: "Unregister from spawn alerts." },
      { type: 1, name: "list", description: "List registered users." },
    ],
  },
  {
    name: "embed_send",
    description: "Send a custom embed to a channel.",
    options: [
      { name: "channel", description: "Target channel.", type: 7, required: true },
      { name: "title", description: "Embed title.", type: 3, required: false },
      { name: "description", description: "Embed description.", type: 3, required: false, max_length: 4000 },
      { name: "color", description: "Hex color like #D01C28.", type: 3, required: false },
    ],
  },
  {
    name: "level_blacklist_add",
    description: "Blacklist a channel from XP gain.",
    options: [{ name: "channel", description: "Channel to blacklist.", type: 7, required: true }],
  },
  {
    name: "level_blacklist_remove",
    description: "Remove a channel from XP blacklist.",
    options: [{ name: "channel", description: "Channel to remove.", type: 7, required: true }],
  },
  {
    name: "level_blacklist_list",
    description: "List XP blacklisted channels.",
  },
  {
    name: "hotrate",
    description: "Rate how hot someone is.",
    options: [{ name: "target", description: "Target user.", type: 6, required: false }],
  },
  {
    name: "mute",
    description: "Timeout a user for a duration.",
    options: [
      { name: "target", description: "Target user.", type: 6, required: true },
      { name: "duration", description: "Duration like 10m, 2h, 1d.", type: 3, required: true },
    ],
  },
  {
    name: "leaderboard",
    description: "View XP leaderboard.",
    options: [{ name: "page", description: "Leaderboard page.", type: 4, required: false, min_value: 1 }],
  },
  {
    name: "hof_leaderboard",
    description: "View Hall of Fame star leaderboard.",
    options: [{ name: "page", description: "Leaderboard page.", type: 4, required: false, min_value: 1 }],
  },
  {
    name: "unmute",
    description: "Remove timeout from a user.",
    options: [{ name: "target", description: "Target user.", type: 6, required: true }],
  },
  {
    name: "quote",
    description: "Create a quote card.",
    options: [
      { name: "text", description: "Quote text.", type: 3, required: true, max_length: 600 },
      { name: "author", description: "Quote author.", type: 3, required: false, max_length: 100 },
    ],
  },
  {
    name: "quote_style",
    description: "Create a themed quote card.",
    options: [
      { name: "text", description: "Quote text.", type: 3, required: true, max_length: 600 },
      { name: "author", description: "Quote author.", type: 3, required: false, max_length: 100 },
      {
        name: "theme",
        description: "Theme style.",
        type: 3,
        required: false,
        choices: [
          { name: "Dark", value: "dark" },
          { name: "Blue", value: "blue" },
          { name: "Purple", value: "purple" },
          { name: "Gradient", value: "gradient" },
          { name: "Red", value: "red" },
          { name: "Green", value: "green" },
        ],
      },
    ],
  },
  {
    name: "calculate",
    description: "Evaluate a math expression.",
    options: [{ name: "expression", description: "Expression to evaluate.", type: 3, required: true, max_length: 200 }],
  },
  {
    name: "member_count",
    description: "Show member count breakdown.",
  },
  {
    name: "rules",
    description: "Show server rules.",
  },
  {
    name: "rules_dm",
    description: "DM server rules.",
  },
  {
    name: "meme",
    description: "Get a random meme.",
  },
  {
    name: "meme_mc",
    description: "Get a Minecraft meme.",
  },
  {
    name: "joke",
    description: "Tell a random joke.",
  },
  {
    name: "8ball",
    description: "Ask the magic 8-ball.",
    options: [{ name: "question", description: "Your question.", type: 3, required: true }],
  },
  {
    name: "wholesome",
    description: "Get a wholesome message.",
  },
  {
    name: "say",
    description: "Make the bot say something.",
    options: [{ name: "text", description: "Text to say.", type: 3, required: true, max_length: 1800 }],
  },
  {
    name: "flip",
    description: "Flip a coin.",
  },
  {
    name: "rps",
    description: "Play rock paper scissors.",
    options: [
      {
        name: "choice",
        description: "Your choice.",
        type: 3,
        required: true,
        choices: [
          { name: "rock", value: "rock" },
          { name: "paper", value: "paper" },
          { name: "scissors", value: "scissors" },
        ],
      },
    ],
  },
  {
    name: "kill",
    description: "Fake kill someone dramatically.",
    options: [{ name: "target", description: "Target user.", type: 6, required: true }],
  },
  {
    name: "level_channel",
    description: "Set the level-up announcement channel.",
    options: [{ name: "channel", description: "Announcement channel.", type: 7, required: true }],
  },
  {
    name: "level_role_add",
    description: "Set role granted at a level.",
    options: [
      { name: "level", description: "Target level.", type: 4, required: true, min_value: 1, max_value: 1000 },
      { name: "role", description: "Role to grant.", type: 8, required: true },
    ],
  },
  {
    name: "level_role_remove",
    description: "Set role removed at a level.",
    options: [
      { name: "level", description: "Target level.", type: 4, required: true, min_value: 1, max_value: 1000 },
      { name: "role", description: "Role to remove.", type: 8, required: true },
    ],
  },
  {
    name: "level_role_clear",
    description: "Clear all level role rules.",
  },
  {
    name: "level_xp_add",
    description: "Add XP to a user.",
    options: [
      { name: "user", description: "Target user.", type: 6, required: true },
      { name: "amount", description: "XP amount.", type: 4, required: true, min_value: 1, max_value: 1000000 },
    ],
  },
  {
    name: "level_set",
    description: "Set a user's level.",
    options: [
      { name: "user", description: "Target user.", type: 6, required: true },
      { name: "level", description: "Level value.", type: 4, required: true, min_value: 0, max_value: 1000 },
    ],
  },
  {
    name: "gayrate",
    description: "Measure rainbow energy.",
    options: [{ name: "target", description: "Target user.", type: 6, required: false }],
  },
  {
    name: "wordgame_start",
    description: "Start a WordCore Survival lobby.",
  },
  {
    name: "level",
    description: "Check current level and XP.",
    options: [{ name: "user", description: "Target user.", type: 6, required: false }],
  },
  {
    name: "autoreact_toggle",
    description: "Toggle auto react on a target user.",
    options: [
      { name: "user", description: "Target user.", type: 6, required: true },
      { name: "emoji", description: "Emoji to react with.", type: 3, required: true },
    ],
  },
];

module.exports = { MU_COMMANDS };
