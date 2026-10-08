/**
 * Per-session analysis for the insights layer (facts insan, inscl, insrt,
 * insst, instr): one pass over a parsed session's events that counts tool
 * calls and errors by class, retries and loops, stalls and the recurring traps.
 * Pure — takes a parsed session, returns a small JSON-safe record.
 */
import {
  classifyError,
  isSuspectError,
  isCiWaitCommand,
  isFileTool,
  isLongRunningTool,
  isPathBleed,
  isShellTool,
  isTestRunnerCommand,
  isWriteTool,
  isWrongFolderError,
  repoArea,
  shellTargetDirs,
  sleepSeconds,
} from "./classify.js";
import { redactText } from "./redact.js";

/** Bump when the record shape or any classifier changes: invalidates the cache. */
export const INSIGHTS_VERSION = 2;

/** A gap this long with no event is a stall (agent waiting) or idle (human away). */
export const STALL_MS = 5 * 60 * 1000;
/** Longer than this is never one command running: the session was left and resumed. */
export const MAX_STALL_MS = 6 * 60 * 60 * 1000;
/** A model turn slower than this is a rate-limit pause or a suspended machine. */
export const MAX_MODEL_WAIT_MS = 30 * 60 * 1000;
/** Two CI polls further apart than this are separate waits. */
export const CI_POLL_GAP_MS = 30 * 60 * 1000;
/** A test command that keeps the agent waiting this long counts as a hang. */
export const TEST_HANG_MS = 10 * 60 * 1000;
/** Same call this many times inside LOOP_WINDOW calls is a loop. */
export const LOOP_REPEATS = 3;
export const LOOP_WINDOW = 12;
const RETRY_WINDOW = 20;
const EXAMPLE_LEN = 160;

function ms(ts) {
  if (!ts) return NaN;
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : NaN;
}

function oneLine(text, max = EXAMPLE_LEN) {
  const flat = redactText(String(text ?? "")).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function emptyTraps() {
  return {
    "wrong-folder": { count: 0, example: "" },
    "path-bleed": { count: 0, writes: 0, example: "" },
    "test-hang": { count: 0, ms: 0, example: "" },
    "ci-wait": { count: 0, ms: 0, sleepSec: 0, example: "" },
  };
}

/**
 * @param {object} session parsed session ({ cwd, events, startTime, endTime })
 * @returns {object} analysis record
 */
export function analyzeSession(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const cwd = typeof session?.cwd === "string" ? session.cwd : "";

  const calls = [];
  const callById = new Map();
  const classes = {};
  const examples = {};
  const traps = emptyTraps();
  const areas = new Map();
  const recentSigs = [];
  const sigErrored = new Map();
  const loopSigs = new Map();
  let errors = 0;
  let suspect = 0;
  let retries = 0;

  let stalls = 0;
  let stallMs = 0;
  let idleMs = 0;
  let longestStall = null;
  let prevTs = NaN;
  let firstTs = NaN;
  let prevType = "";
  let lastCiAt = NaN;

  for (const e of events) {
    const ts = ms(e.timestamp);
    if (Number.isFinite(ts) && Number.isFinite(prevTs)) {
      const gap = ts - prevTs;
      if (gap >= STALL_MS) {
        // The agent is the one waiting only while a command or sub-agent runs,
        // or while the model answers a tool result. Any other gap (a file read
        // held by a permission prompt, a laptop asleep), and any gap too long
        // to be one command, is a person away or a session resumed later.
        const pending = e.type === "tool_result" && e.toolUseId ? callById.get(e.toolUseId) : null;
        const toolWait = Boolean(pending) && isLongRunningTool(pending.name) && gap <= MAX_STALL_MS;
        const modelWait = e.type === "assistant" && prevType === "tool_result" && gap <= MAX_MODEL_WAIT_MS;
        if (toolWait || modelWait) {
          stalls += 1;
          stallMs += gap;
          if (!longestStall || gap > longestStall.ms) {
            longestStall = { ms: gap, after: toolWait ? oneLine(`${pending.name}: ${pending.input}`, 100) : "a model turn" };
          }
        } else {
          idleMs += gap;
        }
      }
    }
    prevType = e.type;
    if (Number.isFinite(ts)) {
      if (!Number.isFinite(firstTs)) firstTs = ts;
      // Harnesses that merge parallel work log events out of order; measuring
      // gaps from the latest time seen keeps them from being counted twice.
      if (!(ts < prevTs)) prevTs = ts;
    }

    if (Array.isArray(e.toolCalls)) {
      for (const tc of e.toolCalls) {
        const name = String(tc?.name || "tool");
        const input = typeof tc?.input === "string" ? tc.input : JSON.stringify(tc?.input ?? "");
        const call = { name, input, ts, sig: `${name}\u0000${input.slice(0, 400)}`, n: calls.length + 1 };
        calls.push(call);
        if (tc?.id) callById.set(tc.id, call);

        // Retry: the same call again after it already failed.
        if (sigErrored.has(call.sig) && calls.length - sigErrored.get(call.sig) <= RETRY_WINDOW) retries += 1;

        // Loop: the same call LOOP_REPEATS times within a short window.
        recentSigs.push(call.sig);
        if (recentSigs.length > LOOP_WINDOW) recentSigs.shift();
        let seen = 0;
        for (const s of recentSigs) if (s === call.sig) seen += 1;
        if (seen >= LOOP_REPEATS) loopSigs.set(call.sig, Math.max(loopSigs.get(call.sig) || 0, seen));

        if (isFileTool(name) && input.startsWith("/")) {
          const area = repoArea(cwd, input);
          if (area) areas.set(area, (areas.get(area) || 0) + 1);
          if (isPathBleed(cwd, input)) {
            traps["path-bleed"].count += 1;
            if (isWriteTool(name)) traps["path-bleed"].writes += 1;
            if (!traps["path-bleed"].example) traps["path-bleed"].example = oneLine(`${name} ${input}`);
          }
        } else if (isShellTool(name)) {
          for (const dir of shellTargetDirs(input)) {
            if (isPathBleed(cwd, dir)) {
              traps["path-bleed"].count += 1;
              if (!traps["path-bleed"].example) traps["path-bleed"].example = oneLine(input);
            }
          }
          if (isCiWaitCommand(input)) {
            // Time between polls is time spent waiting on CI, not working.
            if (Number.isFinite(ts) && Number.isFinite(lastCiAt) && ts - lastCiAt <= CI_POLL_GAP_MS) {
              traps["ci-wait"].ms += Math.max(0, ts - lastCiAt);
            }
            if (Number.isFinite(ts)) lastCiAt = ts;
            traps["ci-wait"].count += 1;
            traps["ci-wait"].sleepSec += sleepSeconds(input);
            if (!traps["ci-wait"].example) traps["ci-wait"].example = oneLine(input);
          }
        }
      }
    }

    if (e.type === "tool_result") {
      const call = e.toolUseId ? callById.get(e.toolUseId) : null;
      const waited = call && Number.isFinite(ts) && Number.isFinite(call.ts) ? Math.max(0, ts - call.ts) : 0;
      const shell = call ? isShellTool(call.name) : false;
      if (call && shell && isCiWaitCommand(call.input)) {
        traps["ci-wait"].ms += waited;
        if (Number.isFinite(ts)) lastCiAt = ts;
      }

      let cls = null;
      // Confirmed status survives truncation and outranks display-text heuristics.
      if (e.isError && !e.errorConfirmed && isSuspectError(e.text)) {
        suspect += 1;
      } else if (e.isError) {
        errors += 1;
        cls = classifyError(e.text);
        classes[cls] = (classes[cls] || 0) + 1;
        if (!examples[cls]) examples[cls] = oneLine(e.text);
        if (call) sigErrored.set(call.sig, call.n);
        if ((shell || !call) && isWrongFolderError(e.text)) {
          traps["wrong-folder"].count += 1;
          if (!traps["wrong-folder"].example) traps["wrong-folder"].example = oneLine(e.text);
        }
      }
      if (call && shell && isTestRunnerCommand(call.input) && (cls === "timeout" || waited >= TEST_HANG_MS)) {
        traps["test-hang"].count += 1;
        traps["test-hang"].ms += waited;
        if (!traps["test-hang"].example) traps["test-hang"].example = oneLine(call.input);
      }
    }
  }

  // Some harnesses record no session bounds: fall back to the event span.
  const start = Number.isFinite(ms(session?.startTime)) ? ms(session?.startTime) : firstTs;
  const end = Number.isFinite(ms(session?.endTime)) ? ms(session?.endTime) : prevTs;
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? end - start
    : Number(session?.durationMs) || 0;

  let area = null;
  let areaHits = 0;
  for (const [name, hits] of areas) {
    if (hits > areaHits) { area = name; areaHits = hits; }
  }

  let loopCalls = 0;
  let loopExample = "";
  let loopMax = 0;
  for (const [sig, seen] of loopSigs) {
    loopCalls += seen;
    if (seen > loopMax) { loopMax = seen; loopExample = oneLine(sig.replace("\u0000", ": "), 120); }
  }

  return {
    v: INSIGHTS_VERSION,
    cwd,
    start: Number.isFinite(start) ? start : null,
    durationMs,
    activeMs: Math.max(0, durationMs - idleMs),
    idleMs,
    calls: calls.length,
    errors,
    suspect,
    classes,
    examples,
    retries,
    loops: loopSigs.size,
    loopCalls,
    loopExample,
    stalls,
    stallMs,
    longestStall,
    traps,
    area,
  };
}
