/**
 * "Open in <App>" link builder (facts oalcdx, oalcld, oalloc, oalnone): a
 * native per-session link for sessions recorded on this machine, null
 * otherwise.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { originAppLink, showOriginAppLink, ORIGIN_APP_LINK_JS } from "../../src/browser/origin-app-link.js";

const THREAD = "01a17dbd-42d2-7e73-81e6-182c4e1c0fff";
const CODEX = `/home/u/.codex/sessions/2026/10/27/rollout-2026-10-27T15-21-57-${THREAD}.jsonl`;
const CLAUDE_ID = "5ffccdb0-f62c-4825-8fc8-15489b4624c9";
const CLAUDE = `/Users/u/.claude/projects/-Users-u-code-shop/${CLAUDE_ID}.jsonl`;
const WS = "8e0bfb9e-1b7f-4aca-8b0e-2eb321a21b07";
const TASK = "913978b4-50a2-4fbc-9a75-a0c7c639a2dc";

describe("originAppLink: Codex", () => {
  test("a Codex session opens its thread in the Codex app", () => {
    assert.deepEqual(originAppLink({ source: "codex", path: CODEX }), { app: "Codex", href: `codex://threads/${THREAD}` });
  });

  test("a running Codex session keeps its link", () => {
    assert.equal(originAppLink({ source: "codex", path: CODEX, live: true }).href, `codex://threads/${THREAD}`);
  });

  test("a Codex file without a thread id gets no link", () => {
    assert.equal(originAppLink({ source: "codex", path: "/home/u/.codex/sessions/2026/10/27/rollout-x.jsonl" }), null);
  });
});

describe("originAppLink: Claude Code", () => {
  test("a finished Claude Code session opens in Claude Desktop", () => {
    assert.deepEqual(originAppLink({ source: "claude", path: CLAUDE }), { app: "Claude", href: `claude://resume?session=${CLAUDE_ID}` });
  });

  test("a Claude Code session run in a Kandev task folder opens in Claude Desktop too", () => {
    const path = `/home/u/.claude/projects/-home-u--kandev-tasks-${WS}-${TASK}/${CLAUDE_ID}.jsonl`;
    assert.equal(originAppLink({ source: "claude", path }).href, `claude://resume?session=${CLAUDE_ID}`);
  });

  test("a running Claude Code session gets no link: Desktop does not take over a live session", () => {
    assert.equal(originAppLink({ source: "claude", path: CLAUDE, live: true }), null);
  });

  test("a subagent transcript gets no link", () => {
    assert.equal(originAppLink({ source: "claude", path: `/Users/u/.claude/projects/-Users-u-code-shop/${CLAUDE_ID}/subagents/agent-a1b2.jsonl` }), null);
  });
});

describe("originAppLink: only sessions recorded on this machine", () => {
  test("imported Codex and Claude sessions get no link", () => {
    assert.equal(originAppLink({ source: "codex", path: `/hub/hosts/builder${CODEX}`, host: "builder" }), null);
    assert.equal(originAppLink({ source: "claude", path: `/hub/hosts/builder${CLAUDE}`, host: "builder" }), null);
  });
});

describe("originAppLink: apps with no per-session link", () => {
  const cases = [
    ["grok in a Kandev task folder", "grok", `/home/u/.grok/sessions/%2Fhome%2Fu%2F.kandev%2Ftasks%2F${WS}%2F${TASK}/01a17dbd-72c7-7ed0-aff3-1bf6851a8cc5`],
    ["cursor", "cursor", "/home/u/.cursor/projects/home-u-shop/agent-transcripts/3b1c/3b1c.jsonl"],
    ["cursor-cloud", "cursor-cloud", "/home/u/.local/share/tracequest/cursor-cloud/acme-shop/bc-e39a7c9c-5321-47a5-9440-7783e721d04f.jsonl"],
    ["factory", "factory", "/home/u/.factory/sessions/-home-u-shop/0b7e.jsonl"],
    ["vktr", "vktr", "/home/u/.vktr/sessions/%2Fhome%2Fu%2Fshop/01a17a1f-7c9f-7081-8681-134c182cbbf6"],
    ["fx", "fx", "/home/u/.fx/sessions/LOXcHEbGMD2s/events.jsonl"],
    ["dsh", "dsh", "/home/u/.dsh/sessions/-home-u-shop-/fb43c900-724c-4f79-8ea9-3462db95d084/session.v4.jsonl.zstd"],
    ["opencode", "opencode", "opencode://ses_3a1b2c"],
  ];
  for (const [name, source, path] of cases) {
    test(`${name} has no link`, () => {
      assert.equal(originAppLink({ source, path }), null);
    });
  }

  test("no session or no path is no link", () => {
    assert.equal(originAppLink(null), null);
    assert.equal(originAppLink({ source: "codex" }), null);
  });
});

describe("showOriginAppLink", () => {
  function fakeAnchor() {
    return { hidden: true, removeAttribute(k) { delete this[k]; } };
  }

  test("a link labels and shows the anchor; none hides it", () => {
    const a = fakeAnchor();
    showOriginAppLink(a, { app: "Codex", href: `codex://threads/${THREAD}` });
    assert.equal(a.hidden, false);
    assert.equal(a.textContent, "Open in Codex");
    assert.equal(a.href, `codex://threads/${THREAD}`);
    showOriginAppLink(a, null);
    assert.equal(a.hidden, true);
    assert.equal(a.href, undefined);
  });

  test("the inlined source defines both helpers", () => {
    const fns = new Function(`${ORIGIN_APP_LINK_JS}\nreturn { originAppLink, showOriginAppLink };`)();
    assert.equal(fns.originAppLink({ source: "codex", path: CODEX }).app, "Codex");
  });
});
