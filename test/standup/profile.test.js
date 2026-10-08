import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStandupProfiles,
  loadStandupProfile,
  mergeStandupProfileOptions,
  profileParamsToCli,
  standupProfilesPath,
} from "../../src/standup/profile.js";

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tq-standup-profile-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("standup profiles", () => {
  test("standupProfilesPath resolves under HOME/.tracequest", () => {
    assert.equal(
      standupProfilesPath({ HOME: "/tmp/tq-profile-home" }),
      "/tmp/tq-profile-home/.tracequest/standup-profiles.json",
    );
  });

  test("loadStandupProfile reads a named JSON profile", () => {
    withTmpDir((dir) => {
      const configDir = join(dir, ".tracequest");
      mkdirSync(configDir, { recursive: true });
      const path = join(configDir, "standup-profiles.json");
      writeFileSync(path, JSON.stringify({
        daily: {
          project: "tracequest",
          limit: 3,
        },
      }));

      assert.deepEqual(loadStandupProfile("daily", { path }), {
        name: "daily",
        path,
        values: {
          project: "tracequest",
          limit: 3,
        },
      });
      assert.throws(
        () => loadStandupProfile("missing", { path }),
        /Standup profile not found: missing\. Available profiles: daily\./,
      );
    });
  });

  test("standup profile invalid config reports malformed JSON distinctly", () => {
    withTmpDir((dir) => {
      const configDir = join(dir, ".tracequest");
      mkdirSync(configDir, { recursive: true });
      const path = join(configDir, "standup-profiles.json");
      writeFileSync(path, "{not json");

      assert.throws(
        () => loadStandupProfiles(path),
        /Failed to parse standup profile JSON file .*standup-profiles\.json: /,
      );
    });
  });

  test("mergeStandupProfileOptions fills defaults and keeps explicit CLI values", () => {
    const merged = mergeStandupProfileOptions({
      profile: "daily",
      limit: "2",
      today: true,
      param: ["model=cli-model"],
      "agent-timeout-ms": "5000",
    }, {
      project: "tracequest",
      filter: "source:claude",
      sort: "tokens",
      limit: 5,
      since: "1d",
      workday: true,
      previousWorkday: true,
      agentCommand: "codex",
      agentArgs: ["exec", "--quiet"],
      agentTimeoutMs: 120000,
      params: {
        model: "profile-model",
        config: ["a=b", "c=d"],
      },
    });

    assert.equal(merged.project, "tracequest");
    assert.equal(merged.filter, "source:claude");
    assert.equal(merged.sort, "tokens");
    assert.equal(merged.limit, "2");
    assert.equal(merged.today, true);
    assert.equal(merged.since, undefined);
    assert.equal(merged.workday, undefined);
    assert.equal(merged["previous-workday"], undefined);
    assert.equal(merged["agent-command"], "codex");
    assert.deepEqual(merged["agent-arg"], ["exec", "--quiet"]);
    assert.equal(merged["agent-timeout-ms"], "5000");
    assert.deepEqual(merged.param, ["model=cli-model"]);
  });

  test("standup mixed partial agent overrides isolate CLI command argv from profile defaults", () => {
    const commandOverride = mergeStandupProfileOptions({
      profile: "daily",
      "agent-command": "cli-agent",
    }, {
      agentCommand: "profile-agent",
      agentArgs: ["--from-profile"],
      agentTimeoutMs: 120000,
      params: { model: "profile-model" },
    });

    assert.equal(commandOverride["agent-command"], "cli-agent");
    assert.equal(commandOverride["agent-arg"], undefined);
    assert.equal(commandOverride.param, undefined);
    assert.equal(commandOverride["agent-timeout-ms"], 120000);

    const argsOverride = mergeStandupProfileOptions({
      profile: "daily",
      "agent-arg": ["--from-cli"],
    }, {
      agentCommand: "profile-agent",
      agentArgs: ["--from-profile"],
      agentTimeoutMs: 120000,
      params: { model: "profile-model" },
    });

    assert.equal(argsOverride["agent-command"], "profile-agent");
    assert.deepEqual(argsOverride["agent-arg"], ["--from-cli"]);
    assert.deepEqual(argsOverride.param, ["model=profile-model"]);
    assert.equal(argsOverride["agent-timeout-ms"], 120000);
  });

  test("mergeStandupProfileOptions applies profile workday when no CLI window is explicit", () => {
    const merged = mergeStandupProfileOptions({
      profile: "daily",
    }, {
      workday: true,
    });

    assert.equal(merged.workday, true);
  });

  test("mergeStandupProfileOptions applies profile previous-workday keys when no CLI window is explicit", () => {
    const camel = mergeStandupProfileOptions({
      profile: "daily",
    }, {
      previousWorkday: true,
    });
    assert.equal(camel["previous-workday"], true);

    const kebab = mergeStandupProfileOptions({
      profile: "daily",
    }, {
      "previous-workday": true,
    });
    assert.equal(kebab["previous-workday"], true);

    const overridden = mergeStandupProfileOptions({
      profile: "daily",
      workday: true,
    }, {
      previousWorkday: true,
    });
    assert.equal(overridden.workday, true);
    assert.equal(overridden["previous-workday"], undefined);
  });

  test("standup profile invalid config rejects nonscalar agent args and params", () => {
    assert.throws(
      () => mergeStandupProfileOptions({}, { agentArgs: { run: true } }),
      /Standup profile agentArgs must be a string or an array of string\/number\/boolean values; got object\./,
    );
    assert.throws(
      () => mergeStandupProfileOptions({}, { agentArgs: ["exec", { flag: true }] }),
      /Standup profile agentArgs must be a string or an array of string\/number\/boolean values; got object\./,
    );
    assert.throws(
      () => profileParamsToCli({ model: { name: "bad" } }),
      /Standup profile params\.model must be a string, number, boolean, null, or an array of those values; got object\./,
    );
    assert.throws(
      () => profileParamsToCli(["model=gpt-5", { bad: true }]),
      /Standup profile params must be an object or an array of key=value strings; got object\./,
    );
  });

  test("profileParamsToCli accepts objects and repeated values", () => {
    assert.deepEqual(profileParamsToCli({
      model: "gpt-5",
      json: true,
      skip: false,
      config: ["a=b", "c=d"],
    }), [
      "model=gpt-5",
      "json",
      "config=a=b",
      "config=c=d",
    ]);
  });
});
