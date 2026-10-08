import assert from "node:assert/strict";

/**
 * Assert a wall-clock perf budget, unless perf assertions are disabled.
 *
 * These budgets are real regression guards (see CLAUDE.md), but wall-clock time
 * is unstable on shared CI runners — a micro-benchmark that passes comfortably on
 * a dev machine can exceed a tight budget on a noisy hosted runner. With
 * `TRACEQUEST_SKIP_PERF_ASSERTS=1` the workload and every surrounding functional
 * assertion still run; only this timing comparison is skipped. Left unset (local
 * runs, the macOS release runner, dedicated perf jobs) the budget is enforced.
 *
 * Drop-in for `assert.ok(<timingCondition>, message)`.
 */
export function assertPerf(condition, message) {
  if (process.env.TRACEQUEST_SKIP_PERF_ASSERTS === "1") return;
  assert.ok(condition, message);
}
