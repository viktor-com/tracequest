import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resetIndexWritersForTests } from "../../src/sessions/index-writers.js";
import {
  SHARED_QUERY,
  seedMultiSourceFixture,
  seedOpenCodeDb,
} from "./multi-source-fixtures.js";

export async function withMultiSourceHarness(fn, { seedOpenCode = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-multi-src-search-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  const paths = seedMultiSourceFixture(tmpDir);
  if (seedOpenCode) {
    await seedOpenCodeDb(tmpDir, "msrc-oc-1", `opencode side ${SHARED_QUERY}`);
  }

  try {
    resetIndexWritersForTests();
    // Bust ESM cache so sessions.js reads the temp HOME.
    const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
    const { findSessions, buildIndex } = await import(modUrl.href);
    const sessions = findSessions(null);
    const index = buildIndex(sessions);
    await fn({ tmpDir, sessions, index, findSessions, buildIndex, paths });
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}