/**
 * Claude remaining-window collector: GET /api/oauth/usage.
 * Utilization in the live API is a percent (25.0); stored as a 0-1 fraction.
 */
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { readKeychainPassword } from "../utils/macos-keychain.js";
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

export const DEFAULT_CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_LOGIN_HINT = "run `claude` and sign in again";

export function resolveClaudeUsageUrl() {
  return process.env.TRACEQUEST_CLAUDE_USAGE_URL || DEFAULT_CLAUDE_USAGE_URL;
}

export function claudeCredentialsPath(home = homedir()) {
  return join(home, ".claude", ".credentials.json");
}

/** The account's home from the user database — unlike $HOME, tests cannot point it at a fixture. */
function osAccountHome() {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
}

/** Keychain service under which Claude Code on macOS stores its OAuth login. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Claude Code on macOS keeps its live login in the login Keychain;
 * ~/.claude/.credentials.json is a leftover that stops being refreshed, so
 * reading only the file reported a signed-in user as unauthenticated (fact
 * clkeych). Only the account's own home on darwin has that Keychain item; any
 * other home (tests with HOME overridden, fixture hosts) or platform resolves
 * to null without spawning.
 */
export function readClaudeKeychain(home, { platform = process.platform, accountHome = osAccountHome() } = {}) {
  if (platform !== "darwin" || !accountHome || home !== accountHome) return Promise.resolve(null);
  return readKeychainPassword(CLAUDE_KEYCHAIN_SERVICE);
}

function loadClaudeToken(home, readFile, credentialText) {
  const text = credentialText != null ? credentialText : readFile(claudeCredentialsPath(home));
  if (text == null) return { token: null, plan: null, secrets: [] };
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return { token: null, plan: null, secrets: [], error: "malformed credentials.json" };
  }
  const oauth = data?.claudeAiOauth || {};
  const token = typeof oauth.accessToken === "string" ? oauth.accessToken : null;
  const plan = oauth.rateLimitTier || oauth.subscriptionType || null;
  return { token, plan, secrets: collectSecrets([token]) };
}

const KIND_TO_WINDOW = {
  session: "five_hour",
  five_hour: "five_hour",
  weekly: "seven_day",
  seven_day: "seven_day",
};

function windowFrom(id, block) {
  if (!block || typeof block !== "object") return null;
  const utilization = percentToFraction(block.utilization);
  if (utilization == null) return null;
  return { id, utilization, resetsAt: toIso(pick(block, "resets_at", "resetsAt")) };
}

export async function collectClaudeUsage({
  home = homedir(),
  fetchImpl = fetch,
  readFile = defaultReadFile,
  credentialText = null,
  readKeychain = readClaudeKeychain,
  timeoutMs,
} = {}) {
  let loaded = null;
  if (credentialText == null) {
    const keychainText = await readKeychain(home);
    if (keychainText) {
      const fromKeychain = loadClaudeToken(home, readFile, keychainText);
      if (fromKeychain.token) loaded = fromKeychain;
    }
  }
  if (!loaded) loaded = loadClaudeToken(home, readFile, credentialText);
  const secrets = loaded.secrets;
  const finish = (row) => {
    assertNoSecrets(row, secrets, { label: "claude usage row" });
    return row;
  };
  if (loaded.error) return finish(harnessRow({ id: "claude", status: "error", message: loaded.error }));
  if (!loaded.token) return finish(harnessRow({ id: "claude", status: "missing", message: "no credential" }));

  const url = resolveClaudeUsageUrl();
  let result;
  try {
    result = await fetchUsageJson({
      url,
      fetchImpl,
      timeoutMs,
      headers: {
        Authorization: `Bearer ${loaded.token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
  } catch (err) {
    return finish(harnessRow({
      id: "claude",
      status: "error",
      message: err.message,
    }));
  }

  if (result.status === 401) {
    return finish(harnessRow({
      id: "claude",
      status: "unauthenticated",
      message: unauthenticatedMessage(CLAUDE_LOGIN_HINT),
    }));
  }
  if (!result.ok || !result.json || typeof result.json !== "object") {
    return finish(harnessRow({
      id: "claude",
      status: "error",
      message: `HTTP ${result.status}`,
    }));
  }

  const body = result.json;
  const windows = [];
  const five = windowFrom("five_hour", body.five_hour || body.fiveHour);
  const seven = windowFrom("seven_day", body.seven_day || body.sevenDay);
  if (five) windows.push(five);
  if (seven) windows.push(seven);

  let limitingWindow = null;
  if (Array.isArray(body.limits)) {
    const active = body.limits.find((row) => row && row.is_active);
    if (active?.kind && KIND_TO_WINDOW[active.kind]) limitingWindow = KIND_TO_WINDOW[active.kind];
  }
  if (!limitingWindow && windows.length) {
    limitingWindow = windows.reduce((best, win) => (win.utilization >= best.utilization ? win : best)).id;
  }

  return finish(harnessRow({
    id: "claude",
    status: "ok",
    plan: loaded.plan,
    windows,
    limitingWindow,
  }));
}
