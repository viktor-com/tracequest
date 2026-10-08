import { createServer } from "node:http";
import { die } from "../cli/cli-die.js";
import { setInitialFilter } from "./server-state.js";
import { redactText } from "../insights/redact.js";

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

function serveLog(...args) {
  if (process.env.TRACEQUEST_VERBOSE === "1") console.log(...args);
}

/** Write an HTTP response with optional Content-Type and extra headers. */
export function send(res, status, body, contentType, headers) {
  let h;
  if (contentType || headers) {
    h = headers ? { ...headers } : {};
    if (contentType) h["Content-Type"] = contentType;
  }
  res.writeHead(status, h);
  if (_hubMode && body) {
    body = redactText(typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : body);
  }
  res.end(body);
}

/** Build the Node HTTP request listener for a route map. */
export function createHandle(routeMap) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const handler = routeMap[url.pathname];
      if (_hubMode && req.method !== "GET" && req.method !== "HEAD") {
        send(res, 403, "Read-only: this tracequest server runs in hub mode");
      } else if (_hubMode && url.pathname === "/") {
        send(res, 302, "", "text/html; charset=utf-8", { Location: `/insights${url.search}` });
      } else if (handler) {
        await handler(req, res, url);
      } else {
        send(res, 404, "Not found");
      }
    } catch (err) {
      console.error("request handler error:", req.url, err);
      if (!res.headersSent) send(res, 500, "Internal error");
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
