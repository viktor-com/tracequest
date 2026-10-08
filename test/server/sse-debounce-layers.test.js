import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  lrClients,
  triggerDataUpdate,
  DATA_UPDATE_DEBOUNCE_MS,
  _resetDataUpdateTimerForTests,
} from "../../src/server/server-live-reload.js";
import { browserClientScript } from "../../src/browser/browser-client.js";

/** Client `_refreshData` debounce in assembled browser script (ms); independent of server SSE coalesce. */
const CLIENT_REFRESH_DEBOUNCE_MS = 2000;

function trackWrites() {
  const payloads = [];
  const client = { write: (p) => payloads.push(p) };
  lrClients.add(client);
  return {
    payloads,
    cleanup() {
      lrClients.delete(client);
    },
  };
}

function clientRefreshBlock(script) {
  const start = script.indexOf("var _refreshTimer = null");
  const end = script.indexOf("};", script.indexOf("window._refreshData = function()")) + 2;
  return script.slice(start, end);
}

function runRefreshSandbox(script, body) {
  const sandbox = { setTimeout, clearTimeout, fetchCalls: 0 };
  vm.createContext(sandbox);
  vm.runInContext(
    `var window = {};
${clientRefreshBlock(script)}
function fetchSessions(cb) { fetchCalls++; if (cb) cb(); }
function fetchRuns() {}
function render() {}
${body}`,
    sandbox,
  );
  return sandbox;
}

describe("SSE debounce layers", () => {
  afterEach(() => {
    _resetDataUpdateTimerForTests();
    lrClients.clear();
    mock.timers.reset();
  });

  test("server fs coalesce waits 3s — no SSE at 2s, one payload at 3s", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { payloads, cleanup } = trackWrites();

    triggerDataUpdate();
    triggerDataUpdate();
    mock.timers.tick(2000);
    assert.equal(payloads.length, 0, "server must not use the client 2s window");

    mock.timers.tick(1000);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0], "data: data-update\n\n");
    assert.equal(DATA_UPDATE_DEBOUNCE_MS, 3000);
    assert.notEqual(DATA_UPDATE_DEBOUNCE_MS, CLIENT_REFRESH_DEBOUNCE_MS);
    cleanup();
  });

  test("client fetch coalesce waits 2s — not 3s, one fetch after rapid SSE hooks", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const script = browserClientScript({ sessions: [], total: 0, page: 1, pageSize: 50 });
    const sandbox = runRefreshSandbox(
      script,
      `window._refreshData();
window._refreshData();
window._refreshData();`,
    );

    mock.timers.tick(CLIENT_REFRESH_DEBOUNCE_MS - 1);
    assert.equal(sandbox.fetchCalls, 0);

    mock.timers.tick(1);
    assert.equal(sandbox.fetchCalls, 1, "rapid data-update hooks coalesce to one fetch");

    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS - CLIENT_REFRESH_DEBOUNCE_MS);
    assert.equal(sandbox.fetchCalls, 1, "client must not wait for server 3s debounce");
  });
});