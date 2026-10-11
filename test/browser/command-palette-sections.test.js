/**
 * Command palette in-view jumps — run/chat sections and /view #chapter-N
 * anchors. Fact anchors: cprs cprf cprj cpch cpcf cpcj cpjp.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_PALETTE_CLIENT_JS,
  parsePaletteQuery,
  RUN_SECTION_CATALOG,
  VIEW_SECTION_CATALOG,
  inViewSectionItems,
  inViewChapterItems,
  collectChapterDescriptors,
  chapterDescriptorFromElement,
  chapterQueryIndex,
  chapterPermalink,
  isInViewJumpQuery,
  capChapterItems,
  inViewGroupName,
  isRunLikePage,
  CHAPTER_EMPTY_CAP,
} from "../../src/browser/command-palette.js";

function matches(item, q) {
  if (!q) return true;
  if (item.kind === "chapter") {
    const n = chapterQueryIndex(q);
    if (n != null) return item.chapterIndex === n;
  }
  const hay = [item.title, item.subtitle, item.group].concat(item.keywords || []).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((part) => hay.includes(part));
}

function allPresent() {
  return true;
}

describe("command palette in-view sections", () => {
  test("empty query lists This run / This session group of in-view jumps", () => {
    const runItems = inViewSectionItems({ page: "run" }, allPresent);
    const dests = runItems.map((it) => it.dest);
    for (const dest of ["transcript", "analytics", "terminal", "composer"]) {
      assert.ok(dests.includes(dest), `run missing ${dest}: ${dests.join(",")}`);
    }
    for (const it of runItems.filter((x) => ["transcript", "analytics", "terminal", "composer"].includes(x.dest))) {
      assert.equal(it.kind, "jump");
      assert.equal(it.group, "This run");
      assert.ok(it.groupPriority >= 100);
      assert.match(it.title, /^Jump to /);
    }
    assert.equal(inViewGroupName("run"), "This run");
    assert.equal(inViewGroupName("session"), "This session");
    assert.equal(inViewGroupName("view"), "This session");
    assert.ok(isRunLikePage("run"));
    assert.ok(isRunLikePage("session"));

    const sessionItems = inViewSectionItems({ page: "session" }, allPresent);
    assert.ok(sessionItems.every((it) => it.group === "This session"));
    assert.ok(sessionItems.some((it) => it.dest === "transcript"));

    const onlyThread = inViewSectionItems(
      { page: "run" },
      (sel) => sel === "#chatThread" || sel === "#chatScroll",
    );
    assert.deepEqual(onlyThread.map((it) => it.dest), ["transcript"]);

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /hereGroup/);
    assert.match(js, /"This run"/);
    assert.match(js, /This session/);
    assert.match(js, /Jump to transcript/);
    assert.match(js, /Jump to analytics/);
    assert.match(js, /Jump to raw terminal/);
    assert.match(js, /Jump to composer/);
    assert.match(js, /#chatThread/);
    assert.match(js, /#chatScroll/);
    assert.match(js, /#runAnalytics/);
    assert.match(js, /#analyticsToggle/);
    assert.match(js, /#terminalDetails/);
    assert.match(js, /#composerStatus/);
    assert.match(js, /data-dest/);
    assert.match(js, /data-kind/);
  });

  test("typing a section name filters to that in-view jump", () => {
    const items = inViewSectionItems({ page: "run" }, allPresent);
    const cases = [
      ["transcript", "transcript"],
      ["analytics", "analytics"],
      ["terminal", "terminal"],
      ["raw terminal", "terminal"],
      ["composer", "composer"],
      ["follow-up", "composer"],
    ];
    for (const [query, dest] of cases) {
      const hit = items.filter((it) => matches(it, query));
      assert.ok(hit.some((it) => it.dest === dest), `${query} should match ${dest}, got ${hit.map((h) => h.dest).join(",")}`);
    }
    assert.equal(isInViewJumpQuery("transcript"), true);
    assert.equal(isInViewJumpQuery("analytics"), true);
    assert.equal(isInViewJumpQuery("jump composer"), true);
    assert.equal(isInViewJumpQuery("document backend login"), false);
    assert.equal(isInViewJumpQuery("a13f9c82"), false);

    const catalogDests = RUN_SECTION_CATALOG.map((d) => d.dest);
    assert.ok(catalogDests.includes("transcript"));
    assert.ok(catalogDests.includes("analytics"));
    assert.ok(catalogDests.includes("terminal"));
    assert.ok(catalogDests.includes("composer"));

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /kind === "jump"/);
  });

  test("activating a CommandPalette run-section jump scrolls to or opens the matching page section", () => {
    const byDest = Object.fromEntries(RUN_SECTION_CATALOG.map((d) => [d.dest, d]));
    assert.ok(byDest.transcript.selectors.includes("#chatThread"));
    assert.ok(byDest.transcript.selectors.includes("#chatScroll"));
    assert.ok(byDest.analytics.selectors.includes("#runAnalytics"));
    assert.ok(byDest.analytics.selectors.includes("#analyticsToggle"));
    assert.ok(byDest.terminal.selectors.includes("#terminalDetails"));
    assert.ok(byDest.composer.selectors.includes("#composerStatus"));
    assert.ok(byDest.composer.selectors.some((s) => /composer-card|inputText|inputRow/.test(s)));

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /dest === "transcript"/);
    assert.match(js, /#chatThread/);
    assert.match(js, /#chatScroll/);
    assert.match(js, /dest === "analytics"/);
    assert.match(js, /analyticsToggle/);
    assert.match(js, /#runAnalytics/);
    assert.match(js, /dest === "terminal"/);
    assert.match(js, /#terminalDetails/);
    assert.match(js, /openDetails: true/);
    assert.match(js, /dest === "composer"/);
    assert.match(js, /#composerStatus/);
    assert.match(js, /#inputText/);
    assert.match(js, /composer-card/);
    assert.match(js, /scrollIntoView/);
    assert.match(js, /cmdk-jump-flash/);
  });

  test("lists each #chapter-N as an in-page destination with chapter number and prompt excerpt", () => {
    const chapters = [
      { index: 0, id: "chapter-0", prompt: "Set up the command menu" },
      { index: 1, id: "chapter-1", prompt: "Jump to analytics panel" },
      { index: 2, id: "chapter-2", prompt: "Wire chapter anchors" },
    ];
    const items = inViewChapterItems(chapters);
    assert.equal(items.length, 3);
    assert.equal(items[0].kind, "chapter");
    assert.equal(items[0].dest, "chapter-0");
    assert.equal(items[0].chapterIndex, 0);
    assert.equal(items[0].title, "Jump to chapter 1");
    assert.equal(items[0].subtitle, "Set up the command menu");
    assert.equal(items[0].href, "#chapter-0");
    assert.equal(items[0].group, "Chapters");
    assert.ok(items[0].groupPriority >= 100);
    assert.equal(items[2].title, "Jump to chapter 3");
    assert.equal(items[2].href, "#chapter-2");

    const fakeRoot = {
      querySelectorAll() {
        return [
          {
            id: "chapter-0",
            querySelector() { return { textContent: "  First prompt  " }; },
          },
          {
            id: "chapter-1",
            querySelector() { return { textContent: "Second turn" }; },
          },
          { id: "chapter-tools", querySelector() { return null; } },
        ];
      },
    };
    const scanned = collectChapterDescriptors(fakeRoot);
    assert.deepEqual(scanned.map((c) => c.id), ["chapter-0", "chapter-1"]);
    assert.equal(scanned[0].prompt, "First prompt");
    assert.deepEqual(
      chapterDescriptorFromElement({
        id: "chapter-4",
        querySelector() { return { textContent: "Later" }; },
      }),
      { index: 4, id: "chapter-4", prompt: "Later" },
    );

    const viewSections = inViewSectionItems({ page: "view" }, allPresent);
    assert.ok(viewSections.some((it) => it.dest === "chapters"));
    assert.ok(VIEW_SECTION_CATALOG.some((d) => d.dest === "chapters"));

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /#chapter-/);
    assert.match(js, /data-chapter/);
    assert.match(js, /group: "Chapters"/);
    assert.match(js, /Jump to chapter /);
  });

  test("typing a chapter number or prompt filters to that chapter jump", () => {
    const items = inViewChapterItems([
      { index: 0, prompt: "Redesign backend login" },
      { index: 1, prompt: "Add command palette jumps" },
      { index: 2, prompt: "Wire chapter-2 permalink" },
      { index: 12, prompt: "Unrelated wrap-up" },
    ]);
    const byNum = items.filter((it) => matches(it, "2"));
    assert.equal(byNum.length, 1);
    assert.equal(byNum[0].dest, "chapter-1");
    const byHash = items.filter((it) => matches(it, "chapter-2"));
    assert.equal(byHash.length, 1);
    assert.equal(byHash[0].dest, "chapter-2");
    const byPrompt = items.filter((it) => matches(it, "palette"));
    assert.ok(byPrompt.some((it) => it.dest === "chapter-1"));
    assert.ok(!byPrompt.some((it) => it.dest === "chapter-0"));

    assert.equal(chapterQueryIndex("3"), 2);
    assert.equal(chapterQueryIndex("chapter 3"), 2);
    assert.equal(chapterQueryIndex("ch 3"), 2);
    assert.equal(chapterQueryIndex("#chapter-2"), 2);
    assert.equal(chapterQueryIndex("palette"), null);
    assert.equal(isInViewJumpQuery("chapter 2"), true);
    assert.equal(isInViewJumpQuery("ch 1"), true);
    assert.equal(isInViewJumpQuery("#chapter-0"), true);

    const many = inViewChapterItems(
      Array.from({ length: 40 }, (_, i) => ({ index: i, prompt: "Turn " + (i + 1) })),
    );
    const emptyCapped = capChapterItems(many, "");
    assert.equal(emptyCapped.length, CHAPTER_EMPTY_CAP);
    const typed = capChapterItems(items.filter((it) => matches(it, "2")), "2");
    assert.equal(typed.length, 1);

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /kind === "chapter"/);
  });

  test("activating a CommandPalette chapter item scrolls to #chapter-N, expands it, and updates the hash", () => {
    assert.equal(chapterPermalink(3), "#chapter-3");
    assert.equal(chapterPermalink(1, { pathname: "/view", search: "?id=abcd1234" }), "/view?id=abcd1234#chapter-1");

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /#chapter-/);
    assert.match(js, /setChapterHash/);
    assert.match(js, /chapterPermalink/);
    assert.match(js, /expanded/);
    assert.match(js, /jumpToChapter/);
    assert.match(js, /scrollIntoView/);
    assert.match(js, /data-chapter/);
  });

  test("a j/jump/section or ch/chapter prefix focuses in-view section and chapter destinations", () => {
    assert.equal(parsePaletteQuery("j transcript").prefix, "jump");
    assert.equal(parsePaletteQuery("j transcript").q, "transcript");
    assert.equal(parsePaletteQuery("jump analytics").prefix, "jump");
    assert.equal(parsePaletteQuery("jump analytics").q, "analytics");
    assert.equal(parsePaletteQuery("section composer").prefix, "jump");
    assert.equal(parsePaletteQuery("ch 3").prefix, "chapter");
    assert.equal(parsePaletteQuery("ch 3").q, "3");
    assert.equal(parsePaletteQuery("chapter  wire").prefix, "chapter");
    assert.equal(parsePaletteQuery("chapter  wire").q, "wire");
    assert.equal(parsePaletteQuery("j ").prefix, "jump");
    assert.equal(parsePaletteQuery("jump").prefix, "");
    assert.equal(parsePaletteQuery("chapter").prefix, "");
    assert.equal(parsePaletteQuery("g compare").prefix, "goto");
    assert.equal(parsePaletteQuery("s backend").prefix, "session");
    assert.equal(isInViewJumpQuery("j "), true);
    assert.equal(isInViewJumpQuery("ch 2"), true);

    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /prefix === "jump"/);
    assert.match(js, /prefix === "chapter"/);
    assert.match(js, /\^\(j\|jump\|section\)\\s\+/);
    assert.match(js, /\^\(ch\|chapter\)\\s\+/);
    assert.match(js, /kind !== "jump"/);
    assert.match(js, /kind !== "chapter"/);
  });

  test("section-name query keeps in-view jumps and does not list Go to pages", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /focus\.jumpQ && it\.kind === "nav"/);
    assert.match(js, /focus\.pageQ && \(it\.kind === "jump" \|\| it\.kind === "chapter"\)/);
    assert.equal(isInViewJumpQuery("transcript"), true);
    assert.equal(isInViewJumpQuery("analytics"), true);
    assert.equal(isInViewJumpQuery("compare"), false);
    assert.equal(isInViewJumpQuery("chat"), false);
  });
});
