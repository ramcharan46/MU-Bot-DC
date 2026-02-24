const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v10");
require("dotenv").config();

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing TOKEN or CLIENT_ID in .env");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(TOKEN);

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function parseGuildIds(...values) {
  const out = new Set();
  for (const value of values) {
    if (!value) continue;
    const parts = String(value)
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const id of parts) {
      if (/^\d{17,20}$/.test(id)) out.add(id);
    }
  }
  return [...out];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  const status = Number(error?.status ?? error?.rawError?.status ?? 0);
  if (status === 429 || (status >= 500 && status < 600)) return true;

  const code = String(error?.code || "").toUpperCase();
  return [
    "ETIMEDOUT",
    "ECONNRESET",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ECONNABORTED",
  ].includes(code);
}

function getRetryDelayMs(error, attempt) {
  const retryAfterRaw =
    error?.retry_after ??
    error?.data?.retry_after ??
    error?.rawError?.retry_after ??
    0;
  const retryAfterMs = Number(retryAfterRaw) > 0 ? Number(retryAfterRaw) * 1000 : 0;
  if (retryAfterMs > 0) return Math.ceil(retryAfterMs) + 250;
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 10000);
}

async function withRetry(label, fn, maxAttempts = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxAttempts) break;
      const waitMs = getRetryDelayMs(error, attempt);
      console.warn(`[retry ${attempt}/${maxAttempts}] ${label} failed, retrying in ${waitMs}ms`);
      await delay(waitMs);
    }
  }
  throw lastError;
}

async function getGlobalCommands() {
  return withRetry("fetch global commands", () =>
    rest.get(Routes.applicationCommands(CLIENT_ID)),
  );
}

async function getGuildCommands(guildId) {
  return withRetry(`fetch guild commands (${guildId})`, () =>
    rest.get(Routes.applicationGuildCommands(CLIENT_ID, guildId)),
  );
}

async function bulkClearGlobalCommands() {
  return withRetry("bulk clear global commands", () =>
    rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] }),
  );
}

async function bulkClearGuildCommands(guildId) {
  return withRetry(`bulk clear guild commands (${guildId})`, () =>
    rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [] }),
  );
}

async function deleteGlobalCommand(commandId, commandName) {
  return withRetry(`delete global command ${commandName || commandId}`, () =>
    rest.delete(Routes.applicationCommand(CLIENT_ID, commandId)),
  );
}

async function deleteGuildCommand(guildId, commandId, commandName) {
  return withRetry(
    `delete guild command ${commandName || commandId} (${guildId})`,
    () => rest.delete(Routes.applicationGuildCommand(CLIENT_ID, guildId, commandId)),
  );
}

async function clearGlobalCommands({ dryRun = false }) {
  const before = await getGlobalCommands();
  console.log(`Global commands before: ${before.length}`);
  if (!before.length) return true;
  if (dryRun) {
    console.log("[dry-run] Skipping global command deletion.");
    return true;
  }

  await bulkClearGlobalCommands();
  let remaining = await getGlobalCommands();
  if (remaining.length) {
    console.warn(`Bulk clear left ${remaining.length} global command(s). Falling back to individual deletes.`);
    for (const cmd of remaining) {
      await deleteGlobalCommand(cmd.id, cmd.name);
      console.log(`Deleted global command: ${cmd.name}`);
    }
    remaining = await getGlobalCommands();
  }

  console.log(`Global commands after: ${remaining.length}`);
  return remaining.length === 0;
}

async function clearGuildCommands(guildId, { dryRun = false }) {
  const before = await getGuildCommands(guildId);
  console.log(`[${guildId}] guild commands before: ${before.length}`);
  if (!before.length) return true;
  if (dryRun) {
    console.log(`[dry-run][${guildId}] Skipping guild command deletion.`);
    return true;
  }

  await bulkClearGuildCommands(guildId);
  let remaining = await getGuildCommands(guildId);
  if (remaining.length) {
    console.warn(`[${guildId}] bulk clear left ${remaining.length} command(s). Falling back to individual deletes.`);
    for (const cmd of remaining) {
      await deleteGuildCommand(guildId, cmd.id, cmd.name);
      console.log(`[${guildId}] deleted guild command: ${cmd.name}`);
    }
    remaining = await getGuildCommands(guildId);
  }

  console.log(`[${guildId}] guild commands after: ${remaining.length}`);
  return remaining.length === 0;
}

async function fetchBotGuildIds() {
  const ids = new Set();
  let before = "";
  let page = 0;

  while (true) {
    page += 1;
    const guilds = await withRetry(`fetch bot guild list page ${page}`, () =>
      rest.get(Routes.userGuilds(), {
        query: {
          limit: 200,
          ...(before ? { before } : {}),
        },
      }),
    );

    const list = Array.isArray(guilds) ? guilds : [];
    for (const guild of list) {
      if (guild?.id) ids.add(guild.id);
    }

    if (list.length < 200) break;

    const nextBefore = String(list[list.length - 1]?.id || "");
    if (!nextBefore || nextBefore === before) break;
    before = nextBefore;
  }

  return [...ids];
}

(async () => {
  const clearGlobal = parseBool(process.env.CLEAR_GLOBAL, true);
  const clearGuilds = parseBool(process.env.CLEAR_GUILDS, true);
  const clearAllGuilds = parseBool(process.env.CLEAR_ALL_GUILDS, true);
  const dryRun = parseBool(process.env.DRY_RUN, false);

  let failures = 0;
  try {
    if (clearGlobal) {
      const ok = await clearGlobalCommands({ dryRun });
      if (!ok) failures += 1;
    } else {
      console.log("Skipping global command cleanup (CLEAR_GLOBAL=false).");
    }

    if (clearGuilds) {
      let guildIds = parseGuildIds(process.env.GUILD_IDS, process.env.GUILD_ID);
      if (!guildIds.length && clearAllGuilds) {
        guildIds = await fetchBotGuildIds();
      }

      if (!guildIds.length) {
        console.log("No guild IDs found to clear. Set GUILD_ID/GUILD_IDS or enable CLEAR_ALL_GUILDS.");
      } else {
        console.log(`Clearing guild commands in ${guildIds.length} guild(s).`);
        for (const guildId of guildIds) {
          try {
            const ok = await clearGuildCommands(guildId, { dryRun });
            if (!ok) failures += 1;
          } catch (error) {
            failures += 1;
            console.error(`[${guildId}] failed to clear guild commands:`, error?.message || error);
          }
        }
      }
    } else {
      console.log("Skipping guild command cleanup (CLEAR_GUILDS=false).");
    }
  } catch (error) {
    failures += 1;
    console.error("Command cleanup failed:", error);
  }

  if (failures > 0) {
    console.error(`Cleanup finished with ${failures} failure(s).`);
    process.exit(1);
  }

  console.log("Command cleanup complete.");
})();
