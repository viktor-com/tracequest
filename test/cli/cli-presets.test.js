import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";

const CLI_PRESETS_JS = readFileSync(
  new URL("../../src/cli/cli-presets.js", import.meta.url),
  "utf8",
);
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  parseSimpleYaml,
  loadPreset,
  getPreset,
  mergePresetOptions,
  resolveServePort,
  resolveServePortOrDie,
  isValidServePort,
  invalidServePortMessage,
  SERVE_PORT_DEFAULT,
  RENDER_PRESET_KEYS,
  PRESETS_DIR,
  PKG_ROOT,
} from "../../src/cli/cli-presets.js";
import { formatCliError } from "../../src/cli/cli-die.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Mirror loadPreset against an arbitrary presets directory (for temp fixtures). */
function loadPresetFromDir(presetsDir, name) {
  if (!name) return {};
  const p = join(presetsDir, `${name}.yaml`);
  if (!existsSync(p)) return null;
  try {
    return parseSimpleYaml(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function withPresetsDir(fn) {
  const dir = mkdtempSync(join(os.tmpdir(), "tq-presets-"));
  mkdirSync(dir, { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureExit(fn) {
  const origExit = process.exit;
  const origError = console.error;
  let code;
  const errors = [];
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  console.error = (...a) => errors.push(a.join(" "));
  try {
    fn();
    return { threw: false, code, errors };
  } catch (err) {
    if (err.message !== "process.exit") throw err;
    return { threw: true, code, errors };
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
}

describe("cli-presets parseSimpleYaml", () => {
  it("parses lines without text.split alloc", () => {
    assert.ok(!CLI_PRESETS_JS.includes("text.split"));
    assert.ok(CLI_PRESETS_JS.includes('text.indexOf("\\n", start)'));
  });

  it("parses booleans, numbers, and quoted strings", () => {
    const yaml = `
# comment
port: 8888
open: true
closed: false
label: "quoted"
name: 'single'
`;
    const out = parseSimpleYaml(yaml);
    assert.equal(out.port, 8888);
    assert.equal(out.open, true);
    assert.equal(out.closed, false);
    assert.equal(out.label, "quoted");
    assert.equal(out.name, "single");
  });

  it("ignores blank lines, comments, and malformed rows", () => {
    assert.deepEqual(parseSimpleYaml("\n\nnot yaml\n::: garbage\n"), {});
  });

  it("parses dotted keys and negative decimals", () => {
    const out = parseSimpleYaml("foo.bar: 1\nrate: -2.5\n");
    assert.equal(out["foo.bar"], 1);
    assert.equal(out.rate, -2.5);
  });

  it("keeps unquoted string values as strings", () => {
    const out = parseSimpleYaml("out: tracequest-out.html\n");
    assert.equal(out.out, "tracequest-out.html");
  });

  it("parses CRLF line endings", () => {
    const out = parseSimpleYaml("a: 1\r\nb: 2\r\n");
    assert.deepEqual(out, { a: 1, b: 2 });
  });
});

describe("cli-presets cmdPresets listing", () => {
  it("cmdPresets walks preset keys via for-in without Object.entries alloc", () => {
    assert.ok(!CLI_PRESETS_JS.includes("Object.entries"));
    assert.ok(CLI_PRESETS_JS.includes("readPresetYamlFile"));
  });
});

describe("cli-presets loadPreset", () => {
  it("PRESETS_DIR points at package presets folder", () => {
    assert.equal(PRESETS_DIR, join(PKG_ROOT, "presets"));
    assert.equal(PKG_ROOT, ROOT);
    assert.ok(existsSync(join(PRESETS_DIR, "default.yaml")));
  });

  it("loads built-in default.yaml with port 7777", () => {
    const preset = loadPreset("default");
    assert.ok(preset);
    assert.equal(preset.port, 7777);
  });

  it("loads built-in local.yaml with port 8888", () => {
    const preset = loadPreset("local");
    assert.ok(preset);
    assert.equal(preset.port, 8888);
  });

  it("returns empty object when name is omitted", () => {
    assert.deepEqual(loadPreset(), {});
    assert.deepEqual(loadPreset(""), {});
  });

  it("returns null for missing preset file", () => {
    assert.equal(loadPreset("nonexistent-preset-xyz"), null);
  });

  it("returns empty object for yaml with only comments and garbage lines", () => {
    withPresetsDir((dir) => {
      writeFileSync(join(dir, "garbage.yaml"), "# only comments\n::: bad\n");
      assert.deepEqual(loadPresetFromDir(dir, "garbage"), {});
    });
  });

  it("loads valid yaml from a custom presets directory", () => {
    withPresetsDir((dir) => {
      writeFileSync(join(dir, "dev.yaml"), "port: 9001\nopen: true\n");
      assert.deepEqual(loadPresetFromDir(dir, "dev"), { port: 9001, open: true });
    });
  });

  it("returns null when preset path is a directory (read failure)", () => {
    withPresetsDir((dir) => {
      mkdirSync(join(dir, "broken.yaml"));
      assert.equal(loadPresetFromDir(dir, "broken"), null);
    });
  });
});

describe("cli-presets getPreset", () => {
  it("returns empty object when name omitted", () => {
    assert.deepEqual(getPreset(undefined), {});
    assert.deepEqual(getPreset(""), {});
  });

  it("dies with exit 1 when preset name is unknown", () => {
    const { threw, code, errors } = captureExit(() => getPreset("missing-preset-xyz-abc"));
    assert.equal(threw, true);
    assert.equal(code, 1);
    assert.ok(errors.some((e) => e.includes("Preset not found")));
  });
});

describe("cli-presets merge into render and serve options", () => {
  it("RENDER_PRESET_KEYS covers render/latest output flags", () => {
    assert.deepEqual(RENDER_PRESET_KEYS, ["out", "open"]);
  });

  it("mergePresetOptions fills open and out from preset when CLI omits them", () => {
    const preset = { open: true, out: "from-preset.html" };
    const merged = mergePresetOptions({ preset: "default" }, preset, RENDER_PRESET_KEYS);
    assert.equal(merged.open, true);
    assert.equal(merged.out, "from-preset.html");
    assert.equal(merged.preset, "default");
  });

  it("mergePresetOptions keeps explicit CLI flags over preset", () => {
    const preset = { open: true, out: "preset.html" };
    const merged = mergePresetOptions(
      { open: false, out: "cli.html" },
      preset,
      RENDER_PRESET_KEYS,
    );
    assert.equal(merged.open, false);
    assert.equal(merged.out, "cli.html");
  });

  it("resolveServePort uses preset port when CLI omits --port", () => {
    const { rawPort, port } = resolveServePort({}, { port: 8888 });
    assert.equal(rawPort, 8888);
    assert.equal(port, 8888);
  });

  it("resolveServePort prefers CLI --port over preset", () => {
    const { rawPort, port } = resolveServePort({ port: "9999" }, { port: 8888 });
    assert.equal(rawPort, "9999");
    assert.equal(port, 9999);
  });

  it("resolveServePort falls back to default when preset and CLI omit port", () => {
    const { rawPort, port } = resolveServePort({}, {});
    assert.equal(rawPort, SERVE_PORT_DEFAULT);
    assert.equal(port, SERVE_PORT_DEFAULT);
  });

  it("resolveServePort trims string port values", () => {
    const { port } = resolveServePort({ port: "  4242  " }, {});
    assert.equal(port, 4242);
  });

  it("isValidServePort accepts boundary ports and rejects garbage", () => {
    assert.equal(isValidServePort(1), true);
    assert.equal(isValidServePort(65535), true);
    assert.equal(isValidServePort(7777), true);
    assert.equal(isValidServePort(0), false);
    assert.equal(isValidServePort(65536), false);
    assert.equal(isValidServePort(NaN), false);
    assert.equal(isValidServePort(3.14), false);
  });

  it("invalidServePortMessage includes raw value and range", () => {
    assert.match(invalidServePortMessage("abc"), /Invalid port: abc/);
    assert.match(invalidServePortMessage("abc"), /between 1 and 65535/);
  });

  it("resolveServePortOrDie returns parsed port for valid CLI value", () => {
    assert.equal(resolveServePortOrDie({ port: "4242" }, {}), 4242);
  });

  it("resolveServePortOrDie dies on invalid port", () => {
    const errors = [];
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = (code) => {
      throw Object.assign(new Error("exit"), { code });
    };
    console.error = (msg) => errors.push(msg);
    try {
      assert.throws(
        () => resolveServePortOrDie({ port: "99999" }, {}),
        (err) => err.code === 1,
      );
      assert.equal(errors.length, 1);
      assert.equal(errors[0], formatCliError(invalidServePortMessage("99999")));
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });
});