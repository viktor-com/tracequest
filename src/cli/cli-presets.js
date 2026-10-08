import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { die } from "./cli-die.js";
import { k } from "./cli-color.js";

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const PRESETS_DIR = join(PKG_ROOT, "presets");

/** Minimal YAML loader for simple "key: value" presets (no deps) */
export function parseSimpleYaml(text) {
  const out = {};
  let start = 0;
  const len = text.length;
  while (start <= len) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = len;
    let line = text.slice(start, end);
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    start = end + 1;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}

function readPresetYamlFile(p) {
  try {
    return parseSimpleYaml(readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`preset parse error: ${p}`, err);
    return null;
  }
}

export function loadPreset(name) {
  if (!name) return {};
  const p = join(PRESETS_DIR, `${name}.yaml`);
  if (!existsSync(p)) return null;
  return readPresetYamlFile(p);
}

export function getPreset(name) {
  const preset = loadPreset(name);
  if (name && preset === null) {
    die(`Preset not found: ${name}\nBuilt-in presets are located in the presets/ folder inside the package.`);
  }
  return preset || {};
}

/** Merge preset fields into CLI values; explicit CLI flags win. */
export function mergePresetOptions(cliValues, preset, keys) {
  const merged = { ...cliValues };
  for (const key of keys) {
    const v = merged[key];
    if (v === undefined || v === null || v === "") {
      if (preset[key] !== undefined) merged[key] = preset[key];
    }
  }
  return merged;
}

export const SERVE_PORT_MIN = 1;
export const SERVE_PORT_MAX = 65535;
export const SERVE_PORT_DEFAULT = 7777;

/** True when parseInt produced a usable TCP port (1–65535). */
export function isValidServePort(port) {
  return Number.isInteger(port) && port >= SERVE_PORT_MIN && port <= SERVE_PORT_MAX;
}

export function invalidServePortMessage(rawPort) {
  return `Invalid port: ${rawPort} (must be an integer between ${SERVE_PORT_MIN} and ${SERVE_PORT_MAX})`;
}

/** Resolve serve port: CLI --port overrides preset.port, then default 7777. */
export function resolveServePort(cliValues, preset) {
  let rawPort = cliValues.port ?? preset.port ?? SERVE_PORT_DEFAULT;
  if (typeof rawPort === "string") rawPort = rawPort.trim();
  const port = parseInt(String(rawPort), 10);
  return { rawPort, port };
}

/** resolveServePort + validation; dies via die() when port is out of range or non-numeric. */
export function resolveServePortOrDie(cliValues, preset) {
  const { rawPort, port } = resolveServePort(cliValues, preset);
  if (!isValidServePort(port)) die(invalidServePortMessage(rawPort));
  return port;
}

export const RENDER_PRESET_KEYS = ["out", "open"];

export function cmdPresets() {
  if (!existsSync(PRESETS_DIR)) {
    console.log(k.yellow("No presets directory found."));
    process.exit(0);
  }
  const files = readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) {
    console.log(k.yellow("No presets found."));
    process.exit(0);
  }
  console.log(k.bold("Built-in presets:\n"));
  for (const f of files) {
    const name = f.slice(0, -5);
    const data = readPresetYamlFile(join(PRESETS_DIR, f)) || {};
    console.log(`  ${k.cyan(name)}`);
    let hasKeys = false;
    for (const key in data) {
      if (Object.hasOwn(data, key)) {
        hasKeys = true;
        console.log(`    ${k.dim(`${key}:`)} ${data[key]}`);
      }
    }
    if (!hasKeys) console.log(`    ${k.dim("(empty)")}`);
  }
  process.exit(0);
}