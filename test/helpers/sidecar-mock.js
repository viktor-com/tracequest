/**
 * Parallel-safe sidecar mocks via TRACEQUEST_SIDECAR_PATH (see index-writers detectSidecar).
 */
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const IW_URL = new URL("../../src/sessions/index-writers.js", import.meta.url);

export const SIDECAR_SKIP_ENV = {
  NO_SIDECAR: "TRACEQUEST_NO_SIDECAR",
};

export const SIDECAR_PATH_ENV = "TRACEQUEST_SIDECAR_PATH";

function saveEnv(key) {
  const had = Object.hasOwn(process.env, key);
  const prev = process.env[key];
  return {
    restore() {
      if (had) process.env[key] = prev;
      else delete process.env[key];
    },
  };
}

async function importIndexWriters() {
  return import(new URL(`${IW_URL.href}?${Date.now()}`, import.meta.url).href);
}

/** Install a Node mock script in a private temp path; restores env in finally. */
export async function withMockSidecarScript(script, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "tq-sidecar-mock-"));
  const bin = path.join(dir, "tracequest-sidecar");
  const pathEnv = saveEnv(SIDECAR_PATH_ENV);
  const noSidecar = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
  delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];

  try {
    writeFileSync(bin, script, { mode: 0o755 });
    process.env[SIDECAR_PATH_ENV] = bin;
    const { resetIndexWritersForTests } = await importIndexWriters();
    resetIndexWritersForTests();
    return await fn();
  } finally {
    pathEnv.restore();
    noSidecar.restore();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir may already be gone */
    }
    const { resetIndexWritersForTests } = await importIndexWriters();
    resetIndexWritersForTests();
  }
}

/** Point sidecar at a non-executable payload (spawn error path). */
export async function withBrokenSidecarBin(payload, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "tq-sidecar-mock-"));
  const bin = path.join(dir, "tracequest-sidecar");
  const pathEnv = saveEnv(SIDECAR_PATH_ENV);
  const noSidecar = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
  delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];

  try {
    writeFileSync(bin, payload, { mode: 0o644 });
    process.env[SIDECAR_PATH_ENV] = bin;
    const { resetIndexWritersForTests } = await importIndexWriters();
    resetIndexWritersForTests();
    return await fn();
  } finally {
    pathEnv.restore();
    noSidecar.restore();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const { resetIndexWritersForTests } = await importIndexWriters();
    resetIndexWritersForTests();
  }
}