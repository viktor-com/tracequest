import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStandupSelectionWindow,
  parseStandupSince,
  resolveStandupSelectionWindow,
} from "../../src/standup/selection-window.js";

describe("standup selection windows", () => {
  test("parseStandupSince accepts relative durations and local date-only values", () => {
    const now = new Date(2026, 5, 27, 15, 30, 0);
    assert.equal(parseStandupSince("2h", { now }).getTime(), new Date(2026, 5, 27, 13, 30, 0).getTime());

    const dateOnly = parseStandupSince("2026-06-25", { now });
    assert.equal(dateOnly.getFullYear(), 2026);
    assert.equal(dateOnly.getMonth(), 5);
    assert.equal(dateOnly.getDate(), 25);
    assert.equal(dateOnly.getHours(), 0);
    assert.equal(dateOnly.getMinutes(), 0);
  });

  test("resolveStandupSelectionWindow builds today and yesterday windows", () => {
    const now = new Date(2026, 5, 27, 15, 30, 0);
    const today = resolveStandupSelectionWindow({ today: true }, { now });
    assert.equal(today.label, "today");
    assert.equal(today.since.getTime(), new Date(2026, 5, 27, 0, 0, 0).getTime());
    assert.equal(today.before, null);

    const yesterday = resolveStandupSelectionWindow({ yesterday: true }, { now });
    assert.equal(yesterday.label, "yesterday");
    assert.equal(yesterday.since.getTime(), new Date(2026, 5, 26, 0, 0, 0).getTime());
    assert.equal(yesterday.before.getTime(), new Date(2026, 5, 27, 0, 0, 0).getTime());
  });

  test("resolveStandupSelectionWindow builds a local workday window", () => {
    const now = new Date(2026, 5, 27, 15, 30, 0);
    const workday = resolveStandupSelectionWindow({ workday: true }, { now });
    assert.equal(workday.label, "workday (09:00-17:00 local)");
    assert.equal(workday.since.getTime(), new Date(2026, 5, 27, 9, 0, 0).getTime());
    assert.equal(workday.before.getTime(), new Date(2026, 5, 27, 17, 0, 0).getTime());
  });

  test("resolveStandupSelectionWindow builds a previous-workday local window that skips weekends", () => {
    const tuesday = resolveStandupSelectionWindow(
      { "previous-workday": true },
      { now: new Date(2026, 5, 23, 15, 30, 0) },
    );
    assert.equal(tuesday.label, "previous workday (09:00-17:00 local)");
    assert.equal(tuesday.since.getTime(), new Date(2026, 5, 22, 9, 0, 0).getTime());
    assert.equal(tuesday.before.getTime(), new Date(2026, 5, 22, 17, 0, 0).getTime());

    const monday = resolveStandupSelectionWindow(
      { "previous-workday": true },
      { now: new Date(2026, 5, 29, 8, 0, 0) },
    );
    assert.equal(monday.since.getTime(), new Date(2026, 5, 26, 9, 0, 0).getTime());
    assert.equal(monday.before.getTime(), new Date(2026, 5, 26, 17, 0, 0).getTime());

    const sunday = resolveStandupSelectionWindow(
      { previousWorkday: true },
      { now: new Date(2026, 5, 28, 8, 0, 0) },
    );
    assert.equal(sunday.since.getTime(), new Date(2026, 5, 26, 9, 0, 0).getTime());
    assert.equal(sunday.before.getTime(), new Date(2026, 5, 26, 17, 0, 0).getTime());
  });

  test("applyStandupSelectionWindow filters discovery sessions by mtime bounds", () => {
    const window = {
      since: new Date("2026-06-26T00:00:00.000Z"),
      before: new Date("2026-06-27T00:00:00.000Z"),
      label: "yesterday",
    };
    const sessions = [
      { path: "old.jsonl", mtime: new Date("2026-06-25T23:59:59.000Z") },
      { path: "inside.jsonl", mtime: new Date("2026-06-26T12:00:00.000Z") },
      { path: "today.jsonl", mtime: new Date("2026-06-27T00:00:00.000Z") },
    ];

    assert.deepEqual(
      applyStandupSelectionWindow(sessions, window).map((s) => s.path),
      ["inside.jsonl"],
    );
  });

  test("resolveStandupSelectionWindow rejects ambiguous or invalid windows", () => {
    assert.throws(
      () => resolveStandupSelectionWindow({ since: "2h", today: true }),
      /Choose only one/,
    );
    assert.throws(
      () => resolveStandupSelectionWindow({ today: true, workday: true }),
      /Choose only one/,
    );
    assert.throws(
      () => resolveStandupSelectionWindow({ yesterday: true, "previous-workday": true }),
      /Choose only one/,
    );
    assert.throws(
      () => resolveStandupSelectionWindow({ since: "not-a-date" }),
      /Invalid --since value/,
    );
  });
});
