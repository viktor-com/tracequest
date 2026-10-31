/**
 * Resident search for `tracequest search` and `tracequest handoff`
 * (search-daemon facts). A short-lived CLI process spends most of a search
 * starting up, discovering sessions and loading the index; a background
 * process keeps the session list and the search index in memory instead,
 * current through the same data-root watchers and incremental refresh serve
 * uses, and answers each search with exactly what the command prints. While a
 * refresh runs it answers from the index it has (show the current index,
 * update after), like serve (fact sidx4).
 *
 * The first search that finds none starts one and searches in-process; the
 * process exits after IDLE_MS without a search, or when its code changes.
 * One process per code, data, cache directory and TRACEQUEST_* environment.
 * Off on Windows, with TRACEQUEST_NO_SEARCH_DAEMON=1, and when data roots are
 * not watched (TRACEQUEST_SKIP_LR_WATCH=1).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { connect, createServer } from "node:net";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROTOCOL = 1;
/** A resident search exits after this long without a search. */
const IDLE_MS = 30 * 60_000;
/** A start in progress is not repeated for this long. */
const START_GRACE_MS = 30_000;
/** Longest wait for an answer before searching in-process. */
const ANSWER_TIMEOUT_MS = 30_000;
/** Most workers a resident search runs. */
const SEARCH_WORKERS = 8;

export function searchDaemonEnabled() {
  return process.platform !== "win32" &&
    process.env.TRACEQUEST_NO_SEARCH_DAEMON !== "1" &&
    process.env.TRACEQUEST_SKIP_LR_WATCH !== "1";
}

function cacheDir() {
  return process.env.TRACEQUEST_CACHE_DIR || join(homedir(), ".cache", "tracequest");
}

/** Socket of the resident search for this code, data and environment. */
export function searchDaemonSocketPath() {
  let version = "";
  try {
    version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {
    // Unversioned checkout: the path alone names the code.
  }
  const env = Object.keys(process.env).filter((key) => key.startsWith("TRACEQUEST_")).sort()
    .map((key) => `${key}=${process.env[key]}`);
  const id = createHash("sha256")
    .update(JSON.stringify([PROTOCOL, ROOT, version, process.execPath, homedir(), cacheDir(), env]))
    .digest("hex").slice(0, 16);
  const path = join(cacheDir(), `search-${id}.sock`);
  // Unix socket paths are limited to about 100 bytes.
  return path.length <= 100 ? path : join(tmpdir(), `tracequest-search-${id}.sock`);
}

/**
 * The resident search's answer to `req` ({ p, currentProject, color }) as
 * { stdout, stderr }, or null when there is none to ask (one is started then).
 */
export async function askSearchDaemon(req) {
  if (!searchDaemonEnabled()) return null;
  const path = searchDaemonSocketPath();
  let answer = null;
  try {
    answer = await exchange(path, { v: PROTOCOL, ...req });
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ECONNREFUSED") startSearchDaemon(path);
    return null;
  }
  return answer && answer.ok ? answer : null;
}

function exchange(path, body) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let text = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("search daemon timed out"));
    }, ANSWER_TIMEOUT_MS);
    sock.setEncoding("utf8");
    // One line, and this side stays open: the resident search sees this process leave (fact sd3).
    sock.on("connect", () => sock.write(`${JSON.stringify(body)}\n`));
    sock.on("data", (chunk) => { text += chunk; });
    sock.on("end", () => {
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let _started = false;

/** Whether this process just started a resident search (it indexes what changed next; fact sd2). */
export function residentSearchStarted() {
  return _started;
}

function startSearchDaemon(path) {
  const marker = `${path}.starting`;
  try {
    if (Date.now() - statSync(marker).mtimeMs < START_GRACE_MS) return;
  } catch {
    // No start in progress.
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(marker, "w"));
    // A larger young generation: a search's short-lived maps are collected in fewer, cheaper pauses.
    const child = spawn(process.execPath, ["--max-semi-space-size=32", join(ROOT, "src/cli/search-daemon-main.js"), path], {
      detached: true,
      stdio: "ignore",
      cwd: homedir(),
      env: process.env,
    });
    child.unref();
    _started = Boolean(child.pid);
  } catch {
    // Searching in-process is always possible.
  }
}

/** Run the resident search on `path` until it idles out (search-daemon-main.js). */
export async function runSearchDaemon(path) {
  const [{ setSrcHotReload, startLiveReloadWatchers, defaultDataRoots, registerDataUpdateListener },
    { resolveSessionsAndIndexAsync }, { findSessions, buildIndex }, { resolveOpenCodeDbPath },
    { searchIo, printNoSessions, printSearchResults, searchOptions, finishSearchResults }, { setColorEnabled, k },
    { searchSessionsAsync }, { createWorkerPool }, { getSearchIndex }, { hasPendingDataChanges }] = await Promise.all([
    import("../server/server-live-reload.js"),
    import("../routes/route-cache.js"),
    import("../sessions.js"),
    import("../sessions/session-discovery-paths.js"),
    import("./cli-search.js"),
    import("./cli-color.js"),
    import("../sessions/scan-queries.js"),
    import("../server/worker-pool.js"),
    import("../sessions/search-index.js"),
    import("../sessions/session-changes.js"),
  ]);
  const marker = `${path}.starting`;
  const exit = () => {
    try { unlinkSync(path); } catch { /* already gone */ }
    process.exit(0);
  };
  // New code (an upgrade or an edit) gets a new resident search.
  for (const target of [join(ROOT, "src"), join(ROOT, "package.json")]) {
    try {
      watch(target, { recursive: true, persistent: false }, exit);
    } catch {
      // Unwatchable here: the idle exit still retires this process.
    }
  }
  setSrcHotReload(false);
  startLiveReloadWatchers({ srcDir: null, dataRoots: defaultDataRoots(), openCodeDbPath: resolveOpenCodeDbPath(homedir()) });
  const deps = { findSessions, buildIndex };
  // Apply each data change when it lands, as serve does (fact hleager).
  registerDataUpdateListener(() => {
    resolveSessionsAndIndexAsync(null, deps).catch(() => {});
  });
  await resolveSessionsAndIndexAsync(null, deps);

  // A search's per-session file work (snippet scans, near-words scoring the
  // sidecar does not do) runs side by side in workers.
  const slots = Math.max(1, Math.min(SEARCH_WORKERS, availableParallelism() - 1));
  // One worker per slot, so work sent to a slot always reaches the same worker.
  const workers = Array.from({ length: slots }, () => createWorkerPool({ url: new URL("../sessions/search-worker.js", import.meta.url), slots: 1, maxHeavy: 1 }));
  // A session's work always goes to the same batch slot (by path), so a worker's line cache serves its repeats.
  const slotOf = (session) => {
    let h = 0;
    for (const c of String(session?.path || "")) h = (h * 31 + c.charCodeAt(0)) | 0;
    return Math.abs(h) % slots;
  };
  /** [slot, [[index, item], ...]] for the slots that get work. */
  const inBatches = (items) => {
    const bySlot = Array.from({ length: slots }, () => []);
    items.forEach((item, i) => bySlot[slotOf(item.session ?? item)].push([i, item]));
    return bySlot.map((batch, slot) => [slot, batch]).filter(([, batch]) => batch.length);
  };
  const runStep = async (step) => {
    if (step.nearScans) {
      const { args, sessions } = step.nearScans;
      const scores = new Array(sessions.length);
      await Promise.all(inBatches(sessions).map(async ([slot, batch]) => {
        try {
          const reply = await workers[slot].run({ near: { args, sessions: batch.map(([, session]) => session) } }).promise;
          if (reply.scores) batch.forEach(([i], j) => { scores[i] = reply.scores[j]; });
        } catch {
          // Left undefined: the search scores these itself.
        }
      }));
      return scores;
    }
    if (step.phraseScans) {
      const answered = new Map();
      await Promise.all(inBatches(step.phraseScans).map(async ([slot, batch]) => {
        try {
          const { scans } = await workers[slot].run({ phraseScans: batch.map(([, request]) => request) }).promise;
          batch.forEach(([, request], j) => { if (scans?.[j]) answered.set(request.path, scans[j]); });
        } catch {
          // A failed batch is checked by the search itself.
        }
      }));
      return answered;
    }
    const scanned = new Map();
    await Promise.all(inBatches(step.snippetScans).map(async ([slot, batch]) => {
      try {
        const { scans } = await workers[slot].run({ requests: batch.map(([, { session, terms }]) => ({ session, terms })) }).promise;
        batch.forEach(([, request], j) => { if (scans[j]) scanned.set(request.path, new Map(scans[j])); });
      } catch {
        // A failed batch is scanned by the search itself.
      }
    }));
    return scanned;
  };

  // Workers started and the fuzzy-match index built before the first search.
  await Promise.all([
    ...workers.map((worker) => worker.run({ requests: [] }).promise.catch(() => {})),
    getSearchIndex().buildTrigramsAsync(),
  ]);

  let idle = setTimeout(exit, IDLE_MS);
  const answer = async (req, isGone) => {
    if (!req || req.v !== PROTOCOL || !req.p) return { ok: false };
    // A client that went away (Ctrl-C) stops the search at its next step (search-daemon facts).
    const stepUnlessGone = (step) => {
      if (isGone()) throw new Error("search client went away");
      return runStep(step);
    };
    // A search never waits for a refresh in progress (fact sd1).
    const { sessions, index, stale } = await resolveSessionsAndIndexAsync(null, deps, { staleAfterMs: 0 });
    const results = sessions.length
      ? finishSearchResults(req.p, await searchSessionsAsync(sessions, index, req.p.query, req.p.limit, searchOptions(req.p, req.currentProject), stepUnlessGone))
      : [];
    const out = [];
    const err = [];
    // Formatting runs without an await, so one request's color never leaks into another's.
    setColorEnabled(Boolean(req.color));
    try {
      const io = searchIo(req.p, {
        log: (line) => out.push(`${line}\n`),
        err: (line) => err.push(`${line}\n`),
        write: (text) => out.push(text),
      });
      io.status(k.dim("Discovering sessions..."));
      if (!sessions.length) {
        printNoSessions(req.p, io, "No sessions found.");
      } else {
        io.status(k.dim(`Building index for ${sessions.length} sessions...`));
        const n = sessions.length;
        // Said as it is: an index from before the latest changes is not called up to date (fact sd1).
        err.push(stale || index?.deferredStale || hasPendingDataChanges()
          ? `tracequest: searching the index from before the latest session changes while they are indexed (${n} session${n !== 1 ? "s" : ""})\n`
          : `tracequest: index up to date (${n} session${n !== 1 ? "s" : ""}, ${n} cached)\n`);
        printSearchResults(req.p, results, sessions, io);
      }
    } finally {
      setColorEnabled(null);
    }
    return { ok: true, stdout: out.join(""), stderr: err.join("") };
  };
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    clearTimeout(idle);
    idle = setTimeout(exit, IDLE_MS);
    serveSearchSocket(sock, answer);
  });
  await listen(server, path);
  try { chmodSync(path, 0o600); } catch { /* best effort: the cache dir is the user's */ }
  try { unlinkSync(marker); } catch { /* already gone */ }
  // A removed socket (the cache directory was cleared) retires this process too.
  setInterval(() => {
    try {
      statSync(path);
    } catch {
      exit();
    }
  }, 10_000).unref();
  process.on("SIGTERM", exit);
  process.on("SIGINT", exit);
}

/**
 * One client connection of the resident search (fact sd3): the request is
 * the first line; `answer(req, isGone)` runs once it is in and its result
 * goes back as the reply. The client keeps its side open while it waits, so
 * its end (it exited or was interrupted) makes isGone() true and the search
 * stops at its next step.
 */
export function serveSearchSocket(sock, answer) {
  let text = "";
  let started = false;
  let gone = false;
  const start = (line) => {
    started = true;
    let req = null;
    try {
      req = JSON.parse(line);
    } catch {
      // Answered as unusable below.
    }
    answer(req, () => gone || sock.destroyed).then(
      (res) => sock.end(JSON.stringify(res)),
      (err) => sock.end(JSON.stringify({ ok: false, error: String(err?.stack || err) })),
    );
  };
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    if (started) return;
    text += chunk;
    const nl = text.indexOf("\n");
    if (nl !== -1) start(text.slice(0, nl));
  });
  sock.on("end", () => {
    if (started) gone = true;
    else start(text);
  });
  sock.on("close", () => { gone = true; });
  sock.on("error", () => {});
}

/** Listen on `path`; a socket left by a process that is gone is replaced, a live one is not. */
function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code !== "EADDRINUSE") return reject(err);
      const probe = connect(path);
      probe.on("connect", () => {
        probe.destroy();
        reject(err);
      });
      probe.on("error", () => {
        try { unlinkSync(path); } catch { /* raced with another start */ }
        server.listen(path, resolve);
      });
    });
    server.listen(path, resolve);
  });
}
