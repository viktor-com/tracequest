/**
 * Public package entry (`tracequest/render` and tracequest-api).
 * Stable surface only — internal helpers live under `./render/`.
 */
import { esc } from "./server/server-html-helpers.js";
import { CSS } from "./render/render-css.js";
import { RENDER_JS } from "./render/render-assemble.js";
import { sessionHash } from "./sessions/session-hash.js";

const _renderCache = new Map();
const MAX_RENDER_CACHE = 5;

/** Static viewer shell — only title prefix and SESSION JSON vary per render. */
const RENDER_SHELL_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tracequest — `;
const RENDER_SHELL_MID = `</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="app"></div>
<script>
const SESSION = `;
const RENDER_SHELL_TAIL = `;
${RENDER_JS}
</script>
</body>
</html>`;

/** Cache key must change when session content changes, not only when event count changes. */
function renderCacheKey(session) {
  const id = session.sessionHash || (session.path ? sessionHash(session.path) : "") || session.sessionId || "";
  const n = session.events?.length || 0;
  const lastTs = n ? (session.events[n - 1].timestamp || "") : "";
  const end = session.endTime || session.startTime || "";
  return `${id}:${n}:${lastTs}:${end}`;
}

export function renderHTML(session) {
  const key = renderCacheKey(session);
  const cached = _renderCache.get(key);
  if (cached !== undefined) {
    // Re-insert to maintain LRU order (Map preserves insertion order)
    _renderCache.delete(key);
    _renderCache.set(key, cached);
    return cached;
  }

  // agentHistory is server-side metadata from subagent sidecars; not rendered in the viewer.
  const { agentHistory: _agentHistory, agentSidecarCount: _agentSidecarCount, ...sessionForViewer } =
    session;
  if (!sessionForViewer.sessionHash && sessionForViewer.path) {
    sessionForViewer.sessionHash = sessionHash(sessionForViewer.path);
  }
  const data = JSON.stringify(sessionForViewer).replace(/<\//g, "<\\/");
  const displayId = sessionForViewer.sessionHash || session.sessionId?.slice(0, 8) || "session";
  const html =
    RENDER_SHELL_HEAD +
    esc(displayId) +
    RENDER_SHELL_MID +
    data +
    RENDER_SHELL_TAIL;

  if (_renderCache.size >= MAX_RENDER_CACHE) {
    const oldest = _renderCache.keys().next().value;
    _renderCache.delete(oldest);
  }
  _renderCache.set(key, html);
  return html;
}
