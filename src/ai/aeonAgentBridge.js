const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const DEFAULT_TIMEOUT_MS = 60000;
const AGENT_SCRIPT_PATH = path.join(__dirname, "..", "..", "agentic_ai", "aeon_agent.py");
const AGENT_WORKER_SCRIPT_PATH = path.join(__dirname, "..", "..", "agentic_ai", "aeon_agent_worker.py");
const KNOWLEDGE_DIR_PATH = path.join(__dirname, "..", "..", "agentic_ai", "knowledge");
const DEFAULT_ROUTER_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_ANSWER_MODEL = "qwen/qwen3-32b";
const DEFAULT_EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const ENABLE_PERSISTENT_WORKER = !["0", "false", "no", "off"].includes(
  String(process.env.AEON_PERSISTENT_WORKER || "true").trim().toLowerCase(),
);
const LATENCY_SAMPLE_LIMIT = Math.max(
  20,
  Number.parseInt(String(process.env.AEON_LATENCY_SAMPLE_LIMIT || "200"), 10) || 200,
);
const ASK_CACHE_TTL_MS = Math.max(
  0,
  Number.parseInt(String(process.env.AEON_ASK_CACHE_TTL_MS || "120000"), 10) || 120000,
);
const ASK_CACHE_MAX_ITEMS = Math.max(
  10,
  Number.parseInt(String(process.env.AEON_ASK_CACHE_MAX_ITEMS || "120"), 10) || 120,
);
const ASK_QUEUE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(String(process.env.AEON_ASK_QUEUE_CONCURRENCY || "1"), 10) || 1,
);
const ASK_QUEUE_MAX_PENDING = Math.max(
  1,
  Number.parseInt(String(process.env.AEON_ASK_QUEUE_MAX_PENDING || "25"), 10) || 25,
);
const ASK_QUEUE_WAIT_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(String(process.env.AEON_ASK_QUEUE_WAIT_TIMEOUT_MS || "90000"), 10) || 90000,
);
const PYTHON_PROCESS_ENV = {
  ...process.env,
  PYTHONIOENCODING: String(process.env.PYTHONIOENCODING || "utf-8"),
  PYTHONUTF8: String(process.env.PYTHONUTF8 || "1"),
};
const askResponseCache = new Map();
const latencyStore = new Map();
const askQueue = [];
let askQueueActive = 0;
let bridgeStats = {
  askRequests: 0,
  totalRequests: 0,
  failedRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  workerRequests: 0,
  spawnRequests: 0,
  fallbackSpawnRequests: 0,
  workerStarts: 0,
  workerRestarts: 0,
  workerFailures: 0,
  queueEnqueued: 0,
  queueDequeued: 0,
  queueDropped: 0,
  queueTimeouts: 0,
  queueMaxDepth: 0,
};
let persistentWorker = {
  process: null,
  startPromise: null,
  stdoutBuffer: "",
  pending: new Map(),
  requestSeq: 0,
  pythonBin: null,
  startedAt: 0,
  lastError: "",
  lastExitCode: null,
};
let lastAgentScriptMtimeMs = 0;
let lastWorkerScriptMtimeMs = 0;

function pickModelFromEnv(keys, fallback) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return fallback;
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function getFileMtimeMs(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Number.isFinite(stat?.mtimeMs) ? Number(stat.mtimeMs) : 0;
  } catch (_) {
    return 0;
  }
}

function refreshScriptMtimeSnapshot() {
  lastAgentScriptMtimeMs = getFileMtimeMs(AGENT_SCRIPT_PATH);
  lastWorkerScriptMtimeMs = getFileMtimeMs(AGENT_WORKER_SCRIPT_PATH);
}

function ensureFreshPersistentWorkerCode() {
  if (!ENABLE_PERSISTENT_WORKER) return;
  const isRunning = Boolean(persistentWorker.process && !persistentWorker.process.killed);
  const agentMtime = getFileMtimeMs(AGENT_SCRIPT_PATH);
  const workerMtime = getFileMtimeMs(AGENT_WORKER_SCRIPT_PATH);
  if (!isRunning) {
    lastAgentScriptMtimeMs = agentMtime;
    lastWorkerScriptMtimeMs = workerMtime;
    return;
  }
  const changed =
    (agentMtime && lastAgentScriptMtimeMs && agentMtime !== lastAgentScriptMtimeMs) ||
    (workerMtime && lastWorkerScriptMtimeMs && workerMtime !== lastWorkerScriptMtimeMs);
  if (!changed) return;
  stopPersistentWorker();
  askResponseCache.clear();
  lastAgentScriptMtimeMs = agentMtime;
  lastWorkerScriptMtimeMs = workerMtime;
}

function getPythonCandidates() {
  const candidates = [PYTHON_BIN];
  const normalizedPrimary = String(PYTHON_BIN || "").trim().toLowerCase();
  if (process.platform === "win32" && normalizedPrimary !== "py") {
    candidates.push("py");
  }
  return [...new Set(candidates.filter(Boolean))];
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

function recordLatency(action, ms) {
  const safeAction = String(action || "unknown");
  const latency = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  const list = latencyStore.get(safeAction) || [];
  list.push(latency);
  if (list.length > LATENCY_SAMPLE_LIMIT) list.splice(0, list.length - LATENCY_SAMPLE_LIMIT);
  latencyStore.set(safeAction, list);
}

function summarizeLatency(action) {
  const list = latencyStore.get(String(action || "unknown")) || [];
  if (!list.length) return null;
  const total = list.reduce((sum, value) => sum + value, 0);
  return {
    samples: list.length,
    avg_ms: Math.round(total / list.length),
    p50_ms: Math.round(percentile(list, 50) || 0),
    p95_ms: Math.round(percentile(list, 95) || 0),
    last_ms: Math.round(list[list.length - 1] || 0),
  };
}

function queueDepth() {
  return askQueue.length;
}

function runNextAskQueueItem() {
  while (askQueueActive < ASK_QUEUE_CONCURRENCY && askQueue.length > 0) {
    const job = askQueue.shift();
    if (!job) continue;
    clearTimeout(job.waitTimer);
    askQueueActive += 1;
    bridgeStats.queueDequeued += 1;
    recordLatency("ask_queue_wait", Date.now() - job.enqueuedAt);

    Promise.resolve()
      .then(job.run)
      .then((result) => {
        job.resolve(result);
      })
      .catch((error) => {
        job.reject(error);
      })
      .finally(() => {
        askQueueActive = Math.max(0, askQueueActive - 1);
        runNextAskQueueItem();
      });
  }
}

function enqueueAsk(run) {
  return new Promise((resolve, reject) => {
    if (queueDepth() >= ASK_QUEUE_MAX_PENDING) {
      bridgeStats.queueDropped += 1;
      reject(
        new Error(
          `AEON assistant is busy right now (queue full). Please retry in a moment.`,
        ),
      );
      return;
    }

    const job = {
      run,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      waitTimer: null,
    };
    job.waitTimer = setTimeout(() => {
      const index = askQueue.indexOf(job);
      if (index >= 0) askQueue.splice(index, 1);
      bridgeStats.queueTimeouts += 1;
      reject(new Error("AEON assistant is busy. Queue wait timed out, please retry."));
    }, ASK_QUEUE_WAIT_TIMEOUT_MS);

    askQueue.push(job);
    bridgeStats.queueEnqueued += 1;
    bridgeStats.queueMaxDepth = Math.max(bridgeStats.queueMaxDepth, queueDepth());
    runNextAskQueueItem();
  });
}

function getBridgeRuntimeMetrics() {
  const askSamples = summarizeLatency("ask");
  const allSamples = summarizeLatency("all");
  const askQueueWaitSamples = summarizeLatency("ask_queue_wait");
  const totalCache = bridgeStats.cacheHits + bridgeStats.cacheMisses;
  const cacheHitRate = totalCache ? bridgeStats.cacheHits / totalCache : 0;
  const connected = Boolean(persistentWorker.process && !persistentWorker.process.killed);
  return {
    ask_requests: bridgeStats.askRequests,
    backend_requests: bridgeStats.totalRequests,
    total_requests: bridgeStats.totalRequests,
    failed_requests: bridgeStats.failedRequests,
    cache_hits: bridgeStats.cacheHits,
    cache_misses: bridgeStats.cacheMisses,
    cache_hit_rate: Number(cacheHitRate.toFixed(4)),
    ask_latency_ms: askSamples,
    ask_queue_wait_ms: askQueueWaitSamples,
    overall_latency_ms: allSamples,
    queue: {
      concurrency: ASK_QUEUE_CONCURRENCY,
      active: askQueueActive,
      pending: queueDepth(),
      max_pending: ASK_QUEUE_MAX_PENDING,
      wait_timeout_ms: ASK_QUEUE_WAIT_TIMEOUT_MS,
      enqueued: bridgeStats.queueEnqueued,
      dequeued: bridgeStats.queueDequeued,
      dropped: bridgeStats.queueDropped,
      timeouts: bridgeStats.queueTimeouts,
      max_depth: bridgeStats.queueMaxDepth,
    },
    worker: {
      enabled: ENABLE_PERSISTENT_WORKER,
      script_exists: fs.existsSync(AGENT_WORKER_SCRIPT_PATH),
      connected,
      pid: connected ? persistentWorker.process.pid : null,
      python_bin: persistentWorker.pythonBin || PYTHON_BIN,
      started_at: persistentWorker.startedAt || null,
      starts: bridgeStats.workerStarts,
      restarts: bridgeStats.workerRestarts,
      failures: bridgeStats.workerFailures,
      requests: bridgeStats.workerRequests,
      spawn_requests: bridgeStats.spawnRequests,
      fallback_spawns: bridgeStats.fallbackSpawnRequests,
      last_error: persistentWorker.lastError || "",
      last_exit_code: persistentWorker.lastExitCode,
    },
  };
}

function cloneJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function normalizeResponseMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "brief" || normalized === "detailed") return normalized;
  return "normal";
}

function makeAskCacheKey(question, history, mode = "normal") {
  const q = String(question || "").trim().toLowerCase();
  const responseMode = normalizeResponseMode(mode);
  const h = Array.isArray(history)
    ? history
        .slice(-8)
        .map((entry) => ({
          q: String(entry?.question || "").trim().toLowerCase(),
          a: String(entry?.answer || "").trim().toLowerCase(),
        }))
    : [];
  return JSON.stringify({ q, h, mode: responseMode });
}

function getCachedAskResponse(cacheKey) {
  if (!ASK_CACHE_TTL_MS) return null;
  const entry = askResponseCache.get(cacheKey);
  if (!entry) return null;
  if (!entry.expiresAt || Date.now() > entry.expiresAt) {
    askResponseCache.delete(cacheKey);
    return null;
  }
  return cloneJsonSafe(entry.value);
}

function setCachedAskResponse(cacheKey, value) {
  if (!ASK_CACHE_TTL_MS || !cacheKey) return;
  askResponseCache.set(cacheKey, {
    value: cloneJsonSafe(value),
    expiresAt: Date.now() + ASK_CACHE_TTL_MS,
  });
  if (askResponseCache.size <= ASK_CACHE_MAX_ITEMS) return;
  const overflow = askResponseCache.size - ASK_CACHE_MAX_ITEMS;
  let removed = 0;
  for (const key of askResponseCache.keys()) {
    askResponseCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function normalizeAgentError(rawMessage) {
  const text = String(rawMessage || "").trim();
  if (!text) return "Python agent request failed.";

  const moduleMatch = text.match(/ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/i);
  if (moduleMatch) {
    return `Missing Python dependency: ${moduleMatch[1]}. Run \`pip install -r agentic_ai/requirements.txt\`.`;
  }

  if (/\bENOENT\b/i.test(text) || /is not recognized as an internal or external command/i.test(text)) {
    return "Python executable not found. Set `PYTHON_BIN` in `.env` (example: `python` or `py`).";
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return "Python agent request failed.";
  if (lines.some((line) => /^traceback/i.test(line))) {
    return lines[lines.length - 1];
  }

  return lines.slice(0, 2).join(" ");
}

function rejectWorkerPending(error) {
  for (const [, pending] of persistentWorker.pending.entries()) {
    clearTimeout(pending.timer);
    try {
      pending.reject(error);
    } catch (_) {
      // ignore pending reject errors
    }
  }
  persistentWorker.pending.clear();
}

function resetWorkerState() {
  persistentWorker.process = null;
  persistentWorker.startPromise = null;
  persistentWorker.stdoutBuffer = "";
  persistentWorker.pending.clear();
}

function stopPersistentWorker() {
  if (!persistentWorker.process || persistentWorker.process.killed) return;
  try {
    persistentWorker.process.kill();
  } catch (_) {
    // ignore worker kill failures
  } finally {
    persistentWorker.process = null;
  }
}

function handleWorkerStdout(text) {
  persistentWorker.stdoutBuffer += String(text || "");
  const parts = persistentWorker.stdoutBuffer.split(/\r?\n/);
  persistentWorker.stdoutBuffer = parts.pop() || "";

  for (const line of parts) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    const packet = parseJsonSafe(trimmed);
    if (!packet || typeof packet !== "object") continue;
    const requestId = String(packet.id || "").trim();
    if (!requestId) continue;
    const pending = persistentWorker.pending.get(requestId);
    if (!pending) continue;
    persistentWorker.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (packet.ok === false) {
      pending.reject(new Error(normalizeAgentError(packet.error || "Python worker returned an error.")));
      continue;
    }
    pending.resolve(packet.result);
  }
}

async function startPersistentWorker() {
  if (!ENABLE_PERSISTENT_WORKER) throw new Error("Persistent worker is disabled.");
  if (!fs.existsSync(AGENT_WORKER_SCRIPT_PATH)) {
    throw new Error("Persistent worker script not found.");
  }
  if (persistentWorker.process && !persistentWorker.process.killed) {
    return persistentWorker.process;
  }
  if (persistentWorker.startPromise) return persistentWorker.startPromise;

  persistentWorker.startPromise = (async () => {
    const candidates = getPythonCandidates();
    let lastError = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      try {
        const child = await new Promise((resolve, reject) => {
          const proc = spawn(candidate, [AGENT_WORKER_SCRIPT_PATH], {
            cwd: path.join(__dirname, "..", ".."),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: PYTHON_PROCESS_ENV,
          });

          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(proc);
          }, 150);

          proc.once("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          });

          proc.once("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const error = new Error(`Persistent worker exited early with code ${code}.`);
            error.code = code;
            reject(error);
          });
        });

        persistentWorker.process = child;
        persistentWorker.pythonBin = candidate;
        persistentWorker.startedAt = Date.now();
        persistentWorker.lastExitCode = null;
        refreshScriptMtimeSnapshot();
        bridgeStats.workerStarts += 1;
        if (bridgeStats.workerStarts > 1) bridgeStats.workerRestarts += 1;

        child.stdout.on("data", (chunk) => {
          handleWorkerStdout(String(chunk));
        });
        child.stderr.on("data", (chunk) => {
          const text = String(chunk || "").trim();
          if (text) persistentWorker.lastError = text.slice(0, 500);
        });
        child.on("close", (code) => {
          persistentWorker.lastExitCode = code;
          const error = new Error(`Persistent worker exited (code: ${code}).`);
          rejectWorkerPending(error);
          persistentWorker.process = null;
          persistentWorker.startPromise = null;
        });
        child.on("error", (error) => {
          persistentWorker.lastError = normalizeAgentError(error?.message || String(error));
        });

        return child;
      } catch (error) {
        lastError = error;
        persistentWorker.lastError = normalizeAgentError(error?.message || String(error));
        const isLast = i === candidates.length - 1;
        if (error?.code === "ENOENT" && !isLast) continue;
      }
    }
    bridgeStats.workerFailures += 1;
    throw lastError || new Error("Failed to start persistent AEON worker.");
  })();

  try {
    return await persistentWorker.startPromise;
  } finally {
    persistentWorker.startPromise = null;
  }
}

async function runPythonAgentViaWorker(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const proc = await startPersistentWorker();
  if (!proc || proc.killed) throw new Error("Persistent worker is not available.");

  const requestId = `${Date.now().toString(36)}${(++persistentWorker.requestSeq).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      persistentWorker.pending.delete(requestId);
      reject(new Error(`AEON AI request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    persistentWorker.pending.set(requestId, { resolve, reject, timer });

    try {
      proc.stdin.write(`${JSON.stringify({ id: requestId, payload })}\n`);
    } catch (error) {
      clearTimeout(timer);
      persistentWorker.pending.delete(requestId);
      reject(new Error(normalizeAgentError(error?.message || "Failed to send request to persistent worker.")));
    }
  });
}

function runPythonAgentWithBin(pythonBin, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [AGENT_SCRIPT_PATH], {
      cwd: path.join(__dirname, "..", ".."),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: PYTHON_PROCESS_ENV,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        // ignore timeout kill errors
      }
      finish(new Error(`AEON AI request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      const wrapped = new Error(normalizeAgentError(`Failed to start Python agent: ${error.message}`));
      wrapped.code = error?.code;
      finish(wrapped);
    });
    child.on("close", (code) => {
      const parsed = parseJsonSafe(String(stdout || "").trim());
      if (code !== 0) {
        const rawMessage =
          parsed?.error ||
          String(stderr || stdout || `Python agent exited with code ${code}`).trim();
        finish(new Error(normalizeAgentError(rawMessage)));
        return;
      }
      if (!parsed) {
        finish(new Error("Python agent returned invalid JSON output."));
        return;
      }
      if (parsed.ok === false) {
        finish(new Error(parsed.error || "Python agent returned an error."));
        return;
      }
      finish(null, parsed);
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (error) {
      finish(new Error(`Failed to send payload to Python agent: ${error.message}`));
    }
  });
}

async function runPythonAgentViaSpawn(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const candidates = getPythonCandidates();
  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      return await runPythonAgentWithBin(candidate, payload, timeoutMs);
    } catch (error) {
      lastError = error;
      const isLast = i === candidates.length - 1;
      if (error?.code === "ENOENT" && !isLast) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Python agent request failed.");
}

async function runPythonAgent(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const action = String(payload?.action || "unknown").trim().toLowerCase() || "unknown";
  const startedAt = Date.now();
  bridgeStats.totalRequests += 1;
  ensureFreshPersistentWorkerCode();

  let result = null;
  let usedWorker = false;
  try {
    if (ENABLE_PERSISTENT_WORKER) {
      try {
        result = await runPythonAgentViaWorker(payload, timeoutMs);
        usedWorker = true;
        bridgeStats.workerRequests += 1;
      } catch (workerError) {
        bridgeStats.workerFailures += 1;
        persistentWorker.lastError = normalizeAgentError(workerError?.message || String(workerError));
        stopPersistentWorker();
        result = await runPythonAgentViaSpawn(payload, timeoutMs);
        bridgeStats.spawnRequests += 1;
        bridgeStats.fallbackSpawnRequests += 1;
      }
    } else {
      result = await runPythonAgentViaSpawn(payload, timeoutMs);
      bridgeStats.spawnRequests += 1;
    }

    const elapsed = Date.now() - startedAt;
    recordLatency(action, elapsed);
    recordLatency("all", elapsed);
    return result;
  } catch (error) {
    bridgeStats.failedRequests += 1;
    const elapsed = Date.now() - startedAt;
    recordLatency(action, elapsed);
    recordLatency("all", elapsed);
    if (usedWorker) {
      stopPersistentWorker();
    }
    throw error;
  }
}

function getAeonAgentStatusSnapshot() {
  const routerModel = pickModelFromEnv(
    ["GROQ_ROUTER_MODEL", "AEON_AI_ROUTER_MODEL", "ROUTER_MODEL"],
    DEFAULT_ROUTER_MODEL,
  );
  const answerModel = pickModelFromEnv(
    ["QWEN_MODEL", "AEON_AI_QWEN_MODEL", "GROQ_ANSWER_MODEL", "AEON_AI_ANSWER_MODEL", "ANSWER_MODEL"],
    DEFAULT_ANSWER_MODEL,
  );

  return {
    pythonBin: PYTHON_BIN,
    scriptPath: AGENT_SCRIPT_PATH,
    scriptExists: fs.existsSync(AGENT_SCRIPT_PATH),
    workerScriptPath: AGENT_WORKER_SCRIPT_PATH,
    workerScriptExists: fs.existsSync(AGENT_WORKER_SCRIPT_PATH),
    persistentWorkerEnabled: ENABLE_PERSISTENT_WORKER,
    knowledgeDirPath: KNOWLEDGE_DIR_PATH,
    knowledgeDirExists: fs.existsSync(KNOWLEDGE_DIR_PATH),
    chromaDir: String(process.env.CHROMA_DIR || "agentic_ai/chroma_db").trim(),
    embeddingModel: String(process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL).trim(),
    groqConfigured: Boolean(String(process.env.GROQ_API_KEY || "").trim()),
    model: answerModel,
    routerModel,
    answerModel,
  };
}

async function getAeonAgentRuntimeStatus() {
  const base = getAeonAgentStatusSnapshot();
  if (!base.scriptExists) return { ok: false, ...base, error: "Python agent script not found.", bridge: getBridgeRuntimeMetrics() };
  if (!base.knowledgeDirExists) return { ok: false, ...base, error: "Knowledge directory not found.", bridge: getBridgeRuntimeMetrics() };

  try {
    const result = await runPythonAgent({ action: "status" }, 120000);
    return { ok: true, ...base, ...(result.status || {}), bridge: getBridgeRuntimeMetrics() };
  } catch (error) {
    return { ok: false, ...base, error: error.message, bridge: getBridgeRuntimeMetrics() };
  }
}

async function reloadAeonAgentKnowledge() {
  const result = await runPythonAgent({ action: "reload" }, 180000);
  askResponseCache.clear();
  return result;
}

async function askAeonAgent(question, meta = {}) {
  bridgeStats.askRequests += 1;
  const responseMode = normalizeResponseMode(meta.mode);
  const history = Array.isArray(meta.history)
    ? meta.history
        .slice(-8)
        .map((entry) => ({
          question: String(entry?.question || "").trim().slice(0, 320),
          answer: String(entry?.answer || "").trim().slice(0, 520),
        }))
        .filter((entry) => entry.question || entry.answer)
    : [];

  const cacheKey = makeAskCacheKey(question, history, responseMode);
  const cached = getCachedAskResponse(cacheKey);
  if (cached) {
    bridgeStats.cacheHits += 1;
    recordLatency("ask", 1);
    recordLatency("all", 1);
    return cached;
  }
  bridgeStats.cacheMisses += 1;

  const result = await enqueueAsk(() =>
    runPythonAgent(
      {
        action: "ask",
        question,
        username: meta.username || "Attendee",
        history,
        mode: responseMode,
      },
      DEFAULT_TIMEOUT_MS,
    ),
  );
  setCachedAskResponse(cacheKey, result);
  return result;
}

async function rewriteAeonKnowledgeFromInput(trainingInput, meta = {}) {
  const result = await runPythonAgent(
    {
      action: "train_rewrite",
      input: String(trainingInput || ""),
      mode: String(meta.mode || "input"),
      username: String(meta.username || "Admin"),
      userId: String(meta.userId || ""),
    },
    180000,
  );
  askResponseCache.clear();
  return result;
}

async function primeAeonAgentRuntime() {
  try {
    await runPythonAgent({ action: "status" }, 120000);
    return true;
  } catch (error) {
    return false;
  }
}

process.once("exit", () => {
  stopPersistentWorker();
});

process.once("SIGINT", () => {
  stopPersistentWorker();
});

process.once("SIGTERM", () => {
  stopPersistentWorker();
});

module.exports = {
  askAeonAgent,
  getAeonAgentRuntimeStatus,
  reloadAeonAgentKnowledge,
  rewriteAeonKnowledgeFromInput,
  getAeonAgentStatusSnapshot,
  getAeonBridgeRuntimeMetrics: getBridgeRuntimeMetrics,
  primeAeonAgentRuntime,
};
