import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { buildScannerRedactorSrc } from "../../src/share/share-bundle.js";

describe("share bundle", () => {
  test("buildScannerRedactorSrc includes all scanner helpers", () => {
    const src = buildScannerRedactorSrc();
    assert.ok(!src.includes("export "));
  });

  test("inlined bundle executes scanSessionForSecrets in VM", () => {
    const src = buildScannerRedactorSrc();
    const rules = [{ id: "t", description: "t", regex: "sk-[A-Za-z0-9]{16,}", keywords: ["sk-"] }];
    const body = `${src}
      const session = { events: [{ type: 'user', text: 'sk-fake1234567890abcdef' }] };
      scanSessionForSecrets(session, ${JSON.stringify(rules)}).length;
    `;
    const count = new Script(body).runInNewContext({ Object, Array, String, Math, Set, structuredClone: (v) => JSON.parse(JSON.stringify(v)) });
    assert.equal(count, 1);
  });
});