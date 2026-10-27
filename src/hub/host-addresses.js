import { execFileSync } from "node:child_process";
import { loadImportHostsFile } from "../import/ssh-import.js";

let cached = null;

/**
 * Imported host id -> the address SSH connects to for that host (`ssh -G`
 * resolves aliases from ~/.ssh/config), so a page can link to a service on
 * the machine a session came from. Resolved once per process; a host SSH
 * cannot resolve is left out.
 */
export function hostAddresses(resolve = null) {
  if (cached && !resolve) return cached;
  const out = {};
  let hosts = [];
  try {
    hosts = loadImportHostsFile();
  } catch {
    hosts = [];
  }
  for (const { spec, hostId } of hosts) {
    try {
      const addr = (resolve || sshHostname)(spec);
      if (addr) out[hostId] = addr;
    } catch {
      // No address: that host's sessions get no link.
    }
  }
  if (!resolve) cached = out;
  return out;
}

function sshHostname(spec) {
  if (spec.startsWith("-")) return "";
  const text = execFileSync("ssh", ["-G", spec], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  const m = /^hostname\s+(\S+)$/m.exec(text);
  return m ? m[1] : "";
}
