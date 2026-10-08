/**
 * Measurement primitives shared by every bench script.
 *
 * Wall clock, RSS high-water mark, and CPU time. CPU for a child process is
 * read from /proc/<pid>/stat on Linux (utime+stime in clock ticks) because
 * process.cpuUsage() only reports the calling process.
 */
import fs from "node:fs";
import { performance } from "node:perf_hooks";

/** Clock ticks per second; _SC_CLK_TCK is 100 on every Linux tracequest supports. */
const CLK_TCK = 100;

export function nowMs() {
  return performance.now();
}

/** Run fn once, returning { ms, value }. */
export async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

/** Run fn `iters` times after `warmup` warmups; returns per-op statistics. */
export async function timedSeries(fn, { iters = 10, warmup = 2 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return summarise(samples);
}

export function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? sum / sorted.length : 0,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    samples: sorted,
  };
}

function pct(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** Total CPU seconds (user+system) consumed by `pid` so far, or null if it is gone. */
export function procCpuSeconds(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // comm may contain spaces and parentheses; fields are positional after the last ')'.
  const after = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const utime = Number(after[11]);
  const stime = Number(after[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return (utime + stime) / CLK_TCK;
}

/** Resident set size of `pid` in bytes, or null if it is gone. */
export function procRssBytes(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/statm`, "utf8");
  } catch {
    return null;
  }
  const rssPages = Number(raw.split(" ")[1]);
  if (!Number.isFinite(rssPages)) return null;
  return rssPages * 4096;
}

/**
 * Sample a child process for `durationMs`, returning idle CPU percent and the
 * RSS trend. `rssSlopeBytesPerMin` is the least-squares slope: a flat run is
 * near zero, a leak climbs.
 */
export async function sampleProcess(pid, { durationMs = 300_000, intervalMs = 1000 } = {}) {
  const rss = [];
  const t0 = Date.now();
  const cpu0 = procCpuSeconds(pid);
  if (cpu0 === null) throw new Error(`sampleProcess: pid ${pid} is not running`);

  while (Date.now() - t0 < durationMs) {
    await sleep(intervalMs);
    const bytes = procRssBytes(pid);
    if (bytes === null) break;
    rss.push({ tMs: Date.now() - t0, bytes });
  }

  const cpu1 = procCpuSeconds(pid);
  const elapsedMs = Date.now() - t0;
  const cpuSeconds = cpu1 === null ? null : cpu1 - cpu0;

  // Heap warm-up and a leak both show a positive slope over a whole run. They
  // separate on the SECOND half: warm-up flattens, a leak does not. Reporting
  // only the whole-run slope made a plateau look like an unbounded climb.
  const half = Math.floor(rss.length / 2);
  return {
    elapsedMs,
    cpuSeconds,
    cpuPercent: cpuSeconds === null ? null : (cpuSeconds / (elapsedMs / 1000)) * 100,
    rssStartBytes: rss[0]?.bytes ?? null,
    rssEndBytes: rss[rss.length - 1]?.bytes ?? null,
    rssPeakBytes: rss.reduce((m, s) => Math.max(m, s.bytes), 0),
    rssSlopeBytesPerMin: slopePerMinute(rss),
    rssSlopeFirstHalfBytesPerMin: slopePerMinute(rss.slice(0, half)),
    rssSlopeSecondHalfBytesPerMin: slopePerMinute(rss.slice(half)),
    rssMidBytes: rss[half]?.bytes ?? null,
    samples: rss.length,
  };
}

function slopePerMinute(points) {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((a, p) => a + p.tMs, 0) / n;
  const meanY = points.reduce((a, p) => a + p.bytes, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.tMs - meanX) * (p.bytes - meanY);
    den += (p.tMs - meanX) ** 2;
  }
  if (den === 0) return 0;
  return (num / den) * 60_000;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function mb(bytes) {
  return bytes === null || bytes === undefined ? null : +(bytes / 1024 / 1024).toFixed(1);
}

export function ms(value) {
  return value === null || value === undefined ? null : +value.toFixed(1);
}
