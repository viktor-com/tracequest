import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

const SOURCE_IDS = new Set(["claude", "cursor", "codex", "factory", "grok", "opencode"]);
let activeConfig = null;
export function hubConfig() { return activeConfig; }

/** Explicit deployment configuration; no automatic discovery of private files. */
export function loadHubConfig(file) {
  const filename = resolve(file);
  const config = JSON.parse(readFileSync(filename, "utf8"));
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  const fail = (message) => { throw new Error(`Invalid hub config: ${message}`); };
  if (!object(config)) fail("expected a JSON object");
  const allowed = new Set(["home", "hostsDir", "cacheDir", "rsync", "hosts", "serve", "checkoutPatterns"]);
  for (const key of Object.keys(config)) if (!allowed.has(key)) fail(`unknown field ${key}`);
  for (const key of ["home", "hostsDir", "cacheDir", "rsync"]) {
    if (config[key] === undefined) continue;
    if (typeof config[key] !== "string" || !config[key].trim()) fail(`${key} must be a nonempty path`);
    const path = config[key].replace(/^~(?=\/|$)/, homedir());
    config[key] = isAbsolute(path) ? path : resolve(dirname(filename), path);
  }
  if (config.checkoutPatterns !== undefined) {
    if (!Array.isArray(config.checkoutPatterns)) fail("checkoutPatterns must be an array");
    for (const pattern of config.checkoutPatterns) {
      if (typeof pattern !== "string" || !pattern) fail("checkoutPatterns must contain regex strings");
      try { new RegExp(pattern); } catch { fail("invalid checkout pattern"); }
    }
  }
  if (config.hosts !== undefined) {
    if (!Array.isArray(config.hosts)) fail("hosts must be an array");
    const ids = new Set();
    for (const host of config.hosts) {
      if (!object(host) || typeof host.spec !== "string" || !host.spec.trim() ||
          typeof host.hostId !== "string" || !/^[\w.-]+$/.test(host.hostId) ||
          [".", ".."].includes(host.hostId) || host.hostId.toLowerCase().includes("cursor-cloud")) fail("each host needs spec and a safe hostId");
      if (ids.has(host.hostId)) fail(`duplicate hostId ${host.hostId}`);
      ids.add(host.hostId);
      for (const key of Object.keys(host)) if (!["spec", "hostId", "sources"].includes(key)) fail(`unknown host field ${key}`);
      if (host.sources !== undefined) {
        if (!object(host.sources) || !Object.keys(host.sources).length) fail("sources must map provider ids to remote paths");
        for (const [id, path] of Object.entries(host.sources)) {
          if (!SOURCE_IDS.has(id) || typeof path !== "string" || !path.trim() || /[\r\n\0]/.test(path)) fail(`invalid source ${id}`);
        }
      }
    }
  }
  if (config.serve !== undefined) {
    if (!object(config.serve)) fail("serve must be an object");
    for (const key of Object.keys(config.serve)) if (!["bind", "port", "hub", "filter"].includes(key)) fail(`unknown serve field ${key}`);
    const { port, bind, hub, filter } = config.serve;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) fail("serve.port must be a TCP port");
    if (bind !== undefined && (typeof bind !== "string" || !bind.trim())) fail("serve.bind must be an address");
    if (hub !== undefined && typeof hub !== "boolean") fail("serve.hub must be boolean");
    if (filter !== undefined && typeof filter !== "string") fail("serve.filter must be a string");
  }
  return config;
}

export function applyHubConfig(config) {
  for (const [key, env] of Object.entries({ home: "HOME", hostsDir: "TRACEQUEST_HOSTS_DIR", cacheDir: "TRACEQUEST_CACHE_DIR", rsync: "TRACEQUEST_SSH_RSYNC" })) {
    if (config[key] !== undefined) process.env[env] = config[key];
  }
  activeConfig = config;
}
