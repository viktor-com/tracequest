/**
 * Idle-page shortcuts (palette closed, no text form field focused).
 * Dimension B: / j k o Enter G-chords Cmd+K Escape still run.
 * Fact anchors: swis swiv swir swijk swio swip swig swik swiesc swidl swiclosed swiss swisgh swicmdks swichip swsoptab swslistprint swichkui swichkoff swichkon swichkmod swihelp swicmdslash swicheat swihelpfield swihelpoff swilist swilistfield swilistcheat swilistesc swilistescpeek swilistescover swihelpfocus swigshift swilisto swilistrun swilistoe swilistenter
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { COMMAND_PALETTE_CLIENT_JS } from "../../src/browser/command-palette.js";
import { INTERACTIONS_NAV_JS } from "../../src/render/render-interactions-nav.js";
import { runPage, chatHomePage } from "../../src/browser/run-page.js";

const CLIENT_SRC = readFileSync(new URL("../../src/browser/browser-client.js", import.meta.url), "utf8");
const RUN_PAGE_SRC = readFileSync(new URL("../../src/browser/run-page.js", import.meta.url), "utf8");
const NAV_SRC = readFileSync(new URL("../../src/render/render-interactions-nav.js", import.meta.url), "utf8");
const PALETTE_SRC = readFileSync(new URL("../../src/browser/command-palette.js", import.meta.url), "utf8");
const PAGE_BUILD_SRC = readFileSync(new URL("../../src/browser/browser-page-build.js", import.meta.url), "utf8");

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

function extractBlock(src, uniqueNeedle, endNeedle) {
  const i = src.indexOf(uniqueNeedle);
  if (i < 0) throw new Error("idle shortcut source not found: " + uniqueNeedle.slice(0, 80));
  const listenerStart = src.lastIndexOf("document.addEventListener", i);
  const fnStart = src.lastIndexOf("\nfunction ", i);
  const start = Math.max(listenerStart, fnStart);
  if (start < 0) throw new Error("handler not found before " + uniqueNeedle.slice(0, 40));
  const end = src.indexOf(endNeedle, i);
  if (end < 0) throw new Error("end not found for " + uniqueNeedle.slice(0, 40));
  return src.slice(start, end + endNeedle.length);
}

function githubIsFormField(el) {
  if (!el) return false;
  const name = (el.tagName || "").toLowerCase();
  let type = "";
  if (typeof el.getAttribute === "function") type = el.getAttribute("type") || "";
  else if (el.type != null) type = el.type;
  type = String(type).toLowerCase();
  return name === "select" || name === "textarea"
    || (name === "input" && type !== "submit" && type !== "reset" && type !== "checkbox" && type !== "radio" && type !== "file")
    || !!el.isContentEditable;
}

function createIdleDom(opts = {}) {
  const pathname = opts.pathname || "/sessions";
  const search = opts.search || "";
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
      isContentEditable: !!extra.isContentEditable,
      offsetWidth: 100,
      _cap: Object.create(null),
      _bub: Object.create(null),
      _focused: false,
      _clicked: 0,
      style: {},
      disabled: false,
      get id() { return this._id; },
      set id(v) {
        if (this._id) byId.delete(this._id);
        this._id = String(v || "");
        if (this._id) byId.set(this._id, this);
      },
      get children() { return this._kids; },
      setAttribute(name, value) {
        attrs[name] = String(value);
        if (name === "id") this.id = value;
        if (name === "class") this.className = String(value);
        if (name === "type") this.type = String(value);
        if (name === "hidden") this.hidden = true;
      },
      getAttribute(name) {
        if (name === "id") return this.id || null;
        if (name === "class") return this.className || null;
        if (name === "type") return this.type || null;
        if (name === "hidden") return this.hidden ? "" : null;
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      hasAttribute(name) {
        if (name === "hidden") return !!this.hidden;
        if (name === "id") return !!this.id;
        return Object.prototype.hasOwnProperty.call(attrs, name);
      },
      removeAttribute(name) {
        if (name === "hidden") this.hidden = false;
        if (name === "id") this.id = "";
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
      insertBefore(child, ref) {
        if (child.parentNode && child.parentNode._kids) {
          child.parentNode._kids = child.parentNode._kids.filter((k) => k !== child);
        }
        child.parentNode = this;
        const idx = this._kids.indexOf(ref);
        if (idx < 0) this._kids.push(child);
        else this._kids.splice(idx, 0, child);
        return child;
      },
      get firstChild() { return this._kids[0] || null; },
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
        activeElement = this;
        this._focused = true;
      },
      blur() {
        if (activeElement === this) activeElement = document.body;
        this._blurred = true;
      },
      click() {
        this._clicked += 1;
        const list = this._bub.click || [];
        const ev = { type: "click", target: this, preventDefault() {} };
        for (const fn of list) fn(ev);
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
    if (extra.attrs) {
      for (const [k, v] of Object.entries(extra.attrs)) node.setAttribute(k, v);
    }
    return node;
  }

  const htmlEl = createEl("html");
  const document = {
    nodeType: 9,
    tagName: "#DOCUMENT",
    _cap: Object.create(null),
    _bub: Object.create(null),
    parentNode: null,
    _kids: [],
    documentElement: htmlEl,
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
  activeElement = body;

  const app = createEl("div", { id: "app" });
  const filterInput = createEl("input", { id: "filterInput", className: "filter-input", type: "text" });
  const searchInput = createEl("input", { className: "filter-search", type: "text" });
  const chapters = [];
  for (let i = 0; i < 3; i++) {
    const ch = createEl("div", { id: "chapter-" + i, className: "chapter" });
    chapters.push(ch);
    app.appendChild(ch);
  }
  const agentRail = createEl("div", { className: "agent-rail" });
  const railToggle = createEl("button", { id: "railFilterToggle", type: "button" });
  railToggle.tagName = "BUTTON";
  const newRunBtn = createEl("button", { id: "newRunBtn", type: "button" });
  newRunBtn.tagName = "BUTTON";
  const launchOverlay = createEl("div", { id: "launchOverlay", hidden: true });
  const cmdkTrigger = createEl("button", { id: "cmdkTrigger", type: "button" });
  const kbd = createEl("span", { className: "cmdk-trigger-kbd" });
  cmdkTrigger.appendChild(kbd);

  const workspaceSearchWrap = createEl("div", { id: "workspaceSearchWrap", className: "tq-search" });
  const workspaceSearch = createEl("input", { id: "workspaceSearch", className: "tq-search-input", type: "search" });
  workspaceSearch.tagName = "INPUT";
  const workspaceSearchList = createEl("div", { id: "workspaceSearchList", className: "tq-search-list", hidden: true });
  workspaceSearchWrap.appendChild(workspaceSearch);
  workspaceSearchWrap.appendChild(workspaceSearchList);

  const overlay = createEl("div", { id: "cmdkOverlay", className: "cmdk-overlay", hidden: true });
  overlay.setAttribute("data-cmdk-state", "closed");
  const scrim = createEl("div", { id: "cmdkScrim", className: "cmdk-scrim" });
  const dialog = createEl("div", { className: "cmdk" });
  dialog.setAttribute("role", "dialog");
  const contextWrap = createEl("div", { id: "cmdkContextWrap", className: "cmdk-context-wrap", hidden: true });
  const contextEl = createEl("span", { id: "cmdkContext", className: "cmdk-context" });
  const inputWrap = createEl("div", { className: "cmdk-input-wrap" });
  const input = createEl("input", { id: "cmdkInput", className: "cmdk-input", type: "text" });
  const spinner = createEl("span", { id: "cmdkSpinner", className: "cmdk-spinner", hidden: true });
  const emptyEl = createEl("div", { id: "cmdkEmpty", className: "cmdk-empty", hidden: true });
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

  const a11yOverlay = createEl("div", { id: "characterKeysOverlay", className: "tq-a11y-overlay", hidden: true });
  const a11yScrim = createEl("div", { id: "characterKeysScrim", className: "tq-a11y-scrim" });
  const a11yDialog = createEl("div", { id: "characterKeysDialog", className: "tq-a11y-dialog" });
  a11yDialog.setAttribute("role", "dialog");
  a11yDialog.setAttribute("aria-modal", "true");
  a11yDialog.setAttribute("tabindex", "-1");
  const a11yTitle = createEl("h2", { id: "characterKeysTitle", className: "tq-a11y-title", textContent: "Keyboard shortcuts" });
  const a11yClose = createEl("button", { id: "characterKeysClose", type: "button" });
  a11yClose.tagName = "BUTTON";
  a11yClose.textContent = "Close";
  const a11yTable = createEl("table", { id: "shortcutCheatsheet", className: "tq-a11y-table" });
  a11yTable.textContent = "Search Command menu Keyboard shortcuts Character keys";
  const a11yToggle = createEl("input", { id: "characterKeysToggle", type: "checkbox" });
  a11yToggle.tagName = "INPUT";
  a11yToggle.checked = true;
  a11yDialog.appendChild(a11yTitle);
  a11yDialog.appendChild(a11yClose);
  a11yDialog.appendChild(a11yTable);
  a11yDialog.appendChild(a11yToggle);
  a11yOverlay.appendChild(a11yScrim);
  a11yOverlay.appendChild(a11yDialog);

  app.appendChild(filterInput);
  app.appendChild(searchInput);
  app.appendChild(agentRail);
  app.appendChild(railToggle);
  app.appendChild(newRunBtn);
  body.appendChild(app);
  body.appendChild(cmdkTrigger);
  body.appendChild(workspaceSearchWrap);
  body.appendChild(overlay);
  body.appendChild(a11yOverlay);
  body.appendChild(launchOverlay);

  let href = "http://127.0.0.1" + pathname + search;
  const location = {
    pathname,
    search,
    origin: "http://127.0.0.1",
    hash: "",
    get href() { return href; },
    set href(v) {
      href = String(v);
      this._navigated = href;
    },
  };

  const sessionStore = Object.create(null);
  const sessionStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null),
    setItem: (k, v) => { sessionStore[k] = String(v); },
    removeItem: (k) => { delete sessionStore[k]; },
  };
  const lsStore = Object.create(null);
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null),
    setItem: (k, v) => { lsStore[k] = String(v); },
    removeItem: (k) => { delete lsStore[k]; },
  };

  const windowObj = {
    location,
    sessionStorage,
    localStorage,
    document,
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener() {},
    removeEventListener() {},
    open(url) { location.href = url; },
  };

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
      isComposing: !!init.isComposing,
      defaultPrevented: false,
      _prevented: false,
      _stopped: false,
      _immediate: false,
      bubbles: true,
      cancelable: true,
      target,
      currentTarget: null,
      preventDefault() {
        this.defaultPrevented = true;
        this._prevented = true;
      },
      stopPropagation() { this._stopped = true; },
      stopImmediatePropagation() {
        this._stopped = true;
        this._immediate = true;
      },
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
    sessionStorage,
    localStorage,
    history: { replaceState() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [], results: [] }) }),
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
    expandedSet: new Set(),
    searchQuery: "",
    render() {},
    applyFilters() {},
    getChapters() {
      return [{ prompt: "alpha" }, { prompt: "beta" }, { prompt: "gamma" }];
    },
    setChapterHash() {},
    clearChapterHash() {},
    __hash: "",
  };
  windowObj.window = windowObj;

  new Script(COMMAND_PALETTE_CLIENT_JS, { filename: "command-palette.js" }).runInNewContext(sandbox);
  new Script(INTERACTIONS_NAV_JS, { filename: "render-interactions-nav.js" }).runInNewContext(sandbox);

  function press(key, mods = {}) {
    const target = mods.target || document.activeElement || body;
    return dispatch(target, "keydown", { key, ...mods });
  }

  return {
    window: windowObj,
    document,
    body,
    input,
    overlay,
    filterInput,
    searchInput,
    workspaceSearch,
    chapters,
    newRunBtn,
    characterKeysOverlay: a11yOverlay,
    characterKeysDialog: a11yDialog,
    characterKeysToggle: a11yToggle,
    characterKeysClose: a11yClose,
    shortcutCheatsheet: a11yTable,
    launchOverlay,
    agentRail,
    railToggle,
    location,
    createEl,
    press,
    githubIsFormField,
    installPageHotkey: sandbox.installPageHotkey,
    install: sandbox.install,
  };
}

describe("shortcut-when-idle source contract", () => {
  test("idle / is a site-wide workspace search chord", () => {
    assert.match(PALETTE_SRC, /data-hotkey="s,\/"/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /installSlashSearchHotkey/);
    assert.match(PALETTE_SRC, /id="workspaceSearch"/);
    assert.doesNotMatch(COMMAND_PALETTE_CLIENT_JS, /openPageSearch/);
  });

  test("idle character shortcuts yield to cmdk-open, GitHub-style form fields, and the overlay stack", () => {
    assert.match(CLIENT_SRC, /j,J,ArrowDown/);
    assert.match(CLIENT_SRC, /FORM_FIELD_GUARD_SRC/);

    assert.match(NAV_SRC, /FORM_FIELD_GUARD_SRC/);
    assert.match(NAV_SRC, /Slash-to-search is independent of whether any chapter is visible/);

    assert.match(PALETTE_SRC, /installSlashSearchHotkey/);
    assert.match(PALETTE_SRC, /data-hotkey="s,\/"/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /type !== "checkbox"/);
    assert.match(PALETTE_SRC, /k === "c"/);
    assert.match(PALETTE_SRC, /k === "r"/);
    assert.match(PALETTE_SRC, /k === "d"/);
    assert.match(PALETTE_SRC, /k === "v"/);
    assert.match(PALETTE_SRC, /k === "n"/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /\(e\.metaKey \|\| e\.ctrlKey\) && !e\.altKey && !e\.shiftKey && \(key === "k" \|\| key === "K"\)/);

    const runHtml = runPage({ run: { id: "@1", agent: "claude", cwd: "/tmp", startedAt: "2026-01-01T00:00:00.000Z", status: "running" } });
    const homeHtml = chatHomePage({ defaultCwd: "/tmp" });
    assert.match(runHtml, /installSlashSearchHotkey/);
    assert.match(homeHtml, /installSlashSearchHotkey/);
    assert.match(runHtml, /id="filterInput"/);
    assert.match(homeHtml, /id="filterInput"/);

    assert.match(PAGE_BUILD_SRC, /id="filterInput"/);
    assert.doesNotMatch(
      PAGE_BUILD_SRC,
      /const HTML_MIDDLE = `" autofocus>/,
      "/sessions #filterInput must not autofocus, or G-then-letter dies after G then R",
    );
  });

  test("G-then-letter jumps are declared as GitHub sequences g c without four-way case aliases", () => {
    assert.doesNotMatch(PALETTE_SRC, /g c,G c,g C,G C/);
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    h.press("g");
    h.press("c");
    assert.equal(h.location._navigated, "/", "g then c jumps from a single GitHub sequence g c");
    const hR = createIdleDom({ pathname: "/" });
    hR.body.focus();
    hR.press("g");
    hR.press("r");
    assert.equal(hR.location._navigated, "/sessions", "g then r jumps from a single GitHub sequence g r");
  });

  test("Shift+G then c jumps as G then C as written", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    h.press("G", { shiftKey: true });
    h.press("c");
    assert.equal(h.location._navigated, "/", "Shift+G then c jumps to Chat");
    assert.equal(h.overlay.hidden, true, "palette stays closed");
    const held = createIdleDom({ pathname: "/sessions" });
    held.body.focus();
    held.press("G", { shiftKey: true });
    held.press("C", { shiftKey: true });
    assert.equal(held.location._navigated, "/", "Shift+G then Shift+C also jumps");
  });
});

describe("shortcut-when-idle sessions and run", () => {
  test("GitHub data-hotkey s,/ is the workspace search chord", () => {
    assert.match(PALETTE_SRC, /data-hotkey="s,\/"/);
    assert.doesNotMatch(PALETTE_SRC, /data-hotkey="\/">/);
  });

  test("the visible search chip advertises S as well as /", () => {
    const chip = PALETTE_SRC.match(/class="tq-search-kbd"[^>]*>([\s\S]*?)<\/span>/);
    assert.ok(chip, "workspace search chip wrap is present");
    assert.match(chip[1], /<kbd>S<\/kbd>/, "chip shows S");
    assert.match(chip[1], /<kbd>\/<\/kbd>/, "chip shows /");
    assert.doesNotMatch(PALETTE_SRC, /<kbd class="tq-search-kbd"[^>]*>\/<\/kbd>/, "chip is not slash-only");
    assert.match(PALETTE_SRC, /aria-keyshortcuts="s \/"/);
  });

  test("listbox popup options are excluded from the page Tab sequence", () => {
    assert.match(COMMAND_PALETTE_CLIENT_JS, /role="option" tabindex="-1" id="ws-opt-'/);
    const h = createIdleDom({ pathname: "/sessions" });
    const list = h.document.getElementById("workspaceSearchList");
    const item = h.createEl("button", { className: "tq-search-item", type: "button" });
    item.tagName = "BUTTON";
    item.setAttribute("role", "option");
    item.setAttribute("tabindex", "-1");
    list.appendChild(item);
    h.workspaceSearch.focus();
    h.press("Tab", { target: h.workspaceSearch });
    assert.notEqual(h.document.activeElement, item, "Tab from the combobox does not land on a popup option");
    assert.equal(list.hidden, true, "Tab closes the popup so it does not cover the page behind");
  });

  test("printable / and j while a workspace search result is focused insert into #workspaceSearch", () => {
    const h = createIdleDom({ pathname: "/view", search: "?id=deadbeef" });
    const list = h.document.getElementById("workspaceSearchList");
    list.hidden = false;
    const item = h.createEl("button", { className: "tq-search-item", type: "button" });
    item.tagName = "BUTTON";
    item.setAttribute("role", "option");
    item.setAttribute("tabindex", "-1");
    list.appendChild(item);
    item.focus();
    assert.equal(h.document.activeElement, item);
    h.press("/", { target: item });
    assert.equal(h.document.activeElement, h.workspaceSearch, "/ returns focus to the combobox");
    assert.ok(String(h.workspaceSearch.value).includes("/"), "/ inserts, not consumed as the search opener");
    item.focus();
    h.press("j", { target: item });
    assert.equal(h.document.activeElement, h.workspaceSearch, "j returns focus to the combobox");
    assert.ok(String(h.workspaceSearch.value).includes("j"), "j inserts, not chapter kb-focused");
    assert.ok(
      !h.chapters.some((ch) => ch.classList.contains("kb-focused")),
      "j on a focused option does not set chapter kb-focused",
    );
  });

  test("idle / on /sessions focuses #workspaceSearch, not the page-local filter", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    const ev = h.press("/");
    assert.ok(ev._prevented);
    assert.equal(h.document.activeElement, h.workspaceSearch);
    assert.ok(h.workspaceSearch._focused);
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.equal(h.overlay.hidden, true, "idle / does not open the CommandPalette");

    h.workspaceSearch.blur();
    const button = h.createEl("button", { type: "button" });
    button.tagName = "BUTTON";
    h.body.appendChild(button);
    button.focus();
    h.workspaceSearch._focused = false;
    h.press("/", { target: button });
    assert.equal(h.document.activeElement, h.workspaceSearch, "/ with a button focused still focuses workspace search");

    h.workspaceSearch.blur();
    h.body.focus();
    const cmdSlash = h.press("/", { metaKey: true });
    assert.ok(cmdSlash._prevented, "Cmd+/ is the cheatsheet chord, not slash-to-search");
    assert.notEqual(h.document.activeElement, h.workspaceSearch, "Cmd+/ does not focus workspace search");
    assert.equal(h.characterKeysOverlay.hidden, false, "idle Cmd+/ opens the keyboard-shortcuts cheatsheet");
  });

  test("idle s on /sessions focuses #workspaceSearch (same action as /)", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    assert.equal(h.document.activeElement, h.body, "BODY is focused before idle s");
    assert.equal(h.overlay.hidden, true, "palette is closed");
    const ev = h.press("s");
    assert.ok(ev._prevented, "idle s preventDefault on leaf fire");
    assert.equal(h.document.activeElement, h.workspaceSearch, "idle s focuses #workspaceSearch");
    assert.ok(h.workspaceSearch._focused);
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.equal(h.overlay.hidden, true, "idle s does not open the CommandPalette");
  });

  test("idle s and / both focus #workspaceSearch", () => {
    for (const key of ["s", "/"]) {
      const h = createIdleDom({ pathname: "/sessions" });
      h.body.focus();
      assert.equal(h.document.activeElement, h.body, `${key}: BODY first`);
      const ev = h.press(key);
      assert.ok(ev._prevented, `${key}: preventDefault`);
      assert.equal(h.document.activeElement, h.workspaceSearch, `${key}: focuses #workspaceSearch`);
      assert.equal(h.overlay.hidden, true, `${key}: palette stays closed`);
      assert.ok(!h.document.body.classList.contains("cmdk-open"), `${key}: not a Cmd+K alias`);
    }
  });

  test("idle / on a rendered session focuses #workspaceSearch, not .filter-search", () => {
    const h = createIdleDom({ pathname: "/view", search: "?id=deadbeef" });
    h.body.focus();
    const ev = h.press("/");
    assert.ok(ev._prevented);
    assert.equal(h.document.activeElement, h.workspaceSearch);
    assert.ok(!h.searchInput._focused, "idle / does not focus chapter search on served /view");
    assert.equal(h.overlay.hidden, true);
  });

  test("idle / on /run focuses #workspaceSearch, not the rail filter", () => {
    const h = createIdleDom({ pathname: "/run" });
    h.body.focus();
    const ev = h.press("/");
    assert.ok(ev._prevented);
    assert.equal(h.document.activeElement, h.workspaceSearch);
    assert.ok(!h.agentRail.classList.contains("filters-open"), "idle / does not open rail filters");
    assert.notEqual(h.document.activeElement, h.filterInput);
    assert.equal(h.overlay.hidden, true, "idle / does not open the CommandPalette");
  });

  test("idle / on /sessions, /run, /view, and /compare focuses the same #workspaceSearch", () => {
    for (const path of ["/sessions", "/run", "/view", "/compare"]) {
      const h = createIdleDom({ pathname: path });
      h.body.focus();
      const ev = h.press("/");
      assert.ok(ev._prevented, `${path}: / preventDefault`);
      assert.equal(h.document.activeElement, h.workspaceSearch, `${path}: focuses #workspaceSearch`);
      assert.equal(h.overlay.hidden, true, `${path}: palette stays closed`);
      assert.ok(!h.document.body.classList.contains("cmdk-open"), `${path}: not a Cmd+K alias`);
      assert.notEqual(h.document.activeElement, h.filterInput, `${path}: not #filterInput`);
      assert.ok(!h.searchInput._focused, `${path}: not .filter-search`);
    }
  });

  test("idle / does not open the CommandPalette", () => {
    const h = createIdleDom({ pathname: "/compare" });
    h.body.focus();
    h.press("/");
    assert.equal(h.overlay.hidden, true);
    assert.ok(!h.document.body.classList.contains("cmdk-open"));
    assert.equal(h.document.activeElement, h.workspaceSearch);
    h.workspaceSearch.blur();
    h.body.focus();
    h.press("k", { metaKey: true });
    assert.equal(h.overlay.hidden, false, "Cmd+K still opens the command menu");
    assert.equal(h.document.activeElement, h.input);
  });

  test("after G then D lands on /compare with BODY focused, idle / focuses #workspaceSearch", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    h.press("g");
    h.press("d");
    assert.equal(h.location._navigated, "/compare");
    assert.equal(h.overlay.hidden, true, "palette stays closed after G then D");

    const landed = createIdleDom({ pathname: "/compare" });
    landed.body.focus();
    assert.equal(landed.document.activeElement, landed.body);
    assert.equal(landed.overlay.hidden, true);
    const ev = landed.press("/");
    assert.ok(ev._prevented);
    assert.equal(landed.overlay.hidden, true, "idle / on /compare does not alias Cmd+K");
    assert.ok(!landed.document.body.classList.contains("cmdk-open"));
    assert.equal(landed.document.activeElement, landed.workspaceSearch, "idle / focuses #workspaceSearch");
    assert.equal(landed.workspaceSearch.value, "", "slash is the opener, not a typed query character");
  });

  test("idle j/k step the sessions peek flyout", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    const peeked = [];
    const sessionsSrc = extractBlock(
      CLIENT_SRC,
      "function bindPeekHotkeys",
      "bindPeekHotkeys();",
    );
    const env = {
      document: h.document,
      filterInput: h.filterInput,
      isFormField: githubIsFormField,
      installPageHotkey: h.installPageHotkey,
      _peekSession: { id: "s1" },
      closeSessionFlyout() { env._peekSession = null; },
      peekStep(dir) { peeked.push(dir); },
      stepSessionList() {},
    };
    new Function("env", `with (env) { ${sessionsSrc} }`)(env);

    h.body.focus();
    h.press("j");
    h.press("k");
    h.press("J");
    h.press("ArrowDown");
    assert.deepEqual(peeked, [1, -1, 1, 1]);

    const link = h.createEl("a");
    link.tagName = "A";
    h.body.appendChild(link);
    link.focus();
    peeked.length = 0;
    h.press("j", { target: link });
    assert.deepEqual(peeked, [1], "j steps peek while a session link is focused");

    env._peekSession = null;
    peeked.length = 0;
    h.press("j");
    assert.deepEqual(peeked, [], "j does not peek when the flyout is closed");
  });

  function mountSessionList(h, ids, opts = {}) {
    const sessionsEl = h.createEl("div", { id: "sessions" });
    h.body.appendChild(sessionsEl);
    const running = new Set(opts.runningIds || []);
    const wraps = [];
    for (const id of ids) {
      const isRun = running.has(id);
      const wrap = h.createEl("div", {
        className: isRun ? "session-row-wrap run-row-wrap" : "session-row-wrap",
      });
      wrap.setAttribute("data-session-id", id);
      if (isRun) wrap.setAttribute("data-run-id", id);
      const row = isRun
        ? h.createEl("div", { className: "session-row run-row" })
        : h.createEl("a", { className: "session-row" });
      if (isRun) {
        row.setAttribute("tabindex", "0");
        row.setAttribute("role", "link");
        row.setAttribute("data-href", "/run?id=" + id);
        row.setAttribute("data-run-status", "running");
      } else {
        row.tagName = "A";
      }
      wrap.appendChild(row);
      sessionsEl.appendChild(wrap);
      wraps.push(wrap);
    }
    return { sessionsEl, wraps };
  }

  function selectedIds(h) {
    return h.document.querySelectorAll(".session-row-wrap")
      .filter((w) => w.classList.contains("is-selected"))
      .map((w) => w.getAttribute("data-session-id"));
  }

  function bindSessionListHotkeys(h, sessionsEl, extra = {}) {
    const helpersStart = CLIENT_SRC.indexOf("var _listCursorId");
    const helpersEnd = CLIENT_SRC.indexOf("function peekIndex()");
    assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, "list cursor helpers are in browser-client");
    const helpersSrc = CLIENT_SRC.slice(helpersStart, helpersEnd);
    const hotkeysSrc = extractBlock(CLIENT_SRC, "function bindPeekHotkeys", "bindPeekHotkeys();");
    const escSrc = extractBlock(
      CLIENT_SRC,
      "function onSessionsListEscape",
      "document.addEventListener('keydown', onSessionsListEscape);",
    );
    const listEnterSrc = extractBlock(
      CLIENT_SRC,
      "function onSessionsListEnter",
      "document.addEventListener('keydown', onSessionsListEnter);",
    );
    const enterNeedle = "sessionsEl.addEventListener('keydown', function(e) {\n  if (e.key !== 'Enter') return;";
    const enterStart = CLIENT_SRC.indexOf(enterNeedle);
    assert.ok(enterStart >= 0, "run-row Enter listener is in browser-client");
    const enterEnd = CLIENT_SRC.indexOf("});", enterStart);
    const enterSrc = CLIENT_SRC.slice(enterStart, enterEnd + 3);
    const env = {
      document: h.document,
      window: h.window,
      sessionsEl,
      _peekSession: extra.peekSession || null,
      peekStep(dir) { env.peeked = (env.peeked || []).concat([dir]); },
      closeSessionFlyout() {
        env._peekSession = null;
        env.closedPeek = (env.closedPeek || 0) + 1;
        if (typeof env.markSelectedRow === "function") env.markSelectedRow();
      },
      isFormField: githubIsFormField,
      overlayStackBusy() {
        const stack = h.window && h.window.__tqOverlayStack;
        return !!(stack && stack.length);
      },
      installPageHotkey: h.installPageHotkey,
      openSessionFlyout(s) {
        env.openedList = (env.openedList || []).concat([s && s.id]);
      },
      ...extra,
    };
    new Function("env", `with (env) { ${helpersSrc}\n env.stepSessionList = stepSessionList;\n env.clearSessionListCursor = clearSessionListCursor;\n env.markSelectedRow = markSelectedRow;\n env.openSelectedListItem = openSelectedListItem;\n env.restoreListCursorFocus = restoreListCursorFocus;\n env.listOwnsKeyboard = listOwnsKeyboard; }`)(env);
    new Function("env", `with (env) { ${hotkeysSrc} }`)(env);
    new Function("env", `with (env) { ${escSrc} }`)(env);
    new Function("env", `with (env) { ${listEnterSrc} }`)(env);
    new Function("env", `with (env) { ${enterSrc} }`)(env);
    return env;
  }

  test("idle j/k on /sessions with peek closed move the run list", () => {
    assert.match(CLIENT_SRC, /stepSessionList\(-1\)/);
    assert.match(PALETTE_SRC, /Next \/ previous in the current list/);

    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["s1", "s2", "s3"]);
    const env = bindSessionListHotkeys(h, sessionsEl);
    h.body.focus();
    assert.deepEqual(selectedIds(h), [], "Linear default: no row selected until J/K");
    assert.equal(env._peekSession, null);
    h.press("j");
    assert.deepEqual(selectedIds(h), ["s1"], "idle j highlights the first row with peek closed");
    assert.equal(h.document.activeElement, wraps[0].querySelector(".session-row"));
    assert.equal(env.peeked, undefined, "idle j does not open peek");
    h.press("j");
    assert.deepEqual(selectedIds(h), ["s2"]);
    h.press("ArrowDown");
    assert.deepEqual(selectedIds(h), ["s3"], "ArrowDown moves the same list cursor");
    h.press("k");
    assert.deepEqual(selectedIds(h), ["s2"]);
    h.press("ArrowUp");
    assert.deepEqual(selectedIds(h), ["s1"], "ArrowUp moves the same list cursor");

    const fromBody = createIdleDom({ pathname: "/sessions" });
    const mounted = mountSessionList(fromBody, ["a", "b"]);
    bindSessionListHotkeys(fromBody, mounted.sessionsEl);
    fromBody.body.focus();
    fromBody.press("k");
    assert.deepEqual(selectedIds(fromBody), ["b"], "idle k with no selection highlights the last row");
  });

  test("idle j on a running div.session-row.run-row keeps focus so Enter opens", () => {
    assert.match(CLIENT_SRC, /_listCursorFocus = true/);
    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["run1", "s2"], { runningIds: ["run1"] });
    const env = bindSessionListHotkeys(h, sessionsEl);
    const runRow = wraps[0].querySelector(".session-row");
    assert.equal(runRow.tagName, "DIV");
    assert.ok(String(runRow.className).split(/\s+/).includes("run-row"));
    h.body.focus();
    h.press("j");
    assert.deepEqual(selectedIds(h), ["run1"], "idle j highlights the running row");
    assert.equal(h.document.activeElement, runRow, "idle j leaves document.activeElement on div.session-row.run-row");
    assert.equal(runRow.getAttribute("aria-current"), "true");
    h.press("Enter");
    assert.equal(h.window.location.href, "/run?id=run1", "Enter on the focused run-row opens it");

    const archived = wraps[1].querySelector(".session-row");
    wraps[0].parentNode._kids = wraps[0].parentNode._kids.filter((k) => k !== wraps[0]);
    wraps[0].parentNode = null;
    runRow.parentNode = null;
    const wrap2 = h.createEl("div", { className: "session-row-wrap run-row-wrap" });
    wrap2.setAttribute("data-session-id", "run1");
    const row2 = h.createEl("div", { className: "session-row run-row" });
    row2.setAttribute("tabindex", "0");
    row2.setAttribute("role", "link");
    row2.setAttribute("data-href", "/run?id=run1");
    wrap2.appendChild(row2);
    sessionsEl.insertBefore(wrap2, wraps[1]);
    h.document.activeElement = h.body;
    env.markSelectedRow();
    assert.equal(h.document.activeElement, row2, "list rebuild keeps focus on the new running row");
    assert.ok(wrap2.classList.contains("is-selected"));
    h.window.location.href = "http://127.0.0.1/sessions";
    h.press("Enter");
    assert.equal(h.window.location.href, "/run?id=run1", "Enter still opens after the rebuild");

    h.workspaceSearch.focus();
    h.press("j", { target: h.workspaceSearch });
    assert.equal(h.document.activeElement, h.workspaceSearch, "focused field: j must not steal onto the run-row");
    assert.equal(archived.tagName, "A");
  });

  test("while a text field is focused, j/k/ArrowDown do not move the /sessions run list", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl } = mountSessionList(h, ["s1", "s2"]);
    bindSessionListHotkeys(h, sessionsEl);
    h.workspaceSearch.focus();
    const j = h.press("j", { target: h.workspaceSearch });
    assert.ok(!j._prevented, "focused field: j must not preventDefault");
    assert.deepEqual(selectedIds(h), [], "focused field: j must not select a run row");
    h.press("k", { target: h.workspaceSearch });
    h.press("ArrowDown", { target: h.workspaceSearch });
    assert.deepEqual(selectedIds(h), [], "focused field: k/ArrowDown must not move the run list");
    assert.equal(h.document.activeElement, h.workspaceSearch);
  });

  test("cheatsheet advertises J/K as current-list navigation", () => {
    assert.match(PALETTE_SRC, /<kbd>J<\/kbd> \/ <kbd>K<\/kbd>/);
    assert.match(PALETTE_SRC, /Next \/ previous in the current list/);
    assert.match(PALETTE_SRC, /Open focused item or toggle chapter/);
    assert.match(PALETTE_SRC, /Close overlay or unfocus/);
    assert.doesNotMatch(PALETTE_SRC, /Next \/ previous chapter/);
  });

  test("idle o on a /sessions list cursor opens the focused item", () => {
    assert.match(PALETTE_SRC, /Open focused item or toggle chapter/);
    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["s1", "s2"]);
    const env = bindSessionListHotkeys(h, sessionsEl);
    h.body.focus();
    h.press("o");
    assert.deepEqual(env.openedList || [], [], "idle o with no cursor is a no-op");
    assert.equal(env._peekSession, null);
    h.press("j");
    assert.deepEqual(selectedIds(h), ["s1"]);
    assert.equal(h.document.activeElement, wraps[0].querySelector(".session-row"));
    h.press("o");
    assert.deepEqual(env.openedList, ["s1"], "idle o opens the J/K cursor row");
    h.workspaceSearch.focus();
    env.openedList = [];
    h.press("o", { target: h.workspaceSearch });
    assert.deepEqual(env.openedList, [], "focused field: o must not open the list item");
    h.body.focus();
    h.press("Escape");
    h.press("j");
    assert.deepEqual(selectedIds(h), ["s1"]);
    h.body.focus();
    assert.equal(h.document.activeElement, h.body, "BODY focused with .is-selected still set");
    assert.ok(wraps[0].classList.contains("is-selected"));
    env.openedList = [];
    h.press("Enter");
    assert.deepEqual(env.openedList, ["s1"], "idle Enter from BODY opens the same J/K cursor item as O");
  });

  test("idle O and Enter open the J/K cursor when the list owns the keyboard", () => {
    assert.match(PALETTE_SRC, /<kbd>O<\/kbd> or <kbd>Enter<\/kbd>/);
    assert.match(PALETTE_SRC, /Open focused item or toggle chapter/);

    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["run1", "s2"], { runningIds: ["run1"] });
    const env = bindSessionListHotkeys(h, sessionsEl);
    const runRow = wraps[0].querySelector(".session-row");
    assert.equal(runRow.tagName, "DIV");
    assert.ok(String(runRow.className).split(/\s+/).includes("run-row"));
    h.body.focus();
    h.press("j");
    assert.deepEqual(selectedIds(h), ["run1"]);
    h.body.focus();
    assert.equal(h.document.activeElement, h.body, "focus is BODY");
    assert.ok(wraps[0].classList.contains("is-selected"), ".is-selected still set");
    h.press("o");
    assert.equal(h.window.location.href, "/run?id=run1", "idle o from BODY opens the running J/K cursor");
    assert.deepEqual(env.openedList || [], [], "running-row O navigates, it does not peek");

    h.window.location.href = "http://127.0.0.1/sessions";
    h.body.focus();
    assert.ok(wraps[0].classList.contains("is-selected"));
    h.press("Enter");
    assert.equal(h.window.location.href, "/run?id=run1", "idle Enter from BODY is the same open action");

    const archived = createIdleDom({ pathname: "/sessions" });
    const mounted = mountSessionList(archived, ["s1", "s2"]);
    const envA = bindSessionListHotkeys(archived, mounted.sessionsEl);
    archived.body.focus();
    archived.press("j");
    archived.body.focus();
    assert.equal(archived.document.activeElement, archived.body);
    assert.ok(mounted.wraps[0].classList.contains("is-selected"));
    archived.press("o");
    assert.deepEqual(envA.openedList, ["s1"], "archived O still peeks");
    envA.openedList = [];
    archived.body.focus();
    archived.press("Enter");
    assert.deepEqual(envA.openedList, ["s1"], "archived Enter is the same peek action");
  });

  test("focused #newRunBtn Enter is native activation", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["run1", "s2"], { runningIds: ["run1"] });
    const env = bindSessionListHotkeys(h, sessionsEl);

    h.newRunBtn.focus();
    const noCursor = h.press("Enter", { target: h.newRunBtn });
    assert.ok(!noCursor._prevented, "with no J/K cursor, Enter on #newRunBtn must not preventDefault");
    assert.deepEqual(env.openedList || [], []);
    assert.equal(h.window.location._navigated, undefined);

    h.body.focus();
    h.press("j");
    assert.ok(wraps[0].classList.contains("is-selected"));
    h.newRunBtn.focus();
    assert.equal(h.document.activeElement, h.newRunBtn);
    env.openedList = [];
    h.window.location.href = "http://127.0.0.1/sessions";
    const selectedEnter = h.press("Enter", { target: h.newRunBtn });
    assert.ok(!selectedEnter._prevented, "Enter must not steal native activation from #newRunBtn while a row is .is-selected");
    assert.deepEqual(env.openedList || [], [], "must not open the selected row");
    assert.equal(h.window.location.href, "http://127.0.0.1/sessions", "must not navigate to the run");
    if (!selectedEnter._prevented) h.newRunBtn.click();
    assert.equal(h.newRunBtn._clicked, 1, "unconsumed Enter leaves native button activation intact");

    h.body.focus();
    h.press("Escape");
    h.press("j");
    const row = wraps[0].querySelector(".session-row");
    assert.equal(h.document.activeElement, row, "list owns the keyboard after idle j");
    h.window.location.href = "http://127.0.0.1/sessions";
    h.press("Enter");
    assert.equal(h.window.location.href, "/run?id=run1", "idle j then Enter still opens the focused running row");

    h.window.location.href = "http://127.0.0.1/sessions";
    h.body.focus();
    assert.ok(wraps[0].classList.contains("is-selected"));
    assert.equal(h.document.activeElement, h.body);
    h.press("Enter");
    assert.equal(h.window.location.href, "/run?id=run1", "BODY with .is-selected still opens on Enter");
  });

  test("idle Escape on /sessions with peek closed clears the list cursor", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["s1", "s2"]);
    bindSessionListHotkeys(h, sessionsEl);
    h.body.focus();
    h.press("j");
    const row = wraps[0].querySelector(".session-row");
    assert.deepEqual(selectedIds(h), ["s1"]);
    assert.equal(row.getAttribute("aria-current"), "true");
    assert.equal(h.document.activeElement, row);
    h.press("Escape");
    assert.deepEqual(selectedIds(h), [], "Escape clears .session-row-wrap.is-selected");
    assert.equal(row.getAttribute("aria-current"), null, "Escape drops aria-current");
    assert.notEqual(h.document.activeElement, row, "Escape blurs the role=link row");

    h.workspaceSearch.focus();
    h.press("j", { target: h.workspaceSearch });
    assert.deepEqual(selectedIds(h), []);
    wraps[0].classList.add("is-selected");
    row.setAttribute("aria-current", "true");
    h.press("Escape", { target: h.workspaceSearch });
    assert.ok(wraps[0].classList.contains("is-selected"), "focused field: Escape must not clear the list cursor");
    assert.equal(row.getAttribute("aria-current"), "true");
  });

  test("peek Escape still closes peek before list-clear", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["s1", "s2"]);
    const env = bindSessionListHotkeys(h, sessionsEl, { peekSession: { id: "s1" } });
    env.markSelectedRow();
    assert.deepEqual(selectedIds(h), ["s1"]);
    h.body.focus();
    h.press("Escape");
    assert.equal(env.closedPeek, 1, "first Escape closes peek");
    assert.equal(env._peekSession, null);
    assert.deepEqual(selectedIds(h), ["s1"], "peek Escape does not yet clear the list cursor");
    assert.equal(wraps[0].querySelector(".session-row").getAttribute("aria-current"), "true");
    h.press("Escape");
    assert.deepEqual(selectedIds(h), [], "second idle Escape unfocuses the list cursor");
    assert.equal(wraps[0].querySelector(".session-row").getAttribute("aria-current"), null);
  });

  test("overlay Escape still pops overlays before list-clear", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    const { sessionsEl, wraps } = mountSessionList(h, ["s1", "s2"]);
    bindSessionListHotkeys(h, sessionsEl);
    h.body.focus();
    h.press("j");
    assert.deepEqual(selectedIds(h), ["s1"]);
    h.window.__tqOverlayStack = [{ id: "share" }];
    h.press("Escape");
    assert.deepEqual(selectedIds(h), ["s1"], "overlay stack owns Escape — list cursor stays");
    assert.equal(wraps[0].querySelector(".session-row").getAttribute("aria-current"), "true");
    h.document.body.classList.add("cmdk-open");
    h.press("Escape");
    assert.deepEqual(selectedIds(h), ["s1"], "cmdk-open Escape must not clear the list cursor");
    h.window.__tqOverlayStack = [];
    h.document.body.classList.remove("cmdk-open");
    h.press("Escape");
    assert.deepEqual(selectedIds(h), [], "after overlay pop, idle Escape unfocuses the list cursor");
  });
});

describe("shortcut-when-idle palette chords", () => {
  test("idle Cmd/Ctrl+K toggles the CommandPalette when focus is on the page and no form field is focused", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    h.press("k", { metaKey: true });
    assert.equal(h.overlay.hidden, false);
    assert.ok(h.document.body.classList.contains("cmdk-open"));
    assert.equal(h.document.activeElement, h.input);

    h.press("k", { metaKey: true });
    assert.equal(h.overlay.hidden, true);
    assert.ok(!h.document.body.classList.contains("cmdk-open"));

    h.body.focus();
    h.press("k", { ctrlKey: true });
    assert.equal(h.overlay.hidden, false, "Ctrl+K also toggles");
    h.press("k", { ctrlKey: true });
    assert.equal(h.overlay.hidden, true);
  });

  test("idle G then C/R/D/V/N jumps to Chat, Runs, Compare, rendered session, or New run", () => {
    const cases = [
      ["c", "/", null],
      ["r", "/sessions", null],
      ["d", "/compare", null],
      ["v", "/view", null],
    ];
    for (const [letter, dest] of cases) {
      const h = createIdleDom({ pathname: "/sessions" });
      h.body.focus();
      h.press("g");
      h.press(letter);
      assert.equal(h.location._navigated, dest, `G then ${letter.toUpperCase()} -> ${dest}`);
      assert.equal(h.overlay.hidden, true, "palette stays closed");
    }

    const hN = createIdleDom({ pathname: "/sessions" });
    hN.body.focus();
    hN.press("g");
    hN.press("n");
    assert.equal(hN.newRunBtn._clicked, 1, "G then N activates New run");

    const hCheck = createIdleDom({ pathname: "/compare" });
    const checkbox = hCheck.createEl("input", { type: "checkbox" });
    checkbox.tagName = "INPUT";
    hCheck.body.appendChild(checkbox);
    checkbox.focus();
    hCheck.press("g", { target: checkbox });
    hCheck.press("r", { target: checkbox });
    assert.equal(hCheck.location._navigated, "/sessions", "G-chords still run with a checkbox focused");

    assert.doesNotMatch(
      PAGE_BUILD_SRC,
      /const HTML_MIDDLE = `" autofocus>/,
      "/sessions #filterInput must not autofocus, or G then D after G then R types into the filter",
    );
  });

  test("idle shortcuts work again after the CommandPalette closes", () => {
    const h = createIdleDom({ pathname: "/view", search: "?id=deadbeef" });
    const sessionsSrc = extractBlock(
      CLIENT_SRC,
      "function bindPeekHotkeys",
      "bindPeekHotkeys();",
    );
    const env = {
      document: h.document,
      filterInput: h.filterInput,
      isFormField: githubIsFormField,
      installPageHotkey: h.installPageHotkey,
      _peekSession: { id: "s1" },
      closeSessionFlyout() {},
      peekStep() { env.peeked = (env.peeked || 0) + 1; },
    };
    new Function("env", `with (env) { ${sessionsSrc} }`)(env);

    h.body.focus();
    h.press("k", { metaKey: true });
    assert.ok(h.document.body.classList.contains("cmdk-open"));
    h.press("/");
    assert.ok(!h.searchInput._focused, "/ must not run while the palette is open");
    h.press("j");
    assert.ok(!h.chapters[0].classList.contains("kb-focused"), "j must not walk chapters while open");

    h.press("k", { metaKey: true });
    assert.ok(!h.document.body.classList.contains("cmdk-open"));
    h.body.focus();

    h.press("/");
    assert.equal(h.document.activeElement, h.workspaceSearch, "idle / focuses workspace search after palette close");
    h.workspaceSearch.blur();
    h.body.focus();
    h.press("j");
    assert.ok(
      h.chapters[0].classList.contains("kb-focused") || env.peeked === 1,
      "idle j walks chapters or steps peek after palette close",
    );
    h.body.focus();
    h.press("g");
    h.press("c");
    assert.equal(h.location._navigated, "/", "idle G then C works after palette close");
  });

  test("idle shortcuts fire when a button, link, or checkbox is focused — those are not text form fields", () => {
    const h = createIdleDom({ pathname: "/view" });
    const button = h.createEl("button", { type: "button" });
    button.tagName = "BUTTON";
    const link = h.createEl("a");
    link.tagName = "A";
    const checkbox = h.createEl("input", { type: "checkbox" });
    checkbox.tagName = "INPUT";
    h.body.appendChild(button);
    h.body.appendChild(link);
    h.body.appendChild(checkbox);

    for (const control of [button, link, checkbox]) {
      control.focus();
      h.press("Escape", { target: control });
      for (const ch of h.chapters) ch.classList.remove("kb-focused");
      h.searchInput._focused = false;
      control.focus();
      h.press("/", { target: control });
      assert.equal(h.document.activeElement, h.workspaceSearch, `${control.tagName} idle / focuses workspace search`);
      h.workspaceSearch.blur();
      control.focus();
      h.press("j", { target: control });
      assert.ok(h.chapters[0].classList.contains("kb-focused"), `${control.tagName} idle j walks chapters`);
    }
  });
});

describe("shortcut-when-idle character keys WCAG 2.1.4", () => {
  test("a Character keys checkbox (GitHub WCAG 2.1.4 hatch) is available to turn off unmodified character-key shortcuts", () => {
    assert.match(PALETTE_SRC, /id="characterKeysToggle"/);
    assert.match(PALETTE_SRC, /id="characterKeysOverlay"/);
    assert.match(PALETTE_SRC, /for="characterKeysToggle"/);
    assert.match(PALETTE_SRC, /Character keys/);
    assert.match(PALETTE_SRC, /Deselect Character keys/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /id: "keyboard-shortcuts"/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /setCharacterKeysEnabled\(!!toggle\.checked\)/);
    const h = createIdleDom({ pathname: "/sessions" });
    assert.ok(h.characterKeysToggle, "Character keys checkbox is in the page");
    assert.equal(h.characterKeysToggle.type, "checkbox");
    assert.equal(h.characterKeysToggle.checked, true, "Character keys is selected by default");
    assert.equal(h.window.characterKeysEnabled(), true, "character keys default on");
  });

  test("when Character keys is deselected, focused #newRunBtn then s does not move focus to #workspaceSearch and g then c does not navigate", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.window.setCharacterKeysEnabled(false);
    assert.equal(h.document.documentElement.getAttribute("data-tq-character-keys"), "off");
    h.newRunBtn.focus();
    assert.equal(h.document.activeElement, h.newRunBtn);
    h.press("s", { target: h.newRunBtn });
    assert.equal(h.document.activeElement, h.newRunBtn, "s must not steal focus to search");
    assert.notEqual(h.document.activeElement, h.workspaceSearch);
    assert.equal(h.workspaceSearch._focused, false);
    h.press("g", { target: h.newRunBtn });
    h.press("c", { target: h.newRunBtn });
    assert.equal(h.location._navigated, undefined, "g then c must not navigate when Character keys is off");
    assert.equal(h.overlay.hidden, true);
  });

  test("when Character keys is selected (the default), idle s and / still focus #workspaceSearch and idle g then c still jumps", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    assert.equal(h.window.characterKeysEnabled(), true);
    h.newRunBtn.focus();
    h.press("s", { target: h.newRunBtn });
    assert.equal(h.document.activeElement, h.workspaceSearch, "default: s still focuses search");
    h.workspaceSearch.blur();
    h.body.focus();
    h.press("/");
    assert.equal(h.document.activeElement, h.workspaceSearch, "default: / still focuses search");
    h.workspaceSearch.blur();
    h.body.focus();
    h.press("g");
    h.press("c");
    assert.equal(h.location._navigated, "/", "default: g then c still jumps");
  });

  test("Cmd/Ctrl+K still toggles the CommandPalette when Character keys is deselected", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.window.setCharacterKeysEnabled(false);
    h.newRunBtn.focus();
    h.press("k", { metaKey: true, target: h.newRunBtn });
    assert.equal(h.overlay.hidden, false, "Cmd+K still opens the palette with Character keys off");
    assert.ok(h.document.body.classList.contains("cmdk-open"));
    assert.equal(h.document.activeElement, h.input);
    h.press("k", { metaKey: true });
    assert.equal(h.overlay.hidden, true);
    h.body.focus();
    h.press("k", { ctrlKey: true });
    assert.equal(h.overlay.hidden, false, "Ctrl+K still opens the palette with Character keys off");
  });

  test("idle ? opens the keyboard-shortcuts cheatsheet", () => {
    assert.match(PALETTE_SRC, /id="tqHotkeyHelp"/);
    assert.match(PALETTE_SRC, /data-hotkey="\?,Shift\+\?,Shift\+\/,Mod\+\/,Control\+\/,Meta\+\/"/);
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    assert.equal(h.characterKeysOverlay.hidden, true);
    assert.equal(h.overlay.hidden, true);
    h.press("?");
    assert.equal(h.characterKeysOverlay.hidden, false, "idle ? opens #characterKeysOverlay");
    assert.equal(h.overlay.hidden, true, "idle ? does not open the command palette");
  });

  test("idle ? focuses the cheatsheet dialog, not the Character keys checkbox", () => {
    assert.match(PALETTE_SRC, /id="characterKeysDialog"/);
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    h.press("?");
    assert.equal(h.characterKeysOverlay.hidden, false);
    assert.notEqual(h.document.activeElement, h.characterKeysToggle, "idle ? must not land on #characterKeysToggle");
    const onDialog = h.document.activeElement === h.characterKeysDialog
      || h.document.activeElement === h.characterKeysClose;
    assert.equal(onDialog, true, "idle ? focuses the dialog or Close");
    h.characterKeysClose.click();
    h.body.focus();
    h.press("/", { metaKey: true });
    assert.equal(h.characterKeysOverlay.hidden, false);
    assert.notEqual(h.document.activeElement, h.characterKeysToggle, "Cmd+/ must not land on #characterKeysToggle");
  });

  test("idle Cmd/Ctrl+/ opens the keyboard-shortcuts cheatsheet", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.body.focus();
    h.press("/", { metaKey: true });
    assert.equal(h.characterKeysOverlay.hidden, false, "idle Cmd+/ opens #characterKeysOverlay");
    assert.equal(h.overlay.hidden, true, "idle Cmd+/ does not open the command palette");
    h.characterKeysClose.click();
    assert.equal(h.characterKeysOverlay.hidden, true);
    h.body.focus();
    h.press("/", { ctrlKey: true });
    assert.equal(h.characterKeysOverlay.hidden, false, "idle Ctrl+/ opens #characterKeysOverlay");
  });

  test("the keyboard-shortcuts cheatsheet lists page shortcuts and includes the Character keys checkbox", () => {
    assert.match(PALETTE_SRC, /id="shortcutCheatsheet"/);
    assert.match(PALETTE_SRC, /id="characterKeysToggle"/);
    assert.match(PALETTE_SRC, />Search</);
    assert.match(PALETTE_SRC, />Command menu</);
    assert.match(PALETTE_SRC, /Next \/ previous in the current list/);
    assert.match(PALETTE_SRC, /<kbd>\?<\/kbd>/);
    assert.match(PALETTE_SRC, /Character keys/);
    const h = createIdleDom({ pathname: "/sessions" });
    assert.ok(h.shortcutCheatsheet, "cheatsheet table is in the dialog");
    assert.match(h.shortcutCheatsheet.textContent, /Search/);
    assert.ok(h.characterKeysToggle, "Character keys checkbox is in the same dialog");
    assert.equal(h.characterKeysToggle.type, "checkbox");
  });

  test("while a text field is focused, ? inserts and Cmd/Ctrl+/ does not open the cheatsheet", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.workspaceSearch.focus();
    const q = h.press("?", { target: h.workspaceSearch });
    assert.equal(h.characterKeysOverlay.hidden, true, "focused field: ? must not open the cheatsheet");
    assert.ok(!q._prevented, "focused field: ? must not preventDefault");
    assert.equal(h.document.activeElement, h.workspaceSearch);
    const cmd = h.press("/", { metaKey: true, target: h.workspaceSearch });
    assert.equal(h.characterKeysOverlay.hidden, true, "focused field: Cmd+/ must not open the cheatsheet");
    assert.ok(!cmd._prevented, "focused field: Cmd+/ must not preventDefault");
    const ctrl = h.press("/", { ctrlKey: true, target: h.workspaceSearch });
    assert.equal(h.characterKeysOverlay.hidden, true, "focused field: Ctrl+/ must not open the cheatsheet");
    assert.ok(!ctrl._prevented, "focused field: Ctrl+/ must not preventDefault");
    h.input.focus();
    const paletteQ = h.press("?", { target: h.input });
    assert.equal(h.characterKeysOverlay.hidden, true, "palette combobox: ? must not open the cheatsheet");
    assert.ok(!paletteQ._prevented);
  });

  test("when Character keys is deselected, idle ? does not open the cheatsheet and Cmd/Ctrl+/ still opens it", () => {
    const h = createIdleDom({ pathname: "/sessions" });
    h.window.setCharacterKeysEnabled(false);
    h.body.focus();
    h.press("?");
    assert.equal(h.characterKeysOverlay.hidden, true, "character-key ? is off");
    h.press("?", { shiftKey: true });
    assert.equal(h.characterKeysOverlay.hidden, true, "Shift+? is still a character key");
    h.body.focus();
    h.press("/", { metaKey: true });
    assert.equal(h.characterKeysOverlay.hidden, false, "modifier Cmd+/ still opens the cheatsheet");
    h.characterKeysClose.click();
    h.body.focus();
    h.press("/", { ctrlKey: true });
    assert.equal(h.characterKeysOverlay.hidden, false, "modifier Ctrl+/ still opens the cheatsheet");
  });
});
