const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
require('dotenv').config(); // Load .env file with TOKEN, CLIENT_ID, and GUILD_ID

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // Only used for clearing guild commands

const rest = new REST({ version: '9' }).setToken(TOKEN);

(async () => {
  try {
    const clearGlobal = true;   // ⬅️ Set to true to clear global commands
    const clearGuild = true;    // ⬅️ Set to true to clear guild commands

    if (clearGlobal) {
      const globalCommands = await rest.get(Routes.applicationCommands(CLIENT_ID));
      console.log(`Found ${globalCommands.length} global command(s)`);
      for (const cmd of globalCommands) {
        await rest.delete(Routes.applicationCommand(CLIENT_ID, cmd.id));
        console.log(`❌ Deleted global command: ${cmd.name}`);
      }
    }

    if (clearGuild && GUILD_ID) {
      const guildCommands = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID));
      console.log(`Found ${guildCommands.length} guild command(s)`);
      for (const cmd of guildCommands) {
        await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, GUILD_ID, cmd.id));
        console.log(`❌ Deleted guild command: ${cmd.name}`);
      }
    }

    console.log('✅ Finished clearing commands.');
  } catch (err) {
    console.error('❌ Error clearing commands:', err);
  }
})();