/**
 * Deep coverage for warnSidecarFailure + runSidecar fallback paths in index-writers.
 * See test/sidecar-gate.test.js for TRACEQUEST_NO_SIDECAR gate semantics.
 */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { withBrokenSidecarBin, withMockSidecarScript } from "../helpers/sidecar-mock.js";

const IW_URL = new URL("../../src/sessions/index-writers.js", import.meta.url);

async function importIndexWriters() {
  return import(new URL(`${IW_URL.href}?${Date.now()}`, import.meta.url).href);
}

async function withWarnSpy(fn) {
  const warnSpy = mock.method(console, "warn", () => {});
  try {
    return await fn(warnSpy);
  } finally {
    warnSpy.mock.restore();
  }
}

function warnMessages(spy) {
  return spy.mock.calls.map((c) => c.arguments.map(String).join(" "));
}

function firstWarn(spy) {
  return warnMessages(spy)[0] ?? "";
}

describe("warnSidecarFailure", () => {
  test("logs spawn error from result.error and returns without status branch", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    await withWarnSpy((spy) => {
      warnSidecarFailure("index", { error: new Error("ENOENT sidecar") });
      assert.equal(spy.mock.calls.length, 1);
      assert.match(firstWarn(spy), /Sidecar index failed \(ENOENT sidecar\)/);
      assert.match(firstWarn(spy), /falling back to JS/);
    });
  });

  test("logs non-zero exit with trimmed stderr snippet", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    await withWarnSpy((spy) => {
      warnSidecarFailure("scan", { status: 2, stderr: "invalid roots json\n" });
      assert.equal(spy.mock.calls.length, 1);
      assert.match(firstWarn(spy), /Sidecar scan exited 2/);
      assert.match(firstWarn(spy), /invalid roots json/);
      assert.match(firstWarn(spy), /falling back to JS/);
    });
  });

  test("logs non-zero exit without stderr suffix when stderr is empty", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    await withWarnSpy((spy) => {
      warnSidecarFailure("peek", { status: 127, stderr: "   \n" });
      assert.equal(spy.mock.calls.length, 1);
      assert.match(firstWarn(spy), /Sidecar peek exited 127/);
      assert.doesNotMatch(firstWarn(spy), /: /);
    });
  });

  test("truncates stderr detail to 200 characters on non-zero exit", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    const long = "x".repeat(400);
    await withWarnSpy((spy) => {
      warnSidecarFailure("index", { status: 1, stderr: long });
      const msg = firstWarn(spy);
      const detailStart = msg.indexOf("exited 1: ") + "exited 1: ".length;
      const detailEnd = msg.indexOf(", falling back to JS");
      const detail = msg.slice(detailStart, detailEnd);
      assert.equal(detail.length, 200);
      assert.equal(detail, "x".repeat(200));
    });
  });

  test("does not warn when status is zero and there is no spawn error", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    await withWarnSpy((spy) => {
      warnSidecarFailure("index", { status: 0, stdout: "{}", stderr: "" });
      assert.equal(spy.mock.calls.length, 0);
    });
  });

  test("spawn error takes precedence over non-zero status and stderr", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    await withWarnSpy((spy) => {
      warnSidecarFailure("scan", {
        error: new Error("EACCES"),
        status: 2,
        stderr: "should not appear",
      });
      assert.equal(spy.mock.calls.length, 1);
      const msg = firstWarn(spy);
      assert.match(msg, /Sidecar scan failed \(EACCES\)/);
      assert.doesNotMatch(msg, /exited 2/);
      assert.doesNotMatch(msg, /should not appear/);
    });
  });

  test("trims stderr padding before non-zero exit detail suffix", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    await withWarnSpy((spy) => {
      warnSidecarFailure("peek", { status: 1, stderr: "  padded detail  \n" });
      const msg = firstWarn(spy);
      assert.match(msg, /exited 1: padded detail/);
      assert.doesNotMatch(msg, /:  padded/);
    });
  });

  test("non-zero exit without stderr property omits colon detail suffix", async () => {
    const { warnSidecarFailure } = await importIndexWriters();
    await withWarnSpy((spy) => {
      warnSidecarFailure("index", { status: 9 });
      const msg = firstWarn(spy);
      assert.match(msg, /Sidecar index exited 9, falling back to JS/);
      assert.doesNotMatch(msg, /exited 9:/);
    });
  });
});

describe("runSidecar warn + JS fallback", () => {
  test("warns and returns null when mock sidecar exits non-zero with stderr", async () => {
    await withMockSidecarScript(
      `#!/usr/bin/env node
console.error("sidecar index blew up");
process.exit(3);
`,
      async () => {
        const { runSidecar } = await importIndexWriters();
        await withWarnSpy(async (spy) => {
          const out = runSidecar("index", ["index"], () => ({}));
          assert.equal(out, null);
          assert.ok(
            warnMessages(spy).some(
              (m) => m.includes("exited 3") && m.includes("sidecar index blew up"),
            ),
            "non-zero exit should warn with stderr snippet",
          );
        });
      },
    );
  });

  test("warns when stdout parse fails on zero exit", async () => {
    await withMockSidecarScript(
      `#!/usr/bin/env node
console.log("not-json");
process.exit(0);
`,
      async () => {
        const { runSidecar } = await importIndexWriters();
        await withWarnSpy(async (spy) => {
          const out = runSidecar("index", ["index"], (result) => JSON.parse(result.stdout));
          assert.equal(out, null);
          assert.ok(
            warnMessages(spy).some((m) => m.includes("output parse failed")),
            "parse failure should warn",
          );
        });
      },
    );
  });

  test("parse failure truncates stderr parenthetical to 120 characters", async () => {
    await withMockSidecarScript(
      `#!/usr/bin/env node
console.log("{}");
console.error("${"y".repeat(300)}");
process.exit(0);
`,
      async () => {
        const { runSidecar } = await importIndexWriters();
        await withWarnSpy(async (spy) => {
          const out = runSidecar("index", ["index"], () => {
            throw new Error("shape");
          });
          assert.equal(out, null);
          const msg = warnMessages(spy).join(" ");
          const start = msg.indexOf("(stderr: ") + "(stderr: ".length;
          const end = msg.indexOf(")", start);
          const detail = msg.slice(start, end);
          assert.equal(detail.length, 120);
          assert.equal(detail, "y".repeat(120));
        });
      },
    );
  });

  test("parse failure omits stderr parenthetical when stderr is whitespace-only", async () => {
    await withMockSidecarScript(
      `#!/usr/bin/env node
console.log("{}");
console.error("   \\n");
process.exit(0);
`,
      async () => {
        const { runSidecar } = await importIndexWriters();
        await withWarnSpy(async (spy) => {
          const out = runSidecar("index", ["index"], () => {
            throw new Error("no stderr tail");
          });
          assert.equal(out, null);
          const msg = warnMessages(spy).join(" ");
          assert.match(msg, /output parse failed/i);
          assert.match(msg, /no stderr tail/);
          assert.doesNotMatch(msg, /\(stderr:/);
        });
      },
    );
  });

  test("parse failure warning includes stderr snippet when sidecar wrote stderr", async () => {
    await withMockSidecarScript(
      `#!/usr/bin/env node
console.log("{}");
console.error("schema mismatch at row 9");
process.exit(0);
`,
      async () => {
        const { runSidecar } = await importIndexWriters();
        await withWarnSpy(async (spy) => {
          const out = runSidecar("index", ["index"], () => {
            throw new Error("bad shape");
          });
          assert.equal(out, null);
          const joined = warnMessages(spy).join(" ");
          assert.match(joined, /output parse failed/i);
          assert.match(joined, /bad shape/);
          assert.match(joined, /schema mismatch at row 9/);
        });
      },
    );
  });

  test("warns when sidecar binary cannot be executed (spawn error path)", async () => {
    await withBrokenSidecarBin("not a runnable sidecar", async () => {
      const { runSidecar } = await importIndexWriters();
      await withWarnSpy(async (spy) => {
        const out = runSidecar("index", ["index"], () => ({}));
        assert.equal(out, null);
        assert.ok(
          warnMessages(spy).some((m) => /spawn failed|Sidecar index failed|falling back to JS/.test(m)),
          "non-executable sidecar should warn and fall back",
        );
      });
    });
  });

  test("returns parsed value when mock sidecar exits zero", async () => {
    await withMockSidecarScript(
      `#!/usr/bin/env node
console.log(JSON.stringify({ ok: true, n: 2 }));
process.exit(0);
`,
      async () => {
        const { runSidecar } = await importIndexWriters();
        await withWarnSpy(async (spy) => {
          const out = runSidecar("scan", ["scan", "--roots", "[]"], (r) => JSON.parse(r.stdout));
          assert.deepEqual(out, { ok: true, n: 2 });
          assert.equal(spy.mock.calls.length, 0);
        });
      },
    );
  });
});