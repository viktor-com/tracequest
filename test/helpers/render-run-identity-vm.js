/**
 * Render launched-run /run?id= identity: production runPage() SSR of
 * #runStatus / #composerStatus, then production setStatus as the snapshot
 * poll does, plus activityHtml from the session-poll lastState.
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { runPage } from "../../src/browser/run-page.js";

function extractFn(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `page includes function ${name}`);
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function ssrRunStatus(page) {
  const m = page.match(/id="runStatus" data-status="([^"]+)">([^<]*)<\/span>/);
  assert.ok(m, "runPage HTML includes #runStatus");
  return { status: m[1], text: m[2] };
}

function ssrComposer(page) {
  const m = page.match(/id="composerStatus" data-state="([^"]+)"/);
  assert.ok(m, "runPage HTML includes #composerStatus");
  const text = page.match(/id="statusText">([^<]*)<\/span>/);
  const stopTag = page.match(/id="stopBtn"[^>]*/);
  const killTag = page.match(/id="killBtn"[^>]*/);
  return {
    state: m[1],
    text: text ? text[1] : "",
    stopHidden: stopTag ? /\shidden/.test(stopTag[0]) : true,
    killHidden: killTag ? /\shidden/.test(killTag[0]) : true,
  };
}

/** activityHtml() for a launched-run lastState (running vs idle vs pending). */
export function launchedRunActivityHtml({
  run,
  lastState,
  lastKind = "text",
} = {}) {
  const page = runPage({ run });
  const ctx = { result: null };
  vm.createContext(ctx);
  vm.runInContext(
    `var stopped = false;
var lastState = ${JSON.stringify(lastState)};
var lastBlocks = [{ kind: ${JSON.stringify(lastKind)} }];
var resumedFromHash = null;
var followupText = null;
function markerHtml(title, sub) { return title + " :: " + (sub || ""); }
function escHtml(s) { return s; }
function followupDelivered() { return true; }
${extractFn(page, "activityHtml")}
result = activityHtml();`,
    ctx,
  );
  return ctx.result;
}

/**
 * @param {{ run: object, liveSessions?: object[], snapshotStatus?: string }} opts
 * @returns {{ page: string, ssr: string, status: string, text: string, terminalStatus: string,
 *   composer: { state: string, text: string, stopHidden: boolean, killHidden: boolean },
 *   activity: string, pollComposer?: { state: string, text: string, stopHidden: boolean, killHidden: boolean } }}
 */
export function paintLaunchedRunIdentity({
  run,
  liveSessions,
  snapshotStatus,
  sessionState,
} = {}) {
  const sessions = liveSessions ?? (
    run.sessionPath
      ? [{ path: run.sessionPath, live: run.live === true, id: run.id, source: run.agent }]
      : []
  );
  const page = runPage({ run });
  const ssr = ssrRunStatus(page);
  const composer = ssrComposer(page);
  const generating = run.status === "running";
  const chatState = run.status === "exited"
    ? "exited"
    : (run.sessionPath ? (generating ? "running" : "idle") : "pending");
  const activityState = sessionState === "running" || sessionState === "live"
    ? "running"
    : (sessionState === "pending" ? "pending" : (sessionState || chatState));
  const activity = launchedRunActivityHtml({
    run,
    lastState: activityState,
    lastKind: "text",
  });
  if (snapshotStatus === undefined) {
    snapshotStatus = run.status === "exited" ? "exited" : (generating ? "running" : "idle");
  }

  const statusEl = {
    text: ssr.text,
    attrs: { "data-status": ssr.status },
    get textContent() { return this.text; },
    set textContent(v) { this.text = v; },
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  };
  const terminal = {
    attrs: { "data-status": run.status },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  };
  const ctx = {
    _runs: [run],
    _liveSessions: sessions,
    statusEl,
    terminal,
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFn(page, "runIsLive")}
${extractFn(page, "runIdentityStatus")}
window._currentRunIdentityStatus = function () {
  return runIdentityStatus(_runs[0]);
};
${extractFn(page, "setStatus")}
setStatus(${JSON.stringify(snapshotStatus)});`,
    ctx,
  );
  let pollComposer;
  if (sessionState) {
    const composerEl = {
      attrs: { "data-state": composer.state },
      getAttribute(k) { return this.attrs[k]; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
    };
    const statusTextEl = { textContent: composer.text };
    const stopEl = { hidden: composer.stopHidden };
    const killEl = { hidden: composer.killHidden };
    const pollCtx = {
      stopped: false,
      lastState: composer.state === "exited" ? "exited" : "pending",
      composerStatus: composerEl,
      statusText: statusTextEl,
      stopBtn: stopEl,
      killBtn: killEl,
      closeKeysMenu() {},
      closeRunMenu() {},
    };
    vm.createContext(pollCtx);
    vm.runInContext(
      `${extractFn(page, "pollGeneratingStatus")}
${extractFn(page, "setComposerState")}
var data = { status: ${JSON.stringify(sessionState)}, state: ${JSON.stringify(sessionState)}, link: "linked" };
var word = pollGeneratingStatus(data);
if (word === "running") setComposerState("running", "Running");
else if (word === "idle") setComposerState("idle", "Idle");`,
      pollCtx,
    );
    pollComposer = {
      state: composerEl.getAttribute("data-state"),
      text: statusTextEl.textContent,
      stopHidden: stopEl.hidden,
      killHidden: killEl.hidden,
    };
  }

  return {
    page,
    ssr: ssr.status,
    status: statusEl.getAttribute("data-status"),
    text: statusEl.textContent,
    terminalStatus: terminal.attrs["data-status"],
    composer,
    activity,
    pollComposer,
  };
}
