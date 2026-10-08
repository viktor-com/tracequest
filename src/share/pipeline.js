import { readSync } from "node:fs";
import { parseSession } from "../parse.js";
import { renderHTML } from "../render.js";
import { loadSecretRules } from "./secret-rules.js";
import { scanSessionForSecrets } from "./scanner.js";
import { redactSession } from "./redactor.js";
import { buildShareMetadata, publicFindings } from "./metadata.js";
import { shareGist } from "./gist-adapter.js";
import { shareHf, buildHfSidecar } from "./hf-adapter.js";
import { resolveGhToken, resolveHfToken } from "./auth.js";

/**
 * Run the share pipeline: scan → redact → render → upload.
 * Secrets never leave the machine in plaintext.
 */
export async function runSharePipeline({
  sessionPath,
  session: parsedSession,
  findings: preFindings = null,
  discovery = null,
  target = "gist",
  isPrivate = false,
  hfRepo = null,
  token = null,
  fetchImpl = fetch,
}) {
  const session = parsedSession || parseSession(sessionPath);
  const rules = loadSecretRules();
  const findings = preFindings || scanSessionForSecrets(session, rules);
  const redacted = redactSession(session, findings);
  const html = renderHTML(redacted);
  const metadata = buildShareMetadata(redacted, { discovery });

  let url = null;
  let gistUrl = null;
  if (target === "gist") {
    const ghToken = token || resolveGhToken();
    const result = await shareGist({ html, metadata, isPrivate, token: ghToken, fetchImpl });
    gistUrl = result.url;
    url = result.previewUrl || result.url;
  } else if (target === "hf") {
    const hfToken = token || resolveHfToken();
    const sidecar = buildHfSidecar(metadata);
    const result = await shareHf({
      html,
      metadata,
      sidecar,
      repo: hfRepo,
      isPrivate,
      token: hfToken,
      fetchImpl,
    });
    url = result.url;
  } else {
    throw new Error(`Unknown share target: ${target}. Use gist or hf.`);
  }

  return {
    sessionId: metadata.sessionId,
    sessionHash: metadata.sessionHash,
    source: metadata.source,
    model: metadata.model,
    project: metadata.project,
    firstPrompt: metadata.firstPrompt,
    chapterCount: metadata.chapterCount,
    target,
    url,
    gistUrl,
    findings: publicFindings(findings),
    private: !!isPrivate,
    html,
    metadata,
    redacted,
  };
}

/** Print findings to stderr for CLI confirmation. */
export function printFindings(findings, k = { yellow: (s) => s, dim: (s) => s, bold: (s) => s }) {
  if (!findings.length) return;
  console.error(k.yellow(`\n  ${findings.length} potential secret(s) detected:`));
  for (const f of findings) {
    const loc = f.location;
    const where = `ch${loc.chapterIndex} / event ${loc.eventIndex}${loc.field ? ` / ${loc.field}` : ""}${loc.toolName ? ` / ${loc.toolName}` : ""}`;
    console.error(`  ${k.bold(f.description)} — ${k.dim(f.match)} (${where})`);
  }
  console.error("");
}

/** Synchronous stdin confirmation when findings are present. */
export function confirmShareSync(findings, force) {
  if (!findings.length || force) return true;
  if (!process.stdin.isTTY) {
    console.error("Secrets detected. Re-run with --force to share anyway.");
    return false;
  }
  process.stdout.write("Proceed with share anyway? [y/N] ");
  const buf = Buffer.alloc(256);
  const bytes = readSync(process.stdin.fd, buf, 0, 256);
  const answer = buf.toString("utf8", 0, bytes).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
