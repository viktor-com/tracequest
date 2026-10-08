import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sessionListChecksum,
  sortSessionsByMtimeDesc,
} from "../../src/sessions/session-list.js";

/** Minimal session row for checksum tests. */
function row(path, mtime, size = 0) {
  return { path, mtime, size };
}

describe("sessionListChecksum", () => {
  test("returns 0 for an empty session list", () => {
    assert.equal(sessionListChecksum([]), 0);
  });

  test("is stable across repeated calls on the same list", () => {
    const sessions = [
      row("/home/u/.claude/projects/p/a.jsonl", 1_700_000_000_000, 128),
      row("/home/u/.claude/projects/p/b.jsonl", 1_700_000_100_000, 256),
    ];
    const once = sessionListChecksum(sessions);
    assert.equal(sessionListChecksum(sessions), once);
    assert.equal(sessionListChecksum([...sessions]), once);
  });

  test("changes when the only session mtime advances", () => {
    const before = [row("/tmp/solo.jsonl", 1000, 10)];
    const after = [row("/tmp/solo.jsonl", 1001, 10)];
    assert.notEqual(sessionListChecksum(before), sessionListChecksum(after));
  });

  test("changes when a middle session mtime changes in a multi-row list", () => {
    const base = [
      row("/tmp/a.jsonl", 3000, 1),
      row("/tmp/b.jsonl", 2000, 2),
      row("/tmp/c.jsonl", 1000, 3),
    ];
    const bumped = base.map((s, i) =>
      i === 1 ? { ...s, mtime: 2001 } : s
    );
    assert.notEqual(sessionListChecksum(base), sessionListChecksum(bumped));
  });

  test("treats Date and epoch-ms mtimes as equivalent via sessionMtimeMs", () => {
    const asMs = [row("/tmp/dated.jsonl", 1_718_000_000_000, 42)];
    const asDate = [row("/tmp/dated.jsonl", new Date(1_718_000_000_000), 42)];
    assert.equal(sessionListChecksum(asMs), sessionListChecksum(asDate));
  });

  test("differs when mtime is coerced to 0 (invalid) vs a real epoch", () => {
    const valid = [row("/tmp/coerce.jsonl", 5000, 10)];
    const invalid = [row("/tmp/coerce.jsonl", "5000", 10)];
    assert.notEqual(sessionListChecksum(valid), sessionListChecksum(invalid));
  });

  test("changes when file size changes at fixed mtime and path", () => {
    const small = [row("/tmp/size.jsonl", 9000, 10)];
    const large = [row("/tmp/size.jsonl", 9000, 11)];
    assert.notEqual(sessionListChecksum(small), sessionListChecksum(large));
  });

  test("changes when path first character differs at equal length", () => {
    const a = [row("A/tmp/s.jsonl", 1000, 1)];
    const b = [row("B/tmp/s.jsonl", 1000, 1)];
    assert.notEqual(sessionListChecksum(a), sessionListChecksum(b));
  });

  test("changes when path last character differs for paths longer than four", () => {
    const a = [row("/tmp/alpha.jsona", 1000, 1)];
    const b = [row("/tmp/alpha.jsonb", 1000, 1)];
    assert.notEqual(sessionListChecksum(a), sessionListChecksum(b));
  });

  test("changes when path string length differs", () => {
    const short = [row("/tmp/s.jsonl", 1000, 1)];
    const long = [row("/tmp/extra/deep/s.jsonl", 1000, 1)];
    assert.notEqual(sessionListChecksum(short), sessionListChecksum(long));
  });

  test("changes when a session is appended (membership / length)", () => {
    const one = [row("/tmp/only.jsonl", 1000, 1)];
    const two = [...one, row("/tmp/second.jsonl", 2000, 2)];
    assert.notEqual(sessionListChecksum(one), sessionListChecksum(two));
  });

  test("changes when a session is removed from the list", () => {
    const two = [
      row("/tmp/x.jsonl", 3000, 3),
      row("/tmp/y.jsonl", 2000, 2),
    ];
    const one = [two[0]];
    assert.notEqual(sessionListChecksum(two), sessionListChecksum(one));
  });

  test("is order-invariant when the same sessions are permuted", () => {
    const a = row("/tmp/a.jsonl", 1000, 10);
    const b = row("/tmp/b.jsonl", 2000, 20);
    assert.equal(sessionListChecksum([a, b]), sessionListChecksum([b, a]));
  });

  test("all permutations of three sessions yield the same checksum", () => {
    const rows = [
      row("/home/u/.claude/projects/p/alpha.jsonl", 3000, 11),
      row("/home/u/.claude/projects/p/beta.jsonl", 2000, 22),
      row("/home/u/.claude/projects/p/gamma.jsonl", 1000, 33),
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const expected = sessionListChecksum(rows);
    for (const order of permutations) {
      const shuffled = order.map((i) => rows[i]);
      assert.equal(sessionListChecksum(shuffled), expected);
    }
  });

  test("reverse and cyclic rotation preserve checksum for four sessions", () => {
    const rows = [
      row("/tmp/w1/s0.jsonl", 4000, 1),
      row("/tmp/w1/s1.jsonl", 3000, 2),
      row("/tmp/w1/s2.jsonl", 2000, 3),
      row("/tmp/w1/s3.jsonl", 1000, 4),
    ];
    const baseline = sessionListChecksum(rows);
    assert.equal(sessionListChecksum([...rows].reverse()), baseline);
    assert.equal(sessionListChecksum([...rows.slice(1), rows[0]]), baseline);
    assert.equal(
      sessionListChecksum([rows[2], rows[3], rows[0], rows[1]]),
      baseline
    );
  });

  test("checksum matches after sortSessionsByMtimeDesc regardless of input order", () => {
    const newest = row("/tmp/newest.jsonl", 9000, 99);
    const mid = row("/tmp/mid.jsonl", 5000, 50);
    const oldest = row("/tmp/oldest.jsonl", 1000, 1);
    const ascending = [oldest, mid, newest];
    const descending = [newest, mid, oldest];
    const scrambled = [mid, oldest, newest];

    const sorted = sortSessionsByMtimeDesc([...scrambled]);
    const fromSort = sessionListChecksum(sorted);
    assert.equal(sessionListChecksum(ascending), fromSort);
    assert.equal(sessionListChecksum(descending), fromSort);
    assert.equal(sessionListChecksum(scrambled), fromSort);
    assert.deepEqual(sorted.map((s) => s.path), [
      "/tmp/newest.jsonl",
      "/tmp/mid.jsonl",
      "/tmp/oldest.jsonl",
    ]);
  });

  test("order change alone does not mask mtime or size drift", () => {
    const base = [
      row("/tmp/x.jsonl", 1000, 1),
      row("/tmp/y.jsonl", 2000, 2),
    ];
    const reordered = [base[1], base[0]];
    const changed = [
      row("/tmp/x.jsonl", 1001, 1),
      row("/tmp/y.jsonl", 2000, 2),
    ];
    assert.equal(sessionListChecksum(base), sessionListChecksum(reordered));
    assert.notEqual(sessionListChecksum(base), sessionListChecksum(changed));
  });

  test("changes when a row is replaced at the same index (sorted-order swap)", () => {
    const first = [
      row("/tmp/newer.jsonl", 5000, 1),
      row("/tmp/older.jsonl", 1000, 1),
    ];
    const swapped = [
      row("/tmp/newer.jsonl", 5000, 1),
      row("/tmp/other.jsona", 1000, 1),
    ];
    assert.notEqual(sessionListChecksum(first), sessionListChecksum(swapped));
  });

  test("folds missing size as zero without throwing on empty path", () => {
    const withSize = [{ path: "", mtime: 0, size: 5 }];
    const withoutSize = [{ path: "", mtime: 0 }];
    assert.notEqual(sessionListChecksum(withSize), sessionListChecksum(withoutSize));
    assert.equal(sessionListChecksum(withoutSize), sessionListChecksum([{ path: "", mtime: 0, size: 0 }]));
  });
});