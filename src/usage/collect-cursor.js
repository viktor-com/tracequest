/**
 * Cursor remaining-window collector: connect-rpc
 * /aiserver.v1.DashboardService/GetCurrentPeriodUsage (+ GetPlanInfo).
 * Same JSON Content-Type + authorization Bearer style as cursor-cloud.
 */
import { homedir } from "node:os";
import { loadLocalCursorSessionToken, resolveCursorApi2Base } from "../import/cursor-cloud-import.js";
import {
  fetchUsageJson,
  harnessRow,
  percentToFraction,
  pick,
  toIso,
  unauthenticatedMessage,
} from "./http.js";
import { assertNoSecrets, collectSecrets } from "./redact.js";

/** Env override is TRACEQUEST_CURSOR_API2_URL via resolveCursorApi2Base. */
export const CURSOR_USAGE_PATH = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
export const CURSOR_PLAN_PATH = "/aiserver.v1.DashboardService/GetPlanInfo";
export const CURSOR_LOGIN_HINT = "sign in again in Cursor";

function loadCursorToken(home, readCursorToken, cursorToken) {
  if (typeof cursorToken === "string" && cursorToken) {
    return { token: cursorToken, secrets: collectSecrets([cursorToken]) };
  }
  const loader = readCursorToken || ((h) => loadLocalCursorSessionToken(h));
  const token = loader(home);
  return { token: token || null, secrets: collectSecrets([token]) };
}

async function postDashboard(path, token, fetchImpl, timeoutMs) {
  const base = resolveCursorApi2Base().replace(/\/+$/, "");
  return fetchUsageJson({
    url: `${base}${path}`,
    fetchImpl,
    timeoutMs,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: {},
  });
}

function planUsageWindow(body) {
  const usage = pick(body, "planUsage", "plan_usage");
  if (!usage || typeof usage !== "object") return null;
  const pct = pick(usage, "totalPercentUsed", "total_percent_used");
  let utilization = percentToFraction(typeof pct === "number" ? pct : Number(pct));
  if (utilization == null) {
    const remaining = Number(pick(usage, "remaining"));
    const limit = Number(pick(usage, "limit"));
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
      utilization = Math.max(0, (limit - remaining) / limit);
    }
  }
  if (utilization == null) return null;
  const end = pick(body, "billingCycleEnd", "billing_cycle_end");
  return { id: "period", utilization, resetsAt: toIso(end) };
}

export async function collectCursorUsage({
  home = homedir(),
  fetchImpl = fetch,
  readCursorToken,
  cursorToken = null,
  timeoutMs,
} = {}) {
  const loaded = loadCursorToken(home, readCursorToken, cursorToken);
  const secrets = loaded.secrets;
  const finish = (row) => {
    assertNoSecrets(row, secrets, { label: "cursor usage row" });
    return row;
  };
  if (!loaded.token) return finish(harnessRow({ id: "cursor", status: "missing", message: "no credential" }));

  let usageRes;
  let planRes;
  try {
    [usageRes, planRes] = await Promise.all([
      postDashboard(CURSOR_USAGE_PATH, loaded.token, fetchImpl, timeoutMs),
      postDashboard(CURSOR_PLAN_PATH, loaded.token, fetchImpl, timeoutMs).catch(() => null),
    ]);
  } catch (err) {
    return finish(harnessRow({ id: "cursor", status: "error", message: err.message }));
  }

  if (usageRes.status === 401 || usageRes.json?.code === "unauthenticated") {
    return finish(harnessRow({
      id: "cursor",
      status: "unauthenticated",
      message: unauthenticatedMessage(CURSOR_LOGIN_HINT),
    }));
  }
  if (!usageRes.ok || !usageRes.json || typeof usageRes.json !== "object") {
    return finish(harnessRow({ id: "cursor", status: "error", message: `HTTP ${usageRes.status}` }));
  }

  const win = planUsageWindow(usageRes.json);
  if (!win) {
    return finish(harnessRow({
      id: "cursor",
      status: "error",
      message: "unrecognized usage payload",
    }));
  }

  const planInfo = pick(planRes?.json, "planInfo", "plan_info") || {};
  const plan = pick(planInfo, "planName", "plan_name") || null;
  return finish(harnessRow({
    id: "cursor",
    status: "ok",
    plan: typeof plan === "string" ? plan : null,
    windows: [win],
    limitingWindow: "period",
  }));
}
