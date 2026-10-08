/**
 * Overlay focus lifecycle — APG dialog: open moves focus in, Tab stays
 * trapped, Escape/backdrop restore prev, no stale focus on hidden nodes.
 * Fact anchors: ofp oft ofx ofs ofl oflt oflr ofk ofr ofa ofstk ofstkt ofstke ofshare ofshareslash ofkeysslash ofallpush ofkmodal ofrmodal ofstackz ofsharek ofchord ofage ofageslash ofagepush ofageinert offly offlyslash offlypush offlyinert offlyframe offlycmdk
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { COMMAND_PALETTE_CLIENT_JS } from "../../src/browser/command-palette.js";
import { LAUNCHER_CLIENT_JS } from "../../src/browser/launch-page.js";
import { OVERLAY_FOCUS_SRC, pushOverlay, popOverlay } from "../../src/browser/overlay-focus.js";
import { install, keyDownHandler } from "../../src/browser/is-form-field.js";
import { runPage } from "../../src/browser/run-page.js";
import { SHARE_JS } from "../../src/render/render-share.js";
import { CORE_JS } from "../../src/render/render-core.js";

const RUN_PAGE_SRC = readFileSync(new URL("../../src/browser/run-page.js", import.meta.url), "utf8");
const BROWSER_CLIENT_SRC = readFileSync(new URL("../../src/browser/browser-client.js", import.meta.url), "utf8");

function makeClassList(owner) {
  const parts = () => new Set(String(owner.className || "").split(/\s+/).filter(Boolean));
  return {
    add(cls) {
      const s = parts();
      s.add(cls);
      owner.className = [...s].join(" ");
    },
    remove(cls) {
      const s = parts();
      s.delete(cls);
      owner.className = [...s].join(" ");
    },
    contains(cls) {
      return parts().has(cls);
    },
    toggle(cls, force) {
      if (force === true) this.add(cls);
      else if (force === false) this.remove(cls);
      else if (this.contains(cls)) this.remove(cls);
      else this.add(cls);
      return this.contains(cls);
    },
  };
}

function matchesSel(el, sel) {
  if (!el || el.nodeType === 9) return false;
  const s = String(sel || "").trim();
  if (!s) return false;
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return String(el.className || "").split(/\s+/).includes(s.slice(1));
  const attr = s.match(/^([a-z][\w-]*)?\[([^\]]+)\]$/i);
  if (attr) {
    if (attr[1] && String(el.tagName || "").toLowerCase() !== attr[1].toLowerCase()) return false;
    const raw = attr[2];
    const eq = raw.match(/^([^\s=]+)(?:=["']?([^"'\]]+)["']?)?$/);
    if (!eq) return el.hasAttribute(raw);
    if (eq[2] == null) return el.hasAttribute(eq[1]);
    return el.getAttribute(eq[1]) === eq[2];
  }
  return String(el.tagName || "").toLowerCase() === s.toLowerCase();
}

function walk(el, out = []) {
  if (!el || !el._kids) return out;
  for (const kid of el._kids) {
    out.push(kid);
    walk(kid, out);
  }
  return out;
}

function createHarness() {
  const byId = new Map();
  let activeElement = null;

  function createEl(tag, extra = {}) {
    const attrs = Object.create(null);
    const node = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      className: extra.className || "",
      _id: extra.id || "",
      _kids: [],
      parentNode: null,
      hidden: !!extra.hidden,
      value: extra.value || "",
      textContent: extra.textContent || "",
      innerHTML: "",
      type: extra.type || "",
      href: extra.href || "",
      disabled: false,
      isContentEditable: false,
      _cap: Object.create(null),
      _bub: Object.create(null),
      style: {},
      get id() { return this._id; },
      set id(v) {
        if (this._id) byId.delete(this._id);
        this._id = String(v || "");
        if (this._id) byId.set(this._id, this);
      },
      get children() { return this._kids; },
      get childNodes() { return this._kids; },
      get isConnected() {
        let n = this;
        while (n) {
          if (n.nodeType === 9) return true;
          n = n.parentNode;
        }
        return false;
      },
      get ownerDocument() {
        let n = this;
        while (n) {
          if (n.nodeType === 9) return n;
          n = n.parentNode;
        }
        return document;
      },
      setAttribute(name, value) {
        attrs[name] = String(value);
        if (name === "id") this.id = value;
        if (name === "class") this.className = String(value);
        if (name === "type") this.type = String(value);
        if (name === "hidden") this.hidden = true;
        if (name === "href") this.href = String(value);
        if (name === "tabindex" || name === "tabIndex") attrs.tabindex = String(value);
        if (name === "inert") {
          const active = activeElement;
          if (active && (active === node || walk(node).includes(active))) {
            activeElement = document.body;
          }
        }
      },
      getAttribute(name) {
        if (name === "id") return this.id || null;
        if (name === "class") return this.className || null;
        if (name === "type") return this.type || null;
        if (name === "hidden") return this.hidden ? "" : null;
        if (name === "href") return this.href || null;
        if (name === "tabindex" || name === "tabIndex") return Object.prototype.hasOwnProperty.call(attrs, "tabindex") ? attrs.tabindex : null;
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      hasAttribute(name) {
        if (name === "hidden") return !!this.hidden;
        if (name === "id") return !!this.id;
        if (name === "href") return !!this.href;
        if (name === "tabindex" || name === "tabIndex") return Object.prototype.hasOwnProperty.call(attrs, "tabindex");
        return Object.prototype.hasOwnProperty.call(attrs, name);
      },
      removeAttribute(name) {
        if (name === "hidden") this.hidden = false;
        if (name === "id") this.id = "";
        if (name === "tabindex" || name === "tabIndex") delete attrs.tabindex;
        delete attrs[name];
      },
      appendChild(child) {
        if (child.parentNode && child.parentNode._kids) {
          child.parentNode._kids = child.parentNode._kids.filter((k) => k !== child);
        }
        child.parentNode = this;
        this._kids.push(child);
        return child;
      },
      querySelector(sel) {
        return walk(this).find((n) => matchesSel(n, sel)) || null;
      },
      querySelectorAll(sel) {
        return walk(this).filter((n) => matchesSel(n, sel));
      },
      closest(sel) {
        for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
          if (matchesSel(n, sel)) return n;
        }
        return null;
      },
      contains(other) {
        if (other === this) return true;
        return walk(this).includes(other);
      },
      focus() {
        for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
          if (typeof n.hasAttribute === "function" && n.hasAttribute("inert")) return;
        }
        const owner = this.ownerDocument;
        if (owner && owner !== document) {
          const iframe = walk(document).find((n) => n.tagName === "IFRAME" && n.contentDocument === owner);
          owner.activeElement = this;
          if (iframe) {
            activeElement = iframe;
            this._focused = true;
            return;
          }
        }
        activeElement = this;
        this._focused = true;
      },
      getBoundingClientRect() {
        return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      },
      get offsetHeight() { return 0; },
      get offsetWidth() { return 0; },
      blur() {
        if (activeElement === this) activeElement = document.body;
        this._blurred = true;
      },
      click() {
        dispatch(this, "click");
      },
      addEventListener(type, fn, cap) {
        const bucket = cap === true || (cap && cap.capture) ? this._cap : this._bub;
        if (!bucket[type]) bucket[type] = [];
        bucket[type].push(fn);
      },
      removeEventListener() {},
      scrollIntoView() {},
    };
    node.classList = makeClassList(node);
    if (extra.id) node.id = extra.id;
    if (extra.type) node.type = extra.type;
    if (extra.attrs) {
      for (const [k, v] of Object.entries(extra.attrs)) node.setAttribute(k, v);
    }
    return node;
  }

  const document = {
    nodeType: 9,
    tagName: "#DOCUMENT",
    _cap: Object.create(null),
    _bub: Object.create(null),
    parentNode: null,
    _kids: [],
    get children() { return this._kids; },
    get activeElement() { return activeElement; },
    set activeElement(v) { activeElement = v; },
    body: null,
    getElementById: (id) => byId.get(id) || null,
    querySelector(sel) {
      if (matchesSel(this.body, sel)) return this.body;
      return walk(this).find((n) => matchesSel(n, sel)) || null;
    },
    querySelectorAll(sel) {
      const out = [];
      if (matchesSel(this.body, sel)) out.push(this.body);
      return out.concat(walk(this).filter((n) => matchesSel(n, sel)));
    },
    createElement: (tag) => createEl(tag),
    addEventListener(type, fn, cap) {
      const bucket = cap === true || (cap && cap.capture) ? this._cap : this._bub;
      if (!bucket[type]) bucket[type] = [];
      bucket[type].push(fn);
    },
    removeEventListener() {},
  };

  const body = createEl("body");
  body.parentNode = document;
  document._kids = [body];
  document.body = body;

  const app = createEl("div", { id: "app" });
  const filterInput = createEl("input", { id: "filterInput", className: "filter-input", type: "text" });
  const behindLink = createEl("a", { id: "behindLink" });
  behindLink.href = "/sessions";
  behindLink.setAttribute("href", "/sessions");
  const newRunBtn = createEl("button", { id: "newRunBtn", type: "button" });
  const ageBtn = createEl("button", { id: "ageBtn", type: "button" });
  const ageMenu = createEl("div", { id: "ageMenu", className: "toolbar-menu", hidden: true });
  ageMenu.setAttribute("role", "listbox");
  const ageAll = createEl("button", { className: "toolbar-option", type: "button" });
  const ageDay = createEl("button", { className: "toolbar-option", type: "button" });
  ageMenu.appendChild(ageAll);
  ageMenu.appendChild(ageDay);
  const sourceBtn = createEl("button", { id: "sourceBtn", type: "button" });
  const sourceMenu = createEl("div", { id: "sourceMenu", className: "toolbar-menu", hidden: true });
  sourceMenu.setAttribute("role", "listbox");
  const sourceAll = createEl("button", { className: "toolbar-option", type: "button" });
  sourceMenu.appendChild(sourceAll);
  const displayToggle = createEl("button", { id: "displayToggle", type: "button" });
  const sortBar = createEl("div", { id: "sortBar", className: "sort-bar toolbar-menu", hidden: true });
  const sortRecent = createEl("button", { className: "sort-btn", type: "button" });
  const sortCost = createEl("button", { className: "sort-btn", type: "button" });
  sortBar.appendChild(sortRecent);
  sortBar.appendChild(sortCost);
  const cmdkTrigger = createEl("button", { id: "cmdkTrigger", type: "button" });
  const kbd = createEl("span", { className: "cmdk-trigger-kbd" });
  cmdkTrigger.appendChild(kbd);

  const overlay = createEl("div", { id: "cmdkOverlay", className: "cmdk-overlay", hidden: true });
  overlay.setAttribute("data-cmdk-state", "closed");
  const scrim = createEl("div", { id: "cmdkScrim", className: "cmdk-scrim" });
  const dialog = createEl("div", { className: "cmdk" });
  const contextWrap = createEl("div", { id: "cmdkContextWrap", hidden: true });
  const contextEl = createEl("span", { id: "cmdkContext" });
  const inputWrap = createEl("div", { className: "cmdk-input-wrap" });
  const input = createEl("input", { id: "cmdkInput", className: "cmdk-input", type: "text" });
  const spinner = createEl("span", { id: "cmdkSpinner", hidden: true });
  const emptyEl = createEl("div", { id: "cmdkEmpty", hidden: true });
  const listEl = createEl("div", { id: "cmdkList", className: "cmdk-list" });
  contextWrap.appendChild(contextEl);
  inputWrap.appendChild(input);
  inputWrap.appendChild(spinner);
  dialog.appendChild(contextWrap);
  dialog.appendChild(inputWrap);
  const bodyWrap = createEl("div", { className: "cmdk-body" });
  bodyWrap.appendChild(emptyEl);
  bodyWrap.appendChild(listEl);
  dialog.appendChild(bodyWrap);
  overlay.appendChild(scrim);
  overlay.appendChild(dialog);

  const launchOverlay = createEl("div", { id: "launchOverlay", className: "launch-overlay", hidden: true });
  const launchModal = createEl("div", { className: "launch-modal" });
  const launchClose = createEl("button", { id: "launchClose", type: "button" });
  const launchForm = createEl("form", { id: "launchForm" });
  const agentSelect = createEl("select", { id: "agentSelect" });
  const agentsEmpty = createEl("div", { id: "agentsEmpty", hidden: true });
  const cwdInput = createEl("input", { id: "cwdInput", className: "launch-input", type: "text" });
  const promptInput = createEl("textarea", { id: "promptInput", className: "launch-textarea" });
  const startBtn = createEl("button", { id: "startBtn", type: "submit" });
  const launchError = createEl("div", { id: "launchError", hidden: true });
  const launchNoMux = createEl("div", { id: "launchNoMux", hidden: true });
  launchForm.appendChild(agentSelect);
  launchForm.appendChild(agentsEmpty);
  launchForm.appendChild(cwdInput);
  launchForm.appendChild(promptInput);
  launchForm.appendChild(startBtn);
  launchForm.appendChild(launchError);
  launchModal.appendChild(launchClose);
  launchModal.appendChild(launchForm);
  launchModal.appendChild(launchNoMux);
  launchOverlay.appendChild(launchModal);

  const keysBtn = createEl("button", { id: "keysBtn", type: "button" });
  const keysOverlay = createEl("div", { id: "keysOverlay", className: "keys-overlay", hidden: true });
  const keysMenu = createEl("div", { id: "keysMenu", className: "keys-menu", hidden: true });
  keysMenu.setAttribute("tabindex", "-1");
  keysMenu.setAttribute("role", "dialog");
  keysMenu.setAttribute("aria-modal", "true");
  const keyEnter = createEl("button", { className: "run-key-btn", type: "button" });
  const keyEsc = createEl("button", { className: "run-key-btn", type: "button" });
  keysMenu.appendChild(keyEnter);
  keysMenu.appendChild(keyEsc);
  keysOverlay.appendChild(keysMenu);
  const agentChip = createEl("button", { id: "agentChip", type: "button" });
  const modelChip = createEl("button", { id: "modelChip", type: "button" });
  const runOverlay = createEl("div", { id: "runOverlay", className: "run-overlay", hidden: true });
  const runMenu = createEl("div", { id: "runMenu", className: "run-menu", hidden: true });
  runMenu.setAttribute("tabindex", "-1");
  runMenu.setAttribute("role", "dialog");
  runMenu.setAttribute("aria-modal", "true");
  const recLink = createEl("a", { id: "menuRecording" });
  recLink.href = "/view";
  recLink.setAttribute("href", "/view");
  runMenu.appendChild(recLink);
  runOverlay.appendChild(runMenu);
  const inputText = createEl("input", { id: "inputText", type: "text" });
  const inputRow = createEl("form", { id: "inputRow" });
  inputRow.appendChild(inputText);
  inputRow.appendChild(agentChip);
  inputRow.appendChild(modelChip);
  inputRow.appendChild(keysBtn);

  const shell = createEl("div", { className: "tq-shell" });
  const appTop = createEl("div", { className: "app-top" });
  const workspaceSearchWrap = createEl("div", { id: "workspaceSearchWrap", className: "tq-search" });
  const workspaceSearch = createEl("input", { id: "workspaceSearch", className: "tq-search-input", type: "search" });
  const workspaceSearchList = createEl("div", { id: "workspaceSearchList", className: "tq-search-list", hidden: true });
  workspaceSearchWrap.appendChild(workspaceSearch);
  workspaceSearchWrap.appendChild(workspaceSearchList);
  appTop.appendChild(workspaceSearchWrap);
  appTop.appendChild(cmdkTrigger);
  const agePop = createEl("div", { className: "toolbar-pop", id: "agePop" });
  agePop.appendChild(ageBtn);
  agePop.appendChild(ageMenu);
  const sourcePop = createEl("div", { className: "toolbar-pop", id: "sourcePop" });
  sourcePop.appendChild(sourceBtn);
  sourcePop.appendChild(sourceMenu);
  const displayPop = createEl("div", { className: "toolbar-pop", id: "displayPop" });
  displayPop.appendChild(displayToggle);
  displayPop.appendChild(sortBar);
  const toolbarActions = createEl("div", { className: "runs-toolbar-actions" });
  toolbarActions.appendChild(agePop);
  toolbarActions.appendChild(sourcePop);
  toolbarActions.appendChild(displayPop);
  const runsChrome = createEl("div", { className: "runs-chrome" });
  runsChrome.appendChild(filterInput);
  runsChrome.appendChild(toolbarActions);
  const sessionRow = createEl("a", { id: "sessionRow", className: "session-row run-row" });
  sessionRow.href = "/run";
  sessionRow.setAttribute("href", "/run");
  sessionRow.setAttribute("data-href", "/run");
  sessionRow.setAttribute("role", "link");
  const runsInventory = createEl("div", { className: "runs-inventory", id: "sessions" });
  runsInventory.appendChild(sessionRow);
  app.appendChild(behindLink);
  app.appendChild(newRunBtn);
  app.appendChild(runsChrome);
  app.appendChild(runsInventory);
  app.appendChild(inputRow);
  const sessionFlyout = createEl("aside", { id: "sessionFlyout", className: "session-flyout", hidden: true });
  sessionFlyout.setAttribute("role", "dialog");
  sessionFlyout.setAttribute("aria-modal", "true");
  sessionFlyout.setAttribute("aria-label", "Run analytics");
  sessionFlyout.setAttribute("tabindex", "-1");
  const sessionFlyoutOpen = createEl("a", { id: "sessionFlyoutOpen" });
  sessionFlyoutOpen.href = "/view";
  sessionFlyoutOpen.setAttribute("href", "/view");
  const sessionFlyoutPrev = createEl("button", { id: "sessionFlyoutPrev", type: "button" });
  const sessionFlyoutNext = createEl("button", { id: "sessionFlyoutNext", type: "button" });
  const sessionFlyoutClose = createEl("button", { id: "sessionFlyoutClose", type: "button" });
  const sessionFlyoutFrame = createEl("iframe", { id: "sessionFlyoutFrame", className: "session-flyout-frame", hidden: true });
  sessionFlyoutFrame.setAttribute("tabindex", "-1");
  sessionFlyoutFrame.setAttribute("title", "Run analytics");
  const frameDocument = {
    nodeType: 9,
    tagName: "#DOCUMENT",
    _cap: Object.create(null),
    _bub: Object.create(null),
    parentNode: null,
    _kids: [],
    get children() { return this._kids; },
    get childNodes() { return this._kids; },
    activeElement: null,
    body: null,
    documentElement: null,
    addEventListener(type, fn, cap) {
      const bucket = cap === true || (cap && cap.capture) ? this._cap : this._bub;
      if (!bucket[type]) bucket[type] = [];
      bucket[type].push(fn);
    },
    removeEventListener() {},
  };
  const frameBody = createEl("body");
  frameBody.parentNode = frameDocument;
  frameDocument._kids = [frameBody];
  frameDocument.body = frameBody;
  frameDocument.documentElement = frameBody;
  const errorDot = createEl("button", { className: "error-dot has-error", type: "button" });
  errorDot.setAttribute("class", "error-dot has-error");
  const chapterChrome = createEl("button", { className: "chapter-toggle", type: "button" });
  frameBody.appendChild(errorDot);
  frameBody.appendChild(chapterChrome);
  frameDocument.activeElement = frameBody;
  sessionFlyoutFrame.contentDocument = frameDocument;
  sessionFlyoutFrame.contentWindow = { document: frameDocument };
  sessionFlyout.appendChild(sessionFlyoutOpen);
  sessionFlyout.appendChild(sessionFlyoutPrev);
  sessionFlyout.appendChild(sessionFlyoutNext);
  sessionFlyout.appendChild(sessionFlyoutClose);
  sessionFlyout.appendChild(sessionFlyoutFrame);

  shell.appendChild(appTop);
  shell.appendChild(app);
  body.appendChild(shell);
  body.appendChild(sessionFlyout);
  body.appendChild(overlay);
  body.appendChild(launchOverlay);
  body.appendChild(keysOverlay);
  body.appendChild(runOverlay);
  activeElement = body;

  let href = "http://127.0.0.1/sessions";
  const location = {
    pathname: "/sessions",
    search: "",
    origin: "http://127.0.0.1",
    hash: "",
    _navigated: undefined,
    get href() { return href; },
    set href(v) {
      href = String(v);
      this._navigated = href;
    },
  };
  const ls = Object.create(null);
  function overlayCssFromClass(el) {
    const cls = String((el && el.className) || "").split(/\s+/);
    if (cls.includes("hf-modal-overlay")) return "1000";
    if (cls.includes("cmdk-overlay")) return "500";
    if (cls.includes("launch-overlay")) return "400";
    if (cls.includes("keys-overlay") || cls.includes("run-overlay")) return "450";
    return "auto";
  }
  const windowObj = {
    location,
    document,
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener() {},
    removeEventListener() {},
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
    },
    open() {},
    getComputedStyle(el) {
      const inline = el && el.style && el.style.zIndex;
      const z = inline != null && String(inline) !== "" ? String(inline) : overlayCssFromClass(el);
      return { zIndex: z };
    },
  };
  document.defaultView = windowObj;

  function fire(node, ev, capture) {
    if (!node) return;
    const bucket = capture ? node._cap : node._bub;
    const list = bucket && bucket[ev.type];
    if (!list) return;
    ev.currentTarget = node;
    for (const fn of list.slice()) {
      if (ev._immediate) return;
      fn.call(node, ev);
    }
  }

  function dispatch(target, type, init = {}) {
    const ev = {
      type,
      key: init.key,
      keyCode: init.keyCode || 0,
      metaKey: !!init.metaKey,
      ctrlKey: !!init.ctrlKey,
      altKey: !!init.altKey,
      shiftKey: !!init.shiftKey,
      isComposing: false,
      defaultPrevented: false,
      _prevented: false,
      _stopped: false,
      _immediate: false,
      bubbles: true,
      cancelable: true,
      target,
      currentTarget: null,
      preventDefault() { this.defaultPrevented = true; this._prevented = true; },
      stopPropagation() { this._stopped = true; },
      stopImmediatePropagation() { this._stopped = true; this._immediate = true; },
    };
    const path = [];
    for (let n = target; n; n = n.parentNode) path.push(n);
    for (let i = path.length - 1; i >= 0; i--) {
      if (ev._stopped) break;
      fire(path[i], ev, true);
      if (ev._immediate) break;
    }
    if (!ev._stopped && !ev._immediate) {
      for (let i = 0; i < path.length; i++) {
        if (ev._stopped) break;
        fire(path[i], ev, false);
        if (ev._immediate) break;
      }
    }
    return ev;
  }

  const sandbox = {
    document,
    window: windowObj,
    location,
    navigator: { platform: "MacIntel" },
    localStorage: windowObj.localStorage,
    sessionStorage: windowObj.sessionStorage,
    history: { replaceState() {} },
    fetch: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ mux: { available: true }, agents: [{ id: "claude" }], sessions: [], results: [] }),
    }),
    requestAnimationFrame: (fn) => { fn(); return 0; },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    AbortController,
    URL,
    URLSearchParams,
    Object,
    Array,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    parseInt,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    Set,
    Map,
    console,
    _INIT_DATA: { defaultCwd: "/tmp" },
    escH(s) { return String(s == null ? "" : s); },
  };
  windowObj.window = windowObj;

  new Script(OVERLAY_FOCUS_SRC, { filename: "overlay-focus.js" }).runInNewContext(sandbox);
  new Script(COMMAND_PALETTE_CLIENT_JS, { filename: "command-palette.js" }).runInNewContext(sandbox);
  new Script(LAUNCHER_CLIENT_JS, { filename: "launch-page.js" }).runInNewContext(sandbox);
  new Script(`
    var keysPrevFocus = null;
    var runPrevFocus = null;
    var keysMenu = document.getElementById("keysMenu");
    var keysOverlay = document.getElementById("keysOverlay");
    var keysBtn = document.getElementById("keysBtn");
    var runMenu = document.getElementById("runMenu");
    var runOverlay = document.getElementById("runOverlay");
    var agentChip = document.getElementById("agentChip");
    var modelChip = document.getElementById("modelChip");
    function openKeysMenu() {
      closeRunMenu();
      if (keysMenu.hidden) {
        keysPrevFocus = overlayPrevFocus(keysMenu);
        if (!keysPrevFocus) keysPrevFocus = document.activeElement;
      }
      if (keysOverlay) keysOverlay.hidden = false;
      keysMenu.hidden = false;
      keysBtn.setAttribute("aria-expanded", "true");
      pushOverlay(keysMenu);
      focusOverlay(keysMenu, keysMenu.querySelector(".run-key-btn"));
    }
    function closeKeysMenu() {
      if (keysMenu.hidden) return;
      keysMenu.hidden = true;
      if (keysOverlay) keysOverlay.hidden = true;
      keysBtn.setAttribute("aria-expanded", "false");
      popOverlay(keysMenu);
      restoreOverlayFocus(keysPrevFocus, keysMenu);
      keysPrevFocus = null;
    }
    function openRunMenu() {
      closeKeysMenu();
      if (runMenu.hidden) {
        runPrevFocus = overlayPrevFocus(runMenu);
        if (!runPrevFocus) runPrevFocus = document.activeElement;
      }
      if (runOverlay) runOverlay.hidden = false;
      runMenu.hidden = false;
      agentChip.setAttribute("aria-expanded", "true");
      modelChip.setAttribute("aria-expanded", "true");
      pushOverlay(runMenu);
      focusOverlay(runMenu, runMenu);
    }
    function closeRunMenu() {
      if (runMenu.hidden) return;
      runMenu.hidden = true;
      if (runOverlay) runOverlay.hidden = true;
      agentChip.setAttribute("aria-expanded", "false");
      modelChip.setAttribute("aria-expanded", "false");
      popOverlay(runMenu);
      restoreOverlayFocus(runPrevFocus, runMenu);
      runPrevFocus = null;
    }
    var ageBtn = document.getElementById("ageBtn");
    var ageMenu = document.getElementById("ageMenu");
    var sourceBtn = document.getElementById("sourceBtn");
    var sourceMenu = document.getElementById("sourceMenu");
    var displayToggle = document.getElementById("displayToggle");
    var sortBar = document.getElementById("sortBar");
    function closeToolbarMenus(except) { closeToolbarMenuOverlays(except); }
    if (ageBtn && ageMenu) {
      ageBtn.addEventListener("click", function () {
        var open = ageMenu.hidden;
        if (open) {
          closeToolbarMenus("ageMenu");
          openToolbarMenuOverlay(ageMenu);
        } else {
          closeToolbarMenus();
        }
      });
    }
    if (sourceBtn && sourceMenu) {
      sourceBtn.addEventListener("click", function () {
        var open = sourceMenu.hidden;
        if (open) {
          closeToolbarMenus("sourceMenu");
          openToolbarMenuOverlay(sourceMenu);
        } else {
          closeToolbarMenus();
        }
      });
    }
    if (displayToggle && sortBar) {
      displayToggle.addEventListener("click", function () {
        var open = sortBar.hidden;
        if (open) {
          closeToolbarMenus("sortBar");
          openToolbarMenuOverlay(sortBar);
        } else {
          closeToolbarMenus();
        }
      });
    }
    bindToolbarMenuOverlayKeys();
    keysBtn.addEventListener("click", function () {
      if (keysMenu.hidden) openKeysMenu();
      else closeKeysMenu();
    });
    agentChip.addEventListener("click", function () {
      if (runMenu.hidden) openRunMenu();
      else closeRunMenu();
    });
    document.addEventListener("keydown", function (event) {
      if (!keysMenu.hidden || !runMenu.hidden) {
        var menuRoot = keysMenu.hidden ? runMenu : keysMenu;
        if (isTopOverlay(menuRoot)) {
          if (event.key === "Tab") {
            trapOverlayTab(event, menuRoot);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            if (!keysMenu.hidden) closeKeysMenu();
            if (!runMenu.hidden) closeRunMenu();
          }
        }
      }
    }, true);
    var sessionFlyout = document.getElementById("sessionFlyout");
    var sessionFlyoutFrame = document.getElementById("sessionFlyoutFrame");
    var sessionRow = document.getElementById("sessionRow");
    function openSessionFlyoutOverlay() {
      if (!sessionFlyout) return;
      if (sessionFlyout.hidden) {
        sessionFlyout._tqPrevFocus = overlayPrevFocus(sessionFlyout);
        if (!sessionFlyout._tqPrevFocus) sessionFlyout._tqPrevFocus = document.activeElement;
      }
      sessionFlyout.hidden = false;
      sessionFlyout.setAttribute("aria-hidden", "false");
      pushOverlay(sessionFlyout);
      focusOverlay(sessionFlyout, document.getElementById("sessionFlyoutOpen"));
    }
    function closeSessionFlyoutOverlay() {
      if (!sessionFlyout || sessionFlyout.hidden) return;
      sessionFlyout.hidden = true;
      sessionFlyout.setAttribute("aria-hidden", "true");
      if (sessionFlyoutFrame) sessionFlyoutFrame.hidden = true;
      popOverlay(sessionFlyout);
      restoreOverlayFocus(sessionFlyout._tqPrevFocus, sessionFlyout);
      sessionFlyout._tqPrevFocus = null;
    }
    bindOverlayNestedFrameKeys(sessionFlyout, sessionFlyoutFrame, closeSessionFlyoutOverlay);
    if (sessionRow) {
      sessionRow.addEventListener("click", function (event) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        openSessionFlyoutOverlay();
      });
    }
    document.addEventListener("keydown", function (event) {
      if (!sessionFlyout || sessionFlyout.hidden || !isTopOverlay(sessionFlyout)) return;
      if (event.key === "Tab") {
        trapOverlayTab(event, sessionFlyout);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        closeSessionFlyoutOverlay();
      }
    }, true);
    window.openSessionFlyout = openSessionFlyoutOverlay;
  `, { filename: "menus.js" }).runInNewContext(sandbox);

  function press(key, mods = {}) {
    const target = document.activeElement || body;
    return dispatch(target, "keydown", { key, ...mods });
  }

  function hiddenActive() {
    const el = document.activeElement;
    if (!el || el === body || el === document) return false;
    return !!(el.hidden || (el.closest && el.closest("[hidden]")));
  }

  return {
    document,
    body,
    filterInput,
    workspaceSearch,
    behindLink,
    input,
    window: windowObj,
    overlay,
    scrim,
    newRunBtn,
    launchOverlay,
    launchClose,
    promptInput,
    cwdInput,
    agentSelect,
    startBtn,
    keysBtn,
    keysMenu,
    keysOverlay,
    keyEnter,
    keyEsc,
    agentChip,
    runMenu,
    runOverlay,
    shell,
    recLink,
    inputText,
    ageBtn,
    ageMenu,
    ageAll,
    ageDay,
    sourceBtn,
    sourceMenu,
    displayToggle,
    sortBar,
    sortRecent,
    sortCost,
    sessionRow,
    sessionFlyout,
    sessionFlyoutOpen,
    sessionFlyoutClose,
    sessionFlyoutFrame,
    errorDot,
    chapterChrome,
    frameDocument,
    frameBody,
    runsInventory,
    press,
    openSessionFlyout() { sandbox.window.openSessionFlyout(); },
    dispatch,
    hiddenActive,
    location,
    openPalette() { press("k", { metaKey: true }); },
    closePalette() { press("Escape"); },
    pushOverlay: sandbox.pushOverlay,
    popOverlay: sandbox.popOverlay,
  };
}

function assertInside(h, root, label) {
  const active = h.document.activeElement;
  assert.ok(root.contains(active), `${label}: activeElement ${active && active.id || active && active.tagName} is inside overlay`);
}

function hasInertAncestor(el) {
  for (let n = el; n; n = n.parentNode) {
    if (typeof n.hasAttribute === "function" && n.hasAttribute("inert")) return true;
  }
  return false;
}

describe("overlay focus lifecycle", () => {
  test("Opening the CommandPalette moves document.activeElement inside #cmdkOverlay", () => {
    assert.match(COMMAND_PALETTE_CLIENT_JS, /try \{ input\.focus\(\); \} catch \(eOpen\) \{\}/);
    const h = createHarness();
    h.filterInput.focus();
    h.openPalette();
    assert.equal(h.overlay.hidden, false);
    assert.equal(h.document.activeElement, h.input);
    assertInside(h, h.overlay, "palette open");
  });

  test("While the CommandPalette is open, Tab and Shift+Tab keep focus inside #cmdkOverlay", () => {
    assert.match(COMMAND_PALETTE_CLIENT_JS, /trapOverlayTab\(e, overlay\)/);
    const h = createHarness();
    h.filterInput.focus();
    h.openPalette();
    h.press("Tab");
    assertInside(h, h.overlay, "Tab");
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.notEqual(h.document.activeElement, h.behindLink);
    h.press("Tab", { shiftKey: true });
    assertInside(h, h.overlay, "Shift+Tab");
    assert.notEqual(h.document.activeElement, h.filterInput);
  });

  test("Escape or backdrop click closes the CommandPalette and restores the previously focused element", () => {
    assert.match(COMMAND_PALETTE_CLIENT_JS, /restoreOverlayFocus\(prevFocus, overlay\)/);
    const h = createHarness();
    h.filterInput.focus();
    const prev = h.document.activeElement;
    h.openPalette();
    assert.notEqual(h.document.activeElement, prev);
    h.press("Escape");
    assert.equal(h.overlay.hidden, true);
    assert.equal(h.document.activeElement, prev);

    h.filterInput.focus();
    const prev2 = h.document.activeElement;
    h.openPalette();
    h.dispatch(h.scrim, "mousedown");
    assert.equal(h.overlay.hidden, true);
    assert.equal(h.document.activeElement, prev2);
  });

  test("After the CommandPalette closes, document.activeElement is not inside the hidden overlay", () => {
    const h = createHarness();
    h.body.focus();
    h.openPalette();
    assert.equal(h.document.activeElement, h.input);
    h.press("Escape");
    assert.equal(h.overlay.hidden, true);
    assert.equal(h.hiddenActive(), false);
    assert.ok(!h.overlay.contains(h.document.activeElement) || h.document.activeElement === h.body);
  });

  test("Opening the launch overlay moves document.activeElement inside #launchOverlay", () => {
    assert.match(LAUNCHER_CLIENT_JS, /focusOverlay\(launchOverlay, promptInput\)/);
    const h = createHarness();
    h.filterInput.focus();
    h.newRunBtn.click();
    assert.equal(h.launchOverlay.hidden, false);
    assertInside(h, h.launchOverlay, "launch open");
  });

  test("While the launch overlay is open, Tab and Shift+Tab cycle inside #launchOverlay", () => {
    assert.match(LAUNCHER_CLIENT_JS, /trapOverlayTab\(e, launchOverlay\)/);
    const h = createHarness();
    h.newRunBtn.click();
    h.startBtn.focus();
    h.press("Tab");
    assertInside(h, h.launchOverlay, "Tab from last");
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.notEqual(h.document.activeElement, h.behindLink);
    h.launchClose.focus();
    h.press("Tab", { shiftKey: true });
    assertInside(h, h.launchOverlay, "Shift+Tab from first");
    assert.notEqual(h.document.activeElement, h.filterInput);
  });

  test("Escape or backdrop click closes the launch overlay and restores the previously focused element", () => {
    assert.match(LAUNCHER_CLIENT_JS, /restoreOverlayFocus\(launchPrevFocus, launchOverlay\)/);
    const h = createHarness();
    h.filterInput.focus();
    const prev = h.document.activeElement;
    h.newRunBtn.click();
    assert.notEqual(h.document.activeElement, prev);
    h.press("Escape");
    assert.equal(h.launchOverlay.hidden, true);
    assert.equal(h.document.activeElement, prev);

    h.filterInput.focus();
    const prev2 = h.document.activeElement;
    h.newRunBtn.click();
    h.launchOverlay.click();
    assert.equal(h.launchOverlay.hidden, true);
    assert.equal(h.document.activeElement, prev2);
  });

  test("Opening the keys menu moves document.activeElement inside #keysMenu; Tab stays inside; Escape restores previous focus", () => {
    assert.match(RUN_PAGE_SRC, /focusOverlay\(keysMenu, keysMenu\.querySelector\("\.run-key-btn"\)\)/);
    assert.match(RUN_PAGE_SRC, /restoreOverlayFocus\(keysPrevFocus, keysMenu\)/);
    assert.match(RUN_PAGE_SRC, /trapOverlayTab\(event, menuRoot\)/);
    assert.match(RUN_PAGE_SRC, /pushOverlay\(keysMenu\)/);
    assert.match(RUN_PAGE_SRC, /popOverlay\(keysMenu\)/);
    const h = createHarness();
    h.inputText.focus();
    const prev = h.document.activeElement;
    h.keysBtn.click();
    assert.equal(h.keysMenu.hidden, false);
    assertInside(h, h.keysMenu, "keys open");
    h.press("Tab");
    assertInside(h, h.keysMenu, "keys Tab");
    assert.notEqual(h.document.activeElement, h.filterInput);
    h.keyEsc.focus();
    h.press("Tab");
    assertInside(h, h.keysMenu, "keys Tab wrap");
    h.press("Escape");
    assert.equal(h.keysMenu.hidden, true);
    assert.equal(h.document.activeElement, prev);
  });

  test("Opening the run-details popover moves document.activeElement inside #runMenu; Tab stays inside; Escape restores previous focus", () => {
    assert.match(RUN_PAGE_SRC, /focusOverlay\(runMenu, runMenu\)/);
    assert.match(RUN_PAGE_SRC, /restoreOverlayFocus\(runPrevFocus, runMenu\)/);
    assert.match(RUN_PAGE_SRC, /pushOverlay\(runMenu\)/);
    assert.match(RUN_PAGE_SRC, /popOverlay\(runMenu\)/);
    const page = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp", startedAt: "2026-01-01T00:00:00.000Z", status: "running" },
    });
    assert.match(page, /id="runMenu" role="dialog" aria-modal="true"[^>]*hidden tabindex="-1"/);
    const h = createHarness();
    h.inputText.focus();
    const prev = h.document.activeElement;
    h.agentChip.click();
    assert.equal(h.runMenu.hidden, false);
    assertInside(h, h.runMenu, "run menu open");
    h.press("Tab");
    assertInside(h, h.runMenu, "run menu Tab");
    assert.notEqual(h.document.activeElement, h.filterInput);
    h.press("Escape");
    assert.equal(h.runMenu.hidden, true);
    assert.equal(h.document.activeElement, prev);
  });

  test("After palette, launch, keys, or run-details overlays close, focus is not left on a hidden node", () => {
    assert.match(OVERLAY_FOCUS_SRC, /restoreOverlayFocus/);
    assert.match(OVERLAY_FOCUS_SRC, /root\.contains\(active\)/);
    const h = createHarness();

    h.body.focus();
    h.openPalette();
    h.closePalette();
    assert.equal(h.hiddenActive(), false, "palette");

    h.body.focus();
    h.newRunBtn.click();
    h.press("Escape");
    assert.equal(h.hiddenActive(), false, "launch");

    h.body.focus();
    h.keysBtn.click();
    h.press("Escape");
    assert.equal(h.hiddenActive(), false, "keys");

    h.body.focus();
    h.agentChip.click();
    h.press("Escape");
    assert.equal(h.hiddenActive(), false, "run menu");

    h.filterInput.focus();
    h.openPalette();
    h.closePalette();
    assert.equal(h.document.activeElement, h.filterInput);
    h.filterInput.value = "";
    h.filterInput.value += "/";
    assert.equal(h.filterInput.value, "/");
  });

  function stackedZ(h, el) {
    const inline = el && el.style && el.style.zIndex;
    const cs = h.window.getComputedStyle(el);
    return parseInt(String(inline != null && String(inline) !== "" ? inline : cs.zIndex), 10);
  }

  test("Cmd+K over an open launch overlay focuses #cmdkInput and does not leave #cmdkOverlay inert", () => {
    assert.match(OVERLAY_FOCUS_SRC, /__tqOverlayStack/);
    assert.match(OVERLAY_FOCUS_SRC, /function pushOverlay/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /isTopOverlay\(overlay\)/);
    assert.match(LAUNCHER_CLIENT_JS, /isTopOverlay\(launchOverlay\)/);
    const h = createHarness();
    h.filterInput.focus();
    h.newRunBtn.click();
    assert.equal(h.launchOverlay.hidden, false);
    assert.equal(h.overlay.hasAttribute("inert"), true, "palette starts inert under launch");
    h.openPalette();
    assert.equal(h.overlay.hidden, false);
    assert.equal(h.overlay.hasAttribute("inert"), false, "palette is not inert when stacked on top");
    assert.equal(h.launchOverlay.hasAttribute("inert"), true, "launch is inert under palette");
    assert.equal(h.document.activeElement, h.input);
    assertInside(h, h.overlay, "stacked Cmd+K");
    assert.ok(
      stackedZ(h, h.overlay) > stackedZ(h, h.launchOverlay),
      "palette must paint above launch",
    );
  });

  test("While the CommandPalette is stacked over the launch overlay, Tab stays inside #cmdkOverlay", () => {
    const h = createHarness();
    h.newRunBtn.click();
    h.openPalette();
    assert.equal(h.document.activeElement, h.input);
    h.press("Tab");
    assertInside(h, h.overlay, "stacked Tab");
    assert.notEqual(h.document.activeElement, h.promptInput);
    assert.notEqual(h.document.activeElement, h.filterInput);
    h.press("Tab", { shiftKey: true });
    assertInside(h, h.overlay, "stacked Shift+Tab");
    assert.notEqual(h.document.activeElement, h.promptInput);
  });

  test("Escape closes the stacked CommandPalette first without closing or leaving the launch overlay inert", () => {
    const h = createHarness();
    h.filterInput.focus();
    h.newRunBtn.click();
    assert.equal(h.document.activeElement, h.promptInput);
    h.openPalette();
    assert.equal(h.document.activeElement, h.input);
    h.press("Escape");
    assert.equal(h.overlay.hidden, true, "palette closed first");
    assert.equal(h.launchOverlay.hidden, false, "launch stays open");
    assert.equal(h.launchOverlay.hasAttribute("inert"), false, "launch is not left inert");
    assert.equal(h.overlay.hasAttribute("inert"), true);
    assert.equal(h.document.activeElement, h.promptInput);
    h.press("Escape");
    assert.equal(h.launchOverlay.hidden, true);
    assert.equal(h.document.activeElement, h.filterInput);
    assert.equal(h.hiddenActive(), false);
  });

  test("Escape after Cmd+K opened over #workspaceSearch restores #workspaceSearch", () => {
    const h = createHarness();
    h.workspaceSearch.focus();
    assert.equal(h.document.activeElement, h.workspaceSearch);
    h.openPalette();
    assert.equal(h.document.activeElement, h.input);
    h.press("Escape");
    assert.equal(h.overlay.hidden, true);
    assert.equal(h.document.activeElement, h.workspaceSearch);
    assert.equal(h.hiddenActive(), false);
  });

  test("while a launch overlay button is focused, idle / does not focus #workspaceSearch and G-then-letter does not navigate", () => {
    const h = createHarness();
    h.newRunBtn.click();
    assert.equal(h.launchOverlay.hidden, false);
    h.startBtn.focus();
    assert.equal(h.document.activeElement, h.startBtn, "Start is not a form field");
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch, "/ must not steal to #workspaceSearch behind launch");
    assert.equal(h.launchOverlay.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.length > 0);
    h.press("g");
    h.press("r");
    assert.equal(h.location._navigated, undefined, "G then R must not jump while launch owns the keyboard");
    assert.equal(h.launchOverlay.hidden, false);
    h.press("Escape");
    assert.equal(h.launchOverlay.hidden, true);
    h.body.focus();
    h.press("/");
    assert.equal(h.document.activeElement, h.workspaceSearch, "idle / focuses #workspaceSearch after launch closes");
  });

  test("share, keys, and run-details overlays join window.__tqOverlayStack", () => {
    assert.match(SHARE_JS, /pushOverlay\(overlay\)/);
    assert.match(SHARE_JS, /popOverlay\(dying\)/);
    assert.match(SHARE_JS, /trapOverlayTab\(e, overlay\)/);
    assert.match(SHARE_JS, /focusOverlay\(overlay, tokenInput\)/);
    assert.match(SHARE_JS, /restoreOverlayFocus\(sharePrevFocus, dying\)/);
    assert.match(SHARE_JS, /isTopOverlay\(overlay\)/);
    assert.match(RUN_PAGE_SRC, /pushOverlay\(keysMenu\)/);
    assert.match(RUN_PAGE_SRC, /popOverlay\(keysMenu\)/);
    assert.match(RUN_PAGE_SRC, /pushOverlay\(runMenu\)/);
    assert.match(RUN_PAGE_SRC, /popOverlay\(runMenu\)/);
    assert.match(RUN_PAGE_SRC, /isTopOverlay\(menuRoot\)/);
    assert.match(RUN_PAGE_SRC, /id="keysOverlay"/);
    assert.match(RUN_PAGE_SRC, /id="runOverlay"/);
  });

  test("Opening the share-session dialog moves document.activeElement inside .hf-modal-overlay; Tab stays inside; Escape dismisses and restores previous focus", () => {
    assert.match(SHARE_JS, /focusOverlay\(overlay, tokenInput\)/);
    assert.match(SHARE_JS, /trapOverlayTab\(e, overlay\)/);
    assert.match(SHARE_JS, /e\.key === 'Escape'/);
    assert.match(SHARE_JS, /restoreOverlayFocus\(sharePrevFocus, dying\)/);
    assert.match(SHARE_JS, /role: 'dialog'/);
    assert.match(SHARE_JS, /'aria-modal': 'true'/);
  });

  test("while a share-session dialog button is focused, idle / does not focus #workspaceSearch and the modal stays up", () => {
    assert.match(SHARE_JS, /pushOverlay\(overlay\)/);
    assert.match(SHARE_JS, /document\.addEventListener\('keydown', shareKeyHandler, true\)/);
  });

  test("while a keys menu .run-key-btn is focused, idle / does not focus #workspaceSearch and #keysMenu stays open on the overlay stack", () => {
    const h = createHarness();
    h.inputText.focus();
    h.keysBtn.click();
    assert.equal(h.keysMenu.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.length > 0);
    h.keyEnter.focus();
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch, "/ must not steal to #workspaceSearch behind keys menu");
    assert.equal(h.keysMenu.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.keysMenu));
    h.press("g");
    h.press("r");
    assert.equal(h.location._navigated, undefined, "G then R must not jump while keys menu owns the keyboard");
    h.press("Escape");
    assert.equal(h.keysMenu.hidden, true);
    h.body.focus();
    h.press("/");
    assert.equal(h.document.activeElement, h.workspaceSearch, "idle / focuses #workspaceSearch after keys menu closes");
  });

  test("keys menu is an APG modal dialog: role=dialog, page behind inert, / does not focus #workspaceSearch", () => {
    assert.match(RUN_PAGE_SRC, /COMMAND_PALETTE_HTML\}\s*\n<div class="keys-overlay" id="keysOverlay" hidden>/);
    assert.match(RUN_PAGE_SRC, /id="keysMenu" role="dialog" aria-modal="true"/);
    const page = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp", startedAt: "2026-01-01T00:00:00.000Z", status: "running" },
    });
    const shellIdx = page.indexOf('class="tq-shell"');
    const keysIdx = page.indexOf('id="keysOverlay"');
    const composerIdx = page.indexOf('id="keysBtn"');
    assert.ok(shellIdx >= 0 && keysIdx > composerIdx, "keys overlay is a body-level sibling after the shell composer");
    assert.match(page, /id="keysMenu" role="dialog" aria-modal="true"/);
    const h = createHarness();
    h.inputText.focus();
    h.keysBtn.click();
    assert.equal(h.keysMenu.hidden, false);
    assert.equal(h.keysOverlay.hidden, false);
    assert.equal(h.keysMenu.getAttribute("role"), "dialog");
    assert.equal(h.keysMenu.getAttribute("aria-modal"), "true");
    assert.equal(h.shell.hasAttribute("inert"), true, ".tq-shell is inert under the keys dialog");
    assert.equal(hasInertAncestor(h.workspaceSearch), true, "#workspaceSearch is under an inert ancestor");
    assert.equal(hasInertAncestor(h.inputText), true, "composer is under an inert ancestor");
    assert.equal(h.keysOverlay.hasAttribute("inert"), false);
    h.keyEnter.focus();
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch);
    assert.equal(h.keysMenu.hidden, false);
  });

  test("the last-pushed overlay paints above overlays under it", () => {
    assert.match(OVERLAY_FOCUS_SRC, /applyOverlayStackPaint/);
    assert.match(OVERLAY_FOCUS_SRC, /__tqOverlayPainted/);
    const h = createHarness();
    const under = h.document.createElement("div");
    under.id = "hfModalOverlay";
    under.className = "hf-modal-overlay";
    h.body.appendChild(under);
    const over = h.document.createElement("div");
    over.id = "laterOverlay";
    over.className = "cmdk-overlay";
    h.body.appendChild(over);
    h.pushOverlay(under);
    h.pushOverlay(over);
    assert.ok(stackedZ(h, over) > stackedZ(h, under), `top ${stackedZ(h, over)} must exceed under ${stackedZ(h, under)}`);
    h.popOverlay(over);
    assert.ok(stackedZ(h, over) <= stackedZ(h, under) || String(over.style.zIndex || "") === "", "pop restores the closed overlay's paint");
  });

  test("Cmd+K over the share modal paints #cmdkOverlay above .hf-modal-overlay", () => {
    assert.match(OVERLAY_FOCUS_SRC, /applyOverlayStackPaint/);
    const h = createHarness();
    const share = h.document.createElement("div");
    share.id = "hfModalOverlay";
    share.className = "hf-modal-overlay";
    h.body.appendChild(share);
    h.pushOverlay(share);
    assert.equal(share.hasAttribute("inert"), false);
    h.openPalette();
    assert.equal(h.document.activeElement, h.input);
    assert.equal(h.overlay.hidden, false);
    assert.equal(h.overlay.hasAttribute("inert"), false, "palette is not inert when stacked on share");
    assert.equal(share.hasAttribute("inert"), true, "share is inert under palette");
    const palZ = stackedZ(h, h.overlay);
    const shareZ = stackedZ(h, share);
    assert.ok(palZ > shareZ, `palette z-index ${palZ} must exceed share ${shareZ}`);
    h.closePalette();
    assert.equal(h.overlay.hidden, true);
    assert.equal(share.hasAttribute("inert"), false, "share is not left inert");
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(share), "share remains on the stack");
  });

  test("pushOverlay/popOverlay sequenceReset the GitHub chord so idle g then launch Escape then c does not complete g c", () => {
    assert.match(OVERLAY_FOCUS_SRC, /function disarmPageHotkeyChord/);
    assert.match(OVERLAY_FOCUS_SRC, /disarmPageHotkeyChord\(\)/);
    assert.match(OVERLAY_FOCUS_SRC, /applyOverlayStackInert\(\);\s*disarmPageHotkeyChord\(\);\s*return stack;/);
    assert.match(LAUNCHER_CLIENT_JS, /e\.stopPropagation\(\)/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /key === "Escape"[\s\S]*?e\.stopPropagation\(\)/);
    assert.match(SHARE_JS, /e\.key === 'Escape'[\s\S]*?e\.stopPropagation\(\)/);

    const prevDoc = globalThis.document;
    const prevStack = globalThis.__tqOverlayStack;
    const clicks = [];
    const attrs = { "data-hotkey": "g c" };
    const leaf = {
      nodeName: "BUTTON",
      tagName: "BUTTON",
      id: "tqHotkeyGoC",
      type: "button",
      isContentEditable: false,
      ownerDocument: null,
      getAttribute(name) {
        if (name === "type") return this.type;
        if (name === "id") return this.id;
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      setAttribute(name, value) { attrs[name] = String(value); },
      click() { clicks.push(this); },
      dispatchEvent() { return true; },
    };
    function keyEvent(target, key) {
      return {
        target,
        key,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
      };
    }
    const fakeDoc = {
      _tqFormGuardInstalled: false,
      documentElement: { getAttribute() { return null; }, setAttribute() {} },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
      createElement() { return leaf; },
      body: { appendChild(el) { return el; } },
      addEventListener() {},
    };
    leaf.ownerDocument = fakeDoc;
    const body = { nodeName: "BODY", tagName: "BODY", id: "", type: "", isContentEditable: false, ownerDocument: fakeDoc, getAttribute() { return null; } };
    globalThis.document = fakeDoc;
    try {
      install(leaf, "g c");
      keyDownHandler(keyEvent(body, "g"));
      assert.equal(clicks.length, 0, "idle g arms the sequence");
      const overlay = { id: "launchOverlay" };
      pushOverlay(overlay);
      popOverlay(overlay);
      keyDownHandler(keyEvent(body, "c"));
      assert.equal(clicks.length, 0, "c after overlay push/pop must not complete a g armed before open");

      keyDownHandler(keyEvent(body, "g"));
      keyDownHandler(keyEvent(body, "c"));
      assert.equal(clicks.length, 1, "idle g then c still fires when no overlay owns the keyboard");
    } finally {
      if (prevDoc === undefined) delete globalThis.document;
      else globalThis.document = prevDoc;
      if (prevStack === undefined) delete globalThis.__tqOverlayStack;
      else globalThis.__tqOverlayStack = prevStack;
    }

    const h = createHarness();
    h.body.focus();
    h.press("g");
    h.newRunBtn.click();
    assert.equal(h.launchOverlay.hidden, false);
    h.press("Escape");
    assert.equal(h.launchOverlay.hidden, true);
    h.body.focus();
    h.press("c");
    assert.notEqual(h.location._navigated, "/", "harness: c after launch Escape must not complete g c");
    assert.equal(h.location._navigated, undefined);
    h.press("g");
    h.press("c");
    assert.equal(h.location._navigated, "/", "harness: idle G then C still jumps with no overlay");
  });

  test("Opening #ageMenu, #sourceMenu, or #sortBar moves document.activeElement inside the menu; Tab stays inside; Escape restores previous focus", () => {
    assert.match(OVERLAY_FOCUS_SRC, /function openToolbarMenuOverlay/);
    assert.match(OVERLAY_FOCUS_SRC, /function closeToolbarMenuOverlays/);
    assert.match(OVERLAY_FOCUS_SRC, /trapOverlayTab\(event, open\)/);
    assert.match(BROWSER_CLIENT_SRC, /openToolbarMenuOverlay\(ageMenu\)/);
    assert.match(BROWSER_CLIENT_SRC, /openToolbarMenuOverlay\(sourceMenu\)/);
    assert.match(BROWSER_CLIENT_SRC, /openToolbarMenuOverlay\(sortBar\)/);
    assert.match(RUN_PAGE_SRC, /openToolbarMenuOverlay\(ageMenu\)/);
    assert.match(RUN_PAGE_SRC, /openToolbarMenuOverlay\(sourceMenu\)/);
    assert.match(RUN_PAGE_SRC, /openToolbarMenuOverlay\(sortBar\)/);
    const h = createHarness();
    h.filterInput.focus();
    const prev = h.document.activeElement;
    h.ageBtn.click();
    assert.equal(h.ageMenu.hidden, false);
    assertInside(h, h.ageMenu, "ageMenu open");
    h.press("Tab");
    assertInside(h, h.ageMenu, "ageMenu Tab");
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.notEqual(h.document.activeElement, h.workspaceSearch);
    h.ageDay.focus();
    h.press("Tab");
    assertInside(h, h.ageMenu, "ageMenu Tab wrap");
    h.press("Escape");
    assert.equal(h.ageMenu.hidden, true);
    assert.equal(h.document.activeElement, prev);
    assert.equal(h.hiddenActive(), false);

    h.filterInput.focus();
    const prevSource = h.document.activeElement;
    h.sourceBtn.click();
    assert.equal(h.sourceMenu.hidden, false);
    assertInside(h, h.sourceMenu, "sourceMenu open");
    h.press("Tab");
    assertInside(h, h.sourceMenu, "sourceMenu Tab");
    h.press("Escape");
    assert.equal(h.sourceMenu.hidden, true);
    assert.equal(h.document.activeElement, prevSource);

    h.filterInput.focus();
    const prevSort = h.document.activeElement;
    h.displayToggle.click();
    assert.equal(h.sortBar.hidden, false);
    assertInside(h, h.sortBar, "sortBar open");
    h.press("Tab");
    assertInside(h, h.sortBar, "sortBar Tab");
    h.press("Escape");
    assert.equal(h.sortBar.hidden, true);
    assert.equal(h.document.activeElement, prevSort);
  });

  test("while a rail toolbar menu option is focused, idle / does not focus #workspaceSearch and the menu stays open on the overlay stack", () => {
    const h = createHarness();
    h.filterInput.focus();
    h.ageBtn.click();
    assert.equal(h.ageMenu.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.length > 0);
    h.ageAll.focus();
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch, "/ must not steal to #workspaceSearch behind ageMenu");
    assert.equal(h.ageMenu.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.ageMenu));
    h.press("g");
    h.press("r");
    assert.equal(h.location._navigated, undefined, "G then R must not jump while ageMenu owns the keyboard");
    h.press("Escape");
    assert.equal(h.ageMenu.hidden, true);
    h.body.focus();
    h.press("/");
    assert.equal(h.document.activeElement, h.workspaceSearch, "idle / focuses #workspaceSearch after ageMenu closes");
  });

  test("open #ageMenu inerts the page behind so a session row click does not navigate to /run", () => {
    assert.match(OVERLAY_FOCUS_SRC, /function inertOverlaySiblings/);
    assert.match(OVERLAY_FOCUS_SRC, /inertOverlaySiblings\(top, prev\)/);
    const h = createHarness();
    h.sessionRow.addEventListener("click", () => {
      h.location.href = "/run";
    });
    h.filterInput.focus();
    h.ageBtn.click();
    assert.equal(h.ageMenu.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.ageMenu));
    assert.equal(h.ageMenu.hasAttribute("inert"), false, "open #ageMenu itself is not inert");
    assert.equal(h.shell.hasAttribute("inert"), false, "nested menu stays in the shell; shell is an ancestor, not a sibling");
    assert.equal(hasInertAncestor(h.sessionRow), true, "session row sits under an inert ancestor while #ageMenu is open");
    assert.equal(hasInertAncestor(h.workspaceSearch), true, "#workspaceSearch is under an inert ancestor");
    assert.equal(hasInertAncestor(h.filterInput), true, "filter input behind the menu is under an inert ancestor");
    h.ageAll.focus();
    h.press("Tab");
    assertInside(h, h.ageMenu, "ageMenu Tab while page behind is inert");
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch, "/ must not steal while ageMenu owns the keyboard");
    assert.equal(h.ageMenu.hidden, false);
    h.sessionRow.click();
    assert.equal(h.location._navigated, undefined, "clicking a session row must not navigate to /run");
    assert.notEqual(h.location._navigated, "/run");
    if (!h.ageMenu.hidden) h.press("Escape");
    assert.equal(h.ageMenu.hidden, true);
    assert.equal(hasInertAncestor(h.sessionRow), false, "session row is not left inert after ageMenu closes");

    h.sourceBtn.click();
    assert.equal(hasInertAncestor(h.sessionRow), true, "session row sits under an inert ancestor while #sourceMenu is open");
    h.press("Escape");
    h.displayToggle.click();
    assert.equal(hasInertAncestor(h.sessionRow), true, "session row sits under an inert ancestor while #sortBar is open");
    h.press("Escape");
  });

  test("Opening #sessionFlyout moves document.activeElement inside the flyout; Tab stays trapped; Escape restores previous focus", () => {
    assert.match(BROWSER_CLIENT_SRC, /pushOverlay\(flyout\)/);
    assert.match(BROWSER_CLIENT_SRC, /focusOverlay\(flyout/);
    assert.match(BROWSER_CLIENT_SRC, /trapOverlayTab\(event, flyout\)/);
    assert.match(BROWSER_CLIENT_SRC, /restoreOverlayFocus\(flyout\._tqPrevFocus, flyout\)/);
    const h = createHarness();
    h.filterInput.focus();
    const prev = h.document.activeElement;
    h.sessionRow.click();
    assert.equal(h.sessionFlyout.hidden, false);
    assertInside(h, h.sessionFlyout, "sessionFlyout open");
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.sessionFlyout));
    h.press("Tab");
    assertInside(h, h.sessionFlyout, "sessionFlyout Tab");
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.notEqual(h.document.activeElement, h.workspaceSearch);
    h.sessionFlyoutClose.focus();
    h.press("Tab");
    assertInside(h, h.sessionFlyout, "sessionFlyout Tab wrap");
    h.press("Escape");
    assert.equal(h.sessionFlyout.hidden, true);
    assert.equal(h.document.activeElement, prev);
    assert.equal(h.hiddenActive(), false);
  });

  test("while #sessionFlyout is open, idle / does not focus #workspaceSearch and the flyout stays open on the overlay stack", () => {
    const h = createHarness();
    h.filterInput.focus();
    h.sessionRow.click();
    assert.equal(h.sessionFlyout.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.length > 0);
    h.sessionFlyoutOpen.focus();
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch, "/ must not steal to #workspaceSearch behind sessionFlyout");
    assert.equal(h.sessionFlyout.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.sessionFlyout));
    h.press("g");
    h.press("r");
    assert.equal(h.location._navigated, undefined, "G then R must not jump while sessionFlyout owns the keyboard");
    h.press("Escape");
    assert.equal(h.sessionFlyout.hidden, true);
    h.body.focus();
    h.press("/");
    assert.equal(h.document.activeElement, h.workspaceSearch, "idle / focuses #workspaceSearch after sessionFlyout closes");
  });

  test("#sessionFlyout joins window.__tqOverlayStack", () => {
    assert.match(BROWSER_CLIENT_SRC, /pushOverlay\(flyout\)/);
    assert.match(BROWSER_CLIENT_SRC, /popOverlay\(flyout\)/);
    assert.match(BROWSER_CLIENT_SRC, /focusOverlay\(flyout/);
    assert.match(BROWSER_CLIENT_SRC, /trapOverlayTab\(event, flyout\)/);
    assert.match(BROWSER_CLIENT_SRC, /restoreOverlayFocus\(flyout\._tqPrevFocus, flyout\)/);
    assert.match(BROWSER_CLIENT_SRC, /isTopOverlay\(flyout\)/);
    const h = createHarness();
    h.sessionRow.click();
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.sessionFlyout));
    h.press("Escape");
    assert.ok(!h.window.__tqOverlayStack.includes(h.sessionFlyout));
  });

  test("open #sessionFlyout inerts the page behind so / does not steal to #workspaceSearch", () => {
    assert.match(BROWSER_CLIENT_SRC, /pushOverlay\(flyout\)/);
    assert.match(BROWSER_CLIENT_SRC, /getElementById\('sessionFlyout'\)/);
    const h = createHarness();
    h.filterInput.focus();
    h.sessionRow.click();
    assert.equal(h.sessionFlyout.hidden, false);
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.sessionFlyout));
    assert.equal(h.sessionFlyout.hasAttribute("inert"), false, "open #sessionFlyout itself is not inert");
    assert.equal(h.sessionFlyout.parentNode, h.body, "#sessionFlyout is a body-level sibling");
    assert.equal(h.sessionFlyout.getAttribute("role"), "dialog");
    assert.equal(h.sessionFlyout.getAttribute("aria-modal"), "true");
    assert.equal(h.shell.hasAttribute("inert"), true, ".tq-shell is inert under #sessionFlyout");
    assert.equal(hasInertAncestor(h.sessionRow), true, "session row sits under an inert ancestor while #sessionFlyout is open");
    assert.equal(hasInertAncestor(h.workspaceSearch), true, "#workspaceSearch is under an inert ancestor");
    assert.equal(hasInertAncestor(h.filterInput), true, "filter input behind the flyout is under an inert ancestor");
    h.sessionFlyoutOpen.focus();
    h.press("Tab");
    assertInside(h, h.sessionFlyout, "sessionFlyout Tab while page behind is inert");
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch, "/ must not steal while sessionFlyout owns the keyboard");
    assert.equal(h.sessionFlyout.hidden, false);
    h.press("Escape");
    assert.equal(h.sessionFlyout.hidden, true);
    assert.equal(hasInertAncestor(h.sessionRow), false, "session row is not left inert after sessionFlyout closes");
    assert.equal(h.document.activeElement, h.filterInput);
  });

  test("click inside #sessionFlyoutFrame Tab wraps back to flyout chrome; Escape still dismisses", () => {
    assert.match(OVERLAY_FOCUS_SRC, /function bindOverlayNestedFrameKeys/);
    assert.match(OVERLAY_FOCUS_SRC, /function trapOverlayNestedTab/);
    assert.match(OVERLAY_FOCUS_SRC, /function overlayNestedTabbables/);
    assert.match(BROWSER_CLIENT_SRC, /bindOverlayNestedFrameKeys\(/);
    const h = createHarness();
    h.filterInput.focus();
    const prev = h.document.activeElement;
    h.sessionRow.click();
    assert.equal(h.sessionFlyout.hidden, false);
    h.sessionFlyoutFrame.hidden = false;

    h.sessionFlyoutClose.focus();
    h.press("Tab");
    assert.equal(h.document.activeElement, h.sessionFlyoutFrame, "Tab from last chrome enters the nested /view iframe");
    assert.equal(h.frameDocument.activeElement, h.errorDot, "focus lands on the first inner tabbable");

    h.chapterChrome.focus();
    h.dispatch(h.chapterChrome, "keydown", { key: "Tab" });
    assert.equal(h.document.activeElement, h.sessionFlyoutOpen, "Tab from last inner tabbable wraps back to flyout chrome");
    assertInside(h, h.sessionFlyout, "wrapped Tab stays in #sessionFlyout");
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.notEqual(h.document.activeElement, h.workspaceSearch);

    h.errorDot.focus();
    h.dispatch(h.errorDot, "keydown", { key: "Tab", shiftKey: true });
    assert.equal(h.document.activeElement, h.sessionFlyoutClose, "Shift+Tab from first inner tabbable wraps to last chrome");
    assertInside(h, h.sessionFlyout, "Shift+Tab wrap stays in #sessionFlyout");

    h.frameBody.focus();
    h.dispatch(h.frameBody, "keydown", { key: "Tab" });
    assert.equal(h.document.activeElement, h.sessionFlyoutOpen, "Tab after a click on iframe body wraps to flyout chrome");

    h.errorDot.focus();
    h.dispatch(h.errorDot, "keydown", { key: "Escape" });
    assert.equal(h.sessionFlyout.hidden, true, "Escape from nested iframe dismisses #sessionFlyout");
    assert.equal(h.document.activeElement, prev);
    assert.equal(h.hiddenActive(), false);
  });

  test("Cmd+K inside #sessionFlyoutFrame opens the parent palette the same way Cmd+K over launch does", () => {
    assert.match(OVERLAY_FOCUS_SRC, /function overlayIsCommandPaletteChord/);
    assert.match(OVERLAY_FOCUS_SRC, /function overlayToggleParentPalette/);
    assert.match(OVERLAY_FOCUS_SRC, /overlayToggleParentPalette\(\)/);
    assert.match(BROWSER_CLIENT_SRC, /action === 'cmdk'/);
    assert.match(CORE_JS, /action: 'cmdk'/);
    const h = createHarness();
    h.filterInput.focus();
    h.sessionRow.click();
    assert.equal(h.sessionFlyout.hidden, false);
    h.sessionFlyoutFrame.hidden = false;
    h.errorDot.focus();
    assert.equal(h.document.activeElement, h.sessionFlyoutFrame, "click inside nested /view leaves parent activeElement on the iframe");
    h.dispatch(h.errorDot, "keydown", { key: "k", metaKey: true });
    assert.equal(h.overlay.hidden, false, "Cmd+K from #sessionFlyoutFrame must open parent #cmdkOverlay");
    assert.equal(h.document.activeElement, h.input, "parent #cmdkInput takes focus the same way Cmd+K over launch does");
    assert.equal(h.overlay.hasAttribute("inert"), false, "palette is not inert when stacked on #sessionFlyout");
    assert.equal(h.sessionFlyout.hasAttribute("inert"), true, "#sessionFlyout is inert under the stacked palette");
    assert.ok(
      stackedZ(h, h.overlay) > stackedZ(h, h.sessionFlyout),
      "palette must paint above #sessionFlyout",
    );
    h.input.value = "/ojkg?x";
    assert.equal(h.input.value, "/ojkg?x");
    h.press("Escape");
    assert.equal(h.overlay.hidden, true, "Escape closes the stacked palette first");
    assert.equal(h.sessionFlyout.hidden, false, "#sessionFlyout stays open under the palette");
    assert.equal(h.sessionFlyout.hasAttribute("inert"), false, "#sessionFlyout is not left inert");
  });

  test("rail toolbar menus join window.__tqOverlayStack", () => {
    assert.match(OVERLAY_FOCUS_SRC, /function openToolbarMenuOverlay/);
    assert.match(OVERLAY_FOCUS_SRC, /function closeToolbarMenuOverlays/);
    assert.match(OVERLAY_FOCUS_SRC, /pushOverlay\(menu\)/);
    assert.match(OVERLAY_FOCUS_SRC, /popOverlay\(menu\)/);
    assert.match(BROWSER_CLIENT_SRC, /openToolbarMenuOverlay\(ageMenu\)/);
    assert.match(BROWSER_CLIENT_SRC, /openToolbarMenuOverlay\(sourceMenu\)/);
    assert.match(BROWSER_CLIENT_SRC, /openToolbarMenuOverlay\(sortBar\)/);
    assert.match(BROWSER_CLIENT_SRC, /closeToolbarMenuOverlays/);
    assert.match(RUN_PAGE_SRC, /openToolbarMenuOverlay\(ageMenu\)/);
    assert.match(RUN_PAGE_SRC, /openToolbarMenuOverlay\(sourceMenu\)/);
    assert.match(RUN_PAGE_SRC, /openToolbarMenuOverlay\(sortBar\)/);
    assert.match(RUN_PAGE_SRC, /closeToolbarMenuOverlays/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /bindToolbarMenuOverlayKeys\(\)/);
    const h = createHarness();
    h.ageBtn.click();
    assert.ok(h.window.__tqOverlayStack && h.window.__tqOverlayStack.includes(h.ageMenu));
    h.press("Escape");
    assert.ok(!h.window.__tqOverlayStack.includes(h.ageMenu));
    h.sourceBtn.click();
    assert.ok(h.window.__tqOverlayStack.includes(h.sourceMenu));
    h.displayToggle.click();
    assert.ok(h.window.__tqOverlayStack.includes(h.sortBar));
    assert.ok(!h.window.__tqOverlayStack.includes(h.sourceMenu), "opening sortBar pops the other toolbar menu");
  });

  test("run-details is an APG modal dialog: role=dialog, page behind inert, / does not focus #workspaceSearch", () => {
    assert.match(RUN_PAGE_SRC, /id="runOverlay"/);
    assert.match(RUN_PAGE_SRC, /id="runMenu" role="dialog" aria-modal="true"/);
    const page = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp", startedAt: "2026-01-01T00:00:00.000Z", status: "running" },
    });
    const composerIdx = page.indexOf('id="agentChip"');
    const runIdx = page.indexOf('id="runOverlay"');
    assert.ok(runIdx > composerIdx, "run overlay is a body-level sibling after the shell composer");
    const h = createHarness();
    h.inputText.focus();
    h.agentChip.click();
    assert.equal(h.runMenu.hidden, false);
    assert.equal(h.runOverlay.hidden, false);
    assert.equal(h.runMenu.getAttribute("role"), "dialog");
    assert.equal(h.runMenu.getAttribute("aria-modal"), "true");
    assert.equal(h.shell.hasAttribute("inert"), true, ".tq-shell is inert under the run-details dialog");
    assert.equal(hasInertAncestor(h.workspaceSearch), true, "#workspaceSearch is under an inert ancestor");
    assert.equal(hasInertAncestor(h.inputText), true, "composer is under an inert ancestor");
    assert.equal(h.runOverlay.hasAttribute("inert"), false);
    h.press("/");
    assert.notEqual(h.document.activeElement, h.workspaceSearch);
    assert.equal(h.runMenu.hidden, false);
  });
});
