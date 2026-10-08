import "../helpers/skip-lr-watch-env.js";
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { send, createHandle, serve } from "../../src/server/server-http.js";
import { mockHttpResponse } from "../helpers/capture-json-handler.js";

function mockRequest(url, method = "GET") {
  return { url, method, headers: {} };
}

describe("server-http send", () => {
  it("writes status and body without Content-Type when omitted", () => {
    const res = mockHttpResponse({ mockFns: true });
    send(res, 404, "Not found");
    assert.equal(res.status, 404);
    assert.equal(res.body, "Not found");
    assert.equal(res.headers, undefined);
    assert.equal(res.writeHead.mock.calls.length, 1);
    assert.equal(res.end.mock.calls.length, 1);
  });

  it("sets Content-Type when provided", () => {
    const res = mockHttpResponse({ mockFns: true });
    send(res, 500, "Error parsing session", "text/plain");
    assert.equal(res.status, 500);
    assert.equal(res.body, "Error parsing session");
    assert.deepEqual(res.headers, { "Content-Type": "text/plain" });
  });

  it("calls writeHead before end", () => {
    const order = [];
    const res = {
      headersSent: false,
      writeHead: mock.fn(() => {
        order.push("writeHead");
      }),
      end: mock.fn(() => {
        order.push("end");
      }),
    };
    send(res, 200, "ok");
    assert.deepEqual(order, ["writeHead", "end"]);
  });

  it("allows empty body with success status", () => {
    const res = mockHttpResponse({ mockFns: true });
    send(res, 204, "");
    assert.equal(res.status, 204);
    assert.equal(res.body, "");
    assert.equal(res.headers, undefined);
  });

  it("does not add CORS or other default headers", () => {
    const res = mockHttpResponse({ mockFns: true });
    send(res, 200, "{}", "application/json");
    assert.deepEqual(res.headers, { "Content-Type": "application/json" });
    assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  });

  it("treats falsy contentType like omitted headers", () => {
    const res = mockHttpResponse({ mockFns: true });
    send(res, 200, "plain", "");
    assert.equal(res.headers, undefined);
  });

  it("merges extra headers with Content-Type", () => {
    const res = mockHttpResponse({ mockFns: true });
    send(res, 200, "body", "text/html; charset=utf-8", {
      "Content-Disposition": 'attachment; filename="x.html"',
    });
    assert.deepEqual(res.headers, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": 'attachment; filename="x.html"',
    });
  });
});

describe("server-http createHandle routing", () => {
  it("dispatches to route handler with req, res, and parsed url", async () => {
    const handler = mock.fn(async () => {});
    const handle = createHandle({ "/api/ping": handler });
    const req = mockRequest("/api/ping?x=1");
    const res = mockHttpResponse({ mockFns: true });

    await handle(req, res);

    assert.equal(handler.mock.calls.length, 1);
    assert.strictEqual(handler.mock.calls[0].arguments[0], req);
    assert.strictEqual(handler.mock.calls[0].arguments[1], res);
    assert.equal(handler.mock.calls[0].arguments[2].pathname, "/api/ping");
    assert.equal(handler.mock.calls[0].arguments[2].searchParams.get("x"), "1");
    assert.equal(res.writeHead.mock.calls.length, 0);
  });

  it("returns 404 when path is not in route map", async () => {
    const handle = createHandle({});
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/missing"), res);
    assert.equal(res.status, 404);
    assert.equal(res.body, "Not found");
    assert.equal(res.headers, undefined);
  });

  it("returns 404 for root when / is not registered", async () => {
    const handle = createHandle({ "/api": async () => {} });
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/"), res);
    assert.equal(res.status, 404);
    assert.equal(res.body, "Not found");
  });

  it("does not match trailing slash when route omits it", async () => {
    const handler = mock.fn(async () => {});
    const handle = createHandle({ "/api/ping": handler });
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/api/ping/"), res);
    assert.equal(handler.mock.calls.length, 0);
    assert.equal(res.status, 404);
  });

  it("invokes only the handler for the requested pathname", async () => {
    const a = mock.fn(async () => {});
    const b = mock.fn(async () => {});
    const handle = createHandle({ "/a": a, "/b": b });
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/b"), res);
    assert.equal(a.mock.calls.length, 0);
    assert.equal(b.mock.calls.length, 1);
  });

  it("lets handler write the response via send without double headers", async () => {
    const handle = createHandle({
      "/ok": async (_req, res) => {
        send(res, 200, "pong", "text/plain");
      },
    });
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/ok"), res);
    assert.equal(res.status, 200);
    assert.equal(res.body, "pong");
    assert.deepEqual(res.headers, { "Content-Type": "text/plain" });
    assert.equal(res.writeHead.mock.calls.length, 1);
  });

  it("404 responses do not include CORS headers", async () => {
    const handle = createHandle({});
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/nope"), res);
    assert.equal(res.status, 404);
    assert.equal(res.headers?.["Access-Control-Allow-Origin"], undefined);
  });
});

describe("server-http createHandle errors", () => {
  it("returns 500 when handler throws and headers not sent", async () => {
    const handle = createHandle({
      "/boom": async () => {
        throw new Error("handler failed");
      },
    });
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/boom"), res);
    assert.equal(res.status, 500);
    assert.equal(res.body, "Internal error");
  });

  it("does not send 500 when handler threw after headers were sent", async () => {
    const handle = createHandle({
      "/partial": async (_req, res) => {
        res.headersSent = true;
        throw new Error("late failure");
      },
    });
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/partial"), res);
    assert.equal(res.writeHead.mock.calls.length, 0);
  });

  it("500 error responses do not include CORS headers", async () => {
    const handle = createHandle({
      "/err": async () => {
        throw new Error("boom");
      },
    });
    const res = mockHttpResponse({ mockFns: true });
    await handle(mockRequest("/err"), res);
    assert.equal(res.status, 500);
    assert.equal(res.headers?.["Access-Control-Allow-Origin"], undefined);
  });
});

describe("server-http serve", () => {
  it("throws when routeMap is missing", () => {
    assert.throws(() => serve(0, null, null), /routeMap is required/);
  });

  it("throws when routeMap is undefined", () => {
    assert.throws(() => serve(7777, null, undefined), /routeMap is required/);
  });
});