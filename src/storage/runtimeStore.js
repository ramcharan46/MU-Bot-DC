const fs = require("fs");
const path = require("path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_) {
  DatabaseSync = null;
}

const { DATABASE_DIR, RUNTIME_DB_FILE } = require("../config/paths");

const RUNTIME_DB_PATH = RUNTIME_DB_FILE;
const FALLBACK_STORE_PATH = path.join(DATABASE_DIR, "runtime-store.json");

let dbInstance = null;
let fallbackCache = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseObjectJson(raw) {
  if (typeof raw !== "string") return {};
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function ensureDatabaseDir() {
  if (!fs.existsSync(DATABASE_DIR)) fs.mkdirSync(DATABASE_DIR, { recursive: true });
}

function ensureRuntimeDb() {
  if (!DatabaseSync) return null;
  if (dbInstance) return dbInstance;
  ensureDatabaseDir();

  const db = new DatabaseSync(RUNTIME_DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv_store (
      namespace TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  dbInstance = db;
  return dbInstance;
}

function ensureFallbackCache() {
  if (fallbackCache) return fallbackCache;
  ensureDatabaseDir();
  if (!fs.existsSync(FALLBACK_STORE_PATH)) {
    fs.writeFileSync(FALLBACK_STORE_PATH, "{}\n", "utf8");
  }
  const raw = fs.readFileSync(FALLBACK_STORE_PATH, "utf8");
  fallbackCache = parseObjectJson(raw);
  return fallbackCache;
}

function persistFallbackCache() {
  ensureDatabaseDir();
  const data = isPlainObject(fallbackCache) ? fallbackCache : {};
  fs.writeFileSync(FALLBACK_STORE_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function loadFromLegacyJson(fallbackFilePath) {
  if (!fallbackFilePath || !fs.existsSync(fallbackFilePath)) return {};
  try {
    const raw = fs.readFileSync(fallbackFilePath, "utf8");
    return parseObjectJson(raw);
  } catch (_) {
    return {};
  }
}

function loadNamespace(namespace, fallbackFilePath = "") {
  if (!namespace || typeof namespace !== "string") return {};

  const db = ensureRuntimeDb();
  if (db) {
    const stmt = db.prepare("SELECT data FROM kv_store WHERE namespace = ?");
    const row = stmt.get(namespace);
    if (row?.data) {
      const parsed = parseObjectJson(String(row.data));
      if (isPlainObject(parsed)) return parsed;
    }
  } else {
    const cache = ensureFallbackCache();
    const stored = cache[namespace];
    if (isPlainObject(stored)) return stored;
  }

  const migrated = loadFromLegacyJson(fallbackFilePath);
  if (Object.keys(migrated).length > 0) {
    saveNamespace(namespace, migrated);
  }
  return migrated;
}

function saveNamespace(namespace, data) {
  if (!namespace || typeof namespace !== "string") return;
  const payload = isPlainObject(data) ? data : {};
  const db = ensureRuntimeDb();
  if (db) {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO kv_store (namespace, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `);
    stmt.run(namespace, JSON.stringify(payload), now);
    return;
  }

  const cache = ensureFallbackCache();
  cache[namespace] = payload;
  persistFallbackCache();
}

function deleteNamespace(namespace) {
  if (!namespace || typeof namespace !== "string") return;
  const db = ensureRuntimeDb();
  if (db) {
    const stmt = db.prepare("DELETE FROM kv_store WHERE namespace = ?");
    stmt.run(namespace);
    return;
  }

  const cache = ensureFallbackCache();
  if (cache[namespace] !== undefined) {
    delete cache[namespace];
    persistFallbackCache();
  }
}

function getRuntimeStoreStatus() {
  const db = ensureRuntimeDb();
  if (db) {
    const row = db.prepare("SELECT COUNT(*) AS count FROM kv_store").get();
    const size = fs.existsSync(RUNTIME_DB_PATH) ? fs.statSync(RUNTIME_DB_PATH).size : 0;
    return {
      backend: "sqlite",
      path: RUNTIME_DB_PATH,
      namespace_count: Number(row?.count || 0),
      size_bytes: size,
    };
  }

  const cache = ensureFallbackCache();
  const size = fs.existsSync(FALLBACK_STORE_PATH) ? fs.statSync(FALLBACK_STORE_PATH).size : 0;
  return {
    backend: "json",
    path: FALLBACK_STORE_PATH,
    namespace_count: Object.keys(cache).length,
    size_bytes: size,
  };
}

module.exports = {
  RUNTIME_DB_PATH,
  loadNamespace,
  saveNamespace,
  deleteNamespace,
  getRuntimeStoreStatus,
};
