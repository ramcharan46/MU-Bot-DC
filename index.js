const {
  Client,
  Intents,
  Collection,
  MessageEmbed,
  Permissions,
  MessageActionRow,
  MessageButton,
  AttachmentBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const math = require("mathjs");
const moment = require("moment");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");
const { SlashCommandBuilder } = require("@discordjs/builders");
const dotenv = require("dotenv");
const fetch = require("node-fetch");
const express = require("express");
const { QuickDB } = require("quick.db");
const db = new QuickDB();
const app = express();
const port = process.env.PORT || 4000;
const WELCOME_CHANNEL_ID = "1387088404855914646"; //hardcoded
const LEVEL_UP_CHANNEL_KEY = "1396457739852451941"; //hardcoded
const XP_PER_MESSAGE = 5;
const XP_COOLDOWN = 500; // half second
const userCooldowns = new Map();
dotenv.config();

app.get("/", (req, res) => {
  res.send("Express server is running!");
});

app.listen(port, () => {
  console.log(`MU Bot listening on port ${port}`);
});

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.MESSAGE_CONTENT,
    Intents.FLAGS.GUILD_MEMBERS,
  ],
});

client.commands = new Collection();
const cooldowns = new Collection();

// Cooldown settings
const commandCooldowns = {
  ping: 5,
  joke: 10,
  meme: 10,
  wholesome: 15,
  kill: 10,
  quote: 15,
  quotestyle: 20,
};

//Help Pages
const helpPages = {
  moderation: new MessageEmbed()
    .setTitle("🛠️ Moderation Commands")
    .setColor(0x00ae86)
    .setDescription(
      [
        "`/kick` — Kick a user",
        "`/ban` — Ban a user",
        "`/unban` — Unban by user ID",
        "`/mute` — Mute user with custom duration (e.g., 30s, 10m, 2h)",
        "`/unmute` — Unmute user",
        "`/warn` — Warn a user",
        "`/purge` — Bulk delete messages",
        "`/addautorole` — Auto-assign a role when members join",
        "`/sendembed` — Send a custom embed to a specific channel",
        "`/removeautorole` — Remove the auto-role setting",
        "`/blacklistchannel` — Blacklist a channel from XP gain",
        "`/removeblacklist` — Remove channel from XP blacklist",
        "`/listblacklist` — Show all blacklisted channels",
      ].join("\n"),
    ),

  general: new MessageEmbed()
    .setTitle("ℹ️ General Commands")
    .setColor(0x00ae86)
    .setDescription(
      [
        "`/ping` — Ping the bot",
        "`/help` — Show this help menu",
        "`/serverinfo` — Info about this server",
        "`/userinfo` — Info about a user",
        "`/membercount` — Server member count",
        "`/rules` — Show server rules",
        "`/rulesdm` — DM the rules",
      ].join("\n"),
    ),

  leveling: new MessageEmbed()
    .setTitle("📊 Leveling Commands")
    .setColor(0x00ae86)
    .setDescription(
      [
        "`/level` — View your current level and XP",
        "`/leaderboard` — View the server XP leaderboard",
        "`/addxp` — [Admin] Add XP to a user",
        "`/setlevel` — [Admin] Set a user's level",
        "`/setlevelchannel` — Set the level-up announcement channel",
        "`/setlevelrole` — Assign role at a certain level",
        "`/setclearrole` — Set role to remove at a level",
        "`/clearlevelroles` — Clear all level role settings",
      ].join("\n"),
    ),

  fun: new MessageEmbed()
    .setTitle("🎉 Fun Commands")
    .setColor(0x00ae86)
    .setDescription(
      [
        "`/meme` — Get a random meme",
        "`/mcmeme` — Minecraft meme",
        "`/startwordgame` — Start the WordCore Survival game",
        "`/quote` — Create a stylish quote image with your profile picture",
        "`/quotestyle` — Create themed quote images (Dark, Blue, Purple, Rainbow)",
        "`/joke` — Tell a random joke",
        "`/8ball` — Ask the magic 8-ball",
        "`/gayrate` — Tells how gay someone is!",
        "`/hotrate` — Tells how hot someone is!",
        "`/ship` — Ship two people and reveal their secret connection",
        "`/wholesome` — Uplifting messages",
        "`/roast` — Roast someone to ashes",
        "`/say` — Make the bot speak",
        "`/flip` — Flip a coin",
        "`/rps` — Rock Paper Scissors",
        "`/kill` — Fake kill someone",
      ].join("\n"),
    ),

  utility: new MessageEmbed()
    .setTitle("🧮 Utility Commands")
    .setColor(0x00ae86)
    .setDescription(
      ["`/calculate` — Solve math", "`/avatar` — Show user avatar"].join("\n"),
    )
    .setFooter({ text: "Use /command to run a command." }),
};

const helpButtons = new MessageActionRow().addComponents(
  new MessageButton()
    .setCustomId("moderation")
    .setLabel("🛠️ Moderation")
    .setStyle("SECONDARY"),
  new MessageButton()
    .setCustomId("general")
    .setLabel("ℹ️ General")
    .setStyle("SECONDARY"),
  new MessageButton()
    .setCustomId("leveling")
    .setLabel("📊 Leveling")
    .setStyle("SECONDARY"),
  new MessageButton()
    .setCustomId("fun")
    .setLabel("🎉 Fun")
    .setStyle("SECONDARY"),
  new MessageButton()
    .setCustomId("utility")
    .setLabel("🧮 Utility")
    .setStyle("SECONDARY"),
);

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Replies with Pong!"),
  new SlashCommandBuilder()
    .setName("roast")
    .setDescription("Roast someone to ashes 🔥")
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("The poor soul to roast")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("ship")
    .setDescription("Ship two people and reveal their secret connection 💘")
    .addUserOption((option) =>
      option.setName("user1").setDescription("First person").setRequired(true),
    )
    .addUserOption((option) =>
      option.setName("user2").setDescription("Second person").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("sendembed")
    .setDescription("Build and send a custom embed to a specific channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel where the embed will be sent")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available commands"),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user")
    .addUserOption((opt) =>
      opt.setName("target").setDescription("User to kick").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("blacklistchannel")
    .setDescription("Blacklist a channel from XP gain")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to blacklist from XP")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("removeblacklist")
    .setDescription("Remove a channel from XP blacklist")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to remove from blacklist")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("listblacklist")
    .setDescription("Show all blacklisted channels"),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user")
    .addUserOption((opt) =>
      opt.setName("target").setDescription("User to ban").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user")
    .addStringOption((opt) =>
      opt
        .setName("userid")
        .setDescription("User ID to unban")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("hotrate")
    .setDescription("Find out how hot someone is!")
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("User to rate")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute a user for a specified duration")
    .addUserOption((opt) =>
      opt.setName("target").setDescription("User to mute").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("duration")
        .setDescription("Duration (e.g., 10s, 5m, 1h)")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the server XP leaderboard")
    .addIntegerOption((option) =>
      option
        .setName("page")
        .setDescription("Page number to view (default: 1)")
        .setRequired(false)
        .setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute a user")
    .addUserOption((opt) =>
      opt.setName("target").setDescription("User to unmute").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a user")
    .addUserOption((opt) =>
      opt.setName("target").setDescription("User to warn").setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk delete messages")
    .addIntegerOption((opt) =>
      opt
        .setName("amount")
        .setDescription("Number to delete")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Create a stylish quote embed with your profile picture")
    .addStringOption((option) =>
      option
        .setName("text")
        .setDescription("The quote text")
        .setRequired(true)
        .setMaxLength(200),
    )
    .addStringOption((option) =>
      option
        .setName("author")
        .setDescription("Quote author (optional - defaults to your username)")
        .setRequired(false)
        .setMaxLength(50),
    ),

  new SlashCommandBuilder()
    .setName("quotestyle")
    .setDescription("Create a themed quote embed")
    .addStringOption((option) =>
      option
        .setName("text")
        .setDescription("The quote text")
        .setRequired(true)
        .setMaxLength(200),
    )
    .addStringOption((option) =>
      option
        .setName("author")
        .setDescription("Quote author (optional)")
        .setRequired(false)
        .setMaxLength(50),
    )
    .addStringOption((option) =>
      option
        .setName("theme")
        .setDescription("Choose a theme")
        .setRequired(false)
        .addChoices(
          { name: "🖤 Dark (Default)", value: "dark" },
          { name: "💙 Blue Gradient", value: "blue" },
          { name: "💜 Purple Gradient", value: "purple" },
          { name: "🌈 Rainbow Gradient", value: "gradient" },
          { name: "❤️ Red Passion", value: "red" },
          { name: "💚 Green Nature", value: "green" },
        ),
    ),

  new SlashCommandBuilder()
    .setName("calculate")
    .setDescription("Calculate a mathematical expression.")
    .addStringOption((option) =>
      option
        .setName("expression")
        .setDescription("The expression to evaluate (e.g. 2 + 2 * (5 - 3))")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Get server info"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Get user info")
    .addUserOption((opt) =>
      opt.setName("target").setDescription("User").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("membercount")
    .setDescription("Get member count"),

  new SlashCommandBuilder().setName("rules").setDescription("Show rules"),
  new SlashCommandBuilder().setName("rulesdm").setDescription("DM the rules"),

  new SlashCommandBuilder().setName("meme").setDescription("Get a random meme"),
  new SlashCommandBuilder()
    .setName("mcmeme")
    .setDescription("Get a Minecraft meme"),
  new SlashCommandBuilder().setName("joke").setDescription("Tell a joke"),
  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the 8-ball")
    .addStringOption((opt) =>
      opt.setName("question").setDescription("Your question").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("wholesome")
    .setDescription("Get a wholesome message"),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot say something")
    .addStringOption((opt) =>
      opt.setName("text").setDescription("Text to say").setRequired(true),
    ),
  new SlashCommandBuilder().setName("flip").setDescription("Flip a coin"),
  new SlashCommandBuilder()
    .setName("rps")
    .setDescription("Play Rock-Paper-Scissors with the bot!"),
  new SlashCommandBuilder()
    .setName("kill")
    .setDescription("Kill someone in a hilarious way.")
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("Select the user to kill")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show user avatar")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("User").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("setlevelchannel")
    .setDescription("Set the channel for level-up messages")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("The level-up channel")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setlevelrole")
    .setDescription("Set a role to give when a user reaches a certain level")
    .addIntegerOption((opt) =>
      opt
        .setName("level")
        .setDescription("Level to give the role at")
        .setRequired(true),
    )
    .addRoleOption((opt) =>
      opt.setName("role").setDescription("Role to assign").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setclearrole")
    .setDescription("Set a role to remove when a user reaches a certain level")
    .addIntegerOption((opt) =>
      opt
        .setName("level")
        .setDescription("Level to remove the role at")
        .setRequired(true),
    )
    .addRoleOption((opt) =>
      opt.setName("role").setDescription("Role to remove").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("clearlevelroles")
    .setDescription("Clear all level role and removal settings"),
  new SlashCommandBuilder()
    .setName("addxp")
    .setDescription("Add XP to a user")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("User to add XP to").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Amount of XP").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setlevel")
    .setDescription("Set a user's level manually")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("User to set level for")
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("level").setDescription("Level to set").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("gayrate")
    .setDescription("Tells how gay someone is!")
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("The user to scan")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("startwordgame")
    .setDescription("Starts or begins the WordCore Survival game"),
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Check your current level and XP")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("User to check (optional)")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("addautorole")
    .setDescription("Set a role to automatically assign to new members")
    .addRoleOption((option) =>
      option
        .setName("role")
        .setDescription("Role to assign on join")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("removeautorole")
    .setDescription("Remove an autorole from the list")
    .addRoleOption((opt) =>
      opt
        .setName("role")
        .setDescription("Role to remove from autoroles")
        .setRequired(true),
    ),
];

// Quote image generation function
function getThemeColors(theme) {
  const themes = {
    dark: { color: 0x000000, accent: "🖤" },
    blue: { color: 0x1e3c72, accent: "💙" },
    purple: { color: 0x667eea, accent: "💜" },
    gradient: { color: 0xff9a9e, accent: "🌈" },
    red: { color: 0xff4757, accent: "❤️" },
    green: { color: 0x2ed573, accent: "💚" },
  };
  return themes[theme] || themes.dark;
}

function formatQuoteText(text, author, username) {
  const styledText = `*"${text}"*`;
  const attribution = `**— ${author}**`;
  const watermark = `\n\n*Created by @${username}*`;

  return `${styledText}\n\n${attribution}${watermark}`;
}

//Hall of fame XP Grant

const HALL_OF_FAME_CHANNEL_ID = "1388845716851396758";

client.on("messageCreate", async (message) => {
  if (message.channel.id !== HALL_OF_FAME_CHANNEL_ID) return;
  if (!message.embeds || !message.embeds[0]) return;

  const embed = message.embeds[0];
  if (!embed.author || !embed.author.name) return;

  const authorName = embed.author.name;

  // Avoid double rewarding
  const rewardKey = `hof_rewarded_${message.id}`;
  if (db.get(rewardKey)) return;

  try {
    const members = await message.guild.members.fetch();
    const matchedMember = members.find(
      (m) => m.displayName === authorName || m.user.username === authorName,
    );

    if (!matchedMember) {
      console.log(`⚠️ Could not match author "${authorName}" to a member.`);
      return;
    }

    const userId = matchedMember.user.id;
    const xpKey = `xp_${userId}`;
    const currentXP = db.get(xpKey) || 0;

    db.set(xpKey, currentXP + 1000);
    db.set(rewardKey, true);

    console.log(
      `🌟 Gave 1000 XP to ${authorName} (${userId}) for Hall of Fame!`,
    );
  } catch (error) {
    console.error("❌ Error processing HOF XP:", error);
  }
});

// Register to Discord
const rest = new REST({ version: "9" }).setToken(process.env.TOKEN);

client.once("ready", async () => {
  console.log(`✅ Bot is online! Logged in as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} servers`);

  try {
    console.log("Clearing global commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: [],
    });
    console.log("Global commands cleared!");
    console.log("Registering slash commands to guilds...");
    for (const guild of client.guilds.cache.values()) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id),
        { body: commands.map((cmd) => cmd.toJSON()) },
      );
      console.log(`Registered commands for guild: ${guild.name}`);
    }
    console.log("All slash commands registered!");
  } catch (err) {
    console.error("Error registering commands:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName, user } = interaction;
  if (commandCooldowns[commandName]) {
    if (!cooldowns.has(commandName))
      cooldowns.set(commandName, new Collection());
    const now = Date.now();
    const timestamps = cooldowns.get(commandName);
    const cooldownAmount = commandCooldowns[commandName] * 1000;
    if (timestamps.has(user.id)) {
      const expirationTime = timestamps.get(user.id) + cooldownAmount;
      if (now < expirationTime) {
        const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
        return interaction.reply({
          content: `⏳ Wait ${timeLeft}s before using \`/${commandName}\` again.`,
          ephemeral: true,
        });
      }
    }
    timestamps.set(user.id, now);
    setTimeout(() => timestamps.delete(user.id), cooldownAmount);
  }

  console.log(`[${new Date().toISOString()}] ${user.tag} used /${commandName}`);

  function getRequiredXP(level) {
    return 100 + level * 25;
  }

  // Commands
  if (commandName === "ping") {
    await interaction.reply("🏓 Pong!");
  } else if (commandName === "leaderboard") {
    await interaction.deferReply();

    const requestedPage = interaction.options.getInteger("page") || 1;
    const usersPerPage = 10;
    const guildId = interaction.guild.id;

    try {
      const members = await interaction.guild.members.fetch();
      const levelData = [];

      for (const [memberId, member] of members) {
        if (member.user.bot) continue;

        const key = `${guildId}-${memberId}`;
        const xp = (await db.get(`xp.${key}`)) || 0;
        const level = (await db.get(`level.${key}`)) || 0;

        if (xp > 0 || level > 0) {
          levelData.push({
            userId: memberId,
            username: member.user.username,
            displayName: member.displayName,
            avatar: member.user.displayAvatarURL({ dynamic: true, size: 64 }),
            level: level,
            xp: xp,
          });
        }
      }

      if (levelData.length === 0) {
        return interaction.editReply({
          content:
            "📊 No leaderboard data found yet! Start chatting to gain XP!",
          ephemeral: true,
        });
      }

      levelData.sort((a, b) => {
        if (a.level !== b.level) return b.level - a.level;
        return b.xp - a.xp;
      });

      const totalPages = Math.ceil(levelData.length / usersPerPage);
      const currentPage = Math.min(requestedPage, totalPages);
      const startIndex = (currentPage - 1) * usersPerPage;
      const endIndex = startIndex + usersPerPage;
      const pageData = levelData.slice(startIndex, endIndex);

      function getRequiredXP(level) {
        return 100 + level * 25;
      }

      const embed = new MessageEmbed()
        .setTitle("🏆 XP Leaderboard")
        .setColor("#D01C28")
        .setDescription(
          `**Page ${currentPage} of ${totalPages}** • **${levelData.length}** ranked users`,
        )
        .setFooter({
          text: `Mahindra University Discord | Requested by ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
        })
        .setTimestamp();

      let description = "";
      pageData.forEach((user, index) => {
        const rank = startIndex + index + 1;
        const requiredXp = getRequiredXP(user.level);

        const progressPercentage = Math.min(
          Math.max((user.xp / requiredXp) * 100, 0),
          100,
        );
        const filledBars = Math.floor((progressPercentage / 100) * 10);
        const emptyBars = 10 - filledBars;

        const progressBar =
          "█".repeat(Math.max(filledBars, 0)) +
          "░".repeat(Math.max(emptyBars, 0));

        let medal = "";
        if (rank === 1) medal = "🥇";
        else if (rank === 2) medal = "🥈";
        else if (rank === 3) medal = "🥉";
        else medal = `**#${rank}**`;

        description += `${medal} **${user.displayName}**\n`;
        description += `📊 Level **${user.level}** • ${user.xp}/${requiredXp} XP\n`;
        description += `\`${progressBar}\`\n\n`;
      });

      embed.setDescription(
        `**Page ${currentPage} of ${totalPages}** • **${levelData.length}** ranked users\n\n${description}`,
      );

      const row = new MessageActionRow().addComponents(
        new MessageButton()
          .setCustomId(`leaderboard_${currentPage - 1}`)
          .setLabel("◀️ Previous")
          .setStyle("SECONDARY")
          .setDisabled(currentPage <= 1),
        new MessageButton()
          .setCustomId(`leaderboard_page_info`)
          .setLabel(`Page ${currentPage}/${totalPages}`)
          .setStyle("SUCCESS")
          .setDisabled(true),
        new MessageButton()
          .setCustomId(`leaderboard_${currentPage + 1}`)
          .setLabel("Next ▶️")
          .setStyle("SECONDARY")
          .setDisabled(currentPage >= totalPages),
      );

      const message = await interaction.editReply({
        embeds: [embed],
        components: totalPages > 1 ? [row] : [],
      });

      if (totalPages > 1) {
        const collector = message.createMessageComponentCollector({
          componentType: "BUTTON",
          time: 300000,
          filter: (i) =>
            i.user.id === interaction.user.id &&
            i.customId.startsWith("leaderboard_"),
        });

        collector.on("collect", async (i) => {
          if (i.customId === "leaderboard_page_info") return;

          const newPage = parseInt(i.customId.split("_")[1]);
          if (newPage < 1 || newPage > totalPages) return;

          const newStartIndex = (newPage - 1) * usersPerPage;
          const newEndIndex = newStartIndex + usersPerPage;
          const newPageData = levelData.slice(newStartIndex, newEndIndex);

          let newDescription = "";
          newPageData.forEach((user, index) => {
            const rank = newStartIndex + index + 1;
            const requiredXp = getRequiredXP(user.level);

            const progressPercentage = Math.min(
              Math.max((user.xp / requiredXp) * 100, 0),
              100,
            );
            const filledBars = Math.floor((progressPercentage / 100) * 10);
            const emptyBars = 10 - filledBars;

            const progressBar =
              "█".repeat(Math.max(filledBars, 0)) +
              "░".repeat(Math.max(emptyBars, 0));

            let medal = "";
            if (rank === 1) medal = "🥇";
            else if (rank === 2) medal = "🥈";
            else if (rank === 3) medal = "🥉";
            else medal = `**#${rank}**`;

            newDescription += `${medal} **${user.displayName}**\n`;
            newDescription += `📊 Level **${user.level}** • ${user.xp}/${requiredXp} XP\n`;
            newDescription += `\`${progressBar}\`\n\n`;
          });

          const newEmbed = new MessageEmbed()
            .setTitle("🏆 XP Leaderboard")
            .setColor("#D01C28")
            .setDescription(
              `**Page ${newPage} of ${totalPages}** • **${levelData.length}** ranked users\n\n${newDescription}`,
            )
            .setFooter({
              text: `Mahindra University Discord | Requested by ${interaction.user.username}`,
              iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
            })
            .setTimestamp();

          const newRow = new MessageActionRow().addComponents(
            new MessageButton()
              .setCustomId(`leaderboard_${newPage - 1}`)
              .setLabel("◀️ Previous")
              .setStyle("SECONDARY")
              .setDisabled(newPage <= 1),
            new MessageButton()
              .setCustomId(`leaderboard_page_info`)
              .setLabel(`Page ${newPage}/${totalPages}`)
              .setStyle("SUCCESS")
              .setDisabled(true),
            new MessageButton()
              .setCustomId(`leaderboard_${newPage + 1}`)
              .setLabel("Next ▶️")
              .setStyle("SECONDARY")
              .setDisabled(newPage >= totalPages),
          );

          await i.update({
            embeds: [newEmbed],
            components: [newRow],
          });
        });

        collector.on("end", async () => {
          try {
            const disabledRow = new MessageActionRow().addComponents(
              row.components.map((btn) => btn.setDisabled(true)),
            );
            await interaction.editReply({ components: [disabledRow] });
          } catch (err) {
            console.warn("Failed to disable leaderboard buttons:", err.message);
          }
        });
      }
    } catch (error) {
      console.error("Leaderboard error:", error);
      await interaction.editReply({
        content:
          "❌ An error occurred while fetching the leaderboard. Please try again later.",
        ephemeral: true,
      });
    }
  } else if (commandName === "setlevelchannel") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "You do not have permission to set the level-up channel.",
        ephemeral: true,
      });
    }
    const channel = interaction.options.getChannel("channel");
    await db.set(`${interaction.guild.id}_${LEVEL_UP_CHANNEL_KEY}`, channel.id);
    interaction.reply(`✅ Level-up messages will now be sent in ${channel}`);
  } else if (commandName === "setlevelrole") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_ROLES)) {
      return interaction.reply({
        content: "You do not have permission to set level roles.",
        ephemeral: true,
      });
    }
    const level = interaction.options.getInteger("level");
    const role = interaction.options.getRole("role");
    await db.set(`levelrole.${interaction.guild.id}.${level}`, role.id);
    interaction.reply(
      `✅ Users will receive **${role.name}** at level **${level}**.`,
    );
  } else if (commandName === "setclearrole") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_ROLES)) {
      return interaction.reply({
        content: "You do not have permission to set role removals.",
        ephemeral: true,
      });
    }
    const level = interaction.options.getInteger("level");
    const role = interaction.options.getRole("role");
    await db.set(`clearrole.${interaction.guild.id}.${level}`, role.id);
    interaction.reply(
      `✅ Users will lose **${role.name}** at level **${level}**.`,
    );
  } else if (commandName === "clearlevelroles") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "You do not have permission to clear level role settings.",
        ephemeral: true,
      });
    }
    await db.delete(`levelrole.${interaction.guild.id}`);
    await db.delete(`clearrole.${interaction.guild.id}`);
    interaction.reply("🧹 Cleared all level role settings.");
  } else if (commandName === "addxp") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "You do not have permission to add XP.",
        ephemeral: true,
      });
    }
    const user = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");
    const key = `${interaction.guild.id}-${user.id}`;
    const current = (await db.get(`xp.${key}`)) || 0;
    await db.set(`xp.${key}`, current + amount);
    interaction.reply(`✅ Added **${amount} XP** to ${user.tag}.`);
  } else if (commandName === "setlevel") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "You do not have permission to set levels.",
        ephemeral: true,
      });
    }
    const user = interaction.options.getUser("user");
    const level = interaction.options.getInteger("level");
    const key = `${interaction.guild.id}-${user.id}`;
    await db.set(`level.${key}`, level);
    await db.set(`xp.${key}`, 0);
    interaction.reply(`✅ Set ${user.tag} to **level ${level}**.`);
  } else if (commandName === "level") {
    const user = interaction.options.getUser("user") || interaction.user;
    const key = `${interaction.guild.id}-${user.id}`;

    const xp = (await db.get(`xp.${key}`)) || 0;
    const level = (await db.get(`level.${key}`)) || 0;
    const required = getRequiredXP(level);

    const embed = new MessageEmbed()
      .setTitle(`📈 ${user.username}'s Level`)
      .setColor("#00BFFF")
      .setThumbnail(user.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: "🔢 Level", value: `${level}`, inline: true },
        { name: "💠 XP", value: `${xp} / ${required}`, inline: true },
      )
      .setFooter({ text: "Mahindra University | Progress Tracker" })
      .setTimestamp();

    interaction.reply({ embeds: [embed] });
  } else if (commandName === "roast") {
    const target = interaction.options.getUser("target");

    const roasts = [
      `${target.username} brings everyone so much joy… when they leave the room.`,
      `${target.username}'s secrets are safe with me. I never even listen when they talk.`,
      `${target.username}, you have something on your chin… no, the third one down.`,
      `${target.username} is like a cloud. When they disappear, it’s a beautiful day.`,
      `You're the reason shampoo has instructions, ${target.username}.`,
      `${target.username} thought High IQ was a Wi-Fi plan.`,
      `${target.username}, your face makes onions cry.`,
      `${target.username} tried to climb a ladder to success but got stuck on step one.`,
      `If I had a dollar every time ${target.username} said something smart, I’d be broke.`,
      `Some people graduate with honors. ${target.username} is just honored to graduate.`,
      `${target.username} has something on their face… oh wait, that’s just their face.`,
      `${target.username} is the reason why the gene pool needs a lifeguard.`,
      `${target.username} has two brain cells and they’re both fighting for third place.`,
      `You have something on your nose, ${target.username}… oh wait, that's just karma.`,
      `${target.username} brings flashbacks of buffering YouTube in 144p.`,
      `You're proof that evolution can go in reverse, ${target.username}.`,
      `${target.username}'s typing speed is 1 word per crash.`,
      `Even Clippy couldn’t help ${target.username}.`,
      `${target.username} once tripped over a wireless connection.`,
      `If laziness were an Olympic sport, ${target.username} wouldn’t even show up.`,
      `You're not dumb, ${target.username}… you’re just… post-dumb.`,
      `If I had a time machine, I'd go back and stop ${target.username}'s keyboard from ever being made.`,
      `${target.username}'s opinions are like NFTs — loud, pointless, and not worth anything.`,
      `${target.username} thinks sarcasm is a type of dinosaur.`,
      `${target.username}'s internet personality needs a reboot.`,
      `${target.username}, Google doesn’t even autocomplete you.`,
      `Even ChatGPT couldn't generate a valid reason to listen to ${target.username}.`,
      `${target.username} once failed a CAPTCHA. Twice.`,
      `You're so invisible, ${target.username}, even ghosts ignore you.`,
      `${target.username}'s best joke is their life decisions.`,
      `I've seen 404 pages that make more sense than ${target.username}.`,
      `You're like a software update, ${target.username} — no one asked, no one wanted, and everyone skipped.`,
      `When ${target.username} joined the VC, even the bot disconnected.`,
      `If I roasted you any harder, ${target.username}, your router would overheat.`,
      `You're the reason the mute button exists.`,
      `${target.username} laughs at their own jokes because no one else will.`,
      `${target.username}, even Minecraft villagers would say “Huh?” to your logic.`,
      `${target.username} has the IQ of a rock… but not Dwayne Johnson.`,
      `${target.username} is what happens when the "Skip tutorial" button is abused.`,
      `If brains were RAM, ${target.username} would be a floppy disk.`,
      `${target.username} has more red flags than a Minesweeper board.`,
      `You’re like a group project, ${target.username} — full of promises and absolutely no contribution.`,
      `You’re not built different, ${target.username}. You’re just… barely built.`,
      `${target.username} is the human version of “this message has been deleted.”`,
      `${target.username} thought JavaScript was a coffee recipe.`,
      `You're the kind of person who claps when the plane lands.`,
      `You're like the terms and conditions, ${target.username} — long, annoying, and nobody reads you.`,
      `Even incognito mode can't hide your embarrassment, ${target.username}.`,
      `${target.username} thinks SQL is short for "squeal".`,
      `You're not lagging, ${target.username}, you just think that slow.`,
      `${target.username} could get lost in a straight hallway.`,
      `You're not bad at games, ${target.username}, you're just in spectator mode for life.`,
      `You're like a 1% progress bar — annoying, slow, and always stuck.`,
      `${target.username} once asked “Is Google Drive a racing game?”`,
    ];

    const randomRoast = roasts[Math.floor(Math.random() * roasts.length)];

    await interaction.reply({
      content: `🔥 **Roast Incoming!** 🔥\n${randomRoast}`,
      allowedMentions: { users: [] },
    });
  } else if (commandName === "sendembed") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "❌ Only administrators can use this command.",
        ephemeral: true,
      });
    }

    const channel = interaction.options.getChannel("channel");

    if (!channel || !channel.isText()) {
      return interaction.reply({
        content: "❌ Please select a valid text-based channel.",
        ephemeral: true,
      });
    }

    if (
      !channel
        .permissionsFor(interaction.guild.me)
        .has(Permissions.FLAGS.SEND_MESSAGES)
    ) {
      return interaction.reply({
        content: `❌ I don't have permission to send messages in ${channel}.`,
        ephemeral: true,
      });
    }

    const embedData = {};
    let currentStep = 0;

    const steps = [
      {
        name: "title",
        prompt: "🏷️ **Embed Title** (or 'skip' to skip):",
        required: false,
      },
      {
        name: "description",
        prompt: "📝 **Embed Description** (or 'skip' to skip):",
        required: false,
      },
      {
        name: "color",
        prompt:
          "🎨 **Embed Color** (hex code like #FF5733, color name, or 'skip'):",
        required: false,
      },
      {
        name: "field1_name",
        prompt: "📋 **Field 1 Name** (or 'skip' to skip fields):",
        required: false,
      },
      {
        name: "field1_value",
        prompt: "📄 **Field 1 Value**:",
        required: false,
        dependsOn: "field1_name",
      },
      {
        name: "field1_inline",
        prompt: "↔️ **Field 1 Inline?** (yes/no):",
        required: false,
        dependsOn: "field1_name",
      },
      {
        name: "field2_name",
        prompt: "📋 **Field 2 Name** (or 'skip' to skip remaining fields):",
        required: false,
      },
      {
        name: "field2_value",
        prompt: "📄 **Field 2 Value**:",
        required: false,
        dependsOn: "field2_name",
      },
      {
        name: "field2_inline",
        prompt: "↔️ **Field 2 Inline?** (yes/no):",
        required: false,
        dependsOn: "field2_name",
      },
      {
        name: "field3_name",
        prompt: "📋 **Field 3 Name** (or 'skip' to skip remaining fields):",
        required: false,
      },
      {
        name: "field3_value",
        prompt: "📄 **Field 3 Value**:",
        required: false,
        dependsOn: "field3_name",
      },
      {
        name: "field3_inline",
        prompt: "↔️ **Field 3 Inline?** (yes/no):",
        required: false,
        dependsOn: "field3_name",
      },
      {
        name: "image",
        prompt: "🖼️ **Image URL** (or 'skip' to skip):",
        required: false,
      },
      {
        name: "thumbnail",
        prompt: "🖼️ **Thumbnail URL** (or 'skip' to skip):",
        required: false,
      },
      {
        name: "footer",
        prompt: "👣 **Footer Text** (or 'skip' to skip):",
        required: false,
      },
      {
        name: "timestamp",
        prompt: "⏰ **Add Timestamp?** (yes/no):",
        required: false,
      },
    ];

    function parseColor(colorInput) {
      const colorInput_lower = colorInput.toLowerCase();
      const colors = {
        red: 0xff0000,
        green: 0x00ff00,
        blue: 0x0000ff,
        yellow: 0xffff00,
        purple: 0x800080,
        orange: 0xffa500,
        pink: 0xffc0cb,
        black: 0x000000,
        white: 0xffffff,
        mahindra: 0xd01c28,
        gold: 0xffd700,
      };

      if (colors[colorInput_lower]) return colors[colorInput_lower];

      const hexMatch = colorInput.match(/^#?([A-Fa-f0-9]{6})$/);
      if (hexMatch) return parseInt(hexMatch[1], 16);

      return 0x00ae86;
    }

    const askNextQuestion = async () => {
      if (currentStep >= steps.length) {
        try {
          const embed = new MessageEmbed();

          if (embedData.title && embedData.title !== "skip") {
            embed.setTitle(embedData.title);
          }

          if (embedData.description && embedData.description !== "skip") {
            embed.setDescription(embedData.description);
          }

          if (embedData.color && embedData.color !== "skip") {
            embed.setColor(parseColor(embedData.color));
          } else {
            embed.setColor(0x00ae86);
          }

          const fields = [];
          for (let i = 1; i <= 3; i++) {
            const fieldName = embedData[`field${i}_name`];
            const fieldValue = embedData[`field${i}_value`];
            const fieldInline = embedData[`field${i}_inline`];

            if (fieldName && fieldName !== "skip" && fieldValue) {
              fields.push({
                name: fieldName,
                value: fieldValue,
                inline:
                  fieldInline && fieldInline.toLowerCase().startsWith("y"),
              });
            }
          }

          if (fields.length > 0) {
            embed.addFields(fields);
          }

          if (
            embedData.image &&
            embedData.image !== "skip" &&
            embedData.image.startsWith("http")
          ) {
            embed.setImage(embedData.image);
          }

          if (
            embedData.thumbnail &&
            embedData.thumbnail !== "skip" &&
            embedData.thumbnail.startsWith("http")
          ) {
            embed.setThumbnail(embedData.thumbnail);
          }

          if (embedData.footer && embedData.footer !== "skip") {
            embed.setFooter({
              text: embedData.footer,
              iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
            });
          }

          if (
            embedData.timestamp &&
            embedData.timestamp.toLowerCase().startsWith("y")
          ) {
            embed.setTimestamp();
          }

          await channel.send({ embeds: [embed] });

          await interaction.followUp({
            content: `✅ Embed successfully sent to ${channel}!`,
            ephemeral: true,
          });
        } catch (error) {
          console.error("Error building embed:", error);
          await interaction.followUp({
            content: "❌ Error building the embed. Please try again.",
            ephemeral: true,
          });
        }
        return;
      }

      const step = steps[currentStep];

      if (
        step.dependsOn &&
        (!embedData[step.dependsOn] || embedData[step.dependsOn] === "skip")
      ) {
        currentStep++;
        return askNextQuestion();
      }

      await interaction.followUp({
        content: `${step.prompt}\n\n*Step ${currentStep + 1}/${steps.length}*`,
        ephemeral: true,
      });
    };

    await interaction.reply({
      content:
        "🛠️ **Embed Builder Started!**\nI'll ask you a series of questions to build your embed. You can type 'skip' for any optional field.\n\n*Please answer in this channel...*",
      ephemeral: true,
    });

    setTimeout(askNextQuestion, 1000);

    const filter = (msg) => msg.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({
      filter,
      time: 300000,
      max: steps.length,
    });

    collector.on("collect", async (message) => {
      const step = steps[currentStep];
      const userInput = message.content.trim();

      embedData[step.name] = userInput;

      try {
        await message.delete();
      } catch (err) {}

      currentStep++;
      await askNextQuestion();
    });

    collector.on("end", async (collected, reason) => {
      if (reason === "time") {
        await interaction.followUp({
          content: "⏰ Embed builder timed out. Please try again.",
          ephemeral: true,
        });
      }
    });
  } else if (commandName === "gayrate") {
    const target = interaction.options.getUser("target") || interaction.user;
    const percentage = Math.floor(Math.random() * 101); // 0–100%
    let ratingMessage = "";
    let emoji = "🏳️‍🌈";

    if (percentage <= 10) {
      ratingMessage = "Certified Hetero™ 😐";
    } else if (percentage <= 30) {
      ratingMessage = "A little fruity 🍓";
    } else if (percentage <= 50) {
      ratingMessage = "Occasionally sings ABBA in the shower 🎶";
    } else if (percentage <= 70) {
      ratingMessage = "Pride parade enthusiast 🏳️‍🌈✨";
    } else if (percentage <= 90) {
      ratingMessage = "Absolutely fabulous 💅";
    } else {
      ratingMessage = "Gay levels: 🌈🌈🌈 OVER 9000!!! 💥";
      emoji = "💖💜💙";
    }

    const embed = new MessageEmbed()
      .setTitle(`🌈 Gay Calculator`)
      .setDescription(
        `${target} is **${percentage}% gay**!\n\n${emoji} ${ratingMessage}`,
      )
      .setColor("#FF69B4")
      .setThumbnail(target.displayAvatarURL({ dynamic: true }))
      .setFooter(`For entertainment purposes only 😄`);

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "help") {
    await interaction.reply({
      embeds: [helpPages.general],
      components: [helpButtons],
      ephemeral: true,
    });

    const collector = interaction.channel.createMessageComponentCollector({
      componentType: "BUTTON",
      time: 60000, // 1 min timeout
      filter: (i) => i.user.id === interaction.user.id,
    });

    collector.on("collect", async (i) => {
      if (helpPages[i.customId]) {
        await i.update({
          embeds: [helpPages[i.customId]],
          components: [helpButtons],
        });
      }
    });

    collector.on("end", async () => {
      try {
        const disabledRow = new MessageActionRow().addComponents(
          helpButtons.components.map((btn) => btn.setDisabled(true)),
        );
        await interaction.editReply({ components: [disabledRow] });
      } catch (err) {
        console.warn("Failed to disable help buttons:", err.message);
      }
    });
  } else if (commandName === "kick") {
    const member = interaction.options.getMember("target");
    if (!interaction.member.permissions.has(Permissions.FLAGS.KICK_MEMBERS)) {
      return interaction.reply({
        content: "You do not have permission to kick users.",
        ephemeral: true,
      });
    }
    if (!member.kickable) {
      return interaction.reply({
        content: "I cannot kick this user.",
        ephemeral: true,
      });
    }
    await member.kick();
    await interaction.reply(`${member.user.tag} has been kicked.`);
  } else if (commandName === "ban") {
    const member = interaction.options.getMember("target");
    if (!interaction.member.permissions.has(Permissions.FLAGS.BAN_MEMBERS)) {
      return interaction.reply({
        content: "You do not have permission to ban users.",
        ephemeral: true,
      });
    }
    if (!member.bannable) {
      return interaction.reply({
        content: "I cannot ban this user.",
        ephemeral: true,
      });
    }
    await member.ban();
    await interaction.reply(`${member.user.tag} has been banned.`);
  } else if (commandName === "unban") {
    const userId = interaction.options.getString("userid");
    if (!interaction.member.permissions.has(Permissions.FLAGS.BAN_MEMBERS)) {
      return interaction.reply({
        content: "You do not have permission to unban users.",
        ephemeral: true,
      });
    }
    try {
      await interaction.guild.members.unban(userId);
      await interaction.reply(`Unbanned user with ID: ${userId}`);
    } catch {
      await interaction.reply("User not found or not banned.");
    }
  } else if (commandName === "startwordgame") {
    const {
      MessageActionRow,
      MessageButton,
      MessageEmbed,
    } = require("discord.js");
    const fetch = require("node-fetch");

    if (!interaction.member.permissions.has("ADMINISTRATOR")) {
      return interaction.reply({
        content: "Only admins can start the game.",
        ephemeral: true,
      });
    }

    const gameData = {
      participants: new Map(),
      isRunning: false,
      channel: interaction.channel,
      currentTurnActive: false,
    };

    const row = new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId("join_game")
        .setLabel("✅ Join Game")
        .setStyle("SUCCESS"),
      new MessageButton()
        .setCustomId("start_game")
        .setLabel("▶️ Start Game")
        .setStyle("PRIMARY"),
      new MessageButton()
        .setCustomId("stop_game")
        .setLabel("⛔ Stop Game")
        .setStyle("DANGER"),
    );

    const embed = new MessageEmbed()
      .setTitle("🎮 WordCore Survival Lobby")
      .setDescription(
        "Welcome to the word survival game!\n\n" +
          "📜 **Rules:**\n" +
          "• A **3-letter fragment** will be given.\n" +
          "• Submit an **English word** containing that fragment.\n" +
          "• You have **15 seconds** to reply.\n" +
          "• Everyone starts with ❤️❤️. Lose both = eliminated.\n\n" +
          "**Players Joined:**\n*None yet*",
      )
      .setColor("#00cc99")
      .setFooter("Only admins can start or stop the game.")
      .setThumbnail("https://cdn-icons-png.flaticon.com/512/3657/3657231.png");

    const msg = await interaction.reply({
      embeds: [embed],
      components: [row],
      fetchReply: true,
    });

    const collector = msg.createMessageComponentCollector({
      componentType: "BUTTON",
      time: 10 * 60 * 1000,
    });

    collector.on("collect", async (i) => {
      if (i.customId === "join_game") {
        if (!gameData.participants.has(i.user.id)) {
          gameData.participants.set(i.user.id, { user: i.user, hearts: 2 });
          const updatedList = [...gameData.participants.values()]
            .map((p) => `• <@${p.user.id}>`)
            .join("\n");

          const updatedEmbed = new MessageEmbed(embed).setDescription(
            embed.description.replace(
              /\*\*Players Joined:\*\*[\s\S]*/,
              `**Players Joined:**\n${updatedList}`,
            ),
          );
          return i.update({ embeds: [updatedEmbed], components: [row] });
        } else {
          return i.reply({
            content: "You've already joined!",
            ephemeral: true,
          });
        }
      }

      if (i.customId === "start_game") {
        if (!i.member.permissions.has("ADMINISTRATOR")) {
          return i.reply({
            content: "Only admins can start the game.",
            ephemeral: true,
          });
        }
        if (gameData.participants.size < 2) {
          return i.reply({
            content: "Not enough players! Need at least 2.",
            ephemeral: true,
          });
        }

        gameData.isRunning = true;
        i.update({ components: [] });
        startGame(gameData);
      }

      if (i.customId === "stop_game") {
        if (!i.member.permissions.has("ADMINISTRATOR")) {
          return i.reply({
            content: "Only admins can stop the game.",
            ephemeral: true,
          });
        }
        gameData.isRunning = false;
        gameData.currentTurnActive = false;
        collector.stop();
        return i.update({
          content: "🛑 Game was cancelled.",
          embeds: [],
          components: [],
        });
      }
    });

    async function startGame(gameData) {
      const validFragments = [
        "ing",
        "ion",
        "ent",
        "ate",
        "ous",
        "est",
        "ant",
        "ble",
        "ive",
        "ack",
        "ard",
        "ash",
        "ock",
        "ush",
        "ell",
        "all",
        "ore",
        "ish",
        "art",
        "ort",
        "phy",
        "tch",
        "ght",
        "ump",
        "unk",
        "ift",
        "urb",
        "amp",
        "ink",
        "umb",
        "ick",
        "odg",
        "erg",
        "urp",
        "yst",
        "mph",
        "rch",
        "sch",
        "nch",
        "whi",
        "ire",
        "age",
        "ory",
        "ure",
        "ary",
        "ern",
        "ine",
        "ace",
        "ice",
        "uce",
        "ade",
        "ude",
        "ide",
        "ode",
        "ain",
        "ean",
        "een",
        "oon",
        "own",
        "awn",
        "ear",
        "eer",
        "oor",
        "air",
        "eir",
        "our",
        "eal",
        "eil",
        "oil",
        "oul",
        "ame",
        "eme",
        "ime",
        "ome",
        "ume",
        "ane",
        "ene",
        "ine",
        "one",
        "une",
        "ape",
        "epe",
        "ipe",
        "ope",
        "upe",
        "ase",
        "ese",
        "ise",
        "ose",
        "use",
        "ave",
        "eve",
        "ive",
        "ove",
        "aze",
        "ize",
        "oze",
        "ath",
        "eth",
        "ith",
        "oth",
        "uth",
        "alm",
        "elm",
        "ilm",
        "olm",
        "ulm",
        "alk",
        "elk",
        "ilk",
        "olk",
        "arp",
        "erp",
        "irp",
        "orp",
        "urp",
        "asp",
        "esp",
        "isp",
        "osp",
        "usp",
        "arb",
        "erb",
        "irb",
        "orb",
        "urb",
        "arc",
        "erc",
        "irc",
        "orc",
        "urc",
        "aft",
        "eft",
        "ift",
        "oft",
        "uft",
        "ald",
        "eld",
        "ild",
        "old",
        "uld",
        "alf",
        "elf",
        "ilf",
        "olf",
        "ulf",
        "alp",
        "elp",
        "ilp",
        "olp",
        "ulp",
        "alt",
        "elt",
        "ilt",
        "olt",
        "ult",
        "ams",
        "ems",
        "ims",
        "oms",
        "ums",
        "aps",
        "eps",
        "ips",
        "ops",
        "ups",
        "ars",
        "ers",
        "irs",
        "ors",
        "urs",
        "ats",
        "ets",
        "its",
        "ots",
        "uts",
        "aws",
        "ews",
        "iws",
        "ows",
        "uws",
        "ays",
        "eys",
        "iys",
        "oys",
        "uys",
        "ter",
        "per",
        "ner",
        "der",
        "ker",
        "ber",
        "fer",
        "ger",
        "her",
        "jer",
        "ler",
        "mer",
        "ver",
        "wer",
        "and",
        "end",
        "ind",
        "ond",
        "und",
        "ank",
        "enk",
        "ink",
        "onk",
        "unk",
        "alk",
        "elk",
        "ilk",
        "olk",
        "ulk",
        "ard",
        "erd",
        "ird",
        "ord",
        "urd",
      ];

      let players = [...gameData.participants.values()];
      let currentPlayerIndex = 0;
      let roundNumber = 1;

      let gameState = {
        waitingForPlayer: null,
        currentFragment: null,
        turnInProgress: false,
        currentCollector: null,
      };

      async function processTurn() {
        try {
          if (gameState.turnInProgress || !gameData.isRunning) {
            return;
          }

          if (players.length <= 1) {
            if (players.length === 1) {
              await gameData.channel.send(
                `🏆 <@${players[0].user.id}> is the last one standing and WINS! 🎉`,
              );
            } else {
              await gameData.channel.send(
                `🎮 The game has ended with no survivors!`,
              );
            }
            gameData.isRunning = false;
            return;
          }

          if (currentPlayerIndex >= players.length) {
            currentPlayerIndex = 0;
          }

          const currentPlayer = players[currentPlayerIndex];
          if (!currentPlayer || !currentPlayer.user) {
            console.error("Invalid player, skipping turn");
            currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
            setTimeout(processTurn, 1000);
            return;
          }

          gameState.turnInProgress = true;
          gameState.waitingForPlayer = currentPlayer.user.id;
          gameState.currentFragment =
            validFragments[Math.floor(Math.random() * validFragments.length)];

          const maxHearts = 2;
          const currentHearts = Math.max(
            0,
            Math.min(maxHearts, currentPlayer.hearts || 0),
          );
          const lostHearts = maxHearts - currentHearts;
          const heartDisplay =
            "❤️ ".repeat(currentHearts) + "❌ ".repeat(lostHearts);
          const heartBar = `\`\`\`${heartDisplay}\`\`\``;

          const turnEmbed = new MessageEmbed()
            .setTitle(`🔤 Round ${roundNumber} - Your Turn!`)
            .setDescription(
              `🔤 Form a word that contains: **${gameState.currentFragment.toUpperCase()}**\n` +
                `⏱️ You have **15 seconds** to reply!\n\n` +
                `❤️ **Hearts Remaining:**\n${heartBar}\n\n` +
                `👥 **Players Left:** ${players.length}`,
            )
            .setColor("#FFD700")
            .setFooter({
              text: `Fragment: ${gameState.currentFragment.toUpperCase()} | Round ${roundNumber}`,
            });

          await gameData.channel.send({
            content: `<@${currentPlayer.user.id}> **YOUR TURN!** ⏰`,
            embeds: [turnEmbed],
          });

          const filter = (m) => {
            return (
              m.author.id === currentPlayer.user.id &&
              m.content.trim().length > 0 &&
              m.content.trim().length <= 30 &&
              !m.content.includes(" ") &&
              !m.content.includes("\n") &&
              /^[a-zA-Z]+$/.test(m.content.trim())
            );
          };

          const msgCollector = gameData.channel.createMessageCollector({
            filter,
            time: 15000,
          });

          gameState.currentCollector = msgCollector;
          let turnResolved = false;

          msgCollector.on("collect", async (msg) => {
            if (turnResolved || !gameState.turnInProgress) return;

            const word = msg.content.toLowerCase().trim();

            const fragment = gameState.currentFragment.toLowerCase();
            if (!word.includes(fragment)) {
              await gameData.channel.send(
                `❌ <@${currentPlayer.user.id}>, "${word}" must include **${gameState.currentFragment.toUpperCase()}**! Try again!`,
              );
              return;
            }

            if (word.length < 2) {
              await gameData.channel.send(
                `❌ <@${currentPlayer.user.id}>, "${word}" is too short to be a valid word! Try again!`,
              );
              return;
            }

            if (word.length > 25) {
              await gameData.channel.send(
                `❌ <@${currentPlayer.user.id}>, "${word}" is too long! Try a shorter word!`,
              );
              return;
            }

            let isValidWord = false;
            let apiError = null;

            try {
              console.log(`Checking word: ${word} for fragment: ${fragment}`);

              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 6000);

              const res = await fetch(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`,
                {
                  signal: controller.signal,
                  headers: {
                    "User-Agent": "WordCoreGame/1.0",
                  },
                },
              );

              clearTimeout(timeoutId);

              if (res.ok) {
                const data = await res.json();
                if (
                  data &&
                  Array.isArray(data) &&
                  data.length > 0 &&
                  data[0].word
                ) {
                  isValidWord = true;
                  console.log(`Word "${word}" validated successfully via API`);
                } else {
                  console.log(
                    `Word "${word}" - API returned unexpected format:`,
                    data,
                  );
                  apiError = "Unexpected API response format";
                }
              } else {
                console.log(
                  `Word "${word}" - API returned status: ${res.status}`,
                );
                apiError = `API returned status ${res.status}`;
              }
            } catch (error) {
              console.log(`Word "${word}" - API error:`, error.message);
              if (error.name === "AbortError") {
                apiError = "API timeout";
              } else {
                apiError = error.message;
              }
            }

            if (!isValidWord && apiError) {
              console.log(
                `API failed for "${word}", checking fallback list...`,
              );

              const commonWords = [
                "the",
                "and",
                "for",
                "are",
                "but",
                "not",
                "you",
                "all",
                "can",
                "had",
                "her",
                "was",
                "one",
                "our",
                "out",
                "day",
                "get",
                "has",
                "him",
                "his",
                "how",
                "man",
                "new",
                "now",
                "old",
                "see",
                "two",
                "way",
                "who",
                "boy",
                "did",
                "its",
                "let",
                "put",
                "say",
                "she",
                "too",
                "use",
                "cat",
                "dog",
                "run",
                "sit",
                "big",
                "red",
                "hot",
                "cold",
                "good",
                "bad",
                "fast",
                "slow",
                "high",
                "low",
                "long",
                "short",
                "happy",
                "sad",
                "angry",
                "calm",
                "bright",
                "dark",
                "clean",
                "dirty",
                "easy",
                "hard",
                "soft",
                "loud",
                "quiet",
                "strong",
                "weak",
                "young",
                "old",
                "rich",
                "poor",
                "book",
                "car",
                "door",
                "house",
                "tree",
                "water",
                "fire",
                "earth",
                "air",
                "sun",
                "moon",
                "star",
                "light",
                "dark",
                "food",
                "money",
                "time",
                "work",
                "play",
                "love",
                "hate",
                "hope",
                "fear",
                "dream",
                "sleep",
                "wake",
                "walk",
                "talk",
                "sing",
                "dance",
                "laugh",
                "cry",
                "smile",
                "frown",
                "computer",
                "phone",
                "internet",
                "game",
                "music",
                "movie",
                "school",
                "teacher",
                "student",
                "friend",
                "family",
                "mother",
                "father",
                "sister",
                "brother",
                "child",
                "baby",
                "adult",
                "person",
                "people",
                "city",
                "country",
                "world",
                "space",
                "science",
                "technology",
                "engineering",
              ];

              if (commonWords.includes(word)) {
                isValidWord = true;
                console.log(
                  `Word "${word}" validated via fallback common words list`,
                );
              }
            }

            if (!isValidWord && apiError === "API timeout") {
              await gameData.channel.send(
                `⏱️ <@${currentPlayer.user.id}>, dictionary check timed out for "${word}". Try a different word!`,
              );
              return;
            }

            if (
              !isValidWord &&
              apiError &&
              !apiError.includes("404") &&
              !apiError.includes("status 404")
            ) {
              await gameData.channel.send(
                `🔧 <@${currentPlayer.user.id}>, dictionary service temporarily unavailable. Try "${word}" again or use a different word!`,
              );
              return;
            }

            if (isValidWord) {
              if (turnResolved) return;

              turnResolved = true;
              gameState.turnInProgress = false;

              msgCollector.stop("word_found_success");

              await gameData.channel.send(
                `✅ <@${currentPlayer.user.id}> survives with "${word}"!`,
              );

              currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
              roundNumber++;

              setTimeout(() => {
                if (gameData.isRunning) {
                  processTurn();
                }
              }, 2000);
            } else {
              await gameData.channel.send(
                `❌ <@${currentPlayer.user.id}>, "${word}" is not a valid English word. Try again!`,
              );
              return;
            }
          });

          msgCollector.on("end", async (collected, reason) => {
            if (turnResolved) {
              console.log(
                `Turn already resolved, ignoring end event. Reason: ${reason}`,
              );
              return;
            }

            if (reason === "word_found_success") {
              console.log(
                "Collector stopped due to successful word, ignoring end event",
              );
              return;
            }

            if (!gameState.turnInProgress) {
              console.log("Turn not in progress, ignoring end event");
              return;
            }

            console.log(
              `Processing timeout for player ${currentPlayer.user.id}, reason: ${reason}`,
            );

            turnResolved = true;
            gameState.turnInProgress = false;

            currentPlayer.hearts = Math.max(0, (currentPlayer.hearts || 2) - 1);
            await gameData.channel.send(
              `⌛ <@${currentPlayer.user.id}> ran out of time and lost a heart!`,
            );

            if (currentPlayer.hearts <= 0) {
              await gameData.channel.send(
                `💀 <@${currentPlayer.user.id}> has been eliminated from the game!`,
              );

              const playerIndex = players.findIndex(
                (p) => p && p.user && p.user.id === currentPlayer.user.id,
              );
              if (playerIndex !== -1) {
                players.splice(playerIndex, 1);

                if (
                  currentPlayerIndex >= players.length &&
                  players.length > 0
                ) {
                  currentPlayerIndex = 0;
                } else if (currentPlayerIndex > playerIndex) {
                  currentPlayerIndex--;
                }
              }
            } else {
              currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
            }

            roundNumber++;

            setTimeout(() => {
              if (gameData.isRunning && players.length > 0) {
                processTurn();
              }
            }, 2000);
          });
        } catch (error) {
          console.error("Error in processTurn:", error);
          gameState.turnInProgress = false;
          gameData.isRunning = false;
          await gameData.channel.send("❌ Game error occurred. Game stopped.");
        }
      }

      await gameData.channel.send(
        `🎮 **WordCore Survival begins!** ${players.length} players entered the arena!\n\n🔥 **May the best wordsmith survive!** 🔥`,
      );

      setTimeout(() => {
        if (gameData.isRunning) {
          processTurn();
        }
      }, 2000);
    }
  } else if (commandName === "mute") {
    const member = interaction.options.getMember("target");
    const durationInput = interaction.options.getString("duration");

    if (
      !interaction.member.permissions.has(Permissions.FLAGS.MODERATE_MEMBERS)
    ) {
      return interaction.reply({
        content: "You do not have permission to mute users.",
        ephemeral: true,
      });
    }

    function parseDuration(input) {
      const match = input.match(/^(\d+)([smh])$/);
      if (!match) return null;

      const value = parseInt(match[1]);
      const unit = match[2];

      switch (unit) {
        case "s":
          return value * 1000;
        case "m":
          return value * 60 * 1000;
        case "h":
          return value * 60 * 60 * 1000;
        default:
          return null;
      }
    }

    const durationMs = parseDuration(durationInput.toLowerCase());

    if (!durationMs) {
      return interaction.reply({
        content: "Invalid duration format. Use formats like: 30s, 10m, 2h",
        ephemeral: true,
      });
    }

    const maxTimeout = 28 * 24 * 60 * 60 * 1000;
    if (durationMs > maxTimeout) {
      return interaction.reply({
        content: "Duration cannot exceed 28 days (Discord's maximum).",
        ephemeral: true,
      });
    }

    if (durationMs < 1000) {
      return interaction.reply({
        content: "Duration must be at least 1 second.",
        ephemeral: true,
      });
    }

    try {
      await member.timeout(durationMs);

      let displayDuration;
      if (durationMs < 60000) {
        displayDuration = `${durationMs / 1000} second(s)`;
      } else if (durationMs < 3600000) {
        displayDuration = `${durationMs / 60000} minute(s)`;
      } else {
        displayDuration = `${durationMs / 3600000} hour(s)`;
      }

      await interaction.reply(
        `${member.user.tag} has been muted for ${displayDuration}.`,
      );
    } catch (error) {
      await interaction.reply({
        content:
          "I don't have permission to timeout this user. Make sure I have the 'Moderate Members' permission and my role is higher than the target user's highest role.",
        ephemeral: true,
      });
    }
  } else if (commandName === "ship") {
    const user1 = interaction.options.getUser("user1");
    const user2 = interaction.options.getUser("user2");

    if (user1.id === user2.id) {
      return interaction.reply(
        "🚫 You can't ship someone with themselves... or can you? 👀",
      );
    }

    const score = Math.floor(Math.random() * 101);
    const loveBar =
      "█".repeat(score / 10) + "░".repeat(10 - Math.floor(score / 10));

    const shipName = (
      user1.username.slice(0, Math.ceil(user1.username.length / 2)) +
      user2.username.slice(Math.floor(user2.username.length / 2))
    ).toLowerCase();

    let message = "";
    if (score > 90) message = "💍 Wedding bells soon?";
    else if (score > 75) message = "😍 Sparks are flying!";
    else if (score > 50) message = "😊 There's something here...";
    else if (score > 25) message = "😐 Just friends... for now.";
    else message = "🚫 Um. Yeah, this is a hard pass.";

    const gifs = [
      "https://media1.tenor.com/m/LeG6BgV5ZPEAAAAd/hachioji-naoto-naoto.gif",
      "https://media1.tenor.com/m/1ne0nfJrA9MAAAAd/anime-anime-blush.gif",
      "https://media1.tenor.com/m/rI5Jgr2lQesAAAAd/rikekoi-anime-blush.gif",
      "https://media1.tenor.com/m/G9MD-V9y4XcAAAAd/anime-roshidere.gif",
      "https://media1.tenor.com/m/lkj1vfUtUggAAAAd/when-supernatural-battles-became-commonplace-embarrassed.gif",
      "https://media1.tenor.com/m/hYpq25r8eywAAAAd/cat-anime.gif",
    ];
    const randomGif = gifs[Math.floor(Math.random() * gifs.length)];

    const embed = {
      title: `💞 Match Maker 3000 💞`,
      description:
        `**${user1.username}** ❤️ **${user2.username}**\n\n` +
        `**Ship Name:** \`${shipName}\`\n` +
        `**Compatibility:** \`${score}%\`\n` +
        `\`\`\`${loveBar}\`\`\`\n${message}`,
      thumbnail: { url: user1.displayAvatarURL({ dynamic: true }) },
      image: { url: randomGif },
      color: 0xff69b4,
      footer: { text: "Made by Enigma's LoveBot 💘" },
    };

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "unmute") {
    const member = interaction.options.getMember("target");
    if (
      !interaction.member.permissions.has(Permissions.FLAGS.MODERATE_MEMBERS)
    ) {
      return interaction.reply({
        content: "You do not have permission to unmute users.",
        ephemeral: true,
      });
    }
    await member.timeout(null);
    await interaction.reply(`${member.user.tag} has been unmuted.`);
  } else if (commandName === "warn") {
    const user = interaction.options.getUser("target");
    const reason = interaction.options.getString("reason");
    if (
      !interaction.member.permissions.has(Permissions.FLAGS.MODERATE_MEMBERS)
    ) {
      return interaction.reply({
        content: "You do not have permission to warn users.",
        ephemeral: true,
      });
    }
    await interaction.reply(`${user.tag} has been warned. Reason: ${reason}`);
  } else if (commandName === "purge") {
    const amount = interaction.options.getInteger("amount");
    if (
      !interaction.member.permissions.has(Permissions.FLAGS.MANAGE_MESSAGES)
    ) {
      return interaction.reply({
        content: "You do not have permission to delete messages.",
        ephemeral: true,
      });
    }
    if (amount < 1 || amount > 100) {
      return interaction.reply({
        content: "Amount must be between 1 and 100.",
        ephemeral: true,
      });
    }
    await interaction.channel.bulkDelete(amount, true);
    await interaction.reply({
      content: `Deleted ${amount} messages.`,
      ephemeral: true,
    });
  } else if (commandName === "calculate") {
    const expression = interaction.options.getString("expression");

    try {
      const result = math.evaluate(expression);

      const embed = new MessageEmbed()
        .setTitle("🧮 Calculator")
        .addField("📥 Expression", `\`\`\`${expression}\`\`\``)
        .addField("📤 Result", `\`\`\`${result}\`\`\``)
        .setColor("#00B386")
        .setFooter(
          `Requested by ${interaction.user.username}`,
          interaction.user.displayAvatarURL({ dynamic: true }),
        );

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: "❌ Invalid math expression. Please try again.",
        ephemeral: true,
      });
    }
  } else if (commandName === "serverinfo") {
    const { guild } = interaction;

    const createdAt = `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`;
    const iconURL = guild.iconURL({ dynamic: true, size: 1024 });

    const embed = {
      title: `🎓 Welcome to ${guild.name}`,
      description: `This server was made with the intention of serving the Batch of '25 prior to your next big step - college life. Here, you can take this platform to strengthen your ties with your upcoming student community at Mahindra University, discuss and get the latest updates on college, meet and talk to your seniors.\n\u200B`,
      color: 0xd01c28,
      thumbnail: { url: iconURL },
      fields: [
        {
          name: "👑 Owner",
          value: `<@${guild.ownerId}>`,
          inline: true,
        },
        {
          name: "📅 Created On",
          value: createdAt,
          inline: true,
        },
        {
          name: "👥 Total Members",
          value: `${guild.memberCount.toLocaleString()}`,
          inline: true,
        },
        {
          name: "🤖 Bots",
          value: `16`,
          inline: true,
        },
        {
          name: "💬 Channels",
          value: `${guild.channels.cache.size}`,
          inline: true,
        },
        {
          name: "🔒 Roles",
          value: `${guild.roles.cache.size}`,
          inline: true,
        },
        {
          name: "🚀 Boost Level",
          value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount || 0} boosts)`,
          inline: true,
        },
      ],
      image: {
        url: "https://i.postimg.cc/xdRL8FpS/freshersatmu.png",
      },
      footer: {
        text: `Mahindra University Discord | Requested by ${interaction.user.username}`,
        icon_url: interaction.user.displayAvatarURL({ dynamic: true }),
      },
    };

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "quote") {
    const quoteText = interaction.options.getString("text");
    const author =
      interaction.options.getString("author") || interaction.user.username;

    const theme = getThemeColors("dark");
    const formattedText = formatQuoteText(
      quoteText,
      author,
      interaction.user.username,
    );

    const embed = new MessageEmbed()
      .setTitle(`${theme.accent} Quote`)
      .setDescription(formattedText)
      .setColor(theme.color)
      .setThumbnail(
        interaction.user.displayAvatarURL({ dynamic: true, size: 256 }),
      )
      .setFooter({
        text: `Quote by ${author}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
      })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "quotestyle") {
    const quoteText = interaction.options.getString("text");
    const author =
      interaction.options.getString("author") || interaction.user.username;
    const themeChoice = interaction.options.getString("theme") || "dark";

    const theme = getThemeColors(themeChoice);
    const formattedText = formatQuoteText(
      quoteText,
      author,
      interaction.user.username,
    );

    const embed = new MessageEmbed()
      .setTitle(
        `${theme.accent} ${themeChoice.charAt(0).toUpperCase() + themeChoice.slice(1)} Quote`,
      )
      .setDescription(formattedText)
      .setColor(theme.color)
      .setThumbnail(
        interaction.user.displayAvatarURL({ dynamic: true, size: 256 }),
      )
      .setFooter({
        text: `${themeChoice.charAt(0).toUpperCase() + themeChoice.slice(1)} themed quote by ${author}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
      })
      .setTimestamp();

    if (themeChoice === "gradient") {
      embed.setImage("https://i.imgur.com/rainbow_line.gif"); // Optional: add a rainbow line
    }

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "userinfo") {
    const user = interaction.options.getUser("target") || interaction.user;
    const member = interaction.guild.members.cache.get(user.id);

    const roles =
      member.roles.cache
        .filter((role) => role.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((role) => `<@&${role.id}>`)
        .slice(0, 15)
        .join(" • ") || "None";

    // Get key permissions
    const keyPerms = [];
    if (member.permissions.has("ADMINISTRATOR")) keyPerms.push("Administrator");
    if (member.permissions.has("MANAGE_GUILD")) keyPerms.push("Manage Server");
    if (member.permissions.has("BAN_MEMBERS")) keyPerms.push("Ban Members");
    if (member.permissions.has("KICK_MEMBERS")) keyPerms.push("Kick Members");

    const embed = new MessageEmbed()
      .setAuthor(user.tag, user.displayAvatarURL({ dynamic: true }))
      .setTitle("ℹ️ User Info")
      .setColor("#D01C28") // Mahindra red
      .setThumbnail(user.displayAvatarURL({ dynamic: true }))
      .setDescription(
        `**User ID:** \`${user.id}\`\n` +
          `**Created:** ${moment(user.createdAt).format("DD MMMM YYYY")} (${moment(user.createdAt).fromNow()})\n` +
          `**Joined:** ${moment(member.joinedAt).format("DD MMMM YYYY")} (${moment(member.joinedAt).fromNow()})`,
      )
      .addField(`📛 ${member.roles.cache.size} Roles`, roles, false)
      .addField(
        `\n🟢 Key Permissions`,
        keyPerms.length > 0 ? keyPerms.join(", ") : "None",
        false,
      )
      .setFooter(
        `Mahindra University Discord | Requested by ${interaction.user.username}`,
        interaction.user.displayAvatarURL({ dynamic: true }),
      );

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "avatar") {
    const user = interaction.options.getUser("user") || interaction.user;
    const embed = new MessageEmbed()
      .setTitle(`${user.username}'s Avatar`)
      .setColor(0x00ae86)
      .setImage(user.displayAvatarURL({ dynamic: true, size: 512 }));
    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "blacklistchannel") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "You do not have permission to manage XP blacklist.",
        ephemeral: true,
      });
    }

    const channel = interaction.options.getChannel("channel");

    // Get existing blacklisted channels
    const blacklist =
      (await db.get(`xp_blacklist.${interaction.guild.id}`)) || [];

    // Check if channel is already blacklisted
    if (blacklist.includes(channel.id)) {
      return interaction.reply({
        content: `${channel} is already blacklisted from XP gain.`,
        ephemeral: true,
      });
    }

    // Add channel to blacklist
    blacklist.push(channel.id);
    await db.set(`xp_blacklist.${interaction.guild.id}`, blacklist);

    const embed = new MessageEmbed()
      .setTitle("🚫 Channel Blacklisted")
      .setDescription(`${channel} has been blacklisted from XP gain.`)
      .setColor("#FF6B6B")
      .setFooter({ text: "Mahindra University | XP Management" })
      .setTimestamp();

    interaction.reply({ embeds: [embed] });
  } else if (commandName === "removeblacklist") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "You do not have permission to manage XP blacklist.",
        ephemeral: true,
      });
    }

    const channel = interaction.options.getChannel("channel");

    // Get existing blacklisted channels
    const blacklist =
      (await db.get(`xp_blacklist.${interaction.guild.id}`)) || [];

    // Check if channel is in blacklist
    if (!blacklist.includes(channel.id)) {
      return interaction.reply({
        content: `${channel} is not currently blacklisted.`,
        ephemeral: true,
      });
    }

    // Remove channel from blacklist
    const updatedBlacklist = blacklist.filter(
      (channelId) => channelId !== channel.id,
    );
    await db.set(`xp_blacklist.${interaction.guild.id}`, updatedBlacklist);

    const embed = new MessageEmbed()
      .setTitle("✅ Channel Removed from Blacklist")
      .setDescription(`${channel} has been removed from the XP blacklist.`)
      .setColor("#4ECDC4")
      .setFooter({ text: "Mahindra University | XP Management" })
      .setTimestamp();

    interaction.reply({ embeds: [embed] });
  } else if (commandName === "listblacklist") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
      return interaction.reply({
        content: "You do not have permission to view XP blacklist.",
        ephemeral: true,
      });
    }

    const blacklist =
      (await db.get(`xp_blacklist.${interaction.guild.id}`)) || [];

    if (blacklist.length === 0) {
      return interaction.reply({
        content: "📋 No channels are currently blacklisted from XP gain.",
        ephemeral: true,
      });
    }

    // Get channel mentions for display
    const channelList = blacklist
      .map((channelId) => {
        const channel = interaction.guild.channels.cache.get(channelId);
        return channel ? `• ${channel}` : `• Unknown Channel (${channelId})`;
      })
      .join("\n");

    const embed = new MessageEmbed()
      .setTitle("🚫 Blacklisted Channels")
      .setDescription(`**Channels excluded from XP gain:**\n\n${channelList}`)
      .setColor("#FFE66D")
      .setFooter({
        text: `Mahindra University | ${blacklist.length} blacklisted channels`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
      })
      .setTimestamp();

    interaction.reply({ embeds: [embed] });
  } else if (commandName === "membercount") {
    await interaction.deferReply(); // ⏳ useful if fetching takes time

    // fetch all members from the server
    await interaction.guild.members.fetch(); // ensures full cache

    const totalMembers = interaction.guild.memberCount;
    const members = interaction.guild.members.cache;

    const botCount = members.filter((member) => member.user.bot).size;
    const humanCount = members.filter((member) => !member.user.bot).size;

    const embed = new MessageEmbed()
      .setTitle("📊 Server Member Stats")
      .setColor("#D01C28")
      .addField("👥 Total Members", `${totalMembers}`, true)
      .addField("🧍 Humans", `${humanCount}`, true)
      .addField("🤖 Bots", `${botCount}`, true)
      .setFooter(
        `Mahindra University Discord | Requested by ${interaction.user.username}`,
        interaction.user.displayAvatarURL({ dynamic: true }),
      );

    await interaction.editReply({ embeds: [embed] });
  } else if (commandName === "meme") {
    try {
      const res = await fetch("https://meme-api.com/gimme");
      const data = await res.json();
      const embed = new MessageEmbed()
        .setTitle(data.title)
        .setColor(0x00ae86)
        .setImage(data.url)
        .setFooter({ text: `👍 ${data.ups} upvotes` });
      await interaction.reply({ embeds: [embed] });
    } catch {
      await interaction.reply({
        content: "Failed to fetch meme. Try again later!",
        ephemeral: true,
      });
    }
  } else if (commandName === "mcmeme") {
    try {
      const res = await fetch("https://meme-api.com/gimme/Minecraft");
      const data = await res.json();
      const embed = new MessageEmbed()
        .setTitle(data.title)
        .setColor(0x00ae86)
        .setImage(data.url)
        .setFooter({ text: `👍 ${data.ups} upvotes` });
      await interaction.reply({ embeds: [embed] });
    } catch {
      await interaction.reply({
        content: "Failed to fetch Minecraft meme. Try again later!",
        ephemeral: true,
      });
    }
  } else if (commandName === "hotrate") {
    const target = interaction.options.getUser("target") || interaction.user;
    const hotness = Math.floor(Math.random() * 101); // 0 - 100%

    let comment = "You're... unique 😅";

    if (hotness > 90) comment = "You're basically the sun ☀️🔥";
    else if (hotness > 75) comment = "Model-level vibes 😎";
    else if (hotness > 60) comment = "You’re definitely warm 😉";
    else if (hotness > 40) comment = "Mildly microwaved 🧊➡️🔥";
    else if (hotness > 20) comment = "Like tea left out for 2 hours 😬";
    else comment = "You might need some extra seasoning 🧂";

    const embed = new MessageEmbed()
      .setTitle("🔥 Hotness Scanner")
      .setDescription(`${target} is **${hotness}% hot!**\n\n${comment}`)
      .setThumbnail(target.displayAvatarURL({ dynamic: true }))
      .setColor("#FF6F61")
      .setFooter(
        `Mahindra University Discord | Hot-o-meter`,
        interaction.user.displayAvatarURL({ dynamic: true }),
      );

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "joke") {
    try {
      const res = await fetch(
        "https://official-joke-api.appspot.com/jokes/random",
      );
      const data = await res.json();
      await interaction.reply(`${data.setup}\n\n||${data.punchline}||`);
    } catch {
      await interaction.reply({
        content: "Failed to fetch joke. Try again later!",
        ephemeral: true,
      });
    }
  } else if (commandName === "say") {
    const msg = interaction.options.getString("text");
    await interaction.reply(msg);
  } else if (commandName === "flip") {
    const flip = Math.random() < 0.5 ? "Heads" : "Tails";
    await interaction.reply(`🪙 You flipped: **${flip}**`);
  } else if (commandName === "rps") {
    const choices = ["🪨 Rock", "📄 Paper", "✂️ Scissors"];
    const botChoice = choices[Math.floor(Math.random() * choices.length)];

    const embed = new MessageEmbed()
      .setTitle("🎮 Rock Paper Scissors")
      .setDescription("Click a button below to make your move!")
      .setColor("#D01C28");

    const row = new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId("rock")
        .setLabel("🪨 Rock")
        .setStyle("PRIMARY"),
      new MessageButton()
        .setCustomId("paper")
        .setLabel("📄 Paper")
        .setStyle("SUCCESS"),
      new MessageButton()
        .setCustomId("scissors")
        .setLabel("✂️ Scissors")
        .setStyle("DANGER"),
    );

    const message = await interaction.reply({
      embeds: [embed],
      components: [row],
      fetchReply: true,
    });

    const filter = (i) => i.user.id === interaction.user.id;
    const collector = message.createMessageComponentCollector({
      filter,
      time: 15000,
      max: 1,
    });

    collector.on("collect", async (i) => {
      const userChoice =
        i.customId === "rock"
          ? "🪨 Rock"
          : i.customId === "paper"
            ? "📄 Paper"
            : "✂️ Scissors";

      let result = "";

      if (userChoice === botChoice) {
        result = "It's a draw!";
      } else if (
        (userChoice === "🪨 Rock" && botChoice === "✂️ Scissors") ||
        (userChoice === "📄 Paper" && botChoice === "🪨 Rock") ||
        (userChoice === "✂️ Scissors" && botChoice === "📄 Paper")
      ) {
        result = "🎉 You win!";
      } else {
        result = "💀 You lost!";
      }

      const resultEmbed = new MessageEmbed()
        .setTitle("🎮 Rock Paper Scissors - Results")
        .addField("Your Choice", userChoice, true)
        .addField("Bot's Choice", botChoice, true)
        .addField("Result", result)
        .setColor(
          result.includes("win")
            ? "#57F287"
            : result.includes("draw")
              ? "#5865F2"
              : "#ED4245",
        )
        .setFooter(
          `Mahindra University Discord | Requested by ${interaction.user.username}`,
          interaction.user.displayAvatarURL({ dynamic: true }),
        );

      await i.update({
        embeds: [resultEmbed],
        components: [],
      });
    });

    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        const timeoutEmbed = new MessageEmbed()
          .setTitle("⏰ Time's Up!")
          .setDescription("You didn't make a choice in time.")
          .setColor("#FFCC00");

        await interaction.editReply({
          embeds: [timeoutEmbed],
          components: [],
        });
      }
    });
  } else if (commandName === "8ball") {
    const question = interaction.options.getString("question");

    const responses = [
      "Yes, definitely!",
      "No chance.",
      "Ask again later.",
      "It is certain.",
      "Doubtful.",
      "Absolutely!",
      "Better not tell you now...",
      "Outlook not so good.",
      "Without a doubt.",
      "Signs point to yes.",
      "Very unlikely.",
      "You may rely on it.",
      "Cannot predict now.",
      "Focus and ask again.",
      "Sure, why not!",
      "That's a mystery even to me.",
    ];

    const randomAnswer =
      responses[Math.floor(Math.random() * responses.length)];

    const embed = new MessageEmbed()
      .setTitle("🎱 The Magic 8-Ball Has Spoken")
      .setColor("#8A2BE2")
      .addField("❓ Your Question", question, false)
      .addField("💬 My Answer", randomAnswer, false)
      .setFooter(
        `Asked by ${interaction.user.username}`,
        interaction.user.displayAvatarURL({ dynamic: true }),
      );

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "wholesome") {
    const wholesomeMessages = [
      "You're doing so much better than you think you are. Take a deep breath — you've got this. 💖",
      "No matter how tough things get, you're tougher. And you're never alone here. 🌟",
      "You're a light in someone’s life, even if you don’t see it yet. Shine on! ✨",
      "Take a moment to smile today. You deserve happiness just for being you. 😊",
      "You're enough. Right now. Just as you are. And you always have been. 💫",
      "The world is better with you in it — don’t ever forget that. ❤️",
      "Every step you take, no matter how small, is still progress. Be proud of yourself. 🌱",
      "If no one told you today: You are appreciated, loved, and absolutely amazing. 🌈",
      "Your kindness ripples further than you realize. Keep being you. 💕",
      "Good days, bad days — you're still worthy, you're still growing, and you're still loved. 🌻",
    ];

    const randomMessage =
      wholesomeMessages[Math.floor(Math.random() * wholesomeMessages.length)];

    const embed = new MessageEmbed()
      .setTitle("🌸 A Wholesome Thought")
      .setDescription(randomMessage)
      .setColor("#FFC0CB") // Soft pink
      .setFooter(
        `Mahindra University Discord | From MU Bot 💌`,
        interaction.client.user.displayAvatarURL({ dynamic: true }),
      );

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "kill") {
    const target = interaction.options.getUser("target");

    if (!target) {
      return interaction.reply({
        content: "You need to mention someone to kill!",
        ephemeral: true,
      });
    }

    if (target.id === interaction.user.id) {
      return interaction.reply({
        content: "You can't kill yourself... that'd be messy 😵",
        ephemeral: true,
      });
    }

    const killer = interaction.user.username;
    const victim = `<@${target.id}>`;

    const killScenarios = [
      `${killer} challenged ${victim} to a pillow fight, but replaced their pillow with a brick. 🧱`,
      `${killer} pushed ${victim} into a Minecraft ravine... without a water bucket. 💀`,
      `${killer} told ${victim} to press Alt+F4 for free Nitro. They exploded instead. 🎇`,
      `${killer} dropped an entire bookshelf on ${victim} while they were reading “How to Survive Anything.” 📚`,
      `${killer} beat ${victim} in Uno so badly, their soul disconnected. 🃏`,
      `${killer} told ${victim} that anime is cringe. A weeb battalion dealt the rest. ⚔️`,
      `${killer} baked a cake for ${victim}… with C4 frosting. 🎂💣`,
      `${killer} used a flip-flop with *critical hit damage* on ${victim}. 👡⚡`,
      `${killer} challenged ${victim} to a dance-off. The cringe was fatal. 🕺💀`,
      `${killer} rigged ${victim}’s chair with a rocket. They're in orbit now. 🚀🌕`,
      `${killer} swapped ${victim}’s coffee with lava. ☕🔥`,
      `${killer} whispered “Ratio + L” and ${victim} immediately vanished from existence. 💀`,
      `${killer} offered ${victim} free WiFi… in a pit of spikes. 📶🪓`,
      `${killer} programmed a bot that only targets ${victim}. It did its job well. 🤖🔪`,
      `${killer} convinced ${victim} to touch grass… it was poisoned. 🍃💀`,
    ];

    const scenario =
      killScenarios[Math.floor(Math.random() * killScenarios.length)];

    const embed = new MessageEmbed()
      .setTitle("💀 MURDER MOST FOUL 💀")
      .setDescription(`**${scenario}**`)
      .setColor("#ED4245") // Discord red
      .setThumbnail(target.displayAvatarURL({ dynamic: true }))
      .setFooter(
        `Mahindra University Discord | Executed by ${killer}`,
        interaction.user.displayAvatarURL({ dynamic: true }),
      );

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === "rules") {
    const rulesEmbed = new MessageEmbed()
      .setTitle("📜 Server Rules & Philosophy")
      .setColor("#d01c28")
      .setDescription(
        `
  **General Philosophy**
  This server was made for the Batch of **2025** to connect before stepping into college life. Use this space to:
  • Make friends and bond with future classmates  
  • Get updates, tips, and insights about Mahindra University  
  • Ask seniors about academics, hostel life, and more  
  • Explore fun and useful server features!

  Walk into college with excitement, not confusion.

  ---

  **📖 Rules**  
  *"Learn your rules, you better learn your rules. If you don't, you'll be eaten in your sleep ARRCH."*  
  — *Dwight Schrute, The Office*

  **1. Be Respectful**  
  Treat everyone with respect. No bullying, harassment, or offensive behavior.

  **2. No Discrimination**  
  Hate speech or discrimination of any kind will not be tolerated.

  **3. Keep It Safe**  
  Don't share private info like phone numbers, passwords, or addresses.

  **4. No Spam or Self-Promo**  
  Avoid flooding chats or promoting outside content without approval.

  **5. Respect Privacy**  
  No sharing screenshots or messages without permission.

  **6. Use Proper Channels**  
  Stick to topic-specific channels to keep discussions clean.

  **7. No NSFW Content**  
  This is a student space. Keep it appropriate.  
  Yes, the NSFW channel is a *joke*. Don't get whoosh'd.

  **8. Listen to Mods**  
  Moderators are here to help. Please follow their instructions.

  **9. Report Issues**  
  See something wrong? DM a mod privately. Avoid public drama.

  **10. No Trolling or Flaming**  
  Don’t provoke fights or post to get a reaction.

  **11. English Only**  
  To include everyone, keep all chats in English.

  **12. Drop Feedback**  
  Have ideas to improve the server? Use the ⁠#server-feedback channel or DM the team.

  **13. Have Fun!**  
  Meet new people, ask questions, and enjoy this community! Cheers to the batch of 2025!

  — With 0b 01101100 01101111 01110110 01100101 ❤️  
  **Team Enigma**
      `,
      )
      .setImage("https://i.postimg.cc/xdRL8FpS/freshersatmu.png");

    interaction.reply({ embeds: [rulesEmbed], ephemeral: false });
  } else if (commandName === "rulesdm") {
    const rulesEmbed = new MessageEmbed()
      .setTitle("📜 Server Rules & Philosophy")
      .setColor("#d01c28")
      .setDescription(
        `
  **General Philosophy**
  This server was made for the Batch of **2025** to connect before stepping into college life. Use this space to:
  • Make friends and bond with future classmates  
  • Get updates, tips, and insights about Mahindra University  
  • Ask seniors about academics, hostel life, and more  
  • Explore fun and useful server features!

  Walk into college with excitement, not confusion.

  ---

  **📖 Rules**  
  *"Learn your rules, you better learn your rules. If you don't, you'll be eaten in your sleep ARRCH."*  
  — *Dwight Schrute, The Office*

  **1. Be Respectful**  
  Treat everyone with respect. No bullying, harassment, or offensive behavior.

  **2. No Discrimination**  
  Hate speech or discrimination of any kind will not be tolerated.

  **3. Keep It Safe**  
  Don't share private info like phone numbers, passwords, or addresses.

  **4. No Spam or Self-Promo**  
  Avoid flooding chats or promoting outside content without approval.

  **5. Respect Privacy**  
  No sharing screenshots or messages without permission.

  **6. Use Proper Channels**  
  Stick to topic-specific channels to keep discussions clean.

  **7. No NSFW Content**  
  This is a student space. Keep it appropriate.  
  Yes, the NSFW channel is a *joke*. Don't get whoosh'd.

  **8. Listen to Mods**  
  Moderators are here to help. Please follow their instructions.

  **9. Report Issues**  
  See something wrong? DM a mod privately. Avoid public drama.

  **10. No Trolling or Flaming**  
  Don’t provoke fights or post to get a reaction.

  **11. English Only**  
  To include everyone, keep all chats in English.

  **12. Drop Feedback**  
  Have ideas to improve the server? Use the ⁠#server-feedback channel or DM the team.

  **13. Have Fun!**  
  Meet new people, ask questions, and enjoy this community! Cheers to the batch of 2025!

  — With 0b 01101100 01101111 01110110 01100101 ❤️  
  **Team Enigma**
      `,
      )
      .setImage("https://i.postimg.cc/xdRL8FpS/freshersatmu.png");

    try {
      await interaction.user.send({ embeds: [rulesEmbed] });
      await interaction.reply({
        content: "✅ Rules have been sent to your DM!",
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content:
          "❌ I couldn’t send you a DM. Please make sure your DMs are open.",
        ephemeral: true,
      });
    }
  } else if (commandName === "addautorole") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_ROLES)) {
      return interaction.reply({
        content: "You do not have permission to manage autoroles.",
        ephemeral: true,
      });
    }

    const role = interaction.options.getRole("role");

    // Get existing autoroles
    const autoroles = (await db.get(`autoroles.${interaction.guild.id}`)) || [];

    // Check if role is already in autoroles
    if (autoroles.includes(role.id)) {
      return interaction.reply({
        content: `**${role.name}** is already an autorole.`,
        ephemeral: true,
      });
    }

    // Add role to autoroles
    autoroles.push(role.id);
    await db.set(`autoroles.${interaction.guild.id}`, autoroles);

    interaction.reply(`✅ **${role.name}** has been added to autoroles.`);
  } else if (commandName === "removeautorole") {
    if (!interaction.member.permissions.has(Permissions.FLAGS.MANAGE_ROLES)) {
      return interaction.reply({
        content: "You do not have permission to manage autoroles.",
        ephemeral: true,
      });
    }

    const role = interaction.options.getRole("role");

    // Get existing autoroles
    const autoroles = (await db.get(`autoroles.${interaction.guild.id}`)) || [];

    // Check if role is in autoroles
    if (!autoroles.includes(role.id)) {
      return interaction.reply({
        content: `**${role.name}** is not an autorole.`,
        ephemeral: true,
      });
    }

    // Remove role from autoroles
    const updatedAutoroles = autoroles.filter((roleId) => roleId !== role.id);
    await db.set(`autoroles.${interaction.guild.id}`, updatedAutoroles);

    interaction.reply(`✅ **${role.name}** has been removed from autoroles.`);
  }
});

// XP System - messageCreate handler
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || message.system) return;

  const userId = message.author.id;
  const guildId = message.guild.id;
  const key = `${guildId}-${userId}`;

  // CHECK IF CHANNEL IS BLACKLISTED - NEW CODE
  const blacklist = (await db.get(`xp_blacklist.${guildId}`)) || [];
  if (blacklist.includes(message.channel.id)) {
    return; // Skip XP gain for blacklisted channels
  }

  // Cooldown logic (existing code)
  if (
    userCooldowns.has(key) &&
    Date.now() - userCooldowns.get(key) < XP_COOLDOWN
  )
    return;
  userCooldowns.set(key, Date.now());

  // Helper function (existing code)
  function getRequiredXP(level) {
    return 100 + level * 25;
  }

  // Fetch user data (existing code)
  const userXP = (await db.get(`xp.${key}`)) || 0;
  const userLevel = (await db.get(`level.${key}`)) || 0;

  const newXP = userXP + XP_PER_MESSAGE;
  const requiredXP = getRequiredXP(userLevel);

  await db.set(`xp.${key}`, newXP);

  if (newXP >= requiredXP) {
    await db.set(`xp.${key}`, newXP - requiredXP);
    await db.set(`level.${key}`, userLevel + 1);

    const newLevel = userLevel + 1;

    // Send level-up message (existing code)
    const channelId = await db.get(`${guildId}_${LEVEL_UP_CHANNEL_KEY}`);
    const channel = message.guild.channels.cache.get(channelId);
    if (channel) {
      const embed = new MessageEmbed()
        .setColor("GOLD")
        .setTitle("🌟 Level Up!")
        .setDescription(
          `${message.author} has reached **Level ${newLevel}**! 🎉`,
        )
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: "Mahindra University | Leveling System" })
        .setTimestamp();

      channel.send({ embeds: [embed] });
    }

    // Handle role rewards (existing code)
    const rewardRoleId = await db.get(`levelrole.${guildId}.${newLevel}`);
    if (rewardRoleId) {
      const role = message.guild.roles.cache.get(rewardRoleId);
      if (role) {
        message.member.roles.add(role).catch(console.error);
      }
    }

    const clearRoleId = await db.get(`clearrole.${guildId}.${newLevel}`);
    if (clearRoleId) {
      const role = message.guild.roles.cache.get(clearRoleId);
      if (role) {
        message.member.roles.remove(role).catch(console.error);
      }
    }
  }
});
// Text responses - messageCreate handler
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.toLowerCase();

  if (content === "hi bot") {
    message.reply("Hello! 👋 Try using `/help` to see what I can do!");
  } else if (
    content.includes("pick me a random color") ||
    content.includes("random color")
  ) {
    const colors = [
      "Red ❤️",
      "Blue 💙",
      "Green 💚",
      "Yellow 💛",
      "Pink 💗",
      "Purple 💜",
      "Orange 🧡",
      "Teal 🩵",
    ];
    const color = colors[Math.floor(Math.random() * colors.length)];
    message.reply(`🎨 Your random color is: **${color}**`);
  }
});

// When a member joins the server
client.on("guildMemberAdd", async (member) => {
  const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!channel) return;

  const welcomeEmbed = new MessageEmbed()
    .setColor("GREEN")
    .setTitle("🎉 Welcome!")
    .setDescription(`Hey ${member}, welcome to **${member.guild.name}**!`)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();

  channel.send({ embeds: [welcomeEmbed] });

  // Assign autoroles
  const autoroles = (await db.get(`autoroles.${member.guild.id}`)) || [];
  if (autoroles && autoroles.length > 0) {
    try {
      await member.roles.add(autoroles);
      console.log(`Assigned autoroles to ${member.user.tag}`);
    } catch (error) {
      console.error("Failed to assign autoroles:", error);
    }
  }
});

// When a member leaves the server
client.on("guildMemberRemove", async (member) => {
  const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!channel) return;

  const farewellEmbed = new MessageEmbed()
    .setColor("RED")
    .setTitle("👋 Goodbye!")
    .setDescription(
      `Sad to see ${member.user.tag} leave **${member.guild.name}**.`,
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();

  channel.send({ embeds: [farewellEmbed] });
});

client.login(process.env.TOKEN);
