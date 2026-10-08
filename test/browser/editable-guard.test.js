/**
 * Editable-guard: focused native input/textarea/select/contenteditable consume
 * printable keys. Page-level /, o, j, k, g and similar chords must not run.
 * Not the command-palette combobox (see command-palette-key-capture.test.js).
 * Fact anchors: edgtype edgnav edgsurf edgent edgidle edg1
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { COMMAND_PALETTE_CLIENT_JS } from "../../src/browser/command-palette.js";
import { INTERACTIONS_NAV_JS } from "../../src/render/render-interactions-nav.js";
import { CORE_JS } from "../../src/render/render-core.js";
import { LAUNCHER_CLIENT_JS } from "../../src/browser/launch-page.js";
import { isFormField, keyDownHandler, install } from "../../src/browser/is-form-field.js";

const PRINTABLE = "/ojkg?x";
const CLIENT_SRC = readFileSync(new URL("../../src/browser/browser-client.js", import.meta.url), "utf8");
const PAGE_BUILD_SRC = readFileSync(new URL("../../src/browser/browser-page-build.js", import.meta.url), "utf8");
const RUN_PAGE_SRC = readFileSync(new URL("../../src/browser/run-page.js", import.meta.url), "utf8");
const NAV_SRC = readFileSync(new URL("../../src/render/render-interactions-nav.js", import.meta.url), "utf8");
const CORE_SRC = readFileSync(new URL("../../src/render/render-core.js", import.meta.url), "utf8");
const ANALYTICS_SRC = readFileSync(new URL("../../src/browser/run-analytics-panel.js", import.meta.url), "utf8");

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
      isContentEditable: !!extra.isContentEditable,
      offsetWidth: 100,
      _cap: Object.create(null),
      _bub: Object.create(null),
      _focused: false,
      style: {},
      scrollTop: 0,
      get id() {
        return this._id;
      },
      set id(v) {
        if (this._id) byId.delete(this._id);
        this._id = String(v || "");
        if (this._id) byId.set(this._id, this);
      },
      get children() {
        return this._kids;
      },
      setAttribute(name, value) {
        attrs[name] = String(value);
        if (name === "id") this.id = value;
        if (name === "class") this.className = String(value);
        if (name === "type") this.type = String(value);
        if (name === "hidden") this.hidden = true;
        if (name === "data-href") this._href = String(value);
      },
      getAttribute(name) {
        if (name === "id") return this.id || null;
        if (name === "class") return this.className || null;
        if (name === "type") return this.type || null;
        if (name === "hidden") return this.hidden ? "" : null;
        if (name === "data-href") return this._href || null;
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      hasAttribute(name) {
        return this.getAttribute(name) != null;
      },
      appendChild(child) {
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
        activeElement = this;
        this._focused = true;
      },
      blur() {
        if (activeElement === this) activeElement = document.body;
        this._blurred = true;
      },
      click() {
        this._clicked = (this._clicked || 0) + 1;
        const list = this._bub.click || [];
        const ev = { type: "click", target: this, preventDefault() {} };
        for (const fn of list.slice()) fn.call(this, ev);
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

  const document = {
    nodeType: 9,
    tagName: "#DOCUMENT",
    _cap: Object.create(null),
    _bub: Object.create(null),
    parentNode: null,
    _kids: [],
    get activeElement() {
      return activeElement;
    },
    set activeElement(v) {
      activeElement = v;
    },
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
  const railFilter = createEl("input", { id: "filterInputRail", className: "filter-input", type: "text" });
  const searchInput = createEl("input", { className: "filter-search", type: "text" });
  const composer = createEl("input", { id: "inputText", className: "run-input", type: "text" });
  const homePrompt = createEl("input", { id: "homePrompt", className: "run-input", type: "text" });
  const liveTailInput = createEl("input", { id: "liveTailInput", className: "run-input", type: "text" });
  const promptInput = createEl("textarea", { id: "promptInput", className: "launch-textarea" });
  const cwdInput = createEl("input", { id: "cwdInput", className: "launch-input", type: "text" });
  const agentSelect = createEl("select", { id: "agentSelect", className: "launch-select" });
  const tokenInput = createEl("input", { className: "hf-modal-input", type: "password" });
  const repoInput = createEl("input", { className: "hf-modal-input", type: "text" });
  const continueInput = createEl("input", { className: "session-continue-input", type: "text" });
  const continueForm = createEl("form", { className: "session-continue-form" });
  const runRow = createEl("div", { className: "session-row run-row" });
  runRow.setAttribute("data-href", "/run?id=%401");
  const sessionsEl = createEl("div", { id: "sessions" });
  const wrap = createEl("div", { className: "session-row-wrap run-row-wrap" });
  const launchOverlay = createEl("div", { id: "launchOverlay", className: "launch-overlay" });
  launchOverlay.hidden = false;
  const newRunBtn = createEl("button", { id: "newRunBtn" });
  const launchForm = createEl("form", { id: "launchForm" });
  const launchNoMux = createEl("div", { id: "launchNoMux", hidden: true });
  const agentsEmpty = createEl("div", { id: "agentsEmpty", hidden: true });
  const startBtn = createEl("button", { id: "startBtn" });
  const launchError = createEl("div", { id: "launchError", hidden: true });
  const launchClose = createEl("button", { id: "launchClose" });

  const chapters = [];
  for (let i = 0; i < 3; i++) {
    const ch = createEl("div", { id: "chapter-" + i, className: "chapter" });
    chapters.push(ch);
    app.appendChild(ch);
  }
  app.appendChild(searchInput);
  app.appendChild(composer);
  app.appendChild(homePrompt);
  app.appendChild(liveTailInput);
  app.appendChild(tokenInput);
  app.appendChild(repoInput);
  continueForm.appendChild(continueInput);
  wrap.appendChild(runRow);
  wrap.appendChild(continueForm);
  sessionsEl.appendChild(wrap);
  app.appendChild(sessionsEl);
  launchForm.appendChild(agentSelect);
  launchForm.appendChild(cwdInput);
  launchForm.appendChild(promptInput);
  launchForm.appendChild(startBtn);
  launchOverlay.appendChild(launchForm);
  launchOverlay.appendChild(launchNoMux);
  launchOverlay.appendChild(agentsEmpty);
  launchOverlay.appendChild(launchError);
  launchOverlay.appendChild(launchClose);
  const workspaceSearchWrap = createEl("div", { id: "workspaceSearchWrap", className: "tq-search" });
  const workspaceSearch = createEl("input", { id: "workspaceSearch", className: "tq-search-input", type: "search" });
  const workspaceSearchList = createEl("div", { id: "workspaceSearchList", className: "tq-search-list", hidden: true });
  workspaceSearchWrap.appendChild(workspaceSearch);
  workspaceSearchWrap.appendChild(workspaceSearchList);

  body.appendChild(app);
  body.appendChild(filterInput);
  body.appendChild(railFilter);
  body.appendChild(workspaceSearchWrap);
  body.appendChild(newRunBtn);
  body.appendChild(launchOverlay);

  const overlay = createEl("div", { id: "cmdkOverlay", className: "cmdk-overlay", hidden: true });
  overlay.setAttribute("data-cmdk-state", "closed");
  const scrim = createEl("div", { id: "cmdkScrim", className: "cmdk-scrim" });
  const dialog = createEl("div", { className: "cmdk" });
  dialog.setAttribute("role", "dialog");
  const contextWrap = createEl("div", { id: "cmdkContextWrap", className: "cmdk-context-wrap", hidden: true });
  const contextEl = createEl("span", { id: "cmdkContext", className: "cmdk-context" });
  const inputWrap = createEl("div", { className: "cmdk-input-wrap" });
  const cmdkInput = createEl("input", { id: "cmdkInput", className: "cmdk-input", type: "text" });
  const spinner = createEl("span", { id: "cmdkSpinner", className: "cmdk-spinner", hidden: true });
  const emptyEl = createEl("div", { id: "cmdkEmpty", className: "cmdk-empty", hidden: true });
  const listEl = createEl("div", { id: "cmdkList", className: "cmdk-list" });
  contextWrap.appendChild(contextEl);
  inputWrap.appendChild(cmdkInput);
  inputWrap.appendChild(spinner);
  dialog.appendChild(contextWrap);
  dialog.appendChild(inputWrap);
  const bodyWrap = createEl("div", { className: "cmdk-body" });
  bodyWrap.appendChild(emptyEl);
  bodyWrap.appendChild(listEl);
  dialog.appendChild(bodyWrap);
  overlay.appendChild(scrim);
  overlay.appendChild(dialog);
  body.appendChild(overlay);

  activeElement = body;

  let href = "http://127.0.0.1/view?id=deadbeef";
  const location = {
    pathname: "/view",
    search: "?id=deadbeef",
    origin: "http://127.0.0.1",
    hash: "",
    get href() {
      return href;
    },
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

  const windowObj = {
    location,
    sessionStorage,
    document,
    innerWidth: 1024,
    innerHeight: 768,
    parent: { __posted: [] },
    addEventListener() {},
    removeEventListener() {},
  };
  windowObj.window = windowObj;
  windowObj.parent.postMessage = function postMessage(msg) {
    windowObj.parent.__posted.push(msg);
  };

  const steals = { slash: 0, peek: 0, rail: 0, rowEnter: 0, embed: 0 };

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
      stopPropagation() {
        this._stopped = true;
      },
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
    if (
      type === "keydown"
      && !ev.defaultPrevented
      && init.key
      && init.key.length === 1
      && !init.metaKey
      && !init.ctrlKey
      && !init.altKey
      && document.activeElement
      && typeof document.activeElement.value === "string"
      && (String(document.activeElement.tagName || "").toLowerCase() === "input"
        || String(document.activeElement.tagName || "").toLowerCase() === "textarea"
        || String(document.activeElement.tagName || "").toLowerCase() === "select"
        || document.activeElement.isContentEditable)
    ) {
      document.activeElement.value += init.key;
      if (document.activeElement.isContentEditable) {
        document.activeElement.textContent += init.key;
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
    localStorage: sessionStorage,
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
    SESSION: { events: [] },
    _INIT_DATA: { defaultCwd: "/tmp" },
  };

  new Script(COMMAND_PALETTE_CLIENT_JS, { filename: "command-palette.js" }).runInNewContext(sandbox);
  new Script(INTERACTIONS_NAV_JS, { filename: "render-interactions-nav.js" }).runInNewContext(sandbox);

  sessionsEl.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    if (document.body.classList.contains("cmdk-open")) return;
    if (isFormField(e.target)) return;
    if (e.target && e.target.closest && e.target.closest(".session-continue-form")) return;
    const row = e.target && e.target.closest ? e.target.closest(".run-row") : null;
    if (row) {
      location.href = row.getAttribute("data-href");
      steals.rowEnter += 1;
    }
  });

  function press(key, mods = {}) {
    const target = document.activeElement || body;
    return dispatch(target, "keydown", { key, ...mods });
  }

  function type(text) {
    for (const ch of text) press(ch, { shiftKey: ch === "?" });
  }

  function focusAndType(field, text = PRINTABLE) {
    field.value = "";
    if (field.isContentEditable) field.textContent = "";
    field.focus();
    type(text);
    return field.value;
  }

  return {
    document,
    filterInput,
    workspaceSearch,
    railFilter,
    searchInput,
    composer,
    homePrompt,
    liveTailInput,
    promptInput,
    cwdInput,
    agentSelect,
    tokenInput,
    repoInput,
    continueInput,
    continueForm,
    runRow,
    sessionsEl,
    launchOverlay,
    chapters,
    location,
    steals,
    press,
    type,
    focusAndType,
  };
}

describe("editable-guard: focused form fields consume printable keys", () => {
  test("page shortcut sources skip GitHub-style form fields via one shared GitHub isFormField, not only .filter-search", () => {
    assert.match(NAV_SRC, /FORM_FIELD_GUARD_SRC/);
    assert.match(INTERACTIONS_NAV_JS, /function isFormField/);
    assert.match(INTERACTIONS_NAV_JS, /function keyDownHandler/);
    assert.match(INTERACTIONS_NAV_JS, /addEventListener\("keydown", keyDownHandler\)/);
    assert.match(INTERACTIONS_NAV_JS, /installPageHotkey\('tqHotkeyChapterNext'/);
    assert.match(INTERACTIONS_NAV_JS, /isFormField\(ev\.target\) \|\| isFormField\(document\.activeElement\)/);
    assert.match(INTERACTIONS_NAV_JS, /if \(isInSearch \|\| editing\) return/);
    assert.match(CLIENT_SRC, /FORM_FIELD_GUARD_SRC/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /installSlashSearchHotkey/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /data-hotkey="s,\/"/);
    assert.match(CLIENT_SRC, /installPageHotkey\('tqHotkeyPeekNext'/);
    assert.match(CLIENT_SRC, /if \(isFormField\(e\.target\)\) return/);
    assert.match(CLIENT_SRC, /closest\('\.session-continue-form'\)/);
    assert.match(RUN_PAGE_SRC, /FORM_FIELD_GUARD_SRC/);
    assert.doesNotMatch(CLIENT_SRC, /function onSessionsSlashKey/);
    assert.doesNotMatch(RUN_PAGE_SRC, /function onRailSlashKey/);
    assert.match(CORE_SRC, /FORM_FIELD_GUARD_SRC/);
    assert.match(CORE_JS, /installPageHotkey\('tqHotkeyEmbedNext'/);
    assert.match(CORE_JS, /if \(isFormField\(e\.target\)\) return/);
    assert.match(ANALYTICS_SRC, /FORM_FIELD_GUARD_SRC/);
    assert.match(ANALYTICS_SRC, /if \(isFormField\(e\.target\)\) return/);
    assert.match(LAUNCHER_CLIENT_JS, /launchOverlay\.hidden \|\| !isTopOverlay\(launchOverlay\)/);
    assert.match(LAUNCHER_CLIENT_JS, /e\.key === 'Escape'/);
    assert.doesNotMatch(INTERACTIONS_NAV_JS, /activeElement === searchInput[\s\S]*if \(isInSearch\) return[\s\S]*ev\.key === 'j'/);
  });

  test("unscoped / o j k g fire from the one GitHub-style keyDownHandler via data-hotkey elements in the radix trie", () => {
    assert.match(COMMAND_PALETTE_CLIENT_JS, /installPageHotkey\("tqHotkeyGoC"/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /installSlashSearchHotkey/);
    assert.match(INTERACTIONS_NAV_JS, /installPageHotkey\('tqHotkeyChapterNext'/);
    assert.match(CLIENT_SRC, /installPageHotkey\('tqHotkeyPeekNext'/);
    assert.match(CORE_JS, /installPageHotkey\('tqHotkeyEmbedNext'/);
    assert.doesNotMatch(COMMAND_PALETTE_CLIENT_JS, /_tqPageHotkeys/);
    assert.doesNotMatch(INTERACTIONS_NAV_JS, /registerPageHotkey/);
    assert.doesNotMatch(CLIENT_SRC, /function onSessionsSlashKey/);
    assert.doesNotMatch(RUN_PAGE_SRC, /function onRailSlashKey/);
    assert.doesNotMatch(
      CLIENT_SRC,
      /document\.addEventListener\('keydown', function\(e\) \{\s*if \(document\.body\.classList\.contains\('cmdk-open'\)\) return;\s*if \(e\.key === '\/'/,
    );
    assert.doesNotMatch(
      RUN_PAGE_SRC,
      /document\.addEventListener\("keydown", function \(e\) \{\s*if \(document\.body\.classList\.contains\("cmdk-open"\)\) return;\s*if \(e\.key !== "\/"/,
    );
  });

  test("while a text-like input, textarea, select, or contenteditable is focused, typing /ojkg?x inserts those characters into the field", () => {
    const h = createHarness();
    const fields = [
      h.filterInput,
      h.workspaceSearch,
      h.searchInput,
      h.composer,
      h.railFilter,
      h.promptInput,
      h.cwdInput,
      h.tokenInput,
      h.repoInput,
      h.continueInput,
      h.homePrompt,
      h.liveTailInput,
    ];
    h.press("j");
    assert.ok(h.chapters[0].classList.contains("kb-focused"), "idle j still focuses a chapter first");
    for (const field of fields) {
      h.steals.slash = 0;
      h.steals.peek = 0;
      h.steals.rail = 0;
      h.location._navigated = undefined;
      const value = h.focusAndType(field);
      assert.equal(value, PRINTABLE, `${field.id || field.className} value`);
      for (const ch of PRINTABLE) {
        assert.ok(value.includes(ch), `${field.id || field.className} missing '${ch}'`);
      }
      assert.equal(h.steals.slash, 0, `${field.id || field.className}: no slash steal`);
      assert.equal(h.steals.peek, 0, `${field.id || field.className}: no peek steal`);
      assert.equal(h.steals.rail, 0, `${field.id || field.className}: no rail slash steal`);
      assert.ok(!h.location._navigated, `${field.id || field.className}: no G-chord`);
    }
    assert.ok(h.chapters[0].classList.contains("kb-focused"), "o/j/k must not move the focused chapter");
    assert.ok(!h.chapters[1].classList.contains("kb-focused"));
  });

  test("sessions filter, chapter search, run composer, rail filter, launch prompt and cwd, share token and repo, and session continue-form consume printable keys without slash-to-search, chapter toggle, peek step, or G-chord", () => {
    const h = createHarness();
    h.press("j");
    const surfaces = [
      ["sessions filter", h.filterInput],
      ["workspace search", h.workspaceSearch],
      ["chapter search", h.searchInput],
      ["run composer", h.composer],
      ["rail filter", h.railFilter],
      ["launch prompt", h.promptInput],
      ["launch cwd", h.cwdInput],
      ["share token", h.tokenInput],
      ["share repo", h.repoInput],
      ["session continue-form", h.continueInput],
    ];
    for (const [name, field] of surfaces) {
      h.steals.slash = 0;
      h.steals.peek = 0;
      h.steals.rail = 0;
      h.location._navigated = undefined;
      assert.equal(h.focusAndType(field), PRINTABLE, name);
      h.type("gr");
      assert.equal(field.value, PRINTABLE + "gr", `${name}: g then r types`);
      assert.ok(!h.location._navigated, `${name}: G-chord must not navigate`);
      assert.equal(h.steals.slash, 0, name);
      assert.equal(h.steals.peek, 0, name);
      assert.equal(h.steals.rail, 0, name);
    }
  });

  test("printable keys on non-palette surfaces do not run chapter nav when a form field is focused", () => {
    const h = createHarness();
    h.press("j");
    assert.equal(h.focusAndType(h.tokenInput), PRINTABLE);
    assert.ok(!h.searchInput._focused);
    assert.ok(h.chapters[0].classList.contains("kb-focused"));
  });

  test("GitHub leaf filter: unscoped / o j k g do not steal from #liveTailInput even if a data-hotkey-scope node exists", () => {
    const h = createHarness();
    const scoped = h.document.createElement("button");
    scoped.setAttribute("data-hotkey-scope", "liveTailInput");
    h.document.body.appendChild(scoped);
    assert.ok(
      h.document.querySelector('[data-hotkey-scope="liveTailInput"]'),
      "harness mounts a data-hotkey-scope node matching the focused field",
    );
    h.steals.slash = 0;
    h.steals.peek = 0;
    h.steals.rail = 0;
    h.location._navigated = undefined;
    assert.equal(h.focusAndType(h.liveTailInput), PRINTABLE, "#liveTailInput still inserts /ojkg?x");
    assert.equal(h.steals.slash, 0, "unscoped slash must not fire because leaf scope does not match");
    assert.equal(h.steals.peek, 0, "unscoped peek j/k must not fire");
    assert.equal(h.steals.rail, 0, "unscoped rail slash must not fire");
    assert.ok(!h.location._navigated, "unscoped G-chord must not fire");
    assert.equal(h.document.activeElement, h.liveTailInput);
  });

  test("Enter on a .run-row does not navigate while a form field including .session-continue-input is focused", () => {
    const h = createHarness();
    h.continueInput.focus();
    h.focusAndType(h.continueInput, "hello");
    assert.equal(h.continueInput.value, "hello");
    const ev = h.press("Enter");
    assert.ok(!ev._prevented);
    assert.equal(h.steals.rowEnter, 0);
    assert.ok(!h.location._navigated, "continue-form Enter must not follow data-href");

    h.runRow.focus();
    h.press("Enter");
    assert.equal(h.steals.rowEnter, 1, "idle Enter on the row still navigates");
    assert.equal(h.location._navigated, "/run?id=%401");
  });
});

describe("editable-guard session flyout j/k", () => {
  test("flyout and embed j/k are data-hotkey leaves on the one GitHub-style keyDownHandler; there is no capture-phase document sibling for those printables", () => {
    assert.match(PAGE_BUILD_SRC, /id="sessionFlyoutNext"[^>]*data-hotkey="j,J,ArrowDown"/);
    assert.match(PAGE_BUILD_SRC, /id="sessionFlyoutPrev"[^>]*data-hotkey="k,K,ArrowUp"/);
    assert.match(CLIENT_SRC, /setAttribute\('data-hotkey', 'j,J,ArrowDown'\)/);
    assert.match(CLIENT_SRC, /setAttribute\('data-hotkey', 'k,K,ArrowUp'\)/);
    assert.match(CLIENT_SRC, /install\(next\)/);
    assert.match(CLIENT_SRC, /install\(prev\)/);
    assert.match(CORE_JS, /installPageHotkey\('tqHotkeyEmbedNext'/);
    assert.match(CORE_JS, /installPageHotkey\('tqHotkeyEmbedPrev'/);
    assert.doesNotMatch(
      CLIENT_SRC,
      /event\.key === 'j' \|\| event\.key === 'J' \|\| event\.key === 'ArrowDown'/,
    );
    assert.doesNotMatch(
      CLIENT_SRC,
      /event\.key === 'k' \|\| event\.key === 'K' \|\| event\.key === 'ArrowUp'/,
    );
    const capNeedle = "document.addEventListener('keydown', function(event) {\n    var flyout = document.getElementById('sessionFlyout')";
    const capStart = CLIENT_SRC.indexOf(capNeedle);
    assert.ok(capStart >= 0, "flyout Tab/Escape capture listener is in browser-client");
    const capEnd = CLIENT_SRC.indexOf("}, true);", capStart);
    const capSrc = CLIENT_SRC.slice(capStart, capEnd);
    assert.match(capSrc, /event\.key === 'Tab'/);
    assert.match(capSrc, /event\.key === 'Escape'/);
    assert.doesNotMatch(capSrc, /peekStep\(/);
    assert.doesNotMatch(capSrc, /event\.key === 'j'/);
    assert.doesNotMatch(capSrc, /event\.key === 'k'/);
    const embedStart = CORE_JS.indexOf("document.addEventListener('keydown', function(e) {");
    assert.ok(embedStart >= 0, "embed document keydown is in CORE_JS");
    const embedSrc = CORE_JS.slice(embedStart, embedStart + 800);
    assert.doesNotMatch(embedSrc, /action: 'next'/);
    assert.doesNotMatch(embedSrc, /action: 'prev'/);
    assert.match(CORE_JS, /installPageHotkey\('tqHotkeyEmbedNext', 'j,J,ArrowDown'/);
  });

  test("focused native input inside #sessionFlyout consumes j/k; idle peek j/k still step", () => {
    const prevDoc = globalThis.document;
    const prevStack = globalThis.__tqOverlayStack;
    const peeked = [];
    const fakeDoc = {
      querySelector() { return null; },
      body: { hidden: false },
    };
    const flyout = {
      id: "sessionFlyout",
      hidden: false,
      nodeType: 1,
      contains(node) { return node === this || node === nextBtn || node === prevBtn || node === field; },
    };
    function leaf(id, hotkey, dir) {
      const attrs = { "data-hotkey": hotkey };
      return {
        id,
        nodeName: "BUTTON",
        tagName: "BUTTON",
        hidden: id.indexOf("Peek") >= 0,
        parentNode: id.indexOf("Flyout") >= 0 ? flyout : fakeDoc.body,
        parentElement: id.indexOf("Flyout") >= 0 ? flyout : fakeDoc.body,
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
        setAttribute(name, value) { attrs[name] = String(value); },
        click() { peeked.push(dir); },
        dispatchEvent() { return true; },
      };
    }
    const nextBtn = leaf("sessionFlyoutNext", "j,J,ArrowDown", 1);
    const prevBtn = leaf("sessionFlyoutPrev", "k,K,ArrowUp", -1);
    const pageNext = leaf("tqHotkeyPeekNext", "j,J,ArrowDown", "page-j");
    const pagePrev = leaf("tqHotkeyPeekPrev", "k,K,ArrowUp", "page-k");
    const field = {
      id: "flyoutProbe",
      nodeName: "INPUT",
      tagName: "INPUT",
      type: "text",
      value: "",
      isContentEditable: false,
      parentNode: flyout,
      parentElement: flyout,
      getAttribute(name) { return name === "type" ? this.type : name === "id" ? this.id : null; },
    };
    globalThis.document = fakeDoc;
    try {
      install(pageNext);
      install(pagePrev);
      install(nextBtn);
      install(prevBtn);
      globalThis.__tqOverlayStack = [flyout];

      for (const key of ["j", "k", "/", "o", "g", "x"]) {
        const ev = {
          key,
          target: field,
          defaultPrevented: false,
          _prevented: false,
          preventDefault() { this._prevented = true; this.defaultPrevented = true; },
        };
        keyDownHandler(ev);
        assert.ok(!ev._prevented, `focused flyout input must not preventDefault '${key}'`);
        if (key.length === 1) field.value += key;
      }
      assert.equal(field.value, "jk/ogx", "focused flyout input keeps j and k");
      assert.deepEqual(peeked, [], "dispatcher peek j/k must not fire while a form field is focused");

      peeked.length = 0;
      const body = { nodeName: "BODY", tagName: "BODY", id: "", isContentEditable: false, getAttribute() { return null; } };
      const idleJ = { key: "j", target: body, defaultPrevented: false, _prevented: false, preventDefault() { this._prevented = true; this.defaultPrevented = true; } };
      const idleK = { key: "k", target: body, defaultPrevented: false, _prevented: false, preventDefault() { this._prevented = true; this.defaultPrevented = true; } };
      keyDownHandler(idleJ);
      keyDownHandler(idleK);
      assert.ok(idleJ._prevented, "idle j still preventDefaults to step peek");
      assert.ok(idleK._prevented, "idle k still preventDefaults to step peek");
      assert.deepEqual(peeked, [1, -1], "idle j/k still peekStep when no form field is focused");
    } finally {
      if (prevDoc === undefined) delete globalThis.document;
      else globalThis.document = prevDoc;
      if (prevStack === undefined) delete globalThis.__tqOverlayStack;
      else globalThis.__tqOverlayStack = prevStack;
    }
  });
});

describe("editable-guard embed flyout", () => {
  test("embed j/k/Escape do not steal from a focused input", () => {
    assert.match(CORE_JS, /installPageHotkey\('tqHotkeyEmbedNext'/);
    assert.match(CORE_JS, /if \(isFormField\(e\.target\)\) return/);
    const posted = [];
    const input = {
      tagName: "INPUT",
      nodeName: "INPUT",
      type: "text",
      id: "embedField",
      value: "",
      isContentEditable: false,
      getAttribute(name) {
        return name === "type" ? this.type : null;
      },
    };
    const prev = globalThis.document;
    const fakeDoc = { querySelector() { return null; } };
    globalThis.document = fakeDoc;
    try {
      const btn = {
        tagName: "BUTTON",
        getAttribute(name) {
          if (name === "data-hotkey") return "j,k,/,Escape";
          return null;
        },
        setAttribute() {},
        click() { posted.push("click"); },
        dispatchEvent() { return true; },
      };
      install(btn);
      for (const key of ["j", "k", "Escape", "/"]) {
        const ev = { key, target: input, defaultPrevented: false, _prevented: false, preventDefault() { this._prevented = true; this.defaultPrevented = true; } };
        keyDownHandler(ev);
        assert.ok(!ev._prevented, `embed must not preventDefault '${key}' in an input`);
      }
      assert.equal(posted.length, 0);
    } finally {
      if (prev === undefined) delete globalThis.document;
      else globalThis.document = prev;
    }
  });
});
