const fs = require("fs");
const path = require("path");

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readLock(lockFilePath) {
  try {
    if (!fs.existsSync(lockFilePath)) return null;
    const raw = fs.readFileSync(lockFilePath, "utf8").trim();
    if (!raw) return null;
    const parsed = safeParseJson(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeLock(lockFilePath, payload) {
  const dir = path.dirname(lockFilePath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(lockFilePath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
}

function acquireSingleInstanceLock(lockFilePath, metadata = {}) {
  if (!lockFilePath || typeof lockFilePath !== "string") {
    throw new Error("Lock file path is required.");
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    argv: process.argv.slice(1),
    ...metadata,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeLock(lockFilePath, payload);

      let released = false;
      return function releaseLock() {
        if (released) return false;
        released = true;

        const existing = readLock(lockFilePath);
        const ownerPid = Number(existing?.pid);
        if (Number.isInteger(ownerPid) && ownerPid !== process.pid) return false;

        try {
          if (fs.existsSync(lockFilePath)) fs.unlinkSync(lockFilePath);
          return true;
        } catch (_) {
          return false;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const existing = readLock(lockFilePath);
      const ownerPid = Number(existing?.pid);
      const ownerRunning = Number.isInteger(ownerPid) && isProcessRunning(ownerPid);

      if (!ownerRunning) {
        try {
          fs.unlinkSync(lockFilePath);
        } catch (_) {
          // ignore stale-lock cleanup failures and retry once
        }
        continue;
      }

      const ownerStarted = existing?.startedAt ? `, started ${existing.startedAt}` : "";
      throw new Error(
        `Another bot instance is already running (PID ${ownerPid}${ownerStarted}). Remove ${lockFilePath} only if that process is gone.`,
      );
    }
  }

  throw new Error(`Unable to acquire bot lock: ${lockFilePath}`);
}

module.exports = {
  acquireSingleInstanceLock,
};
