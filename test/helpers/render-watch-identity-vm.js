/**
 * Run production /run?session= applySession + paintWatchChrome so D1 can
 * assert identity chrome (#runStatus, data-run-state, title, observer
 * heading) follows poll state / detectLiveSessions, not the QUIET_MS
 * growth overlay — and that a completed idle G1 column leftover-occupies
 * the named Bash/shell output (real G1 tool-then-prose fixture,
 * production leftoverSnapIsStale + production leftover layout:
 * production rerender, applyThreadItems, production containNamedOutput),
 * does not shimmer Planning next moves, and paints Send a follow-up.
 */
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { liveSessionPage } from "../../src/browser/run-page.js";
import { parseGrok } from "../../src/parse/parse-grok.js";

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

function extractRange(src, startName, endName) {
  const start = src.indexOf(`function ${startName}(`);
  assert.ok(start >= 0, `page includes function ${startName}`);
  const endStart = src.indexOf(`function ${endName}(`);
  assert.ok(endStart > start, `page includes function ${endName} after ${startName}`);
  const brace = src.indexOf("{", endStart);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${endName}`);
}

function el(attrs = {}) {
  return {
    text: "",
    hidden: false,
    attrs: { ...attrs },
    get textContent() { return this.text; },
    set textContent(v) { this.text = v; },
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
  };
}

function matchesSel(node, sel) {
  sel = String(sel || "").trim();
  if (!sel || !node || node.nodeType !== 1) return false;
  if (sel.startsWith("#")) {
    const id = sel.slice(1);
    return node.id === id || node.getAttribute("id") === id;
  }
  if (sel.startsWith("[")) {
    const m = /^\[([^=\]]+)(?:=([^\]]*))?\]$/.exec(sel);
    if (!m) return false;
    const got = node.getAttribute(m[1]);
    if (m[2] == null) return got != null;
    return got === m[2];
  }
  const tokens = sel.split(/(?=\.)/).filter(Boolean);
  let i = 0;
  if (tokens[0] && !tokens[0].startsWith(".")) {
    if (node.tagName !== tokens[0].toUpperCase()) return false;
    i = 1;
  }
  for (; i < tokens.length; i++) {
    const cls = tokens[i].replace(/^\./, "");
    if (!node.classList || !node.classList.contains(cls)) return false;
  }
  return true;
}

function collectMatches(root, selector, stopAtOne) {
  const groups = String(selector).split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  function walk(node) {
    for (const k of node.children || []) {
      if (k.nodeType && k.nodeType !== 1) continue;
      if (groups.some((g) => matchesSel(k, g))) {
        out.push(k);
        if (stopAtOne) return true;
      }
      if (walk(k)) return true;
    }
    return false;
  }
  walk(root);
  return stopAtOne ? (out[0] || null) : out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([:@]?[\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : "";
  }
  return attrs;
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr", "path",
]);

function textNode(value) {
  const node = {
    nodeType: 3,
    nodeValue: String(value),
    parentNode: null,
    children: [],
    tagName: "",
    className: "",
    classList: { contains() { return false; } },
    style: {},
    attrs: {},
    get textContent() { return node.nodeValue; },
    set textContent(v) { node.nodeValue = v == null ? "" : String(v); },
    get firstChild() { return null; },
    get lastChild() { return null; },
    get nextSibling() {
      if (!node.parentNode || !node.parentNode.children) return null;
      const i = node.parentNode.children.indexOf(node);
      return i >= 0 ? node.parentNode.children[i + 1] || null : null;
    },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { const list = []; list.item = () => null; return list; },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }; },
  };
  return node;
}

function parseFragment(html, parent) {
  const re = /<\/?([a-zA-Z][\w:-]*)([^>]*)\/?>|([^<]+)/g;
  let m;
  const stack = [parent];
  while ((m = re.exec(html))) {
    const cur = stack[stack.length - 1];
    if (m[3] != null) {
      cur.appendChild(textNode(decodeEntities(m[3])));
      continue;
    }
    const tag = m[1];
    if (m[0].startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const child = makeEl(tag, parseAttrs(m[2] || ""));
    cur.appendChild(child);
    const selfClose = m[0].endsWith("/>") || VOID.has(tag.toLowerCase());
    if (!selfClose) stack.push(child);
  }
}

function isLeftoverViewport(node) {
  return !!(node && node.nodeType === 1
    && (node.id === "chatScroll"
      || (node.classList && node.classList.contains("chat-scroll"))));
}

function leftoverViewportHeight(node) {
  if (!isLeftoverViewport(node)) return 0;
  const h = Number(node.clientHeight);
  return h > 0 ? h : 0;
}

function boxHeight(node) {
  // Production leftover is flex:1 leftover viewport: leftover.bottom
  // is composer.top of leftover.clientHeight leftover viewport, not
  // leftover-owned content height (layoutHeight of leftover).
  // leftover occupancy of leftover-owned content is not leftover occupancy of leftover.
  const leftoverH = leftoverViewportHeight(node);
  if (leftoverH > 0) return leftoverH;
  return layoutHeight(node);
}

function layoutHeight(node) {
  if (!node || node.nodeType === 3) return 0;
  if (node.getAttribute && node.getAttribute("data-contained") === "parked") return 0;
  if (node.style && (node.style.height === "0px" || node.style.maxHeight === "0px")) return 0;
  if (node.hidden) return 0;
  // Idle identity CSS hides .chat-activity; leftover-owned pixels are
  // the named column, not the Not-running marker under leftover.
  if (node.id === "chatActivity" || (node.classList && node.classList.contains("chat-activity"))) {
    return 0;
  }
  if (node.classList && node.classList.contains("chat-output-head")) return 28;
  if (node.classList && node.classList.contains("chat-tool-body")) {
    if (node.style && node.style.height) {
      const h = parseFloat(node.style.height);
      if (h > 0) return h;
    }
    const n = String(node.textContent || "").replace(/\n$/, "").split("\n").length;
    return Math.max(24, n * 16);
  }
  if (node.classList && node.classList.contains("chat-output")) {
    const head = node.querySelector && node.querySelector(".chat-output-head");
    const body = node.querySelector && node.querySelector(".chat-tool-body");
    return layoutHeight(head) + layoutHeight(body) + 12;
  }
  if (node.classList && node.classList.contains("chat-user")) return 36;
  if (node.classList && node.classList.contains("chat-assistant")) {
    const n = String(node.textContent || "").replace(/\n$/, "").split("\n").filter(Boolean).length;
    return Math.max(24, Math.max(1, n) * 16);
  }
  if (node.classList && node.classList.contains("chat-composer")) return 44;
  if (node.classList && node.classList.contains("chat-thought")) return 24;
  if (node.children && node.children.length) {
    let h = 0;
    for (const c of node.children) {
      if (c.nodeType === 3) continue;
      h += layoutHeight(c);
    }
    return h;
  }
  return node._height || 0;
}

function makeEl(tag, attrs = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    hidden: Object.prototype.hasOwnProperty.call(attrs, "hidden"),
    style: {},
    attrs: { ...attrs },
    className: attrs.class || "",
    id: attrs.id || "",
    scrollHeight: 96,
    scrollTop: 0,
    clientHeight: 600,
    _innerHTML: "",
    classList: {
      contains(c) {
        return (" " + node.className + " ").includes(" " + c + " ");
      },
    },
    get textContent() {
      if (!node.children.length) return "";
      return node.children.map((c) => (
        c.nodeType === 3 ? c.nodeValue : c.textContent
      )).join("");
    },
    set textContent(v) {
      const t = textNode(v == null ? "" : String(v));
      t.parentNode = node;
      node.children = [t];
      node._innerHTML = "";
    },
    get innerHTML() { return node._innerHTML; },
    set innerHTML(v) {
      node._innerHTML = v == null ? "" : String(v);
      node.children = [];
      parseFragment(node._innerHTML, node);
      if (node.classList.contains("chat-tool-body")) {
        const n = String(node.textContent || "").replace(/\n$/, "").split("\n").length;
        node.scrollHeight = Math.max(24, n * 16);
      }
    },
    get firstChild() { return node.children[0] || null; },
    get lastChild() { return node.children.length ? node.children[node.children.length - 1] : null; },
    get nextSibling() {
      if (!node.parentNode || !node.parentNode.children) return null;
      const i = node.parentNode.children.indexOf(node);
      return i >= 0 ? node.parentNode.children[i + 1] || null : null;
    },
    getAttribute(k) {
      if (k === "class") return node.className;
      if (k === "id") return node.id || node.attrs.id;
      return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null;
    },
    setAttribute(k, v) {
      const s = String(v);
      node.attrs[k] = s;
      if (k === "class") node.className = s;
      if (k === "id") node.id = s;
      if (k === "hidden") node.hidden = true;
    },
    removeAttribute(k) {
      delete node.attrs[k];
      if (k === "class") node.className = "";
      if (k === "id") node.id = "";
      if (k === "hidden") node.hidden = false;
    },
    querySelector(sel) { return collectMatches(node, sel, true); },
    querySelectorAll(sel) {
      const list = collectMatches(node, sel, false);
      list.item = (i) => list[i] || null;
      return list;
    },
    appendChild(child) { return node.insertBefore(child, null); },
    insertBefore(child, ref) {
      if (!child) return child;
      if (child.parentNode && typeof child.parentNode.removeChild === "function") {
        child.parentNode.removeChild(child);
      }
      child.parentNode = node;
      if (ref == null) node.children.push(child);
      else {
        const i = node.children.indexOf(ref);
        node.children.splice(i < 0 ? node.children.length : i, 0, child);
      }
      return child;
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener() {},
    compareDocumentPosition(other) {
      let root = node;
      while (root.parentNode) root = root.parentNode;
      const order = [];
      (function walk(n) {
        order.push(n);
        for (const c of n.children || []) walk(c);
      })(root);
      const i = order.indexOf(node);
      const j = order.indexOf(other);
      if (i < 0 || j < 0) return 0;
      if (j > i) return 4;
      if (j < i) return 2;
      return 0;
    },
    getBoundingClientRect() {
      // Production leftover bounds: leftover.top is leftover
      // (#chatScroll) top, leftover.bottom is composer.top of the
      // flex leftover viewport (leftover.clientHeight), leftover =
      // composer.top − leftover.top = leftover.clientHeight — never
      // leftover occupancy of leftover-owned content is not leftover occupancy of leftover,
      // never a hardcoded 0–560 leftover box.
      let top = 0;
      let n = node;
      while (n && n.parentNode && n.parentNode.children) {
        const parent = n.parentNode;
        for (const kid of parent.children) {
          if (kid === n) break;
          if (kid.nodeType === 3) continue;
          top += boxHeight(kid);
        }
        n = parent;
      }
      const h = boxHeight(node);
      return { top, bottom: top + h, height: h, left: 0, right: 640, width: 640 };
    },
  };
  if (attrs.class) node.className = attrs.class;
  if (attrs.id) node.id = attrs.id;
  return node;
}

const G1_FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/live-finalisation/grok-idle",
);

/** Real G1 recording: opening prose + named Bash/shell output + closing prose. */
export function g1IdleEvents() {
  return parseGrok(G1_FIXTURE_DIR).events;
}

/**
 * @param {{ live?: boolean, etagMtime?: number, events?: object[],
 *   unchanged?: boolean, hash?: string }} opts
 * @returns {{ page: string, status: string, text: string, runState: string,
 *   title: string, observerTitle: string, liveTail: string,
 *   liveTailFormHidden: boolean, growth: boolean, activityHtml: string,
 *   namedOutput: string, continueFormHidden: boolean,
 *   continuePlaceholder: string, leftoverSnapIsStale: boolean,
 *   namedCardContained: string, namedCardInHistory: boolean,
 *   namedCardMeta: string, namedCardName: string, namedCardText: string,
 *   namedCardFold: boolean, priorDumpsParked: boolean,
 *   leftoverUserOnLeftover: boolean, namedOccupiesLeftover: boolean,
 *   leftoverOpeningOnLeftover: boolean, leftoverClosingOnLeftover: boolean,
 *   leftoverNamedTop: number, leftoverNamedBottom: number,
 *   leftoverTop: number, leftoverComposerTop: number, leftover: number,
 *   leftoverOwnedTop: number, leftoverOwnedBottom: number,
 *   leftoverOwned: number, leftoverAir: number,
 *   leftoverClientHeight: number, events: object[] }}
 */
export function paintWatchIdentityAfterPoll({
  live = false,
  etagMtime = Date.now(),
  events = g1IdleEvents(),
  unchanged = false,
  hash = "g1idle",
} = {}) {
  const page = liveSessionPage({
    session: {
      hash,
      path: "/tmp/g1-idle.jsonl",
      source: "grok",
      project: "sample-app",
      live,
      continuable: true,
      agent: "grok",
    },
  });
  const continuePlaceholderMatch = page.match(
    /id="continueInput"[^>]*placeholder="([^"]+)"/,
  );
  assert.ok(continuePlaceholderMatch, "idle watch page paints #continueInput");
  const continuePlaceholder = continuePlaceholderMatch[1];
  const statusEl = el({ "data-status": live ? "running" : "idle" });
  statusEl.text = live ? "running" : "idle";
  const composerStatus = el({ "data-state": live ? "running" : "idle" });
  const observerTitle = { textContent: live ? "Watching a running session" : "Watching an idle session" };
  const observerNoteTail = { textContent: "" };
  const archiveEnding = { hidden: !!live };
  const observerCard = { hidden: !!live };
  const readonlyChip = { hidden: !!live };
  const liveTailForm = el(live ? { "data-busy": "true" } : {});
  liveTailForm.hidden = !live;
  const statusText = { textContent: "Not running right now" };
  const continueForm = el({ "data-mode": "continue" });
  continueForm.hidden = false;
  const body = el({
    "data-run-state": live ? "running" : "idle",
    "data-live-tail": live ? "1" : "0",
  });
  const g1Events = events === undefined ? g1IdleEvents() : events;
  const chatThread = makeEl("div", { id: "chatThread", class: "chat-thread" });
  const historyRoot = makeEl("div", { id: "chatHistory", class: "chat-history" });
  const historyCol = makeEl("div", { id: "chatHistoryCol" });
  historyRoot.appendChild(historyCol);
  historyRoot.hidden = true;
  const chatScroll = makeEl("div", { id: "chatScroll", class: "chat-scroll" });
  chatScroll.scrollTop = 0;
  chatScroll.clientHeight = 600;
  chatScroll.scrollHeight = 800;
  const chatActivity = makeEl("div", { id: "chatActivity", class: "chat-activity" });
  const composer = makeEl("footer", { class: "chat-composer" });
  // Production leftover tree: leftover (#chatScroll) is the flex:1
  // leftover viewport; leftover.bottom is composer.top of leftover
  // leftover.clientHeight leftover viewport. leftover occupancy of leftover-owned content is not leftover occupancy of leftover.
  const chatCol = makeEl("div", { class: "chat-col" });
  chatCol.appendChild(chatThread);
  chatCol.appendChild(chatActivity);
  chatScroll.appendChild(chatCol);
  const chatMain = makeEl("div", { class: "chat-main" });
  chatMain.appendChild(historyRoot);
  chatMain.appendChild(chatScroll);
  chatMain.appendChild(composer);
  const document = {
    body,
    title: `tracequest — ${live ? "running" : "idle"} session ${hash}`,
    createElement(tag) { return makeEl(tag); },
    createTextNode(text) { return textNode(text); },
    getElementById(id) {
      if (id === "continueForm") return continueForm;
      if (id === "chatHistory") return historyRoot;
      if (id === "chatHistoryCol") return historyCol;
      if (id === "chatThread") return chatThread;
      if (id === "chatScroll") return chatScroll;
      if (id === "chatActivity") return chatActivity;
      return null;
    },
    querySelector(sel) {
      if (sel === ".chat-composer") return composer;
      if (matchesSel(chatThread, sel)) return chatThread;
      if (matchesSel(chatScroll, sel)) return chatScroll;
      if (matchesSel(composer, sel)) return composer;
      return chatThread.querySelector(sel)
        || historyRoot.querySelector(sel)
        || chatMain.querySelector(sel)
        || null;
    },
    createRange() {
      let startNode = null;
      let startOff = 0;
      let endOff = 0;
      return {
        setStart(n, o) { startNode = n; startOff = o; },
        setEnd(n, o) { endOff = o; },
        getBoundingClientRect() {
          const raw = (startNode && startNode.nodeValue) || "";
          const pre = startNode && startNode.parentNode;
          const br = pre && typeof pre.getBoundingClientRect === "function"
            ? pre.getBoundingClientRect()
            : { top: 0 };
          const lh = 16;
          const startLine = raw.slice(0, startOff).split("\n").length - 1;
          const endLine = raw.slice(0, endOff).split("\n").length - 1;
          const top = (br.top || 0) + startLine * lh;
          const bottom = (br.top || 0) + (endLine + 1) * lh;
          return { top, bottom, height: Math.max(0, bottom - top), left: 0, right: 640, width: 640 };
        },
      };
    },
  };
  const ctx = {
    statusEl,
    composerStatus,
    observerTitle,
    observerNoteTail,
    archiveEnding,
    observerCard,
    readonlyChip,
    liveTailForm,
    statusText,
    continueForm,
    document,
    chatScroll,
    chatThread,
    chatActivity,
    historyRoot,
    historyCol,
    composer,
    sessionHandle: hash,
    apiLive: !!live,
    lastEtag: null,
    lastGrowthAt: 0,
    lastSession: null,
    lastState: live ? "running" : "idle",
    lastBlocks: [],
    lastThreadHtml: "",
    lastActivityHtml: "",
    lastItems: [],
    leftoverSnapFlag: false,
    occupancy: null,
    stopped: false,
    runCwd: "",
    followTail: true,
    openThoughts: {},
    Date,
    String,
    Number,
    Boolean,
    Object,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Math,
    Array,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    requestAnimationFrame(fn) { fn(); },
    window: {
      getComputedStyle() {
        return {
          paddingTop: "8",
          paddingBottom: "8",
          borderTopWidth: "0",
          borderBottomWidth: "0",
          lineHeight: "16",
          fontSize: "11.5",
        };
      },
      addEventListener() {},
    },
    isAtBottom() { return true; },
    result: null,
  };
  vm.createContext(ctx);
  const etag = `${etagMtime}-42`;
  const session = { events: g1Events, cwd: "/home/dev/code/sample-app/sample-app" };
  vm.runInContext(
    `var QUIET_MS = 4000;
${extractRange(page, "escHtml", "rerender")}
${extractFn(page, "hasUnresolvedToolUse")}
${extractFn(page, "recordingGrewRecently")}
${extractFn(page, "deriveWatchLive")}
${extractFn(page, "watchIdentityWord")}
${extractFn(page, "setWatchState")}
${extractFn(page, "paintWatchChrome")}
${extractFn(page, "activityHtml")}
${extractFn(page, "applySession")}
applySession(${JSON.stringify({
      state: live ? "running" : "idle",
      unchanged,
      etag,
      session,
    })});
leftoverSnapFlag = leftoverSnapIsStale();
occupancy = (function () {
  // Production leftover bounds: leftover.top is leftover (#chatScroll)
  // top, leftover.bottom is composer.top of the flex leftover
  // viewport (leftover.clientHeight), leftover = composer.top −
  // leftover.top = leftover.clientHeight. leftover-owned pixels
  // occupying leftover are opening prose + named card + closing
  // prose. leftoverAir is leftover − leftoverOwned (BAR leftover
  // has leftover air under closing). leftover occupancy of leftover-owned content is not leftover occupancy of leftover.
  var leftoverTop = chatScroll.getBoundingClientRect().top;
  var leftoverBottom = composer.getBoundingClientRect().top;
  var leftover = leftoverBottom - leftoverTop;
  var leftoverClientHeight = chatScroll.clientHeight;
  var cards = chatThread.querySelectorAll(".chat-card.chat-output");
  var named = cards.length ? cards[cards.length - 1] : null;
  var hist = document.getElementById("chatHistoryCol");
  var inHist = false;
  var walk = named;
  while (walk) {
    if (walk === hist || walk.id === "chatHistory" || walk.id === "chatHistoryCol") inHist = true;
    walk = walk.parentNode;
  }
  var metaEl = named && named.querySelector(".chat-output-meta");
  var nameEl = named && named.querySelector(".chat-output-name");
  var bodyEl = named && named.querySelector(".chat-tool-body");
  var contained = named ? named.getAttribute("data-contained") : "";
  var nr = named && named.getBoundingClientRect();
  function occupiesLeftover(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute("data-contained") === "parked") return false;
    var r = el.getBoundingClientRect();
    return !!(r && r.height > 0 && r.bottom > leftoverTop + 1 && r.top < leftoverBottom);
  }
  var namedOccupies = !!(named && contained !== "parked" && !inHist && nr
    && nr.height > 0 && nr.top >= leftoverTop - 1 && nr.top < leftoverBottom
    && nr.bottom <= leftoverBottom + 1);
  var users = chatThread.querySelectorAll(".chat-user");
  var userOn = false;
  var u;
  for (u = 0; u < users.length; u++) {
    if (occupiesLeftover(users[u])) userOn = true;
  }
  var histUsers = hist ? hist.querySelectorAll(".chat-user") : [];
  for (u = 0; u < histUsers.length; u++) {
    if (occupiesLeftover(histUsers[u])) userOn = true;
  }
  var priorParked = true;
  var i;
  for (i = 0; i < cards.length; i++) {
    if (cards[i] === named) continue;
    if (occupiesLeftover(cards[i])) priorParked = false;
  }
  var assistants = chatThread.querySelectorAll(".chat-assistant");
  var opening = null;
  var closing = null;
  for (i = 0; i < assistants.length; i++) {
    if (!occupiesLeftover(assistants[i])) continue;
    if (!opening) opening = assistants[i];
    closing = assistants[i];
  }
  var openingOn = occupiesLeftover(opening);
  var closingOn = occupiesLeftover(closing);
  var or = opening ? opening.getBoundingClientRect() : null;
  var cr = closing ? closing.getBoundingClientRect() : null;
  var leftoverOwnedTop = or ? or.top : leftoverTop;
  var leftoverOwnedBottom = cr ? cr.bottom : leftoverTop;
  var leftoverOwned = leftoverOwnedBottom - leftoverOwnedTop;
  var leftoverAir = leftover - leftoverOwned;
  var leftoverViewport = leftover > 0 && leftover === leftoverClientHeight
    && leftover > leftoverOwned;
  var fold = !!(namedOccupies && openingOn && closingOn && !userOn && priorParked
    && leftoverViewport && leftoverOwned > 0);
  return {
    namedOutput: lastState === "running" ? "parked" : (fold ? "leftover-snap" : (contained === "parked" ? "parked" : "")),
    namedCardContained: contained || "",
    namedCardInHistory: inHist,
    namedCardMeta: metaEl ? metaEl.textContent : "",
    namedCardName: nameEl ? nameEl.textContent : "",
    namedCardText: bodyEl ? bodyEl.textContent : "",
    namedCardFold: fold,
    priorDumpsParked: priorParked,
    leftoverUserOnLeftover: userOn,
    namedOccupiesLeftover: namedOccupies,
    leftoverOpeningOnLeftover: openingOn,
    leftoverClosingOnLeftover: closingOn,
    leftoverOpeningText: opening ? opening.textContent : "",
    leftoverClosingText: closing ? closing.textContent : "",
    leftoverNamedTop: nr ? nr.top : -1,
    leftoverNamedBottom: nr ? nr.bottom : -1,
    leftoverTop: leftoverTop,
    leftoverComposerTop: leftoverBottom,
    leftover: leftover,
    leftoverOwnedTop: leftoverOwnedTop,
    leftoverOwnedBottom: leftoverOwnedBottom,
    leftoverOwned: leftoverOwned,
    leftoverAir: leftoverAir,
    leftoverClientHeight: leftoverClientHeight,
    leftoverPreFirstNodeType: bodyEl && bodyEl.firstChild ? bodyEl.firstChild.nodeType : 0,
  };
})();
result = {
  status: statusEl.getAttribute("data-status"),
  text: statusEl.textContent,
  runState: document.body.getAttribute("data-run-state"),
  title: document.title,
  observerTitle: observerTitle.textContent,
  liveTail: document.body.getAttribute("data-live-tail"),
  liveTailFormHidden: liveTailForm.hidden,
  growth: lastState === "running",
  activityHtml: lastActivityHtml,
  namedOutput: occupancy.namedOutput,
  namedCardContained: occupancy.namedCardContained,
  namedCardInHistory: occupancy.namedCardInHistory,
  namedCardMeta: occupancy.namedCardMeta,
  namedCardName: occupancy.namedCardName,
  namedCardText: occupancy.namedCardText,
  namedCardFold: occupancy.namedCardFold,
  priorDumpsParked: occupancy.priorDumpsParked,
  leftoverUserOnLeftover: occupancy.leftoverUserOnLeftover,
  namedOccupiesLeftover: occupancy.namedOccupiesLeftover,
  leftoverOpeningOnLeftover: occupancy.leftoverOpeningOnLeftover,
  leftoverClosingOnLeftover: occupancy.leftoverClosingOnLeftover,
  leftoverOpeningText: occupancy.leftoverOpeningText,
  leftoverClosingText: occupancy.leftoverClosingText,
  leftoverNamedTop: occupancy.leftoverNamedTop,
  leftoverNamedBottom: occupancy.leftoverNamedBottom,
  leftoverTop: occupancy.leftoverTop,
  leftoverComposerTop: occupancy.leftoverComposerTop,
  leftover: occupancy.leftover,
  leftoverOwnedTop: occupancy.leftoverOwnedTop,
  leftoverOwnedBottom: occupancy.leftoverOwnedBottom,
  leftoverOwned: occupancy.leftoverOwned,
  leftoverAir: occupancy.leftoverAir,
  leftoverClientHeight: occupancy.leftoverClientHeight,
  leftoverPreFirstNodeType: occupancy.leftoverPreFirstNodeType,
  continueFormHidden: !!(archiveEnding.hidden || continueForm.hidden),
  leftoverSnapIsStale: leftoverSnapFlag,
};`,
    ctx,
  );
  return { page, continuePlaceholder, events: g1Events, ...ctx.result };
}
