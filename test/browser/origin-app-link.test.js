/**
 * "Open in <App>" link builder (facts oalkan, oalcdx, oalcur, oalnone,
 * oalhost): one deep link per origin app that has one, null otherwise.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { originAppLink, showOriginAppLink, ORIGIN_APP_LINK_JS } from "../../src/browser/origin-app-link.js";
import { hostAddresses } from "../../src/hub/host-addresses.js";
import { applyHubConfig } from "../../src/hub/config.js";

const WS = "8e0bfb9e-1b7f-4aca-8b0e-2eb321a21b07";
const TASK = "913978b4-50a2-4fbc-9a75-a0c7c639a2dc";
const HERE = { hostname: "127.0.0.1", hosts: { builder: "100.64.1.2" } };

describe("originAppLink: Kandev", () => {
  test("a Claude session in a Kandev task folder opens the task on this machine's Kandev", () => {
    const path = `/home/u/.claude/projects/-home-u--kandev-tasks-${WS}-${TASK}/5ffccdb0-f62c-4825-8fc8-15489b4624c9.jsonl`;
    assert.deepEqual(originAppLink({ source: "claude", path }, HERE), { app: "Kandev", href: `http://127.0.0.1:38429/t/${TASK}` });
  });

  test("a Grok session reads the task from its percent-encoded working directory", () => {
    const path = `/home/u/.grok/sessions/%2Fhome%2Fu%2F.kandev%2Ftasks%2F${WS}%2F${TASK}/01a17dbd-72c7-7ed0-aff3-1bf6851a8cc5`;
    assert.equal(originAppLink({ source: "grok", path }, HERE).href, `http://127.0.0.1:38429/t/${TASK}`);
  });

  test("a subfolder of the task folder still names the task", () => {
    const path = `/Users/u/.claude/projects/-Users-u--kandev-tasks-${WS}-${TASK}-repo/x.jsonl`;
    assert.equal(originAppLink({ source: "claude", path }, HERE).href, `http://127.0.0.1:38429/t/${TASK}`);
  });

  test("an imported session links to the Kandev on the machine that recorded it", () => {
    const path = `/hub/hosts/builder/.claude/projects/-home-u--kandev-tasks-${WS}-${TASK}/x.jsonl`;
    assert.equal(originAppLink({ source: "claude", path, host: "builder" }, HERE).href, `http://100.64.1.2:38429/t/${TASK}`);
  });

  test("an imported host with no known address gets no link", () => {
    const path = `/hub/hosts/gpu/.claude/projects/-home-u--kandev-tasks-${WS}-${TASK}/x.jsonl`;
    assert.equal(originAppLink({ source: "claude", path, host: "gpu" }, HERE), null);
  });

  test("an IPv6 address is bracketed", () => {
    const path = `/home/u/.claude/projects/-home-u--kandev-tasks-${WS}-${TASK}/x.jsonl`;
    assert.equal(originAppLink({ source: "claude", path }, { hostname: "fd7a::1" }).href, `http://[fd7a::1]:38429/t/${TASK}`);
  });

  test("the older named task folders (no task id in the path) get no link", () => {
    const path = "/home/u/.claude/projects/-home-u--kandev-tasks-tracequest-fix-searc-m1ljfloz-tracequest/x.jsonl";
    assert.equal(originAppLink({ source: "claude", path }, HERE), null);
  });
});

describe("originAppLink: Codex", () => {
  const path = "/home/u/.codex/sessions/2026/10/27/rollout-2026-10-27T15-21-57-01a17dbd-42d2-7e73-81e6-182c4e1c0fff.jsonl";

  test("a local Codex session opens its thread in the Codex app", () => {
    assert.deepEqual(originAppLink({ source: "codex", path }, HERE), { app: "Codex", href: "codex://threads/01a17dbd-42d2-7e73-81e6-182c4e1c0fff" });
  });

  test("an imported Codex session gets no link: the app opens threads on the clicking machine", () => {
    assert.equal(originAppLink({ source: "codex", path, host: "builder" }, HERE), null);
  });
});

describe("originAppLink: Cursor Cloud Agents", () => {
  test("a cloud agent opens its page on cursor.com", () => {
    const path = "/home/u/.local/share/tracequest/cursor-cloud/acme-shop/bc-e39a7c9c-5321-47a5-9440-7783e721d04f.jsonl";
    assert.deepEqual(originAppLink({ source: "cursor-cloud", path }, HERE), {
      app: "Cursor",
      href: "https://cursor.com/agents/bc-e39a7c9c-5321-47a5-9440-7783e721d04f",
    });
  });
});

describe("originAppLink: apps with no per-session link", () => {
  const cases = [
    ["claude", "/home/u/.claude/projects/-home-u-code-shop/5ffccdb0-f62c-4825-8fc8-15489b4624c9.jsonl"],
    ["cursor", "/home/u/.cursor/projects/home-u-shop/agent-transcripts/3b1c/3b1c.jsonl"],
    ["factory", "/home/u/.factory/sessions/-home-u-shop/0b7e.jsonl"],
    ["grok", "/home/u/.grok/sessions/%2Fhome%2Fu%2Fshop/01a17a1f-7c9f-7081-8681-134c182cbbf6"],
    ["vktr", "/home/u/.vktr/sessions/%2Fhome%2Fu%2Fshop/01a17a1f-7c9f-7081-8681-134c182cbbf6"],
    ["fx", "/home/u/.fx/sessions/LOXcHEbGMD2s/events.jsonl"],
    ["dsh", "/home/u/.dsh/sessions/-home-u-shop-/fb43c900-724c-4f79-8ea9-3462db95d084/session.v4.jsonl.zstd"],
    ["opencode", "opencode://ses_3a1b2c"],
  ];
  for (const [source, path] of cases) {
    test(`${source} outside a Kandev task has no link`, () => {
      assert.equal(originAppLink({ source, path }, HERE), null);
    });
  }

  test("no session or no path is no link", () => {
    assert.equal(originAppLink(null, HERE), null);
    assert.equal(originAppLink({ source: "codex" }, HERE), null);
  });
});

describe("showOriginAppLink", () => {
  function fakeAnchor() {
    const attrs = {};
    return {
      hidden: true,
      removeAttribute(k) { delete attrs[k]; delete this[k]; },
      get attrs() { return attrs; },
    };
  }

  test("a web link opens in a new tab, an app link in place, and none hides the anchor", () => {
    const a = fakeAnchor();
    showOriginAppLink(a, { app: "Kandev", href: "http://h:38429/t/x" });
    assert.equal(a.hidden, false);
    assert.equal(a.textContent, "Open in Kandev");
    assert.equal(a.target, "_blank");
    showOriginAppLink(a, { app: "Codex", href: "codex://threads/x" });
    assert.equal(a.href, "codex://threads/x");
    assert.equal(a.target, undefined);
    showOriginAppLink(a, null);
    assert.equal(a.hidden, true);
    assert.equal(a.href, undefined);
  });

  test("the inlined source defines both helpers", () => {
    const fns = new Function(`${ORIGIN_APP_LINK_JS}\nreturn { originAppLink, showOriginAppLink };`)();
    assert.equal(fns.originAppLink({ source: "codex", path: "/c/rollout-x-01a17dbd-42d2-7e73-81e6-182c4e1c0fff.jsonl" }, {}).app, "Codex");
  });
});

describe("hostAddresses", () => {
  test("maps each configured host id to the address SSH resolves for its spec", () => {
    applyHubConfig({ hosts: [{ spec: "dev@builder", hostId: "builder" }, { spec: "gone", hostId: "gone" }] });
    try {
      const seen = [];
      const map = hostAddresses((spec) => {
        seen.push(spec);
        if (spec === "gone") throw new Error("no such host");
        return "100.64.1.2";
      });
      assert.deepEqual(seen, ["dev@builder", "gone"]);
      assert.deepEqual(map, { builder: "100.64.1.2" });
    } finally {
      applyHubConfig({});
    }
  });
});
