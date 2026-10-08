/** Human-readable `tracequest limits` lines and chip labels. */

export function limitingWindow(harness) {
  const windows = harness?.windows || [];
  if (!windows.length) return null;
  if (harness.limitingWindow) {
    return windows.find((w) => w.id === harness.limitingWindow) || windows[0];
  }
  return windows.reduce((best, win) => (win.utilization >= best.utilization ? win : best));
}

export function formatPercent(utilization) {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return "";
  const pct = Math.round(utilization * 100);
  return `${pct}%`;
}

/** Used and remaining percents. Remaining clamps at 0 once utilization passes 1. */
export function usageAmounts(utilization) {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const used = Math.round(utilization * 100);
  const left = Math.max(0, 100 - used);
  return { used, left };
}

/** Plan-window id as a short label (`five_hour` → `five hour`). */
export function usageWindowLabel(id) {
  return String(id || "").replace(/_/g, " ");
}

export function relativeReset(iso, now) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return iso;
  if (ms <= 0) return "reset now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

export function formatHarnessLine(harness, { now = new Date() } = {}) {
  const id = harness.id;
  if (harness.status !== "ok") {
    const extra = harness.message ? `  ${harness.message}` : "";
    return `${id}  ${harness.status}${extra}`;
  }
  const win = limitingWindow(harness);
  const plan = harness.plan || "";
  if (!win) return `${id}  ${plan}`.trimEnd();
  const reset = relativeReset(win.resetsAt, now);
  return [id, plan, `${win.id} ${formatPercent(win.utilization)}`, reset].filter(Boolean).join("  ");
}

export function formatUsageLimits(snapshot, { now = new Date() } = {}) {
  const rows = snapshot?.harnesses || [];
  if (!rows.length) return "no harness usage data";
  return rows.map((h) => formatHarnessLine(h, { now })).join("\n");
}

export function usageChipLabel(harness, host) {
  const id = host ? `${harness.id}@${host}` : harness.id;
  if (harness.status === "unauthenticated") return `${id} sign-in`;
  const win = limitingWindow(harness);
  if (!win) return harness.plan ? `${id} ${harness.plan}` : id;
  return `${id} ${formatPercent(win.utilization)}`;
}

export function usageChipTitle(harness, { host = null, collectedAt = null, now = new Date() } = {}) {
  const lines = [];
  if (harness.status && harness.status !== "ok") lines.push(harness.status);
  if (harness.message) lines.push(harness.message);
  if (harness.plan) lines.push(harness.plan);
  for (const win of harness.windows || []) {
    const reset = relativeReset(win.resetsAt, now);
    lines.push(`${win.id} ${formatPercent(win.utilization)}${reset ? ` · ${reset}` : ""}`);
  }
  if (host && collectedAt) lines.push(`imported ${host} at ${collectedAt}`);
  return lines.join("\n");
}
