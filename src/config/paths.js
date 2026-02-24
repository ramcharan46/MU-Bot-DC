const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATABASE_DIR = path.join(ROOT_DIR, "database");

const WARNINGS_FILE = path.join(DATABASE_DIR, "warnings.json");
const LOG_CONFIG_FILE = path.join(DATABASE_DIR, "log-config.json");
const SETUP_CONFIG_FILE = path.join(DATABASE_DIR, "setup-config.json");
const MOD_ACTIONS_FILE = path.join(DATABASE_DIR, "mod-actions.json");
const REMINDERS_FILE = path.join(DATABASE_DIR, "reminders.json");
const AUTOROLE_FILE = path.join(DATABASE_DIR, "autorole-config.json");
const JTC_CONFIG_FILE = path.join(DATABASE_DIR, "jtc-config.json");
const RUNTIME_DB_FILE = path.join(DATABASE_DIR, "runtime.sqlite3");
const BOT_LOCK_FILE = path.join(ROOT_DIR, ".bot.lock");

module.exports = {
  ROOT_DIR,
  DATABASE_DIR,
  WARNINGS_FILE,
  LOG_CONFIG_FILE,
  SETUP_CONFIG_FILE,
  MOD_ACTIONS_FILE,
  REMINDERS_FILE,
  AUTOROLE_FILE,
  JTC_CONFIG_FILE,
  RUNTIME_DB_FILE,
  BOT_LOCK_FILE,
};
