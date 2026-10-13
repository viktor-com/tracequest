import { viewerSessionData } from "../render/render-viewer-data.js";
import { generateMarkdown } from "../export/markdown-export.js";
import { hasCommandPalette } from "../browser/command-palette.js";
import { redactBody } from "./redact-body.js";
import { applyAppShell, applyEmbedLayout, markHubReadonly } from "./server-html-helpers.js";

/**
 * The response body `op` builds from a loaded session: "html" the session
 * page (renderHTML), "data" the viewer JSON (/api/view-session) or
 * "markdown" the Markdown export.
 */
export function sessionBody(op, session, renderHTML) {
  if (op === "html") return renderHTML(session);
  if (op === "data") return JSON.stringify(viewerSessionData(session));
  if (op === "markdown") return generateMarkdown(session);
  throw new Error(`unknown session body: ${op}`);
}

/** The redactBody kind of each op's body (its Content-Type: text/html, application/json, text/markdown). */
const REDACT_KIND = { html: "html", data: "json", markdown: "text" };

/**
 * `op`'s body as it goes on the wire, everything that is proportional to its
 * size done here — in the session worker when the server's own modules are
 * used (fact hps1): the /view embed layout when `embed` (the route's embed
 * stylesheet), the app shell when `shell` (its pieces, built by the route); in hub mode the read-only marking of a page (fact hubro) and
 * the redaction of the body's kind (facts hubmd, hrd6). Returns { body, at, palette }: `at` is where a
 * page's last "</body>" starts (-1: none, or not a page), so the routes add
 * their small per-request blocks there without scanning the body again;
 * `palette` is whether the page already holds the command palette. With
 * `bytes`, `body` is UTF-8 bytes (a worker transfers them to the event loop
 * without a copy) and `at` a byte offset; otherwise a string and its index.
 */
export function finishSessionBody(op, body, { hub = false, embed = false, shell = null, bytes = false } = {}) {
  if (typeof body !== "string") return { body, at: -1, palette: false };
  let text = body;
  if (op === "html" && embed) text = applyEmbedLayout(text, embed);
  if (op === "html" && shell) text = applyAppShell(text, shell);
  if (op === "html" && hub) text = markHubReadonly(text);
  if (hub) text = redactBody(text, REDACT_KIND[op]);
  const palette = op === "html" && hasCommandPalette(text);
  if (!bytes) return { body: text, at: op === "html" ? text.lastIndexOf("</body>") : -1, palette };
  const buf = Buffer.from(text, "utf8");
  return { body: buf, at: op === "html" ? buf.lastIndexOf("</body>") : -1, palette };
}

/** The fields the routes read from a session once its body is built (worker replies carry only these). */
export function sessionIdentity(session) {
  const { path, sessionId, sessionHash, source, host } = session;
  return { path, sessionId, sessionHash, source, host };
}
