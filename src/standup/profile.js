import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STANDUP_PROFILES_RELATIVE_PATH = ".tracequest/standup-profiles.json";

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function standupProfilesPath(env = process.env) {
  return join(env.HOME || homedir(), STANDUP_PROFILES_RELATIVE_PATH);
}

function availableProfileNames(profiles) {
  return Object.keys(profiles).sort((a, b) => a.localeCompare(b));
}

export function loadStandupProfiles(path = standupProfilesPath()) {
  if (!existsSync(path)) {
    throw new Error(`Standup profile file not found: ${path}`);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read standup profile file ${path}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse standup profile JSON file ${path}: ${err.message}`);
  }
  if (!isObject(parsed)) {
    throw new Error(`Standup profile file must contain a JSON object: ${path}`);
  }
  return parsed;
}

export function loadStandupProfile(name, opts = {}) {
  const profileName = String(name || "").trim();
  if (!profileName) throw new Error("Pass a standup profile name after --profile.");
  const path = opts.path || standupProfilesPath(opts.env || process.env);
  const profiles = opts.profiles || loadStandupProfiles(path);
  const profile = profiles[profileName];
  if (!isObject(profile)) {
    const names = availableProfileNames(profiles);
    const suffix = names.length ? ` Available profiles: ${names.join(", ")}.` : "";
    throw new Error(`Standup profile not found: ${profileName}.${suffix}`);
  }
  return { name: profileName, path, values: profile };
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return undefined;
}

function hasOptionValue(source, keys) {
  return firstDefined(source, keys) !== undefined;
}

function setDefault(target, key, value) {
  if (value === undefined) return;
  if (target[key] === undefined || target[key] === null || target[key] === "") target[key] = value;
}

function profileType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isStringableScalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function asProfileArgArray(value, fieldName) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (!isStringableScalar(item)) {
      throw new Error(
        `Standup profile ${fieldName} must be a string or an array of string/number/boolean values; got ${profileType(item)}.`,
      );
    }
  }
  return values.map(String);
}

function validateProfileParamValue(key, value) {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (item == null || isStringableScalar(item)) continue;
    throw new Error(
      `Standup profile params.${key} must be a string, number, boolean, null, or an array of those values; got ${profileType(item)}.`,
    );
  }
}

export function profileParamsToCli(params) {
  if (params == null || params === "") return [];
  if (Array.isArray(params)) {
    for (const item of params) {
      if (typeof item !== "string") {
        throw new Error(`Standup profile params must be an object or an array of key=value strings; got ${profileType(item)}.`);
      }
    }
    return params;
  }
  if (!isObject(params)) {
    throw new Error("Standup profile params must be an object or an array of key=value strings.");
  }
  const out = [];
  for (const [key, rawValue] of Object.entries(params)) {
    if (!key) continue;
    validateProfileParamValue(key, rawValue);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === false || value == null) continue;
      out.push(value === true ? String(key) : `${key}=${value}`);
    }
  }
  return out;
}

function hasAnyCliWindow(values) {
  return (
    values.since != null ||
    values.today != null ||
    values.yesterday != null ||
    values.workday != null ||
    values["previous-workday"] != null ||
    values.previousWorkday != null
  );
}

export function mergeStandupProfileOptions(cliValues = {}, profile = {}) {
  const merged = { ...cliValues };
  const hasCliAgentCommand = hasOptionValue(cliValues, ["agent-command", "agentCommand"]);

  setDefault(merged, "project", firstDefined(profile, ["project"]));
  setDefault(merged, "filter", firstDefined(profile, ["filter"]));
  setDefault(merged, "sort", firstDefined(profile, ["sort"]));
  setDefault(merged, "limit", firstDefined(profile, ["limit"]));

  if (!hasAnyCliWindow(cliValues)) {
    setDefault(merged, "since", firstDefined(profile, ["since"]));
    setDefault(merged, "today", firstDefined(profile, ["today"]));
    setDefault(merged, "yesterday", firstDefined(profile, ["yesterday"]));
    setDefault(merged, "workday", firstDefined(profile, ["workday"]));
    setDefault(merged, "previous-workday", firstDefined(profile, ["previousWorkday", "previous-workday"]));
  }

  setDefault(merged, "agent-command", firstDefined(profile, ["agentCommand", "agent-command"]));
  const profileAgentArgs = firstDefined(profile, ["agentArgs", "agentArg", "agent-arg"]);
  if (!hasCliAgentCommand && (merged["agent-arg"] == null && merged.agentArg == null) && profileAgentArgs !== undefined) {
    merged["agent-arg"] = asProfileArgArray(profileAgentArgs, "agentArgs");
  }
  setDefault(merged, "agent-timeout-ms", firstDefined(profile, ["agentTimeoutMs", "agent-timeout-ms"]));

  if (!hasCliAgentCommand && merged.param == null) {
    const profileParams = firstDefined(profile, ["params", "param"]);
    if (profileParams !== undefined) merged.param = profileParamsToCli(profileParams);
  }

  return merged;
}
