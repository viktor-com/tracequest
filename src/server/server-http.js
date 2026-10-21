import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createGzip, gzip } from "node:zlib";
import { die } from "../cli/cli-die.js";
import { setInitialFilter } from "./server-state.js";
import { redactBody, redactKindFor } from "./redact-body.js";
import { redactOffThread } from "./redact-pool.js";
import { markHubReadonly } from "./server-html-helpers.js";
import { BRAND_ASSETS } from "../ui/brand.js";

/**
 * Hub mode (fact hubmd): the server is a shared, read-only view of collected
 * sessions, so every text response is redacted and nothing can be launched.
 */
let _hubMode = false;

export function setHubMode(on) {
  _hubMode = Boolean(on);
}

export function isHubMode() {
  return _hubMode;
}

/** In hub mode a page that needs a session it was not given opens the list. */
function hubPickerRedirect(url) {
  const q = url.searchParams;
  if (url.pathname === "/compare") return !(q.get("a") && q.get("b"));
  if (url.pathname === "/view") return !(q.get("id") || q.get("path"));
  return false;
}

function serveLog(...args) {
  if (process.env.TRACEQUEST_VERBOSE === "1") console.log(...args);
}

/**
 * Hub bodies up to this many characters (or bytes) are redacted inline — a
 * few ms; anything larger goes to the redaction workers (fact hrd1).
 */
const INLINE_REDACT_LIMIT = 128 * 1024;

/** Responses whose body is still being produced off-thread (redaction, gzip). */
const _pending = new WeakSet();

/** Bodies below this size are not worth a compression round trip. */
const GZIP_MIN_BYTES = 1024;
/** Bodies above this size (whole-recording downloads) go out uncompressed. */
const GZIP_MAX_BYTES = 64 * 1024 * 1024;
const COMPRESSIBLE_TYPE_RE = /^(?:text\/|application\/(?:json|jsonl|javascript)\b)/i;

/** True when the request that `res` answers accepts a gzip-coded body. */
function requestAcceptsGzip(res) {
  const req = res.req;
  if (!req || req.method === "HEAD") return false;
  const ae = req.headers?.["accept-encoding"];
  if (typeof ae !== "string") return false;
  for (const part of ae.split(",")) {
    const [coding, ...params] = part.trim().split(";");
    if (coding.trim().toLowerCase() !== "gzip") continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

/**
 * Write status, headers and the final (already redacted) body. Large text
 * bodies go out gzip-coded when the client accepts it; the compression runs
 * on the libuv thread pool, not the event loop.
 */
function writeBody(res, status, h, body) {
  const contentType = h?.["Content-Type"];
  const size = typeof body === "string" ? Buffer.byteLength(body) : Buffer.isBuffer(body) ? body.length : 0;
  if (size >= GZIP_MIN_BYTES && size <= GZIP_MAX_BYTES && contentType && COMPRESSIBLE_TYPE_RE.test(contentType)
    && !Object.keys(h).some((k) => k.toLowerCase() === "content-encoding")
    && requestAcceptsGzip(res)) {
    _pending.add(res);
    gzip(body, { level: 4 }, (err, coded) => {
      if (res.writableEnded || res.destroyed) return;
      if (err) {
        res.writeHead(status, h);
        res.end(body);
        return;
      }
      res.writeHead(status, { ...h, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": coded.length });
      res.end(coded);
    });
    return;
  }
  res.writeHead(status, h);
  res.end(body);
}

function headersFor(contentType, headers) {
  if (!contentType && !headers) return undefined;
  const h = headers ? { ...headers } : {};
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

/**
 * Finish `res` with the redacted body of `input` ({ text } or { path })
 * produced on a worker thread. Status and headers go out only with the whole
 * redacted body, so nothing unredacted is ever sent; a client that hangs up
 * first cancels the job (facts hrd2, hrd4).
 */
function sendRedacted(res, status, h, input) {
  _pending.add(res);
  const job = redactOffThread(input);
  const onClose = () => {
    if (!res.writableEnded) job.cancel();
  };
  res.once?.("close", onClose);
  job.promise.then((body) => {
    res.off?.("close", onClose);
    if (!res.destroyed) writeBody(res, status, h, body);
  }, (err) => {
    res.off?.("close", onClose);
    if (job.isCancelled()) return;
    console.error("hub redaction failed:", err?.message || err);
    if (!res.headersSent && !res.destroyed) writeBody(res, 500, undefined, "Internal error");
  });
}

/**
 * The redacted form of the last page tail sent in hub mode (fact hlcatmemo):
 * a tail is the same string request after request until its data changes
 * (the palette catalog is built once per list snapshot), so it is redacted
 * off-thread once and every later response reuses the result.
 */
let _tailMemo = { text: null, promise: null };

function redactedTail(text) {
  if (_tailMemo.text === text) return _tailMemo.promise;
  // Never cancelled by one client hanging up: the next request reuses it.
  const promise = text.length <= INLINE_REDACT_LIMIT
    ? Promise.resolve().then(() => redactBody(text, "html"))
    : redactOffThread({ text, bytes: text.length, kind: "html" }).promise;
  const entry = { text, promise };
  _tailMemo = entry;
  promise.catch(() => {
    if (_tailMemo === entry) _tailMemo = { text: null, promise: null };
  });
  return promise;
}

/**
 * Send an HTML page in two parts (fact hlstream): `page` (a whole document)
 * goes out as soon as it is ready, and `tail()` — a large block of data the
 * page does not need to render, such as the palette catalog — is built only
 * once that part is on the wire, then appended at the end of the page's
 * body. The browser renders the page while the tail is still being built,
 * redacted and compressed. In hub mode each part is redacted before it is
 * written, so no unredacted byte is ever sent; a tail that cannot be
 * produced ends the page without it. A response that cannot be written in
 * parts gets the whole page at once.
 */
export function sendHtmlWithTail(res, status, page, tail) {
  const contentType = "text/html; charset=utf-8";
  const buildTail = () => {
    try {
      return tail() || "";
    } catch (err) {
      console.error("page tail failed:", err?.message || err);
      return "";
    }
  };
  const cut = page.lastIndexOf("</body>");
  if (typeof res.write !== "function" || cut === -1) {
    const block = buildTail();
    const tailText = block ? "\n" + block + "\n" : "";
    send(res, status, cut === -1 ? page + tailText : page.slice(0, cut) + tailText + page.slice(cut), contentType);
    return;
  }
  const h = headersFor(contentType);
  const head = _hubMode ? markHubReadonly(page.slice(0, cut)) : page.slice(0, cut);
  const end = _hubMode ? redactBody(page.slice(cut), "html") : page.slice(cut);
  const gzipped = requestAcceptsGzip(res);
  let job = null;
  let closed = false;
  let out = null;
  const onClose = () => {
    closed = true;
    if (job && !res.writableEnded) job.cancel();
    if (out && !res.writableFinished) out.destroy();
  };
  res.once?.("close", onClose);
  const redactedHead = (text) => {
    if (!_hubMode) return Promise.resolve(text);
    if (text.length <= INLINE_REDACT_LIMIT) return Promise.resolve(redactBody(text, "html"));
    job = redactOffThread({ text, bytes: text.length, kind: "html" });
    return job.promise.finally(() => { job = null; });
  };
  // The page part has left the process (its gzip block flushed): only now is
  // the tail built, so building it never delays the rows.
  const writeHead = (body) => new Promise((resolve) => {
    if (gzipped) {
      res.writeHead(status, { ...h, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      out = createGzip({ level: 4 });
      out.on("error", () => res.destroy());
      out.pipe(res);
      out.write(body);
      out.flush(() => setImmediate(resolve));
    } else {
      res.writeHead(status, h);
      res.write(body, () => setImmediate(resolve));
    }
  });
  const finish = (...parts) => {
    if (closed || res.destroyed) return;
    const sink = out || res;
    for (let i = 0; i < parts.length - 1; i++) sink.write(parts[i]);
    sink.end(parts[parts.length - 1]);
  };
  _pending.add(res);
  redactedHead(head).then((body) => {
    if (closed || res.destroyed) return undefined;
    return writeHead(body).then(() => {
      if (closed || res.destroyed) return undefined;
      const block = buildTail();
      if (!block) return finish(end);
      if (!_hubMode) return finish("\n", block, "\n" + end);
      return redactedTail(block).then((red) => finish("\n", red, "\n" + end), (err) => {
        if (closed) return;
        console.error("page tail redaction failed:", err?.message || err);
        finish(end);
      });
    });
  }, (err) => {
    if (closed) return;
    console.error("hub redaction failed:", err?.message || err);
    if (!res.headersSent && !res.destroyed) writeBody(res, 500, undefined, "Internal error");
  }).catch((err) => {
    console.error("page send failed:", err?.message || err);
    res.destroy();
  });
}

/**
 * Write a body already finished for this server's mode — in hub mode marked
 * read-only and redacted by finishSessionBody, in the session worker — so the
 * event loop never scans, redacts or re-encodes it (fact hps1). `parts` is
 * the body, or a list of strings and Buffers sent in order. Every other body
 * goes through send. A response without write (a test double, as
 * sendHtmlWithTail treats it) gets the whole body as one string.
 */
export function sendFinished(res, status, parts, contentType, headers) {
  const h = headersFor(contentType, headers);
  const list = Array.isArray(parts) ? parts : [parts];
  if (typeof res.write !== "function") {
    writeBody(res, status, h, list.map((p) => (Buffer.isBuffer(p) ? p.toString("utf8") : p)).join(""));
    return;
  }
  const body = list.length === 1 && Buffer.isBuffer(list[0])
    ? list[0]
    : Buffer.concat(list.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8"))));
  writeBody(res, status, h, body);
}

/** Redacted copies of large page blocks that repeat request after request (the palette snippet). */
const _fragmentMemo = new Map();
const FRAGMENT_MEMO_MIN = 4096;
const FRAGMENT_MEMO_MAX = 8;

/**
 * `html`, a block a route adds to a finished page (sendFinished), as hub mode
 * sends it: redacted (fact hubmd); unchanged outside hub mode. Blocks are
 * small; large ones repeat (the palette snippet) and are redacted once.
 */
export function finishedHtmlBlock(html) {
  if (!_hubMode || !html) return html;
  if (html.length < FRAGMENT_MEMO_MIN) return redactBody(html, "html");
  let red = _fragmentMemo.get(html);
  if (red === undefined) {
    red = redactBody(html, "html");
    if (_fragmentMemo.size >= FRAGMENT_MEMO_MAX) _fragmentMemo.delete(_fragmentMemo.keys().next().value);
    _fragmentMemo.set(html, red);
  }
  return red;
}

/** Write an HTTP response with optional Content-Type and extra headers. */
export function send(res, status, body, contentType, headers) {
  const h = headersFor(contentType, headers);
  if (_hubMode && body) {
    const kind = redactKindFor(contentType);
    if (kind === "html") body = markHubReadonly(Buffer.isBuffer(body) ? body.toString("utf8") : String(body));
    const size = typeof body === "string" || Buffer.isBuffer(body) ? body.length : 0;
    if (size > INLINE_REDACT_LIMIT) {
      sendRedacted(res, status, h, { text: body, bytes: size, kind });
      return;
    }
    // Structured bodies are redacted value by value, never as serialized text (fact hrd6).
    body = redactBody(typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : body, kind);
  }
  writeBody(res, status, h, body);
}

/**
 * Send the contents of the file at `path`, never reading it on the event
 * loop. In hub mode the file is read and redacted on a worker thread (fact
 * hrd2); otherwise it is read asynchronously and sent as is. Rejects (before
 * anything is written) when the file cannot be read.
 */
export async function sendFile(res, status, path, contentType, headers) {
  const h = headersFor(contentType, headers);
  if (_hubMode) {
    const { size } = await stat(path);
    sendRedacted(res, status, h, { path, bytes: size, kind: redactKindFor(contentType) });
    return;
  }
  writeBody(res, status, h, await readFile(path));
}

/** Build the Node HTTP request listener for a route map. */
export function createHandle(routeMap) {
  return async function handle(req, res) {
    // Nothing this server answers may be stored by the browser (fact hnr14):
    // its pages and answers show live data (runs, live rows, sessions), and a
    // stored copy is what Back/Forward would repaint, and what a page's own
    // first requests would get back while it loads. A route's own
    // Cache-Control (the live-reload stream) wins.
    if (typeof res.setHeader === "function") res.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(req.url, "http://localhost");
      const handler = routeMap[url.pathname];
      if (_hubMode && req.method !== "GET" && req.method !== "HEAD") {
        send(res, 403, "Read-only: this tracequest server runs in hub mode");
      } else if (_hubMode && url.pathname === "/") {
        send(res, 302, "", "text/html; charset=utf-8", { Location: `/insights${url.search}` });
      } else if (_hubMode && hubPickerRedirect(url)) {
        send(res, 302, "", "text/html; charset=utf-8", { Location: "/sessions" });
      } else if (BRAND_ASSETS.has(url.pathname)) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          send(res, 405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
          return;
        }
        const { url: assetUrl, type } = BRAND_ASSETS.get(url.pathname);
        // Public, fixed artwork has no session data to redact or re-encode.
        sendFinished(res, 200, await readFile(assetUrl), type);
      } else if (handler) {
        await handler(req, res, url);
      } else {
        send(res, 404, "Not found");
      }
    } catch (err) {
      console.error("request handler error:", req.url, err);
      if (!res.headersSent && !_pending.has(res)) send(res, 500, "Internal error");
    }
  };
}

/**
 * Start the tracequest HTTP server on `port` with optional session filter.
 * Binds to loopback unless `bind` names another address: the API can launch
 * and kill agent runs, so it must not be reachable from the network by default.
 */
export function serve(port = 7777, filter = null, routeMap, { bind = "127.0.0.1", hub = false } = {}) {
  if (!routeMap) throw new Error("serve: routeMap is required");
  setInitialFilter(filter);
  setHubMode(hub);
  const server = createServer(createHandle(routeMap));
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      die(
        `Port ${port} is already in use. Try a different port:\n  tracequest serve --port ${port + 1}`,
      );
    }
    throw err;
  });
  const onListening = () => {
    const host = bind === "127.0.0.1" ? "localhost" : bind.includes(":") ? `[${bind}]` : bind;
    console.log(`tracequest → http://${host}:${port}${hub ? " (hub mode: read-only, secrets redacted)" : ""}`);
    serveLog("  live-reload enabled — watching src/ + 6 data roots for live session updates");
  };
  server.listen(port, bind, onListening);
  return server;
}
