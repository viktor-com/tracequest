const ESCAPE_RE = /[&<>"]/g;
const ESCAPE_TEST_RE = /[&<>"]/;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function esc(s) {
  const str = String(s);
  if (!ESCAPE_TEST_RE.test(str)) return str;
  return str.replace(ESCAPE_RE, ch => ESCAPE_MAP[ch]);
}

const KNOWN_SUFFIX = "\n</body>\n</html>";

/** The live-update client withLiveReload adds before a page's last </body>. */
export const LIVE_RELOAD_SCRIPT = `<script>(function(){var retries=0,maxRetries=5;function connect(){var es=new EventSource("/__livereload");retries=0;es.onmessage=function(e){if(e.data==="reload"){if(!window._stayLoaded)location.reload()}else if(e.data==="data-update"){if(typeof window._refreshData==="function")window._refreshData()}};es.onerror=function(){es.close();if(++retries<maxRetries)setTimeout(connect,2000*retries)}}connect()})();</script>`;

/**
 * Live-update client for served pages. A data-update (session files changed)
 * NEVER reloads the document (fact hnr1): a page that can refresh in place
 * defines window._refreshData and gets it called; any other page ignores it.
 * Only "reload" — a src/ change in a dev checkout — may reload.
 */
export function withLiveReload(html) {
  const script = LIVE_RELOAD_SCRIPT;
  if (html.endsWith(KNOWN_SUFFIX)) {
    const idx = html.length - KNOWN_SUFFIX.length + 1; // position of '<' in '</body>'
    return html.slice(0, idx) + script + html.slice(idx);
  }
  const idx = html.lastIndexOf("</body>");
  if (idx !== -1) return html.slice(0, idx) + script + html.slice(idx);
  return html + script;
}

/**
 * Hub pages are read-only (fact hubro): every HTML response is marked
 * <html data-tq-hub="readonly"> and carries one stylesheet that removes the
 * controls whose requests hub mode answers 403 — launch, continue, follow-up,
 * stop, kill and dismiss. Client scripts read the same attribute.
 */
const HUB_READONLY_CSS = `<style id="tq-hub-readonly">
html[data-tq-hub] .new-run-btn,
html[data-tq-hub] .run-dismiss,
html[data-tq-hub] .session-continue,
html[data-tq-hub] .session-continue-form,
html[data-tq-hub] .view-continue-chip,
html[data-tq-hub] #stopBtn,
html[data-tq-hub] #killBtn,
html[data-tq-hub] #inputRow,
html[data-tq-hub] #composerQueue { display: none !important; }
</style>`;

export function markHubReadonly(html) {
  const tag = html.indexOf("<html");
  if (tag === -1) return html;
  let out = html.slice(0, tag + 5) + ' data-tq-hub="readonly"' + html.slice(tag + 5);
  const head = out.indexOf("</head>");
  if (head !== -1) out = out.slice(0, head) + HUB_READONLY_CSS + out.slice(head);
  return out;
}

/**
 * Put the served viewer in the app shell: mark <html> data-tq-served, add
 * `head` to its head, `top` (the app bar) after <body> and `script` before its
 * last </body>. The route builds the pieces; this runs where the body is
 * built, in the session worker for served pages, so the event loop never
 * rewrites a page the size of the recording.
 */
export function applyAppShell(html, { head, top, script }) {
  let out = String(html).replace(/<html\b/, "<html data-tq-served");
  out = out.includes("</head>") ? out.replace("</head>", () => `${head}\n</head>`) : head + out;
  out = out.replace(/<body([^>]*)>/, (m) => `${m}\n${top}`);
  const at = out.lastIndexOf("</body>");
  return at >= 0 ? out.slice(0, at) + script + "\n" + out.slice(at) : out + script;
}

/**
 * Compact the standalone /view document so it can sit inside the Runs flyout:
 * mark its <body> embed-view and put `css` (the route's embed stylesheet, a
 * <style id="embed-view-css"> element) in its head. Runs where the body is
 * built — in the session worker for served pages (fact hps1).
 */
export function applyEmbedLayout(html, css) {
  if (!html) return html;
  let out = String(html);
  out = out.replace(/<body(\s[^>]*)?>/i, (m, attrs = "") => {
    if (/\bclass\s*=/.test(attrs)) {
      return m.replace(/class\s*=\s*(["'])([^"']*)\1/i, (_, q, cls) => {
        if (/\bembed-view\b/.test(cls)) return `class=${q}${cls}${q}`;
        return `class=${q}${cls} embed-view${q}`;
      });
    }
    return `<body class="embed-view"${attrs}>`;
  });
  if (out.includes('id="embed-view-css"')) {
    out = out.replace(/<style id="embed-view-css">[\s\S]*?<\/style>/, css);
  } else if (out.includes("</head>")) {
    out = out.replace("</head>", `${css}\n</head>`);
  } else {
    out = css + out;
  }
  return out;
}
