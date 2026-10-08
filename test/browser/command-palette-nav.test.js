/**
 * Command palette page jumps — Go to Chat / Runs / Compare / view / launch,
 * g/go/goto prefixes, G-then chords, contextual this-run / this-chat.
 * Fact anchors: cpgo cpgf cpgp cpgn cpgk cpgt cpgc.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_PALETTE_CLIENT_JS,
  parsePaletteQuery,
  isPageJumpQuery,
  compareHrefFromParts,
  compareHref,
  viewHref,
  thisRunHref,
  thisChatHref,
  rememberPaletteDestinations,
  lastCompareHref,
  pageNavItems,
  PALETTE_LAST_VIEW_KEY,
  PALETTE_LAST_COMPARE_KEY,
  PALETTE_LAST_CHAT_KEY,
  writePaletteStore,
  readPaletteStore,
} from "../../src/browser/command-palette.js";

function mockSessionStorage() {
  const store = Object.create(null);
  globalThis.sessionStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
  };
  return store;
}

describe("command palette page destinations", () => {
  test("an empty query lists a Go to group of app pages: Chat, Runs, Compare, rendered session, New run", () => {
    mockSessionStorage();
    const items = pageNavItems({});
    const dests = items.map((it) => it.dest);
    assert.ok(dests.includes("chat"));
    assert.ok(dests.includes("runs"));
    assert.ok(dests.includes("compare"));
    assert.ok(dests.includes("view"));
    assert.ok(dests.includes("launch"));
    const byDest = Object.fromEntries(items.map((it) => [it.dest, it]));
    assert.equal(byDest.chat.href, "/");
    assert.equal(byDest.runs.href, "/sessions");
    assert.equal(byDest.compare.href, "/compare");
    assert.equal(byDest.view.href, "/view");
    assert.equal(byDest.launch.href, "/?launch=1");
    assert.equal(byDest.chat.title, "Go to Chat");
    assert.equal(byDest.runs.title, "Go to Runs");
    assert.equal(byDest.compare.title, "Go to Compare");
    assert.equal(byDest.view.title, "Go to rendered session");
    assert.equal(byDest.launch.title, "New run");
    for (const it of items.filter((x) => ["chat", "runs", "compare", "view", "launch"].includes(x.dest))) {
      assert.equal(it.kind, "nav");
      assert.equal(it.group, "Go to");
    }

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /function pageNavItems/);
    assert.match(js, /group: "Go to"/);
    assert.match(js, /title: "Go to Chat"/);
    assert.match(js, /title: "Go to Runs"/);
    assert.match(js, /title: "Go to Compare"/);
    assert.match(js, /title: "Go to rendered session"/);
    assert.match(js, /title: "New run"/);
    assert.match(js, /href: "\/"/);
    assert.match(js, /href: "\/sessions"/);
    assert.match(js, /href: "\/\?launch=1"/);
    assert.match(js, /data-dest/);
    assert.match(js, /data-href/);
    assert.match(js, /kind !== "nav"/);
  });

  test("typing a page name (chat, runs, compare, view, launch) filters to that Go to destination", () => {
    mockSessionStorage();
    const items = pageNavItems({});
    function matches(item, q) {
      const hay = [item.title, item.subtitle, item.group].concat(item.keywords || []).join(" ").toLowerCase();
      return q.toLowerCase().split(/\s+/).filter(Boolean).every((part) => hay.includes(part));
    }
    const cases = [
      ["chat", "chat"],
      ["runs", "runs"],
      ["compare", "compare"],
      ["view", "view"],
      ["launch", "launch"],
      ["new run", "launch"],
      ["rendered", "view"],
      ["sessions", "runs"],
    ];
    for (const [query, dest] of cases) {
      const hit = items.filter((it) => matches(it, query));
      assert.ok(hit.some((it) => it.dest === dest), `${query} should match ${dest}, got ${hit.map((h) => h.dest).join(",")}`);
    }
    assert.equal(isPageJumpQuery("compare"), true);
    assert.equal(isPageJumpQuery("go runs"), true);
    assert.equal(isPageJumpQuery("setti"), false);
    assert.equal(isPageJumpQuery("a13f9c82"), false);
    assert.equal(isPageJumpQuery("document backend login"), false);

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /function isPageJumpQuery/);
    assert.match(js, /groupPriority: Math\.max\(it\.groupPriority \|\| 0, 95\)/);
    assert.match(js, /kind === "nav"/);
  });

  test("a g/go/goto prefix focuses Go to page destinations", () => {
    assert.equal(parsePaletteQuery("g compare").prefix, "goto");
    assert.equal(parsePaletteQuery("g compare").q, "compare");
    assert.equal(parsePaletteQuery("go runs").prefix, "goto");
    assert.equal(parsePaletteQuery("go runs").q, "runs");
    assert.equal(parsePaletteQuery("goto  view").prefix, "goto");
    assert.equal(parsePaletteQuery("goto  view").q, "view");
    assert.equal(parsePaletteQuery("g ").prefix, "goto");
    assert.equal(parsePaletteQuery("g ").q, "");
    assert.equal(parsePaletteQuery("go").prefix, "");
    assert.equal(parsePaletteQuery("s backend").prefix, "session");
    assert.equal(isPageJumpQuery("g "), true);
    assert.equal(isPageJumpQuery("go chat"), true);

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /prefix === "goto"/);
    assert.match(js, /kind !== "nav"/);
    assert.match(js, /\^\(g\|go\|goto\)\\s\+/);
  });

  test("activating a CommandPalette Go to item navigates to that surface", () => {
    mockSessionStorage();
    const items = pageNavItems({
      a: "aaa11111",
      b: "bbb22222",
      viewId: "c0ffee00",
    });
    const byDest = Object.fromEntries(items.map((it) => [it.dest, it]));
    assert.equal(byDest.chat.href, "/");
    assert.equal(byDest.runs.href, "/sessions");
    assert.equal(byDest.compare.href, "/compare?a=aaa11111&b=bbb22222");
    assert.equal(byDest.view.href, "/view?id=c0ffee00");
    assert.equal(byDest.launch.href, "/?launch=1");
    assert.equal(byDest.launch.actionName, "launch");

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /actionName === "launch"/);
    assert.match(js, /openLauncherFromPalette/);
    assert.match(js, /location\.href = "\/\?launch=1"/);
    assert.match(js, /location\.href = item\.href/);
    assert.match(js, /function compareHref/);
    assert.match(js, /function viewHref/);
  });

  test("Go to items show G-then-letter shortcut glyphs, and G then C/R/D/V/N jumps when the palette is closed", () => {
    mockSessionStorage();
    const items = pageNavItems({});
    const byDest = Object.fromEntries(items.map((it) => [it.dest, it]));
    assert.deepEqual(byDest.chat.shortcut, ["G", "then", "C"]);
    assert.deepEqual(byDest.runs.shortcut, ["G", "then", "R"]);
    assert.deepEqual(byDest.compare.shortcut, ["G", "then", "D"]);
    assert.deepEqual(byDest.view.shortcut, ["G", "then", "V"]);
    assert.deepEqual(byDest.launch.shortcut, ["G", "then", "N"]);

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /function consumeGoChord/);
    assert.match(js, /function bindGoChordHotkeys/);
    assert.match(js, /k === "c"/);
    assert.match(js, /k === "r"/);
    assert.match(js, /k === "d"/);
    assert.match(js, /k === "v"/);
    assert.match(js, /k === "n"/);
    assert.match(js, /location\.href = "\/"/);
    assert.match(js, /location\.href = "\/sessions"/);
    assert.match(js, /openLauncherFromPalette\(\); return true/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoC", "g c",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoR", "g r",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoD", "g d",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoV", "g v",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoN", "g n",/);
    assert.doesNotMatch(js, /g c,G c,g C,G C/);
  });

  test("G-then-letter jumps are declared as GitHub sequences g c without four-way case aliases", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /installPageHotkey\("tqHotkeyGoC", "g c",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoR", "g r",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoD", "g d",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoV", "g v",/);
    assert.match(js, /installPageHotkey\("tqHotkeyGoN", "g n",/);
    assert.doesNotMatch(js, /g c,G c,g C,G C/);
    assert.doesNotMatch(js, /g r,G r,g R,G R/);
  });

  test("when a run or session is in context, the palette offers Go to this run or Go to this chat", () => {
    mockSessionStorage();
    const runItems = pageNavItems({ page: "run", runId: "@4" });
    const thisRun = runItems.find((it) => it.dest === "this-run");
    assert.ok(thisRun, "this-run present on a run page");
    assert.equal(thisRun.title, "Go to this run");
    assert.equal(thisRun.href, "/run?id=%404");
    assert.equal(thisRunHref({ runId: "@4" }), "/run?id=%404");

    const sessionItems = pageNavItems({ page: "session", session: "abcd1234" });
    const thisChat = sessionItems.find((it) => it.dest === "this-chat");
    assert.ok(thisChat, "this-chat present on a live session");
    assert.equal(thisChat.title, "Go to this chat");
    assert.equal(thisChat.href, "/run?session=abcd1234");
    assert.equal(thisChatHref({ session: "abcd1234" }), "/run?session=abcd1234");

    const viewItems = pageNavItems({ page: "view", viewId: "c0ffee00" });
    const fromView = viewItems.find((it) => it.dest === "this-chat");
    assert.ok(fromView, "view page offers Go to this chat");
    assert.equal(fromView.href, "/run?session=c0ffee00");

    const empty = pageNavItems({});
    assert.ok(!empty.some((it) => it.dest === "this-run"));
    assert.ok(!empty.some((it) => it.dest === "this-chat"));

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /Go to this run/);
    assert.match(js, /Go to this chat/);
    assert.match(js, /\/run\?id=/);
    assert.match(js, /\/run\?session=/);
  });

  test("D1: this-chat palette fallback subtitle is Open chat, never Watch live", () => {
    mockSessionStorage();
    const sessionItems = pageNavItems({ page: "session", session: "abcd1234" });
    const thisChat = sessionItems.find((it) => it.dest === "this-chat");
    assert.ok(thisChat, "this-chat present on a session page");
    assert.equal(thisChat.subtitle, "abcd1234");
    assert.notEqual(thisChat.subtitle, "Watch live");
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /ctx\.session \|\| ctx\.viewId \|\| "Open chat"/,
      "D1: palette this-chat fallback subtitle is Open chat");
    assert.doesNotMatch(js, /"Watch live"/,
      "D1: palette this-chat fallback is not Watch live");
  });

  test("Compare and rendered-session destinations use the current or last pair/session instead of bouncing to /sessions", () => {
    mockSessionStorage();
    assert.equal(compareHrefFromParts("aaa", "bbb"), "/compare?a=aaa&b=bbb");
    assert.equal(
      compareHrefFromParts("aaa", "bbb", "codex", "cursor"),
      "/compare?a=aaa&b=bbb&sa=codex&sb=cursor",
    );
    assert.equal(compareHref({ a: "aaa11111", b: "bbb22222" }), "/compare?a=aaa11111&b=bbb22222");
    assert.equal(compareHref({}), "/compare");
    assert.doesNotMatch(compareHref({}), /\/sessions/);

    rememberPaletteDestinations({
      page: "compare",
      a: "pairaaaa",
      b: "pairbbbb",
      sa: "codex",
    });
    assert.equal(lastCompareHref(), "/compare?a=pairaaaa&b=pairbbbb&sa=codex");
    assert.equal(compareHref({}), "/compare?a=pairaaaa&b=pairbbbb&sa=codex");
    assert.ok(!compareHref({}).includes("/sessions"));

    rememberPaletteDestinations({ page: "view", viewId: "c0ffee00" });
    assert.equal(readPaletteStore(PALETTE_LAST_VIEW_KEY), "/view?id=c0ffee00");
    assert.equal(viewHref({}), "/view?id=c0ffee00");
    assert.equal(viewHref({ session: "abcd1234" }), "/view?id=abcd1234");
    assert.equal(viewHref({ viewHref: "/view?id=deadbeef&source=codex" }), "/view?id=deadbeef&source=codex");
    assert.ok(!viewHref({}).includes("/sessions"));

    rememberPaletteDestinations({ page: "run", runId: "@9" });
    assert.equal(readPaletteStore(PALETTE_LAST_CHAT_KEY), "/run?id=%409");
    const lastChat = pageNavItems({}).find((it) => it.dest === "last-chat");
    assert.ok(lastChat);
    assert.equal(lastChat.href, "/run?id=%409");

    writePaletteStore(PALETTE_LAST_COMPARE_KEY, "");
    writePaletteStore(PALETTE_LAST_VIEW_KEY, "");
    assert.equal(compareHref({}), "/compare");
    assert.equal(viewHref({}), "/view");

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /function rememberPaletteDestinations/);
    assert.match(js, /function lastCompareHref/);
    assert.match(js, /lastCompareHref\(\) \|\| "\/compare"/);
    assert.match(js, /PALETTE_LAST_VIEW_KEY/);
    assert.doesNotMatch(js, /goto-compare[\s\S]{0,400}href: "\/sessions"/);
  });

  test("page-name query keeps Go to destinations and does not list in-view jumps", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /function classFocus/);
    assert.match(js, /function assembleItems/);
    assert.match(js, /focus\.pageQ && \(it\.kind === "jump" \|\| it\.kind === "chapter"\)/);
    assert.match(js, /focus\.jumpQ && it\.kind === "nav"/);
    assert.equal(isPageJumpQuery("chat"), true);
    assert.equal(isPageJumpQuery("compare"), true);
    assert.equal(isPageJumpQuery("transcript"), false);
  });

  test("rendered-session destination prefers the open session", () => {
    mockSessionStorage();
    rememberPaletteDestinations({ page: "view", viewId: "zzzzzzzz" });
    assert.equal(viewHref({ session: "abcd1234" }), "/view?id=abcd1234");
    assert.equal(viewHref({ viewId: "c0ffee00", session: "abcd1234" }), "/view?id=c0ffee00");
    assert.equal(viewHref({}), "/view?id=zzzzzzzz");
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /ctx && ctx\.session/);
    assert.match(js, /\/view\?id=" \+ encodeURIComponent\(ctx\.session\)/);
  });
});
