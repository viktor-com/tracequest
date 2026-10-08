import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseJsonlLine,
  forEachJsonlLine,
  splitJsonlLines,
  forEachParsedJsonlLine,
  collectParsedJsonlLines,
  readPartialJsonlLines,
  forEachPartialJsonlLine,
  forEachPartialParsedJsonlLine,
  forEachJsonlLineFromFile,
} from "../../src/parse/jsonl-read.js";
import { isClaudeIndexSkippableLine } from "../../src/parse/claude-jsonl-index.js";
import { assertPerf } from "../helpers/perf-assert.js";

const JSONL_READ_SRC = readFileSync("src/parse/jsonl-read.js", "utf8");

function withJsonlFile(name, body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jsonl-read-${name}-`));
  const filePath = path.join(dir, "data.jsonl");
  fs.writeFileSync(filePath, body, "utf8");
  try {
    return fn(filePath, dir, body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertForEachJsonlLineFromFileUsesBufferCopy() {
  const fnStart = JSONL_READ_SRC.indexOf("export function forEachJsonlLineFromFile");
  assert.ok(fnStart >= 0, "forEachJsonlLineFromFile export");
  const fnBody = JSONL_READ_SRC.slice(fnStart, fnStart + 2800);
  assert.doesNotMatch(fnBody, /pending\.length\s*>\s*0\s*\?\s*pending\s*\+\s*chunk/);
  assert.doesNotMatch(fnBody, /pending\.slice\s*\(\s*pendingStart\s*\)\s*\+\s*chunk/);
  assert.match(fnBody, /readBuf\.copy\s*\(\s*mergeBuf/);
  assert.match(fnBody, /readBuf\.copy\s*\(\s*pendingBuf,\s*pendingLen/);
  assert.match(fnBody, /lastNlInChunk\s*===\s*-1/);
  assert.match(fnBody, /pendingBuf/);
  assert.match(fnBody, /lastIndexOf\(0x0a/);
}

describe("jsonl-read", () => {
  test("parseJsonlLine returns null for empty, whitespace, and malformed JSONL", () => {
    assert.equal(parseJsonlLine(""), null);
    assert.equal(parseJsonlLine("   "), null);
    assert.equal(parseJsonlLine("{bad"), null);
    assert.equal(parseJsonlLine("not-json"), null);
    assert.deepEqual(parseJsonlLine('{"a":1}'), { a: 1 });
  });

  test("parseJsonlLine logs malformed JSONL lines", () => {
    const errorSpy = mock.method(console, "error", () => {});
    try {
      assert.equal(parseJsonlLine("{bad"), null);
      assert.equal(errorSpy.mock.callCount(), 1);
      const [prefix, detail] = errorSpy.mock.calls[0].arguments;
      assert.match(String(prefix), /parseJsonlLine: malformed JSONL line/);
      assert.match(String(detail), /JSON/);
    } finally {
      errorSpy.mock.restore();
    }
  });

  test("forEachJsonlLine on empty string visits nothing", () => {
    const lines = [];
    forEachJsonlLine("", (line) => lines.push(line));
    assert.deepEqual(lines, []);
  });

  test("forEachJsonlLine visits every non-empty line including final line without newline", () => {
    const lines = [];
    forEachJsonlLine("a\n\nb\nc", (line) => lines.push(line));
    assert.deepEqual(lines, ["a", "b", "c"]);

    const tail = [];
    forEachJsonlLine('{"only":true}', (line) => tail.push(line));
    assert.deepEqual(tail, ['{"only":true}']);
  });

  test("splitJsonlLines on empty and whitespace-only input", () => {
    assert.deepEqual(splitJsonlLines(""), []);
    assert.deepEqual(splitJsonlLines("   \n\n  "), []);
    assert.deepEqual(splitJsonlLines("  x\n\ny \n"), ["x", "y"]);
  });

  test("forEachParsedJsonlLine skips malformed lines", () => {
    const objs = [];
    forEachParsedJsonlLine('{bad\n{"b":2}\n', (o) => objs.push(o));
    assert.deepEqual(objs, [{ b: 2 }]);
  });

  test("collectParsedJsonlLines gathers all valid objects", () => {
    assert.deepEqual(collectParsedJsonlLines('{"a":1}\n{bad\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
  });

  test("collectParsedJsonlLines matches forEachParsedJsonlLine on mixed input", () => {
    const raw = '{"x":1}\n{broken\n{"y":2}\n\n{"z":3}';
    const collected = collectParsedJsonlLines(raw);
    const iterated = [];
    forEachParsedJsonlLine(raw, (o) => iterated.push(o));
    assert.deepEqual(collected, iterated);
    assert.deepEqual(collected, [{ x: 1 }, { y: 2 }, { z: 3 }]);
  });

  test("collect and forEach both return empty arrays for empty trimmed input", () => {
    assert.deepEqual(collectParsedJsonlLines(""), []);
    assert.deepEqual(collectParsedJsonlLines("  \n  "), []);
    const viaForEach = [];
    forEachParsedJsonlLine("  \n  ", (o) => viaForEach.push(o));
    assert.deepEqual(viaForEach, []);
  });

  test("collectParsedJsonlLines on malformed-only input yields nothing", () => {
    assert.deepEqual(collectParsedJsonlLines("{nope\nstill-bad"), []);
  });

  test("readPartialJsonlLines on empty file returns no lines", () => {
    withJsonlFile("empty", "", (filePath) => {
      assert.deepEqual(readPartialJsonlLines(filePath, 0), []);
      assert.deepEqual(readPartialJsonlLines(filePath, 0, 1024), []);
    });
  });

  test("readPartialJsonlLines drops trailing partial line when prefix ends mid-record", () => {
    withJsonlFile("partial", '{"a":1}\n{"b":2}\n{"c":3}', (filePath, _dir, full) => {
      const prefixBytes = Buffer.byteLength('{"a":1}\n{"b":2}\n{"c');
      const lines = readPartialJsonlLines(filePath, full.length, prefixBytes);
      assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    });
  });

  test("readPartialJsonlLines with no newline in buffer yields one raw fragment", () => {
    withJsonlFile("only-partial", '{"incomplete":', (filePath, _dir, full) => {
      const prefixBytes = Buffer.byteLength('{"incom');
      const lines = readPartialJsonlLines(filePath, full.length, prefixBytes);
      assert.deepEqual(lines, ['{"incom']);
      const parsed = [];
      forEachPartialParsedJsonlLine(filePath, full.length, (o) => parsed.push(o), prefixBytes);
      assert.deepEqual(parsed, []);
    });
  });

  test("readPartialJsonlLines skips huge trailing line beyond maxBytes", () => {
    const ok = '{"ok":true}\n';
    const huge = "x".repeat(64 * 1024);
    const body = ok + huge;
    withJsonlFile("huge-tail", body, (filePath, _dir, full) => {
      const maxBytes = Buffer.byteLength(ok) + 4096;
      const lines = readPartialJsonlLines(filePath, full.length, maxBytes);
      assert.deepEqual(lines, [ok.trimEnd()]);
    });
  });

  test("readPartialJsonlLines respects fileSize smaller than maxBytes", () => {
    withJsonlFile("small-size", '{"a":1}\n{"b":2}\n{"c":3}\n', (filePath) => {
      const cap = Buffer.byteLength('{"a":1}\n{"b":2}\n');
      const lines = readPartialJsonlLines(filePath, cap, 1024 * 1024);
      assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    });
  });

  test("forEachPartialJsonlLine matches readPartialJsonlLines on same prefix", () => {
    const body = '{"a":1}\n{"b":2}\n{"c":3}\n';
    withJsonlFile("foreach-partial", body, (filePath, _dir, full) => {
      const fromArray = readPartialJsonlLines(filePath, null, full.length + 64);
      const fromForEach = [];
      forEachPartialJsonlLine(filePath, null, (line) => fromForEach.push(line), full.length + 64);
      assert.deepEqual(fromForEach, fromArray);
    });
  });

  test("forEachPartialJsonlLine early exit skips remaining lines", () => {
    withJsonlFile("foreach-stop", '{"a":1}\n{"b":2}\n{"c":3}\n', (filePath) => {
      const seen = [];
      forEachPartialJsonlLine(filePath, null, (line) => {
        seen.push(line);
        return false;
      });
      assert.deepEqual(seen, ['{"a":1}']);
    });
  });

  test("forEachPartialJsonlLine on empty file visits nothing", () => {
    withJsonlFile("foreach-empty", "", (filePath) => {
      let n = 0;
      forEachPartialJsonlLine(filePath, 0, () => {
        n++;
      });
      assert.equal(n, 0);
    });
  });

  test("forEachPartialJsonlLine avoids lines array on large prefix (perf)", () => {
    const lines = [];
    for (let i = 0; i < 6000; i++) {
      lines.push(JSON.stringify({ type: "noise", n: i, payload: "x".repeat(24) }));
    }
    const body = lines.join("\n") + "\n";
    withJsonlFile("foreach-perf", body, (filePath, _dir, full) => {
      assert.ok(full.length < 512 * 1024, "fixture must fit default peek prefix");
      const WARMUP = 4;
      const TIMED = 16;
      const streamSamples = [];
      const arraySamples = [];
      for (let i = 0; i < WARMUP + TIMED; i++) {
        const t0 = performance.now();
        let streamCount = 0;
        forEachPartialJsonlLine(filePath, full.length, () => {
          streamCount++;
        });
        const streamMs = performance.now() - t0;

        const t1 = performance.now();
        let arrayCount = 0;
        for (const _line of readPartialJsonlLines(filePath, full.length)) {
          arrayCount++;
        }
        const arrayMs = performance.now() - t1;
        assert.equal(streamCount, arrayCount);
        assert.equal(streamCount, 6000);
        if (i >= WARMUP) {
          streamSamples.push(streamMs);
          arraySamples.push(arrayMs);
        }
      }
      streamSamples.sort((a, b) => a - b);
      arraySamples.sort((a, b) => a - b);
      const streamMed = streamSamples[Math.floor(streamSamples.length / 2)];
      const arrayMed = arraySamples[Math.floor(arraySamples.length / 2)];
      assert.ok(
        streamMed < arrayMed * 0.9,
        `expected streaming prefix read faster than array+iterate (stream=${streamMed.toFixed(2)}ms array=${arrayMed.toFixed(2)}ms)`,
      );
    });
  });

  test("forEachPartialParsedJsonlLine parses prefix objects", () => {
    withJsonlFile("peek", '{"type":"user","n":1}\n{"type":"assistant","n":2}\n', (filePath) => {
      const types = [];
      forEachPartialParsedJsonlLine(filePath, null, (o) => types.push(o.type));
      assert.deepEqual(types, ["user", "assistant"]);
    });
  });

  test("forEachPartialParsedJsonlLine matches collect on same prefix read", () => {
    const body = '{"k":1}\n{bad\n{"k":2}\n{"k":3}';
    withJsonlFile("partial-collect", body, (filePath, _dir, full) => {
      const prefixBytes = Buffer.byteLength('{"k":1}\n{bad\n{"k":2}\n{"k":');
      const rawLines = readPartialJsonlLines(filePath, full.length, prefixBytes);
      const fromCollect = rawLines
        .map((line) => parseJsonlLine(line))
        .filter((o) => o != null);

      const fromForEach = [];
      forEachPartialParsedJsonlLine(filePath, full.length, (o) => fromForEach.push(o), prefixBytes);
      assert.deepEqual(fromForEach, fromCollect);
      assert.deepEqual(fromForEach, [{ k: 1 }, { k: 2 }]);
    });
  });

  test("forEachPartialParsedJsonlLine skips malformed lines in prefix", () => {
    withJsonlFile("partial-malformed", 'not-json\n{"v":1}\n', (filePath) => {
      const out = [];
      forEachPartialParsedJsonlLine(filePath, null, (o) => out.push(o));
      assert.deepEqual(out, [{ v: 1 }]);
    });
  });

  test("forEachParsedJsonlLine and collect skip JSON null, false, and 0 (falsy parsed values)", () => {
    const raw = "null\nfalse\n0\n[]\n\"ok\"\n{\"x\":1}";
    const collected = collectParsedJsonlLines(raw);
    assert.deepEqual(collected, [[], "ok", { x: 1 }]);

    const iterated = [];
    forEachParsedJsonlLine(raw, (o) => iterated.push(o));
    assert.deepEqual(iterated, collected);
  });

  test("splitJsonlLines and collect treat non-string input as empty", () => {
    assert.deepEqual(splitJsonlLines(null), []);
    assert.deepEqual(splitJsonlLines(undefined), []);
    assert.deepEqual(collectParsedJsonlLines(42), []);
    const viaForEach = [];
    forEachParsedJsonlLine(false, (o) => viaForEach.push(o));
    assert.deepEqual(viaForEach, []);
  });

  test("readPartialJsonlLines with fileSize 0 reads nothing; null fileSize uses maxBytes", () => {
    withJsonlFile("size-edges", '{"a":1}\n{"b":2}\n', (filePath, _dir, full) => {
      assert.deepEqual(readPartialJsonlLines(filePath, 0), []);
      assert.deepEqual(readPartialJsonlLines(filePath, 0, 1024), []);

      const lines = readPartialJsonlLines(filePath, null, full.length + 64);
      assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    });
  });

  test("forEachJsonlLine preserves CRLF carriage return on line slices", () => {
    const lines = [];
    forEachJsonlLine('{"a":1}\r\n{"b":2}\r\n', (line) => lines.push(line));
    assert.deepEqual(lines, ['{"a":1}\r', '{"b":2}\r']);
    assert.deepEqual(collectParsedJsonlLines('{"a":1}\r\n{"b":2}\r\n'), [{ a: 1 }, { b: 2 }]);
  });

  test("forEachJsonlLineFromFile matches forEachJsonlLine on same bytes", () => {
    const body = '{"a":1}\n\n{"b":2}\n{"c":3}';
    const fromString = [];
    forEachJsonlLine(body, (line) => fromString.push(line));

    withJsonlFile("from-file", body, (filePath) => {
      const fromFile = [];
      forEachJsonlLineFromFile(filePath, (line) => fromFile.push(line));
      assert.deepEqual(fromFile, fromString);
    });
  });

  test("forEachJsonlLineFromFile supports early stop", () => {
    withJsonlFile("early-stop", '{"a":1}\n{"b":2}\n{"c":3}\n', (filePath) => {
      const lines = [];
      forEachJsonlLineFromFile(filePath, (line) => {
        lines.push(line);
        return lines.length >= 2 ? false : undefined;
      });
      assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    });
  });

  test("forEachJsonlLine supports early stop like file stream", () => {
    const body = '{"a":1}\n{"b":2}\n{"c":3}\n';
    const lines = [];
    forEachJsonlLine(body, (line) => {
      lines.push(line);
      return lines.length >= 2 ? false : undefined;
    });
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  test("forEachJsonlLineFromFile streams very long lines without per-chunk string growth (perf)", () => {
    assertForEachJsonlLineFromFileUsesBufferCopy();

    const payload = "x".repeat(2 * 1024 * 1024);
    const body =
      JSON.stringify({ type: "blob", payload }) +
      "\n" +
      Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i })).join("\n") +
      "\n";
    withJsonlFile("long-line", body, (filePath) => {
      const lines = [];
      forEachJsonlLineFromFile(filePath, (line) => lines.push(line));
      assert.equal(lines.length, 51);
      assert.equal(JSON.parse(lines[0]).payload.length, payload.length);

      const WARMUP = 3;
      const TIMED = 12;
      for (let w = 0; w < WARMUP; w++) {
        let n = 0;
        forEachJsonlLineFromFile(filePath, () => n++);
      }
      const samples = [];
      for (let i = 0; i < TIMED; i++) {
        const t0 = performance.now();
        let n = 0;
        forEachJsonlLineFromFile(filePath, () => n++);
        samples.push(performance.now() - t0);
        assert.equal(n, 51);
      }
      samples.sort((a, b) => a - b);
      const med = samples[Math.floor(samples.length / 2)];
      assertPerf(
        med < 8,
        `expected 2MB long-line stream under 8ms/op, got ${med.toFixed(2)}ms`,
      );
    });
  });

  test("forEachJsonlLineFromFile offset callbacks skip slice on gated filler rows (perf)", () => {
    const filler = JSON.stringify({ type: "progress", data: "x".repeat(200) });
    const indexed = JSON.stringify({ type: "user", message: { content: "hello" } });
    const lines = [];
    for (let i = 0; i < 7990; i++) lines.push(filler);
    for (let i = 0; i < 10; i++) lines.push(indexed);
    const body = lines.join("\n") + "\n";

    withJsonlFile("offset-gate", body, (filePath) => {
      const WARMUP = 4;
      const TIMED = 16;
      let offsetWins = 0;
      const ratioSamples = [];

      for (let i = 0; i < WARMUP + TIMED; i++) {
        const t0 = performance.now();
        let n = 0;
        forEachJsonlLineFromFile(filePath, (line) => {
          if (isClaudeIndexSkippableLine(line)) return;
          n++;
        });
        const sliceMs = performance.now() - t0;

        const t1 = performance.now();
        let n2 = 0;
        forEachJsonlLineFromFile(filePath, (text, start, end) => {
          if (isClaudeIndexSkippableLine(text, start, end)) return;
          n2++;
        });
        const offsetMs = performance.now() - t1;

        assert.equal(n, 10);
        assert.equal(n2, 10);
        if (i >= WARMUP) {
          if (offsetMs < sliceMs) offsetWins++;
          ratioSamples.push(offsetMs / sliceMs);
        }
      }

      ratioSamples.sort((a, b) => a - b);
      const ratioMed = ratioSamples[Math.floor(ratioSamples.length / 2)];
      // Paired per-iter samples: offset wins most rounds and stays faster on median.
      // Replaces 0.88× separate-medians cap that flaked when offset was faster but
      // not by 12% under sub-ms timer noise.
      assert.ok(
        offsetWins >= 9 && ratioMed < 1,
        `expected offset skipLine faster than per-line slice (wins=${offsetWins}/${TIMED} ratio=${ratioMed.toFixed(3)})`,
      );
    });
  });

  test("forEachJsonlLineFromFile avoids re-concatenating consumed chunks (perf)", () => {
    assertForEachJsonlLineFromFileUsesBufferCopy();

    const lines = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "progress", n: i, payload: "x".repeat(200) }));
    }
    const body = lines.join("\n") + "\n";
    withJsonlFile("from-file-perf", body, (filePath) => {
      const fromString = [];
      forEachJsonlLine(body, (line) => fromString.push(line));

      const fromFile = [];
      forEachJsonlLineFromFile(filePath, (line) => fromFile.push(line));
      assert.equal(fromFile.length, fromString.length);

      const ITERS = 24;
      for (let w = 0; w < 4; w++) {
        let n = 0;
        forEachJsonlLineFromFile(filePath, () => n++);
      }
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        let n = 0;
        forEachJsonlLineFromFile(filePath, () => n++);
        assert.equal(n, 8000);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 1,
        `expected forEachJsonlLineFromFile under 1ms/op on 8k-line file, got ${ms.toFixed(3)}ms`,
      );
    });
  });
});