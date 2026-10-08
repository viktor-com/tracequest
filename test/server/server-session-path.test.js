import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  agentSessionRootPrefixes,
  isSessionPath,
  normalizeProjectFolder,
  projectLabel,
  sessionDisplayId,
  shortenProjectPath,
  sourceForSessionPath,
} from "../../src/server/server-session-path.js";

const home = homedir();
const cleanupDirs = [];

function tempUnderAgent(agentDir, prefix = "tq-path-test-") {
  const root = join(home, agentDir);
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe("server-session-path shortenProjectPath", () => {
  it("maps ~/code paths to short project labels", () => {
    assert.equal(shortenProjectPath(`${home}/code/tracequest`), "tracequest");
    assert.equal(shortenProjectPath(`${home}/code/foo/bar`), "foo/bar");
  });

  it("keeps other home-relative paths with ~ prefix", () => {
    assert.equal(shortenProjectPath(`${home}/other`), "~/other");
    assert.equal(shortenProjectPath(`${home}/projects/app`), "~/projects/app");
  });

  it("returns empty string for falsy input", () => {
    assert.equal(shortenProjectPath(""), "");
    assert.equal(shortenProjectPath(null), "");
    assert.equal(shortenProjectPath(undefined), "");
    assert.equal(shortenProjectPath(0), "");
    assert.equal(shortenProjectPath(false), "");
  });

  const edgeCases = [
    ["leaves paths outside $HOME unchanged", "/tmp/my-project", "/tmp/my-project"],
    ["maps home directory alone to ~", home, "~"],
    ["keeps ~/code without trailing project segment", `${home}/code`, "~/code"],
    ["strips ~/code/ when path is exactly the code root", `${home}/code/`, ""],
    ["preserves trailing slash on project dirs", `${home}/code/tracequest/`, "tracequest/"],
    ["shortens literal ~/code/ paths (no home prefix in input)", "~/code/nested/app", "nested/app"],
    ["is case-sensitive for the code directory name", `${home}/CODE/app`, "~/CODE/app"],
    ["does not strip ~/code when directory name is a prefix", `${home}/codecool`, "~/codecool"],
    ["does not treat ~/code in the middle of a non-home path", "/var/code/foo", "/var/code/foo"],
    ["replaces only the first home prefix occurrence", `${home}/mirror${home.slice(home.lastIndexOf("/"))}/x`, `~/mirror${home.slice(home.lastIndexOf("/"))}/x`],
    ["handles dotted and hyphenated project names", `${home}/code/foo.bar/baz-qux`, "foo.bar/baz-qux"],
    ["leaves whitespace-only strings unchanged", "   ", "   "],
    ["handles deeply nested code trees", `${home}/code/a/b/c/d`, "a/b/c/d"],
  ];

  for (const [name, input, expected] of edgeCases) {
    it(name, () => assert.equal(shortenProjectPath(input), expected));
  }

  it("does not strip code/ when it appears under ~/other/", () => {
    assert.equal(shortenProjectPath(`${home}/other/code/app`), "~/other/code/app");
  });

  it("shortens ~/code/code to the project directory name code", () => {
    assert.equal(shortenProjectPath(`${home}/code/code`), "code");
  });

  it("leaves relative paths without a home prefix unchanged", () => {
    assert.equal(shortenProjectPath("tracequest"), "tracequest");
    assert.equal(shortenProjectPath("foo/bar"), "foo/bar");
  });
});

describe("server-session-path sessionDisplayId", () => {
  it("strips .jsonl and truncates to 8 characters", () => {
    assert.equal(
      sessionDisplayId("019e47cd-151a-75d1-8f42-53efb31db13f.jsonl"),
      "019e47cd"
    );
  });

  it("returns up to 8 chars when basename has no .jsonl suffix", () => {
    assert.equal(sessionDisplayId("short.jsonl"), "short");
    assert.equal(sessionDisplayId("abcdefgh.jsonl"), "abcdefgh");
    assert.equal(sessionDisplayId("longsessionid"), "longsess");
  });
});

describe("server-session-path normalizeProjectFolder", () => {
  it("reduces absolute code paths to folder names", () => {
    assert.equal(normalizeProjectFolder(`${home}/code/workspace-notes`), "workspace-notes");
    assert.equal(normalizeProjectFolder(`${home}/code/tracequest`), "tracequest");
  });

  it("extracts factory workspace slugs and nested path segments", () => {
    assert.equal(
      normalizeProjectFolder("ws-home-dev-code-tracequest"),
      "tracequest"
    );
    assert.equal(
      normalizeProjectFolder(`${home}/code/foo/bar`),
      "bar"
    );
  });

  it("returns (unknown) for empty input", () => {
    assert.equal(normalizeProjectFolder(""), "(unknown)");
    assert.equal(normalizeProjectFolder(null), "(unknown)");
  });
});

describe("server-session-path projectLabel", () => {
  it("extracts the segment after -code- in workspace slugs", () => {
    assert.equal(projectLabel("ws-home-dev-code-tracequest"), "tracequest");
    assert.equal(projectLabel("prefix-code-myapp"), "myapp");
  });

  it("strips a leading -home-<segment>- prefix when -code- is absent", () => {
    assert.equal(projectLabel("-home-dev-tracequest"), "tracequest");
  });

  it("leaves ws-home slugs unchanged without a -code- suffix", () => {
    assert.equal(projectLabel("ws-home-dev-tracequest"), "ws-home-dev-tracequest");
  });

  it("returns the slug unchanged when no known patterns match", () => {
    assert.equal(projectLabel("plain-workspace"), "plain-workspace");
    assert.equal(projectLabel(""), "");
  });

  const edgeCases = [
    ["keeps version suffixes after -code-", "ws-home-dev-code-tracequest-v2", "tracequest-v2"],
    ["takes the first -code- match and keeps later -code- segments", "a-code-b-code-c", "b-code-c"],
    ["accepts slugs that start with -code-", "-code-foo", "foo"],
    ["leaves trailing -code- without a project segment unchanged", "something-code-", "something-code-"],
    ["leaves ws-home slugs with empty -code- suffix unchanged", "ws-home-dev-code-", "ws-home-dev-code-"],
    ["strips only one -home-<user>- segment", "-home-user-project-extra", "project-extra"],
    ["returns empty when slug is only -home-<user>-", "-home-dev-", ""],
    ["ignores -code- in the middle when a later -code- exists", "ws-home-dev-code-a-code-b", "a-code-b"],
    ["does not strip -home- when slug uses ws-home without -code-", "ws-home-dev-myapp", "ws-home-dev-myapp"],
    ["preserves hyphens in the extracted project name", "ws-x-code-my-cool-app", "my-cool-app"],
    ["does not treat bare code- prefix as workspace pattern", "code-tracequest", "code-tracequest"],
    ["handles minimal -home-<user>-<project> slug", "-home-u-p", "p"],
  ];

  for (const [name, input, expected] of edgeCases) {
    it(name, () => assert.equal(projectLabel(input), expected));
  }

  it("extracts numeric-only and unicode segments after -code-", () => {
    assert.equal(projectLabel("ws-x-code-123"), "123");
    assert.equal(projectLabel("ws-x-code-café"), "café");
    assert.equal(projectLabel(null), "");
    assert.equal(projectLabel(undefined), "");
  });
});

describe("server-session-path isSessionPath opencode URIs", () => {
  it("accepts well-formed OpenCode session IDs", () => {
    assert.equal(isSessionPath("opencode://ses_1c558d1a8ffeLIDNXi2mi8401L"), true);
    assert.equal(isSessionPath("opencode://ses_17d0929beffeDWDAOOZMIKY7bq"), true);
  });

  it("rejects malformed or unsafe opencode URIs", () => {
    assert.equal(isSessionPath("opencode://"), false);
    assert.equal(isSessionPath("opencode://sess-1"), false);
    assert.equal(isSessionPath("opencode://../../../etc/passwd"), false);
    assert.equal(isSessionPath("opencode://019e4786-20ed-7ca2-94ed-f6bab9bfd58d"), false);
    assert.equal(isSessionPath("opencode://ses_short"), false);
  });
});

describe("server-session-path isSessionPath filesystem", () => {
  beforeEach(() => {
    cleanupDirs.length = 0;
  });

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it("rejects null, empty, and non-string paths", () => {
    assert.equal(isSessionPath(null), false);
    assert.equal(isSessionPath(undefined), false);
    assert.equal(isSessionPath(""), false);
    assert.equal(isSessionPath(42), false);
  });

  it("accepts .jsonl session logs under allowed agent directories", () => {
    const dir = tempUnderAgent(".claude");
    const session = join(dir, "abc12345.jsonl");
    writeFileSync(session, "{}\n");
    assert.equal(isSessionPath(session), true);
  });

  it("cursor paths under home are accepted as session paths", () => {
    const dir = tempUnderAgent(".cursor");
    const session = join(dir, "cursor123.jsonl");
    writeFileSync(session, "{}\n");
    assert.equal(isSessionPath(session), true);
  });

  it("isSessionPath accepts host-prefixed opencode URIs", () => {
    assert.equal(isSessionPath("opencode://gpu/ses_abcdefghijklmnopqrst"), true);
    assert.equal(isSessionPath("opencode://ses_abcdefghijklmnopqrst"), true);
    assert.equal(isSessionPath("opencode://gpu/not-an-id"), false);
  });

  it("sourceForSessionPath keeps original agent source under the hosts root", () => {
    assert.equal(
      sourceForSessionPath("/home/u/.local/share/tracequest/hosts/gpu/.claude/projects/p/a.jsonl"),
      "claude",
    );
    assert.equal(
      sourceForSessionPath("/home/u/.local/share/tracequest/hosts/gpu/.cursor/projects/p/u/u.jsonl"),
      "cursor",
    );
    assert.equal(
      sourceForSessionPath("/home/u/.local/share/tracequest/hosts/gpu/.codex/sessions/2026/r.jsonl"),
      "codex",
    );
    assert.equal(
      sourceForSessionPath("/home/u/.local/share/tracequest/hosts/gpu/.factory/sessions/ws/f.jsonl"),
      "factory",
    );
    assert.equal(
      sourceForSessionPath("/home/u/.local/share/tracequest/hosts/gpu/.grok/sessions/enc/sid"),
      "grok",
    );
  });

  it("hosts paths under the hosts root are accepted as session paths", () => {
    const root = mkdtempSync(join(home, "tq-hosts-root-"));
    cleanupDirs.push(root);
    const hadOverride = Object.hasOwn(process.env, "TRACEQUEST_HOSTS_DIR");
    const prevOverride = process.env.TRACEQUEST_HOSTS_DIR;
    process.env.TRACEQUEST_HOSTS_DIR = root;
    try {
      const projDir = join(root, "gpu", ".claude", "projects", "myproj");
      mkdirSync(projDir, { recursive: true });
      const session = join(projDir, "sess.jsonl");
      writeFileSync(session, "{}\n");
      assert.equal(isSessionPath(session), true);

      const notes = join(projDir, "notes.txt");
      writeFileSync(notes, "");
      assert.equal(isSessionPath(notes), false);

      const grokDir = join(root, "gpu", ".grok", "sessions", "enc-cwd", "sid");
      mkdirSync(grokDir, { recursive: true });
      writeFileSync(join(grokDir, "chat_history.jsonl"), "{}\n");
      assert.equal(isSessionPath(grokDir), true);

      const outside = mkdtempSync(join(home, "tq-hosts-outside-"));
      cleanupDirs.push(outside);
      const stray = join(outside, "sess.jsonl");
      writeFileSync(stray, "{}\n");
      assert.equal(isSessionPath(stray), false);
    } finally {
      if (hadOverride) process.env.TRACEQUEST_HOSTS_DIR = prevOverride;
      else delete process.env.TRACEQUEST_HOSTS_DIR;
    }
  });

  it("cursor-cloud paths under the cursor-cloud root are accepted as session paths", () => {
    // Exercise the TRACEQUEST_CURSOR_CLOUD_DIR override so the test never
    // writes into the real ~/.local/share/tracequest (fact ccsp).
    const root = mkdtempSync(join(home, "tq-cursor-cloud-root-"));
    cleanupDirs.push(root);
    const hadOverride = Object.hasOwn(process.env, "TRACEQUEST_CURSOR_CLOUD_DIR");
    const prevOverride = process.env.TRACEQUEST_CURSOR_CLOUD_DIR;
    process.env.TRACEQUEST_CURSOR_CLOUD_DIR = root;
    try {
      const projDir = join(root, "org-repo");
      mkdirSync(projDir, { recursive: true });
      const session = join(projDir, "bc-abc123.jsonl");
      writeFileSync(session, "{}\n");
      assert.equal(isSessionPath(session), true);

      // Non-.jsonl files under the root stay rejected.
      const meta = join(projDir, "notes.txt");
      writeFileSync(meta, "");
      assert.equal(isSessionPath(meta), false);

      // Files outside the resolved root stay rejected exactly as before.
      const outside = mkdtempSync(join(home, "tq-cursor-cloud-outside-"));
      cleanupDirs.push(outside);
      const stray = join(outside, "bc-outside.jsonl");
      writeFileSync(stray, "{}\n");
      assert.equal(isSessionPath(stray), false);
    } finally {
      if (hadOverride) process.env.TRACEQUEST_CURSOR_CLOUD_DIR = prevOverride;
      else delete process.env.TRACEQUEST_CURSOR_CLOUD_DIR;
    }
  });

  it("rejects non-session files under allowed directories", () => {
    const dir = tempUnderAgent(".claude");
    const cred = join(dir, ".credentials.json");
    writeFileSync(cred, "{}");
    assert.equal(isSessionPath(cred), false);

    const settings = join(dir, "settings.json");
    writeFileSync(settings, "{}");
    assert.equal(isSessionPath(settings), false);
  });

  it("accepts Grok session directories containing chat_history.jsonl", () => {
    const dir = tempUnderAgent(".grok");
    writeFileSync(join(dir, "chat_history.jsonl"), "{}\n");
    assert.equal(isSessionPath(dir), true);
  });

  it("rejects Grok directories without chat_history.jsonl", () => {
    const dir = tempUnderAgent(".grok");
    writeFileSync(join(dir, "notes.txt"), "noop");
    assert.equal(isSessionPath(dir), false);
  });

  it("rejects paths outside the agent directory allowlist", () => {
    const outside = mkdtempSync(join(home, "tq-outside-"));
    cleanupDirs.push(outside);
    const file = join(outside, "session.jsonl");
    writeFileSync(file, "{}\n");
    assert.equal(isSessionPath(file), false);
  });

  it("returns false when the target file does not exist", () => {
    const missing = join(home, ".claude", "tq-missing-session-test.jsonl");
    assert.equal(isSessionPath(missing), false);
  });

  describe("forbidden paths", () => {
    it("exposes the five agent home roots used for allowlisting", () => {
      const prefixes = agentSessionRootPrefixes();
      assert.deepEqual(
        prefixes.map((p) => p.slice(home.length)),
        ["/.claude/", "/.codex/", "/.cursor/", "/.factory/", "/.grok/"]
      );
    });

    const forbiddenInputs = [
      ["whitespace-only path", "   "],
      ["tab-only path", "\t"],
      ["array path", []],
      ["plain object path", { path: "/tmp/x.jsonl" }],
      ["opencode URI with wrong scheme casing", "OpenCode://ses_1c558d1a8ffeLIDNXi2mi8401L"],
      ["opencode URI with uuid instead of ses_ id", "opencode://019e4786-20ed-7ca2-94ed-f6bab9bfd58d"],
      ["opencode URI with path traversal in id", "opencode://ses_../../../etc/passwd"],
      ["opencode URI with hyphenated id", "opencode://ses-not-valid-id-123456789012345"],
    ];

    for (const [name, input] of forbiddenInputs) {
      it(`rejects ${name}`, () => assert.equal(isSessionPath(input), false));
    }

    it("rejects non-.jsonl files under ~/.codex", () => {
      const dir = tempUnderAgent(".codex");
      const cfg = join(dir, "auth.json");
      writeFileSync(cfg, "{}");
      assert.equal(isSessionPath(cfg), false);
    });

    it("rejects non-.jsonl files under ~/.factory", () => {
      const dir = tempUnderAgent(".factory");
      const meta = join(dir, "droid.toml");
      writeFileSync(meta, "");
      assert.equal(isSessionPath(meta), false);
    });

    it("rejects Claude project directories without chat_history.jsonl", () => {
      const dir = tempUnderAgent(".claude");
      const projects = join(dir, "projects", "tq-forbidden-proj");
      mkdirSync(projects, { recursive: true });
      assert.equal(isSessionPath(projects), false);
    });

    it("rejects paths whose resolution escapes the agent allowlist via ..", () => {
      const outside = mkdtempSync(join(home, "tq-forbidden-escape-"));
      cleanupDirs.push(outside);
      const trap = join(outside, "trap.jsonl");
      writeFileSync(trap, "{}\n");
      const viaClaude = join(home, ".claude", "..", outside.slice(home.length + 1), "trap.jsonl");
      assert.equal(isSessionPath(viaClaude), false);
      assert.equal(isSessionPath(trap), false);
    });

    it("rejects a .jsonl symlink whose target resolves outside agent homes", () => {
      const outside = mkdtempSync(join(home, "tq-forbidden-target-"));
      cleanupDirs.push(outside);
      const target = join(outside, "external.jsonl");
      writeFileSync(target, "{}\n");
      const dir = tempUnderAgent(".claude");
      const link = join(dir, "external-link.jsonl");
      try {
        symlinkSync(target, link);
        assert.equal(isSessionPath(link), false);
      } catch (err) {
        if (err.code !== "EPERM" && err.code !== "ENOTSUP") throw err;
        assert.equal(isSessionPath(target), false);
      }
    });
  });
});
