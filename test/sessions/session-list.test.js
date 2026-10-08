import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sessionMtimeMs,
  sortSessionsByMtimeDesc,
  sessionListChecksum,
} from "../../src/sessions/session-list.js";

describe("sessionMtimeMs", () => {
  test("returns 0 for missing session or mtime", () => {
    assert.equal(sessionMtimeMs(undefined), 0);
    assert.equal(sessionMtimeMs(null), 0);
    assert.equal(sessionMtimeMs({}), 0);
    assert.equal(sessionMtimeMs({ path: "/x" }), 0);
    assert.equal(sessionMtimeMs({ mtime: null }), 0);
    assert.equal(sessionMtimeMs({ mtime: undefined }), 0);
  });

  test("reads Date instances via getTime", () => {
    const d = new Date("2024-06-01T12:00:00.000Z");
    assert.equal(sessionMtimeMs({ mtime: d }), d.getTime());
  });

  test("epoch Date and invalid Date normalize to 0", () => {
    assert.equal(sessionMtimeMs({ mtime: new Date(0) }), 0);
    assert.equal(sessionMtimeMs({ mtime: new Date("not-a-date") }), 0);
  });

  test("accepts finite epoch-ms numbers including negatives", () => {
    assert.equal(sessionMtimeMs({ mtime: 1_700_000_000_000 }), 1_700_000_000_000);
    assert.equal(sessionMtimeMs({ mtime: -1 }), -1);
    assert.equal(sessionMtimeMs({ mtime: 0 }), 0);
  });

  test("rejects non-finite numbers", () => {
    assert.equal(sessionMtimeMs({ mtime: NaN }), 0);
    assert.equal(sessionMtimeMs({ mtime: Infinity }), 0);
    assert.equal(sessionMtimeMs({ mtime: -Infinity }), 0);
  });

  test("ignores string, boolean, and object mtime values", () => {
    assert.equal(sessionMtimeMs({ mtime: "1700000000000" }), 0);
    assert.equal(sessionMtimeMs({ mtime: true }), 0);
    assert.equal(sessionMtimeMs({ mtime: { valueOf: () => 99 } }), 0);
    assert.equal(sessionMtimeMs({ mtime: [] }), 0);
  });
});

describe("sortSessionsByMtimeDesc", () => {
  test("mutates and returns the same array reference", () => {
    const sessions = [{ path: "/a", mtime: 1 }, { path: "/b", mtime: 2 }];
    const out = sortSessionsByMtimeDesc(sessions);
    assert.equal(out, sessions);
  });

  test("handles empty and single-element arrays", () => {
    const empty = [];
    assert.equal(sortSessionsByMtimeDesc(empty), empty);
    assert.deepEqual(empty, []);

    const one = [{ path: "/only", mtime: 42 }];
    sortSessionsByMtimeDesc(one);
    assert.deepEqual(one, [{ path: "/only", mtime: 42 }]);
  });

  test("orders by mtime descending with Date and epoch-ms values", () => {
    const sessions = [
      { path: "/a", mtime: new Date(1000) },
      { path: "/b", mtime: 3000 },
      { path: "/c", mtime: new Date(2000) },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(sessions.map((s) => s.path), ["/b", "/c", "/a"]);
  });

  test("re-sorts ascending input to newest-first", () => {
    const sessions = [
      { path: "/old", mtime: 100 },
      { path: "/mid", mtime: 200 },
      { path: "/new", mtime: 300 },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(sessions.map((s) => s.path), ["/new", "/mid", "/old"]);
  });

  test("leaves already-descending lists valid", () => {
    const sessions = [
      { path: "/new", mtime: 5000 },
      { path: "/old", mtime: 1000 },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.equal(sessions[0].path, "/new");
    assert.equal(sessions[1].path, "/old");
  });

  test("sinks missing and zero mtimes below positive values", () => {
    const sessions = [
      { path: "/zero-date", mtime: new Date(0) },
      { path: "/big", mtime: 9000 },
      { path: "/missing" },
      { path: "/zero-num", mtime: 0 },
      { path: "/nan", mtime: NaN },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.equal(sessions[0].path, "/big");
    const tail = sessions.slice(1).map((s) => s.path).sort();
    assert.deepEqual(tail, ["/missing", "/nan", "/zero-date", "/zero-num"].sort());
  });

  test("sorts negative epoch ms correctly (older < newer)", () => {
    const sessions = [
      { path: "/b", mtime: -10 },
      { path: "/a", mtime: -100 },
      { path: "/c", mtime: -1 },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(sessions.map((s) => s.path), ["/c", "/b", "/a"]);
  });

  test("keeps all rows when mtimes tie", () => {
    const sessions = [
      { path: "/x", mtime: 1000 },
      { path: "/y", mtime: new Date(1000) },
      { path: "/z", mtime: 1000 },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.equal(sessions.length, 3);
    assert.deepEqual(new Set(sessions.map((s) => s.path)), new Set(["/x", "/y", "/z"]));
    assert.ok(sessionMtimeMs(sessions[0]) >= sessionMtimeMs(sessions[1]));
    assert.ok(sessionMtimeMs(sessions[1]) >= sessionMtimeMs(sessions[2]));
  });
});

describe("sessionListChecksum with sessionMtimeMs", () => {
  test("checksum uses sessionMtimeMs for Date and number mtimes", () => {
    const asNumber = [{ path: "/p/a.jsonl", mtime: 2000, size: 10 }];
    const asDate = [{ path: "/p/a.jsonl", mtime: new Date(2000), size: 10 }];
    assert.equal(sessionListChecksum(asNumber), sessionListChecksum(asDate));
  });

  test("checksum differs when mtime coercion would differ", () => {
    const good = [{ path: "/p/a.jsonl", mtime: 2000, size: 10 }];
    const bad = [{ path: "/p/a.jsonl", mtime: "2000", size: 10 }];
    assert.notEqual(sessionListChecksum(good), sessionListChecksum(bad));
  });
});