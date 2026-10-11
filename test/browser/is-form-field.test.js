/**
 * Single GitHub isFormField + bubble-phase keyDownHandler.
 * Fact anchors: edg1 edgdisp
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isFormField,
  keyDownHandler,
  install,
  installPageHotkey,
  installFormFieldHotkeyGuard,
  eventToHotkeyString,
  normalizeHotkey,
  characterKeysEnabled,
  setCharacterKeysEnabled,
  isCharacterKeyEvent,
  FORM_FIELD_GUARD_SRC,
} from "../../src/browser/is-form-field.js";
import { COMMAND_PALETTE_CLIENT_JS } from "../../src/browser/command-palette.js";
import { INTERACTIONS_NAV_JS } from "../../src/render/render-interactions-nav.js";
import { CORE_JS } from "../../src/render/render-core.js";
import { ANALYTICS_PANEL_JS } from "../../src/browser/run-analytics-panel.js";
import { BROWSER_CLIENT_SCRIPT_TAIL } from "../../src/browser/browser-client.js";
import { runPage, liveSessionPage } from "../../src/browser/run-page.js";

function el(tag, extra = {}) {
  const node = {
    nodeName: String(tag).toUpperCase(),
    tagName: String(tag).toUpperCase(),
    id: extra.id || "",
    type: extra.type || "",
    isContentEditable: !!extra.isContentEditable,
    ownerDocument: extra.ownerDocument || null,
    getAttribute(name) {
      if (name === "type") return this.type || "";
      if (name === "id") return this.id || "";
      return extra[name] ?? null;
    },
  };
  return node;
}

function keyEvent(target, key, extra = {}) {
  return {
    target,
    key,
    metaKey: !!extra.metaKey,
    ctrlKey: !!extra.ctrlKey,
    altKey: !!extra.altKey,
    shiftKey: !!extra.shiftKey,
    defaultPrevented: !!extra.defaultPrevented,
    _stopped: false,
    _prevented: false,
    preventDefault() {
      this._prevented = true;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this._stopped = true;
    },
  };
}

function hotkeyEl(hotkey, extra = {}) {
  const clicks = extra.clicks || [];
  const attrs = {
    "data-hotkey": hotkey,
    ...(extra.scope ? { "data-hotkey-scope": extra.scope } : {}),
  };
  const node = {
    nodeName: extra.tag || "BUTTON",
    tagName: extra.tag || "BUTTON",
    id: extra.id || "",
    type: extra.type || "button",
    isContentEditable: !!extra.isContentEditable,
    ownerDocument: extra.ownerDocument || null,
    getAttribute(name) {
      if (name === "type") return this.type || "";
      if (name === "id") return this.id || "";
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    click() {
      clicks.push(this);
      this._clicked = true;
    },
    focus() {
      this._focused = true;
      clicks.push(this);
    },
    dispatchEvent() {
      return true;
    },
  };
  return node;
}

function withDoc(fn) {
  const prev = globalThis.document;
  const htmlAttrs = Object.create(null);
  const fakeDoc = {
    _tqFormGuardInstalled: false,
    documentElement: {
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(htmlAttrs, name) ? htmlAttrs[name] : null;
      },
      setAttribute(name, value) {
        htmlAttrs[name] = String(value);
      },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() {
      return hotkeyEl("");
    },
    body: { appendChild(el) { return el; } },
    addEventListener(type, fn, cap) {
      this._listener = { type, fn, cap };
    },
  };
  globalThis.document = fakeDoc;
  try {
    return fn(fakeDoc);
  } finally {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  }
}

describe("one shared GitHub isFormField", () => {
  test("isFormField matches GitHub @github/hotkey (select, textarea, text-like input, contenteditable; not checkbox/radio/file/submit/reset)", () => {
    assert.equal(isFormField(null), false);
    assert.equal(isFormField(el("button")), false);
    assert.equal(isFormField(el("a")), false);
    assert.equal(isFormField(el("div")), false);
    assert.equal(isFormField(el("input", { type: "checkbox" })), false);
    assert.equal(isFormField(el("input", { type: "radio" })), false);
    assert.equal(isFormField(el("input", { type: "file" })), false);
    assert.equal(isFormField(el("input", { type: "submit" })), false);
    assert.equal(isFormField(el("input", { type: "reset" })), false);

    assert.equal(isFormField(el("textarea")), true);
    assert.equal(isFormField(el("select")), true);
    assert.equal(isFormField(el("input")), true);
    assert.equal(isFormField(el("input", { type: "text" })), true);
    assert.equal(isFormField(el("input", { type: "search" })), true);
    assert.equal(isFormField(el("input", { type: "password" })), true);
    assert.equal(isFormField(el("div", { isContentEditable: true })), true);
  });

  test("isFormField uses instanceof HTMLElement like GitHub @github/hotkey", () => {
    assert.match(FORM_FIELD_GUARD_SRC, /instanceof HTMLElement/);
    const src = readFileSync(new URL("../../src/browser/is-form-field.js", import.meta.url), "utf8");

    class FakeHTMLElement {
      constructor(tag, extra = {}) {
        this.nodeName = String(tag).toUpperCase();
        this.tagName = String(tag).toUpperCase();
        this.type = extra.type || "";
        this.isContentEditable = !!extra.isContentEditable;
      }
      getAttribute(name) {
        if (name === "type") return this.type || "";
        return null;
      }
    }
    const prev = globalThis.HTMLElement;
    globalThis.HTMLElement = FakeHTMLElement;
    try {
      assert.equal(isFormField(new FakeHTMLElement("input", { type: "text" })), true);
      assert.equal(isFormField(new FakeHTMLElement("textarea")), true);
      assert.equal(isFormField(new FakeHTMLElement("select")), true);
      assert.equal(isFormField(new FakeHTMLElement("div", { isContentEditable: true })), true);
      assert.equal(isFormField(new FakeHTMLElement("input", { type: "checkbox" })), false);
      assert.equal(isFormField(new FakeHTMLElement("button")), false);
      const duck = el("input", { type: "text" });
      assert.equal(isFormField(duck), false, "duck-typed input is not an HTMLElement");
      assert.equal(isFormField({ nodeName: "INPUT", nodeType: 3 }), false, "Text-like Node is not an HTMLElement");
      assert.equal(isFormField(null), false);
    } finally {
      if (prev === undefined) delete globalThis.HTMLElement;
      else globalThis.HTMLElement = prev;
    }
  });

  test("GitHub-style bubble-phase keyDownHandler returns if isFormField(event.target) without stopPropagation so the event still reaches the field", () => {
    withDoc((fakeDoc) => {
      const clicks = [];
      const btn = hotkeyEl("/,o,j,k,g", { clicks, ownerDocument: fakeDoc });
      install(btn);

      const input = el("input", { type: "text", id: "liveTailInput", ownerDocument: fakeDoc });
      for (const key of "/ojkg?x") {
        const ev = keyEvent(input, key);
        keyDownHandler(ev);
        assert.equal(ev._stopped, false, `printable '${key}' in an input must not stopPropagation`);
        assert.equal(ev._prevented, false, `printable '${key}' must not preventDefault`);
      }
      assert.equal(clicks.length, 0, "unscoped hotkeys must not fire while a form field is focused");

      const slash = keyEvent(el("body"), "/");
      keyDownHandler(slash);
      assert.equal(slash._stopped, false, "idle / must not be stopped");
      assert.equal(slash._prevented, true, "GitHub preventDefault on leaf fire");
      assert.equal(clicks.length, 1, "idle / fires the data-hotkey element");

      const checkbox = keyEvent(el("input", { type: "checkbox" }), "j");
      keyDownHandler(checkbox);
      assert.equal(checkbox._stopped, false, "checkbox is not a text form field");
      assert.equal(checkbox._prevented, true, "leaf fire preventDefault on checkbox too");
      assert.equal(clicks.length, 2);

      const cmdK = keyEvent(input, "k", { metaKey: true });
      keyDownHandler(cmdK);
      assert.equal(cmdK._stopped, false, "modifier chords are not character shortcuts");

      const escape = keyEvent(input, "Escape");
      keyDownHandler(escape);
      assert.equal(escape._stopped, false, "Escape is not stopped; dispatcher returns");

      fakeDoc._tqFormGuardInstalled = false;
      installFormFieldHotkeyGuard();
      assert.equal(fakeDoc._listener.type, "keydown");
      assert.equal(fakeDoc._listener.fn, keyDownHandler);
      assert.equal(fakeDoc._listener.cap, undefined, "GitHub installs keyDownHandler on bubble, not capture");
    });
  });

  test("unscoped printable page shortcuts do not fire while an overlay is on the shared overlay stack", () => {
    assert.match(FORM_FIELD_GUARD_SRC, /__tqOverlayStack/);
    const prevStack = globalThis.__tqOverlayStack;
    try {
      withDoc((fakeDoc) => {
        const clicks = [];
        install(hotkeyEl("/,g", { clicks, ownerDocument: fakeDoc }));
        globalThis.__tqOverlayStack = [{ id: "launchOverlay" }];
        const slash = keyEvent(el("body"), "/");
        keyDownHandler(slash);
        assert.equal(slash._stopped, false, "overlay-busy / must not stopPropagation");
        assert.equal(slash._prevented, false, "overlay-busy / must not preventDefault");
        const g = keyEvent(el("button"), "g");
        keyDownHandler(g);
        assert.equal(clicks.length, 0, "unscoped hotkeys must not fire while an overlay owns the keyboard");

        globalThis.__tqOverlayStack = [];
        const idle = keyEvent(el("body"), "/");
        keyDownHandler(idle);
        assert.equal(clicks.length, 1, "idle / fires again after the overlay stack is empty");
        assert.equal(idle._prevented, true, "GitHub preventDefault on leaf fire");
      });
    } finally {
      if (prevStack === undefined) delete globalThis.__tqOverlayStack;
      else globalThis.__tqOverlayStack = prevStack;
    }
  });

  test("while an overlay owns the keyboard, keyDownHandler fires only data-hotkey leaves whose element is inside the top overlay", () => {
    assert.match(FORM_FIELD_GUARD_SRC, /nodeInsideOverlay/);
    const prevStack = globalThis.__tqOverlayStack;
    try {
      withDoc((fakeDoc) => {
        const pageClicks = [];
        const flyClicks = [];
        const pageBtn = hotkeyEl("j,/", { id: "tqHotkeyPeekNext", clicks: pageClicks, ownerDocument: fakeDoc });
        const flyout = {
          id: "sessionFlyout",
          hidden: false,
          nodeType: 1,
          contains(node) {
            return node === this || node === flyBtn;
          },
        };
        const flyBtn = hotkeyEl("j", { id: "sessionFlyoutNext", clicks: flyClicks, ownerDocument: fakeDoc });
        flyBtn.parentNode = flyout;
        flyBtn.parentElement = flyout;
        pageBtn.parentNode = fakeDoc.body;
        pageBtn.parentElement = fakeDoc.body;
        install(pageBtn);
        install(flyBtn);

        globalThis.__tqOverlayStack = [flyout];
        const overlayJ = keyEvent(el("body"), "j");
        keyDownHandler(overlayJ);
        assert.equal(flyClicks.length, 1, "flyout Next data-hotkey leaf fires j while the flyout is top overlay");
        assert.equal(pageClicks.length, 0, "body peek j/k leaf must not fire while an overlay owns the keyboard");
        assert.equal(overlayJ._prevented, true, "GitHub preventDefault on overlay-local leaf fire");

        const overlaySlash = keyEvent(el("body"), "/");
        keyDownHandler(overlaySlash);
        assert.equal(pageClicks.length, 0, "unscoped / must not fire while the flyout owns the keyboard");
        assert.equal(overlaySlash._prevented, false);

        const field = el("input", { type: "text", id: "flyoutProbe" });
        field.parentNode = flyout;
        const fieldJ = keyEvent(field, "j");
        keyDownHandler(fieldJ);
        assert.equal(flyClicks.length, 1, "focused form field still blocks overlay-local j");
        assert.equal(fieldJ._prevented, false, "j in a flyout input is not preventDefaulted");

        globalThis.__tqOverlayStack = [];
        flyout.hidden = true;
        const idleJ = keyEvent(el("body"), "j");
        keyDownHandler(idleJ);
        assert.equal(pageClicks.length, 1, "idle j fires the body list/peek leaf after the overlay stack is empty");
        assert.equal(flyClicks.length, 1, "closed/hidden flyout Next must not steal idle j");
        assert.equal(idleJ._prevented, true);
      });
    } finally {
      if (prevStack === undefined) delete globalThis.__tqOverlayStack;
      else globalThis.__tqOverlayStack = prevStack;
    }
  });

  test("every document-level printable shortcut bundle injects the one GitHub-style bubble-phase keyDownHandler", () => {
    const bundles = {
      palette: COMMAND_PALETTE_CLIENT_JS,
      nav: INTERACTIONS_NAV_JS,
      core: CORE_JS,
      analytics: ANALYTICS_PANEL_JS,
      sessions: BROWSER_CLIENT_SCRIPT_TAIL,
      run: runPage({ run: { id: "@1", agent: "claude", cwd: "/tmp", startedAt: "2026-01-01T00:00:00.000Z", status: "running" } }),
      live: liveSessionPage({ session: { hash: "deadbeef", path: "/tmp/x.jsonl", source: "claude", live: true } }),
    };
    for (const [name, src] of Object.entries(bundles)) {
    }
    assert.doesNotMatch(FORM_FIELD_GUARD_SRC, /stopPropagation/);

    const clientFile = readFileSync(new URL("../../src/browser/browser-client.js", import.meta.url), "utf8");
    const paletteFile = readFileSync(new URL("../../src/browser/command-palette.js", import.meta.url), "utf8");
    const navFile = readFileSync(new URL("../../src/render/render-interactions-nav.js", import.meta.url), "utf8");
    const coreFile = readFileSync(new URL("../../src/render/render-core.js", import.meta.url), "utf8");
    const runFile = readFileSync(new URL("../../src/browser/run-page.js", import.meta.url), "utf8");
    const analyticsFile = readFileSync(new URL("../../src/browser/run-analytics-panel.js", import.meta.url), "utf8");
    for (const [name, src] of Object.entries({ clientFile, paletteFile, navFile, coreFile, runFile, analyticsFile })) {
      assert.match(src, /FORM_FIELD_GUARD_SRC/, `${name} injects the shared guard, not a local copy`);
    }
    assert.match(paletteFile, /installPageHotkey\("tqHotkeyGoC"/);
    assert.doesNotMatch(FORM_FIELD_GUARD_SRC, /_tqPageHotkeys/);
    assert.equal(typeof installFormFieldHotkeyGuard, "function");
    assert.equal(typeof keyDownHandler, "function");
    assert.equal(typeof install, "function");
    assert.equal(typeof installPageHotkey, "function");
  });

  test("unscoped / o j k g fire from the one GitHub-style keyDownHandler via data-hotkey elements in the radix trie", () => {
    const clientFile = readFileSync(new URL("../../src/browser/browser-client.js", import.meta.url), "utf8");
    const paletteFile = readFileSync(new URL("../../src/browser/command-palette.js", import.meta.url), "utf8");
    const navFile = readFileSync(new URL("../../src/render/render-interactions-nav.js", import.meta.url), "utf8");
    const coreFile = readFileSync(new URL("../../src/render/render-core.js", import.meta.url), "utf8");
    const runFile = readFileSync(new URL("../../src/browser/run-page.js", import.meta.url), "utf8");

    assert.match(paletteFile, /data-hotkey="s,\/"/);
    assert.match(paletteFile, /installPageHotkey\("tqHotkeyGoC"/);
    assert.match(paletteFile, /installSlashSearchHotkey/);
    assert.match(clientFile, /installPageHotkey\('tqHotkeyPeekNext'/);
    assert.match(navFile, /installPageHotkey\('tqHotkeyChapterNext'/);
    assert.match(navFile, /installPageHotkey\('tqHotkeyChapterOpen'/);
    assert.match(coreFile, /installPageHotkey\('tqHotkeyEmbedNext'/);

    assert.doesNotMatch(paletteFile, /function registerPageHotkey/);
    assert.doesNotMatch(paletteFile, /document\.addEventListener\("keydown", onGoChordKey/);
    assert.doesNotMatch(paletteFile, /document\.addEventListener\("keydown", onSlashSearchKey/);
    assert.doesNotMatch(clientFile, /document\.addEventListener\('keydown', onPeekStepKey/);
    assert.doesNotMatch(navFile, /document\.addEventListener\('keydown', onChapterCharKey/);
    assert.doesNotMatch(coreFile, /document\.addEventListener\('keydown', onEmbedPeekKey/);
    assert.doesNotMatch(clientFile, /function onSessionsSlashKey/);
    assert.doesNotMatch(runFile, /function onRailSlashKey/);
    assert.doesNotMatch(clientFile, /_tqPageHotkeys/);
    assert.doesNotMatch(paletteFile, /_tqPageHotkeys/);

    assert.doesNotMatch(
      clientFile,
      /document\.addEventListener\('keydown', function\(e\) \{\s*if \(document\.body\.classList\.contains\('cmdk-open'\)\) return;\s*if \(e\.key === '\/'/,
    );
    assert.doesNotMatch(
      runFile,
      /document\.addEventListener\("keydown", function \(e\) \{\s*if \(document\.body\.classList\.contains\("cmdk-open"\)\) return;\s*if \(e\.key !== "\/"/,
    );
    assert.doesNotMatch(
      navFile,
      /if \(isInSearch \|\| editing\) return;\s*\/\/ Slash-to-search/,
    );

    withDoc((fakeDoc) => {
      const clicks = [];
      install(hotkeyEl("/,o,j,k,g", { clicks, ownerDocument: fakeDoc }));
      const field = el("input", { type: "text", id: "liveTailInput", ownerDocument: fakeDoc });
      for (const key of "/ojkg") {
        const ev = keyEvent(field, key);
        keyDownHandler(ev);
        assert.equal(ev._stopped, false, `form-field '${key}' must not stopPropagation`);
        assert.equal(ev._prevented, false, `form-field '${key}' must not preventDefault`);
      }
      assert.equal(clicks.length, 0, "registered / o j k g must not run while a form field is focused");

      const body = el("body");
      const idle = [];
      for (const key of ["/", "o", "j", "k", "g"]) {
        const ev = keyEvent(body, key);
        keyDownHandler(ev);
        idle.push(key);
        assert.equal(ev._prevented, true, `idle '${key}' preventDefault on leaf fire`);
      }
      assert.deepEqual(idle, ["/", "o", "j", "k", "g"]);
      assert.equal(clicks.length, 5, "idle / o j k g fire from the one keyDownHandler");
    });
  });

  test("keyDownHandler walks the radix trie and on Leaf fire calls fireDeterminedAction then event.preventDefault", () => {
    assert.doesNotMatch(FORM_FIELD_GUARD_SRC, /_tqPageHotkeys/);
    withDoc((fakeDoc) => {
      const clicks = [];
      const go = hotkeyEl("g c", { clicks, ownerDocument: fakeDoc });
      install(go);
      const body = el("body");
      const g = keyEvent(body, "g");
      keyDownHandler(g);
      assert.equal(g._prevented, false, "first key of a chord is not a leaf");
      assert.equal(clicks.length, 0);
      const c = keyEvent(body, "c");
      keyDownHandler(c);
      assert.equal(c._prevented, true, "leaf fire preventDefault");
      assert.equal(clicks.length, 1, "leaf fire clicks the data-hotkey element");
    });
  });

  test("GitHub data-hotkey s,/ aliases fire the same search element from the radix trie", () => {
    const paletteFile = readFileSync(new URL("../../src/browser/command-palette.js", import.meta.url), "utf8");
    assert.match(paletteFile, /data-hotkey="s,\/"/);
    assert.match(paletteFile, /setAttribute\("data-hotkey", "s,\/"\)/);
    withDoc((fakeDoc) => {
      const clicks = [];
      const bar = hotkeyEl("s,/", { clicks, tag: "INPUT", id: "workspaceSearch", ownerDocument: fakeDoc });
      bar.type = "search";
      install(bar);
      const body = el("body");
      for (const key of ["s", "/"]) {
        clicks.length = 0;
        const ev = keyEvent(body, key);
        keyDownHandler(ev);
        assert.equal(ev._prevented, true, `idle '${key}' preventDefault on leaf fire`);
        assert.equal(clicks.length, 1, `idle '${key}' fires the same data-hotkey element`);
        assert.equal(clicks[0], bar);
        assert.equal(bar._focused, true, `idle '${key}' focuses the search field`);
      }
      const field = el("input", { type: "text", id: "cmdkInput", ownerDocument: fakeDoc });
      clicks.length = 0;
      const typed = keyEvent(field, "s");
      keyDownHandler(typed);
      assert.equal(typed._prevented, false, "form-field s must not preventDefault");
      assert.equal(clicks.length, 0, "s does not steal while a form field is focused");
    });
  });

  test("the radix trie of data-hotkey HTMLElements is the hotkey table, not a JS callback list", () => {
    assert.match(FORM_FIELD_GUARD_SRC, /doc\._tqHotkey/);
    assert.match(FORM_FIELD_GUARD_SRC, /rt\.trie\.insert/);
    assert.doesNotMatch(FORM_FIELD_GUARD_SRC, /_tqPageHotkeys/);
    const paletteFile = readFileSync(new URL("../../src/browser/command-palette.js", import.meta.url), "utf8");
    assert.match(paletteFile, /data-hotkey="s,\/"/);
    assert.match(paletteFile, /data-hotkey="g c"/);
    assert.doesNotMatch(paletteFile, /g c,G c,g C,G C/);
  });

  test("GitHub leaf filter: unscoped / o j k g do not fire while a form field is focused even if a data-hotkey-scope node exists", () => {
    assert.match(
      FORM_FIELD_GUARD_SRC,
      /\(!formField && !scope\) \|\| \(formField && fireTarget\.id === scope\)/,
      "trie leaf uses GitHub's leaf filter",
    );
    const scopeNode = {
      getAttribute(name) {
        return name === "data-hotkey-scope" ? "liveTailInput" : null;
      },
    };
    withDoc((fakeDoc) => {
      fakeDoc.querySelector = function querySelector(sel) {
        if (sel === '[data-hotkey-scope="liveTailInput"]') return scopeNode;
        return null;
      };
      const unscopedClicks = [];
      const scopedClicks = [];
      install(hotkeyEl("/,o,j,k,g", { clicks: unscopedClicks, ownerDocument: fakeDoc }));
      install(hotkeyEl("/,o,j,k,g", { clicks: scopedClicks, scope: "liveTailInput", ownerDocument: fakeDoc }));

      const field = el("input", { type: "text", id: "liveTailInput", ownerDocument: fakeDoc });
      for (const key of "/ojkg") {
        const ev = keyEvent(field, key);
        keyDownHandler(ev);
        assert.equal(ev._stopped, false, `form-field '${key}' must not stopPropagation when a scoped node exists`);
        assert.equal(ev._prevented, true, "GitHub preventDefault on scoped leaf fire");
      }
      assert.equal(unscopedClicks.length, 0, "unscoped / o j k g must not fire just because a data-hotkey-scope node exists");
      assert.equal(scopedClicks.length, 5, "leaf matching target.id === scope still fires");

      const other = el("input", { type: "text", id: "workspaceSearch", ownerDocument: fakeDoc });
      const otherEv = keyEvent(other, "/");
      keyDownHandler(otherEv);
      assert.equal(unscopedClicks.length, 0, "unscoped / must not fire in a different form field");
      assert.equal(scopedClicks.length, 5, "scoped leaf does not fire for a different field id");
      assert.equal(otherEv._prevented, false);

      const body = el("body");
      for (const key of ["/", "o", "j", "k", "g"]) {
        keyDownHandler(keyEvent(body, key));
      }
      assert.equal(unscopedClicks.length, 5, "idle unscoped / o j k g still fire");
      assert.equal(scopedClicks.length, 5, "scoped leaf does not fire when the page is idle");
    });
  });

  test("normalizeHotkey localizes Mod and sorts modifiers like GitHub hotkey.ts", () => {
    assert.equal(normalizeHotkey("a"), "a");
    assert.equal(normalizeHotkey("Control+a"), "Control+a");
    assert.equal(normalizeHotkey("Meta+a"), "Meta+a");
    assert.equal(normalizeHotkey("Control+Meta+a"), "Control+Meta+a");
    assert.equal(normalizeHotkey("Mod+a", "win / linux"), "Control+a");
    assert.equal(normalizeHotkey("Mod+a", "mac"), "Meta+a");
    assert.equal(normalizeHotkey("Mod+a", "iPod"), "Meta+a");
    assert.equal(normalizeHotkey("Mod+a", "iPhone"), "Meta+a");
    assert.equal(normalizeHotkey("Mod+a", "iPad"), "Meta+a");
    assert.equal(normalizeHotkey("Mod+A", "win / linux"), "Control+A");
    assert.equal(normalizeHotkey("Mod+A", "mac"), "Meta+A");
    assert.equal(normalizeHotkey("Mod+Alt+a", "win / linux"), "Control+Alt+a");
    assert.equal(normalizeHotkey("Mod+Alt+a", "mac"), "Alt+Meta+a");
    assert.equal(normalizeHotkey("Mod+a", undefined), "Control+a");
    assert.equal(normalizeHotkey("Shift+Alt+Meta+Control+m"), "Control+Alt+Meta+Shift+m");
    assert.equal(normalizeHotkey("Shift+Alt+Mod+m", "win"), "Control+Alt+Shift+m");
    assert.equal(normalizeHotkey("Alt", "win / linux"), "Alt");
    assert.equal(normalizeHotkey("Alt+Mod", "win / linux"), "Control+Alt");
  });

  test("eventToHotkeyString applies GitHub macOS Alt-symbol and Command+Shift layers", () => {
    const cases = [
      ["Control+Shift+J", { ctrlKey: true, shiftKey: true, key: "J" }],
      ["Control+Shift+j", { ctrlKey: true, shiftKey: true, key: "j" }],
      ["Control+j", { ctrlKey: true, key: "j" }],
      ["Meta+Shift+p", { key: "p", metaKey: true, shiftKey: true }],
      ["Shift+J", { shiftKey: true, key: "J" }],
      ["/", { key: "/" }],
      ["c", { key: "c" }],
      ["Shift+S", { key: "S", shiftKey: true }],
      ["Shift+!", { key: "!", shiftKey: true }],
      ["Control+Shift", { ctrlKey: true, shiftKey: true, key: "Shift" }],
      ["Alt+s", { altKey: true, key: "s" }],
      ["Control+Space", { ctrlKey: true, key: " " }],
      ["Shift+Plus", { shiftKey: true, key: "+" }],
      ["Control+Shift+X", { ctrlKey: true, shiftKey: true, key: "X" }],
      ["Control+Shift+!", { ctrlKey: true, shiftKey: true, key: "!" }],
    ];
    for (const [expected, props] of cases) {
      assert.equal(
        eventToHotkeyString(keyEvent(el("body"), props.key, props), "win / linux"),
        expected,
        JSON.stringify(props),
      );
    }
    const mac = [
      ["Alt+s", { altKey: true, key: "ß" }],
      ["Alt+Shift+S", { altKey: true, shiftKey: true, key: "Í" }],
      ["Alt+ArrowLeft", { altKey: true, key: "ArrowLeft" }],
      ["Meta+Shift+X", { metaKey: true, shiftKey: true, key: "x" }],
      ["Meta+Shift+!", { metaKey: true, shiftKey: true, key: "1" }],
    ];
    for (const [expected, props] of mac) {
      assert.equal(
        eventToHotkeyString(keyEvent(el("body"), props.key, props), "mac"),
        expected,
        `mac ${JSON.stringify(props)}`,
      );
    }
    assert.match(FORM_FIELD_GUARD_SRC, /macosSymbolLayerKeys/);
    assert.match(FORM_FIELD_GUARD_SRC, /macosUppercaseLayerKeys/);
    assert.match(FORM_FIELD_GUARD_SRC, /syntheticKeyNames/);
  });

  test("G-then-letter jumps are declared as GitHub sequences g c without four-way case aliases", () => {
    const paletteFile = readFileSync(new URL("../../src/browser/command-palette.js", import.meta.url), "utf8");
    assert.match(paletteFile, /data-hotkey="g c"/);
    assert.match(paletteFile, /data-hotkey="g r"/);
    assert.match(paletteFile, /data-hotkey="g d"/);
    assert.match(paletteFile, /data-hotkey="g v"/);
    assert.match(paletteFile, /data-hotkey="g n"/);
    assert.match(paletteFile, /installPageHotkey\("tqHotkeyGoC", "g c",/);
    assert.match(paletteFile, /installPageHotkey\("tqHotkeyGoR", "g r",/);
    assert.doesNotMatch(paletteFile, /g c,G c,g C,G C/);
    assert.doesNotMatch(paletteFile, /g r,G r,g R,G R/);
    assert.doesNotMatch(paletteFile, /g d,G d,g D,G D/);
    assert.doesNotMatch(paletteFile, /g v,G v,g V,G V/);
    assert.doesNotMatch(paletteFile, /g n,G n,g N,G N/);
    withDoc((fakeDoc) => {
      const clicks = [];
      install(hotkeyEl("g c", { clicks, ownerDocument: fakeDoc }));
      const body = el("body");
      keyDownHandler(keyEvent(body, "g"));
      keyDownHandler(keyEvent(body, "c"));
      assert.equal(clicks.length, 1, "GitHub sequence g c fires on g then c without case aliases");
      keyDownHandler(keyEvent(body, "g"));
      keyDownHandler(keyEvent(body, "C"));
      assert.equal(clicks.length, 1, "uppercase C is a different GitHub key than c");
    });
  });

  test("Shift+G then c jumps as G then C as written via encoder Shift+Letter sequence aliases", () => {
    withDoc((fakeDoc) => {
      const clicks = [];
      install(hotkeyEl("g c", { clicks, ownerDocument: fakeDoc }));
      const body = el("body");
      keyDownHandler(keyEvent(body, "G", { shiftKey: true }));
      keyDownHandler(keyEvent(body, "c"));
      assert.equal(clicks.length, 1, "Shift+G then c fires g c (G then C as written)");
      keyDownHandler(keyEvent(body, "g"));
      keyDownHandler(keyEvent(body, "C", { shiftKey: true }));
      assert.equal(clicks.length, 2, "g then Shift+C also completes the documented chord");
      keyDownHandler(keyEvent(body, "G", { shiftKey: true }));
      keyDownHandler(keyEvent(body, "C", { shiftKey: true }));
      assert.equal(clicks.length, 3, "Shift+G then Shift+C completes G then C as written");
      keyDownHandler(keyEvent(body, "s"));
      assert.equal(clicks.length, 3, "single-key s is not given a Shift+S sequence alias");
    });
  });

  test("keyDownHandler sequenceReset on form-field return so idle g does not complete g c after typing and blur", () => {
    assert.match(
      FORM_FIELD_GUARD_SRC,
      /if \(isFormField\(event\.target\)\) \{[\s\S]*?sequenceReset\(\);\s*return;/,
      "unscoped form-field return must sequenceReset so an armed g cannot complete after typing",
    );
    withDoc((fakeDoc) => {
      const clicks = [];
      install(hotkeyEl("g c", { clicks, ownerDocument: fakeDoc }));
      const body = el("body");
      const input = el("input", { type: "text", id: "liveTailInput", ownerDocument: fakeDoc });

      keyDownHandler(keyEvent(body, "g"));
      assert.equal(clicks.length, 0, "idle g arms the sequence and is not a leaf");

      for (const key of "hello") {
        const ev = keyEvent(input, key);
        keyDownHandler(ev);
        assert.equal(ev._stopped, false, `form-field '${key}' must not stopPropagation`);
        assert.equal(ev._prevented, false, `form-field '${key}' must not preventDefault`);
      }
      assert.equal(clicks.length, 0, "typing in #liveTailInput must not fire g c");

      const afterBlur = keyEvent(body, "c");
      keyDownHandler(afterBlur);
      assert.equal(clicks.length, 0, "after blur, c must not complete a g armed before typing");
      assert.equal(afterBlur._prevented, false, "orphan c after form-field reset is not a leaf");

      keyDownHandler(keyEvent(body, "g"));
      const idleC = keyEvent(body, "c");
      keyDownHandler(idleC);
      assert.equal(clicks.length, 1, "idle g then c still fires when no field is focused");
      assert.equal(idleC._prevented, true, "idle g then c preventDefault on leaf fire");
    });
  });

  test("when Character keys is deselected, unmodified s / and g c do not fire; modifier chords still walk the trie", () => {
    assert.equal(isCharacterKeyEvent(keyEvent(el("button"), "s")), true);
    assert.equal(isCharacterKeyEvent(keyEvent(el("button"), "/", { metaKey: true })), false);
    assert.equal(isCharacterKeyEvent(keyEvent(el("button"), "k", { metaKey: true })), false);
    assert.equal(isCharacterKeyEvent(keyEvent(el("button"), "Escape")), false);
    withDoc((fakeDoc) => {
      const clicks = [];
      const search = hotkeyEl("s,/", { clicks, tag: "INPUT", id: "workspaceSearch", ownerDocument: fakeDoc });
      search.type = "search";
      install(search);
      const go = hotkeyEl("g c", { clicks, ownerDocument: fakeDoc });
      install(go);
      const btn = el("button", { id: "newRunBtn" });
      setCharacterKeysEnabled(false);
      assert.equal(characterKeysEnabled(), false);
      assert.equal(fakeDoc.documentElement.getAttribute("data-tq-character-keys"), "off");

      const s = keyEvent(btn, "s");
      keyDownHandler(s);
      assert.equal(s._prevented, false, "s must not preventDefault when Character keys is off");
      assert.equal(clicks.length, 0, "s must not fire search");

      const slash = keyEvent(btn, "/");
      keyDownHandler(slash);
      assert.equal(slash._prevented, false);
      assert.equal(clicks.length, 0, "/ must not fire search");

      keyDownHandler(keyEvent(btn, "g"));
      const c = keyEvent(btn, "c");
      keyDownHandler(c);
      assert.equal(c._prevented, false);
      assert.equal(clicks.length, 0, "g then c must not navigate when Character keys is off");

      const cmdK = keyEvent(btn, "k", { metaKey: true });
      keyDownHandler(cmdK);
      assert.equal(cmdK._stopped, false, "Cmd+K is not a character-key shortcut");

      setCharacterKeysEnabled(true);
      const idleS = keyEvent(btn, "s");
      keyDownHandler(idleS);
      assert.equal(idleS._prevented, true, "turning Character keys back on restores s");
      assert.equal(clicks.length, 1);
    });
  });

  test("when Character keys is selected (the default), idle s and / still fire and idle g then c still jumps", () => {
    withDoc((fakeDoc) => {
      assert.equal(characterKeysEnabled(), true, "Character keys default on");
      const clicks = [];
      const search = hotkeyEl("s,/", { clicks, tag: "INPUT", id: "workspaceSearch", ownerDocument: fakeDoc });
      search.type = "search";
      install(search);
      const go = hotkeyEl("g c", { clicks, ownerDocument: fakeDoc });
      install(go);
      const body = el("body");
      const s = keyEvent(body, "s");
      keyDownHandler(s);
      assert.equal(s._prevented, true);
      const slash = keyEvent(body, "/");
      keyDownHandler(slash);
      assert.equal(slash._prevented, true);
      assert.equal(clicks.length, 2, "default idle s and / fire search");
      keyDownHandler(keyEvent(body, "g"));
      const c = keyEvent(body, "c");
      keyDownHandler(c);
      assert.equal(c._prevented, true);
      assert.equal(clicks.length, 3, "default idle g then c still jumps");
    });
  });
});
