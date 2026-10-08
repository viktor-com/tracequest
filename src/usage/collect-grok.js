/**
 * Grok subscription collector: GET {origin}/user?include=subscription.
 * The proven payload carries subscriptionTier and no remaining-window
 * fields — status ok with empty windows is honest absence of a meter.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import {
  defaultReadFile,
  fetchUsageJson,
  harnessRow,
  unauthenticatedMessage,
} from "./http.js";
import { assertNoSecrets, collectSecrets } from "./redact.js";

export const DEFAULT_GROK_ORIGIN = "https://cli-chat-proxy.grok.com/v1";
export const GROK_LOGIN_HINT = "run `grok login`";

export function grokAuthPath(home = homedir()) {
  return join(home, ".grok", "auth.json");
}

export function grokSettingsPath(home = homedir()) {
  return join(home, ".grok", "settings_cache.json");
}

export function resolveGrokUsageUrl(home, readFile) {
  if (process.env.TRACEQUEST_GROK_USAGE_URL) return process.env.TRACEQUEST_GROK_USAGE_URL;
  let origin = DEFAULT_GROK_ORIGIN;
  try {
    const raw = readFile(grokSettingsPath(home));
    if (raw) {
      const wrap = JSON.parse(raw);
      const payload = typeof wrap.payload === "string" ? JSON.parse(wrap.payload) : wrap.payload;
      if (payload?.origin) origin = String(payload.origin).replace(/\/+$/, "");
    }
  } catch {
    /* default origin */
  }
  return `${origin.replace(/\/+$/, "")}/user?include=subscription`;
}

function loadGrokToken(home, readFile, credentialText) {
  const text = credentialText != null ? credentialText : readFile(grokAuthPath(home));
  if (text == null) return { token: null, secrets: [] };
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return { token: null, secrets: [], error: "malformed auth.json" };
  }
  if (!data || typeof data !== "object") return { token: null, secrets: [] };
  for (const entry of Object.values(data)) {
    if (entry && typeof entry === "object" && typeof entry.key === "string" && entry.key) {
      return { token: entry.key, secrets: collectSecrets([entry.key, entry.email]) };
    }
  }
  return { token: null, secrets: [] };
}

export async function collectGrokUsage({
  home = homedir(),
  fetchImpl = fetch,
  readFile = defaultReadFile,
  credentialText = null,
  timeoutMs,
} = {}) {
  const loaded = loadGrokToken(home, readFile, credentialText);
  const secrets = loaded.secrets;
  const finish = (row) => {
    assertNoSecrets(row, secrets, { label: "grok usage row" });
    return row;
  };
  if (loaded.error) return finish(harnessRow({ id: "grok", status: "error", message: loaded.error }));
  if (!loaded.token) return finish(harnessRow({ id: "grok", status: "missing", message: "no credential" }));

  const url = resolveGrokUsageUrl(home, readFile);
  let result;
  try {
    result = await fetchUsageJson({
      url,
      fetchImpl,
      timeoutMs,
      headers: {
        Authorization: `Bearer ${loaded.token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return finish(harnessRow({ id: "grok", status: "error", message: err.message }));
  }

  if (result.status === 401) {
    return finish(harnessRow({
      id: "grok",
      status: "unauthenticated",
      message: unauthenticatedMessage(GROK_LOGIN_HINT),
    }));
  }
  if (!result.ok || !result.json || typeof result.json !== "object") {
    return finish(harnessRow({ id: "grok", status: "error", message: `HTTP ${result.status}` }));
  }

  const plan = result.json.subscriptionTier || result.json.subscription_tier || null;
  return finish(harnessRow({
    id: "grok",
    status: "ok",
    plan: typeof plan === "string" ? plan : null,
    windows: [],
  }));
}
