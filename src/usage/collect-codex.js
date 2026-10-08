/**
 * Codex remaining-window collector: GET /api/codex/usage on the ChatGPT
 * backend (pinned from the installed CLI binary: base
 * https://chatgpt.com/backend-api/codex + path /api/codex/usage).
 *
 * RateLimitWindow: used_percent (0-100), window_duration_mins, resets_at.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import {
  defaultReadFile,
  fetchUsageJson,
  harnessRow,
  percentToFraction,
  pick,
  toIso,
  unauthenticatedMessage,
} from "./http.js";
import { assertNoSecrets, collectSecrets } from "./redact.js";

export const DEFAULT_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/api/codex/usage";
export const CODEX_LOGIN_HINT = "run `codex login`";

export function resolveCodexUsageUrl() {
  return process.env.TRACEQUEST_CODEX_USAGE_URL || DEFAULT_CODEX_USAGE_URL;
}

export function codexAuthPath(home = homedir()) {
  return join(home, ".codex", "auth.json");
}

function loadCodexAuth(home, readFile, credentialText) {
  const text = credentialText != null ? credentialText : readFile(codexAuthPath(home));
  if (text == null) return { token: null, accountId: null, secrets: [] };
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return { token: null, accountId: null, secrets: [], error: "malformed auth.json" };
  }
  const tokens = data?.tokens || {};
  const token = typeof tokens.access_token === "string" ? tokens.access_token : null;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
  return {
    token,
    accountId,
    secrets: collectSecrets([token, tokens.id_token]),
  };
}

function windowFrom(id, block) {
  if (!block || typeof block !== "object") return null;
  const used = pick(block, "used_percent", "usedPercent");
  const utilization = percentToFraction(typeof used === "number" ? used : Number(used));
  if (utilization == null) return null;
  return {
    id,
    utilization,
    resetsAt: toIso(pick(block, "resets_at", "resetsAt")),
  };
}

export async function collectCodexUsage({
  home = homedir(),
  fetchImpl = fetch,
  readFile = defaultReadFile,
  credentialText = null,
  timeoutMs,
} = {}) {
  const loaded = loadCodexAuth(home, readFile, credentialText);
  const secrets = loaded.secrets;
  const finish = (row) => {
    assertNoSecrets(row, secrets, { label: "codex usage row" });
    return row;
  };
  if (loaded.error) return finish(harnessRow({ id: "codex", status: "error", message: loaded.error }));
  if (!loaded.token || !loaded.accountId) {
    return finish(harnessRow({ id: "codex", status: "missing", message: "no credential" }));
  }

  const url = resolveCodexUsageUrl();
  let result;
  try {
    result = await fetchUsageJson({
      url,
      fetchImpl,
      timeoutMs,
      headers: {
        Authorization: `Bearer ${loaded.token}`,
        "ChatGPT-Account-Id": loaded.accountId,
        originator: "codex_cli_rs",
        Accept: "application/json",
      },
    });
  } catch (err) {
    return finish(harnessRow({ id: "codex", status: "error", message: err.message }));
  }

  if (result.status === 401) {
    return finish(harnessRow({
      id: "codex",
      status: "unauthenticated",
      message: unauthenticatedMessage(CODEX_LOGIN_HINT),
    }));
  }
  if (!result.ok || !result.json || typeof result.json !== "object") {
    return finish(harnessRow({ id: "codex", status: "error", message: `HTTP ${result.status}` }));
  }

  const body = result.json;
  const snapshot = body.rate_limit || body.rateLimit || body.rate_limits || body.rateLimits || body;
  const windows = [];
  const primary = windowFrom("primary", snapshot.primary);
  const secondary = windowFrom("secondary", snapshot.secondary);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  if (!windows.length) {
    return finish(harnessRow({
      id: "codex",
      status: "error",
      message: "unrecognized usage payload",
    }));
  }

  const plan = pick(body, "plan_type", "planType") || pick(snapshot, "plan_type", "planType") || null;
  const limitingWindow = windows.reduce((best, win) => (win.utilization >= best.utilization ? win : best)).id;
  return finish(harnessRow({
    id: "codex",
    status: "ok",
    plan: typeof plan === "string" ? plan : null,
    windows,
    limitingWindow,
  }));
}
