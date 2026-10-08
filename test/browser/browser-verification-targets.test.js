import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readPackageJson() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

function testsReadme() {
  return readFileSync(join(ROOT, "tests", "README.md"), "utf8");
}

function browserPlaywrightTests() {
  return readdirSync(join(ROOT, "test", "browser"))
    .filter((name) => name.endsWith(".playwright.test.js"))
    .map((name) => `test/browser/${name}`)
    .sort();
}

function integrationSpecFiles() {
  return readdirSync(join(ROOT, "tests"))
    .filter((name) => name === "integration.md" || name.endsWith("-integration.md"))
    .map((name) => `tests/${name}`)
    .sort();
}

function integrationHarnesses() {
  const { scripts } = readPackageJson();
  return [...scripts["test:integration"].matchAll(/\btest\/bin\/\S+-integration\.test\.js\b/g)]
    .map((match) => match[0]);
}

function countNodeTestCases(testPath) {
  const source = readFileSync(join(ROOT, testPath), "utf8");
  return (source.match(/^\s*test\s*\(/gm) ?? []).length;
}

function harnessIndexRows() {
  const readme = testsReadme();
  return [...readme.matchAll(/^\| ([^|]+) \| ([^|]+) \|\s*(\d+)\s*\| ([^|]+) \|$/gm)]
    .map((match) => ({
      name: match[1].trim(),
      tests: Number(match[3]),
    }));
}

function integrationSpecHeaderCounts() {
  const integrationHarnessSet = new Set(integrationHarnesses());

  return integrationSpecFiles()
    .map((specPath) => {
      const source = readFileSync(join(ROOT, specPath), "utf8");
      const header = source.match(/^Automated harness:\s*`([^`]+)`([^\n]*)$/m);
      if (!header || !integrationHarnessSet.has(header[1])) return null;
      const count = header[2].match(/\((\d+) scenarios(?:[;)])/);
      return {
        specPath,
        harness: header[1],
        declared: count ? Number(count[1]) : null,
        line: header[0],
      };
    })
    .filter(Boolean);
}

function coreIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-integration.test.js"), "utf8");
}

function coreIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "integration.md"), "utf8");
}

function livereloadIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-livereload-integration.test.js"), "utf8");
}

function livereloadIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "livereload-integration.md"), "utf8");
}

function largeSessionIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-large-session-integration.test.js"), "utf8");
}

function largeSessionIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "large-session-integration.md"), "utf8");
}

function presetIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-preset-integration.test.js"), "utf8");
}

function presetIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "preset-integration.md"), "utf8");
}

function messagesFormatIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-messages-format-integration.test.js"), "utf8");
}

function messagesFormatIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "messages-format-integration.md"), "utf8");
}

function renderMessagesIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-render-messages-integration.test.js"), "utf8");
}

function renderMessagesIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "render-messages-integration.md"), "utf8");
}

function agentHistoryIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-agent-history-integration.test.js"), "utf8");
}

function agentHistoryIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "agent-history-integration.md"), "utf8");
}

function opencodeIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-opencode-integration.test.js"), "utf8");
}

function opencodeIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "opencode-integration.md"), "utf8");
}

function codexIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-codex-integration.test.js"), "utf8");
}

function codexIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "codex-integration.md"), "utf8");
}

function factoryIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-factory-integration.test.js"), "utf8");
}

function factoryIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "factory-integration.md"), "utf8");
}

function grokIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-grok-integration.test.js"), "utf8");
}

function grokIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "grok-integration.md"), "utf8");
}

function multiSourceIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-multi-source-integration.test.js"), "utf8");
}

function multiSourceIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "multi-source-integration.md"), "utf8");
}

function indexSearchIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-index-search-integration.test.js"), "utf8");
}

function indexSearchIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "index-search-integration.md"), "utf8");
}

function edgeIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-edge-integration.test.js"), "utf8");
}

function edgeIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "edge-integration.md"), "utf8");
}

function sidecarIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-sidecar-integration.test.js"), "utf8");
}

function sidecarIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "sidecar-integration.md"), "utf8");
}

function serveIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-serve-integration.test.js"), "utf8");
}

function serveIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "serve-integration.md"), "utf8");
}

function sharingIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-sharing-integration.test.js"), "utf8");
}

function sharingIntegrationSpec() {
  return readFileSync(join(ROOT, "tests", "sharing-integration.md"), "utf8");
}

function stressIntegrationSource() {
  return readFileSync(join(ROOT, "test", "bin", "tracequest-stress-integration.test.js"), "utf8");
}

function numericSort(values) {
  return [...values].sort((a, b) => Number(a) - Number(b));
}

function compareTestNumbers(a, b) {
  const [, aNum, aSuffix = ""] = String(a).match(/^(\d+)([a-z]*)$/) ?? [];
  const [, bNum, bSuffix = ""] = String(b).match(/^(\d+)([a-z]*)$/) ?? [];
  if (aNum && bNum && Number(aNum) !== Number(bNum)) {
    return Number(aNum) - Number(bNum);
  }
  return aSuffix.localeCompare(bSuffix);
}

function testNumberSort(values) {
  return [...values].sort(compareTestNumbers);
}

function formatTestList(values) {
  const sorted = testNumberSort(values);
  if (sorted.length <= 1) return `Tests ${sorted.join("")}`;
  if (sorted.length === 2) return `Tests ${sorted.join(" and ")}`;
  return `Tests ${sorted.slice(0, -1).join(", ")}, and ${sorted.at(-1)}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("package scripts keep Playwright browser coverage explicit", () => {
  const { scripts } = readPackageJson();

  assert.match(scripts.test, /\bTRACEQUEST_SKIP_PLAYWRIGHT=1\b/);
  assert.match(scripts["test:browser"], /\bTRACEQUEST_SKIP_LR_WATCH=1\b/);
  assert.match(scripts["test:browser"], /(^|\s)--test-concurrency=1(\s|$)/);
  assert.match(scripts["test:browser"], /(^|\s)test\/browser\/\*\.playwright\.test\.js(\s|$)/);
  assert.ok(
    browserPlaywrightTests().includes("test/browser/live-ui-served.playwright.test.js"),
    "test:browser glob must include served live UI Playwright coverage",
  );
});

test("package scripts keep browser Playwright tests out of integration target", () => {
  const { scripts } = readPackageJson();

  assert.match(scripts["test:integration"], /\btest\/bin\/tracequest-integration\.test\.js\b/);
  assert.doesNotMatch(scripts["test:integration"], /\btest\/browser\//);
  assert.doesNotMatch(scripts["test:integration"], /\.playwright\.test\.js\b/);

  for (const browserTest of browserPlaywrightTests()) {
    assert.ok(
      !scripts["test:integration"].includes(browserTest),
      `${browserTest} belongs to test:browser, not test:integration`,
    );
  }
});

test("CI does not rerun integration harnesses already covered by npm test", () => {
  const { scripts } = readPackageJson();
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const livereloadHarness = "test/bin/tracequest-livereload-integration.test.js";
  const livereloadSource = livereloadIntegrationSource();

  assert.match(scripts.test, /(^|\s)test\/\*\*\/\*\.test\.js(\s|$)/);
  assert.match(scripts["test:integration"], /\btest\/bin\/tracequest-integration\.test\.js\b/);
  assert.ok(
    scripts["test:integration"].includes(livereloadHarness),
    "focused integration target must include the livereload subprocess harness",
  );
  assert.ok(
    integrationHarnesses().includes(livereloadHarness),
    "recursive npm test coverage should include non-Playwright integration harnesses",
  );
  assert.match(
    livereloadSource,
    /Test 9: nested browser helper edit refreshes served root HTML after reload/,
  );
  assert.match(livereloadSource, /delete env\.TRACEQUEST_SKIP_LR_WATCH/);
  assert.doesNotMatch(ci, /^\s*run:\s*npm run test:integration\b/m);
});

test("tests README scenario totals match package test targets and harness rows", () => {
  const readme = testsReadme();
  const rows = harnessIndexRows();
  const browserRows = rows.filter((row) => row.name.includes("(browser)"));
  const nonBrowserRows = rows.filter((row) => !row.name.includes("(browser)"));
  const integrationTotal = integrationHarnesses().reduce(
    (sum, testPath) => sum + countNodeTestCases(testPath),
    0,
  );
  const browserTotal = browserPlaywrightTests().reduce(
    (sum, testPath) => sum + countNodeTestCases(testPath),
    0,
  );
  const rowTotal = rows.reduce((sum, row) => sum + row.tests, 0);
  const nonBrowserRowTotal = nonBrowserRows.reduce((sum, row) => sum + row.tests, 0);
  const browserRowTotal = browserRows.reduce((sum, row) => sum + row.tests, 0);
  const quickStartIntegration = readme.match(
    /# Non-Playwright integration harnesses \((\d+) scenarios\)\nnpm run test:integration/,
  );
  const quickStartBrowser = readme.match(
    /# Browser-only \(Playwright; (\d+) scenarios; skips when Chromium unavailable\)\nnpm run test:browser/,
  );
  const totalLine = readme.match(
    /\*\*Total: (\d+) automated integration scenarios\*\* across (\d+) harnesses \((\d+) CLI\/serve runners \+ (\d+) Playwright\)\./,
  );

  assert.ok(quickStartIntegration, "README must document the test:integration scenario count");
  assert.ok(quickStartBrowser, "README must document the test:browser scenario count");
  assert.ok(totalLine, "README must document the aggregate scenario and harness counts");
  assert.equal(Number(quickStartIntegration[1]), integrationTotal);
  assert.equal(Number(quickStartBrowser[1]), browserTotal);
  assert.equal(nonBrowserRowTotal, integrationTotal);
  assert.equal(browserRowTotal, browserTotal);
  assert.equal(rowTotal, integrationTotal + browserTotal);
  assert.equal(Number(totalLine[1]), rowTotal);
  assert.equal(Number(totalLine[2]), rows.length);
  assert.equal(Number(totalLine[3]), integrationHarnesses().length);
  assert.equal(Number(totalLine[4]), browserPlaywrightTests().length);
  assert.equal(nonBrowserRows.length, integrationHarnesses().length);
  assert.equal(browserRows.length, browserPlaywrightTests().length);
});

test("integration spec headers declare matching scenario counts", () => {
  const specs = integrationSpecHeaderCounts();
  const specHarnesses = specs.map((spec) => spec.harness).sort();
  const expectedHarnesses = integrationHarnesses()
    .filter((harness) => !harness.endsWith("tracequest-stress-integration.test.js"))
    .sort();

  assert.deepEqual(
    specHarnesses,
    expectedHarnesses,
    "every non-stress integration harness should have a paired spec header",
  );

  for (const spec of specs) {
    assert.notEqual(spec.declared, null, `${spec.specPath} must include '(N scenarios)'`);
    assert.equal(
      spec.declared,
      countNodeTestCases(spec.harness),
      `${spec.specPath} scenario count must match ${spec.harness}`,
    );
  }
});

test("stress integration runner-only exception is documented", () => {
  const readme = testsReadme();
  const stressHarness = "test/bin/tracequest-stress-integration.test.js";
  const runnerOnlyHarnesses = integrationHarnesses()
    .filter((harness) => !integrationSpecHeaderCounts().some((spec) => spec.harness === harness))
    .sort();

  assert.deepEqual(
    runnerOnlyHarnesses,
    [stressHarness],
    "stress must remain the only non-Playwright integration harness without a markdown spec",
  );
  assert.ok(integrationHarnesses().includes(stressHarness), "test:integration must include the stress harness");
  assert.equal(countNodeTestCases(stressHarness), 6);
  assert.ok(!integrationSpecFiles().includes("tests/stress-integration.md"));
  assert.match(stressIntegrationSource(), /STRESS_SESSION_COUNT = 60/);
  assert.match(readme, /\| Stress \| \*\(inline in harness\)\* \| 6 \|/);
  assert.match(readme, /stress harness is the only runner-only exception/i);
  assert.match(readme, /intentionally has no `tests\/stress-integration\.md`/);
});

test("core integration spec execution results match automated scenarios", () => {
  const source = coreIntegrationSource();
  const spec = coreIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "core integration spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+[a-z]?):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+[a-z]?):/gm)].map((match) => match[1]);
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+[a-z]?) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);
  const specHeader = spec.match(
    /^Automated harness:\s*`test\/bin\/tracequest-integration\.test\.js`\s*\((\d+) scenarios\)\./m,
  );
  const sourceHeader = source.match(
    /^\s*\* Automated harness for tests\/integration\.md .+ (\d+) core CLI integration scenarios\./m,
  );
  const summary = executionResults[1].match(/\*\*Summary:\*\*\s*(\d+)\/(\d+) PASS\./);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.deepEqual(
    sectionNumbers,
    automatedNumbers,
    "core spec must include exactly one prose section per automated scenario, in runner order",
  );
  assert.deepEqual(
    rowNumbers,
    automatedNumbers,
    "core execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.ok(specHeader, "core spec must declare its automated scenario count");
  assert.ok(sourceHeader, "core harness header must declare its scenario count");
  assert.ok(summary, "core execution results must summarize the PASS total");
  assert.equal(Number(specHeader[1]), automatedNumbers.length);
  assert.equal(Number(sourceHeader[1]), automatedNumbers.length);
  assert.equal(Number(summary[1]), automatedNumbers.length);
  assert.equal(Number(summary[2]), automatedNumbers.length);
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("livereload integration spec execution results are concrete for every scenario", () => {
  const spec = livereloadIntegrationSpec();
  const expectations = spec.match(/## Expectations\n\n([\s\S]*?)\n## Execution results/);
  const executionResults = spec.match(/## Execution results\n\n([\s\S]*)$/);

  assert.ok(expectations, "livereload spec must include an expectations table");
  assert.ok(executionResults, "livereload spec must include execution results");

  const expectationRows = [...expectations[1].matchAll(/^\| (\d+) \| [^|]+ \| [^|]+ \|$/gm)]
    .map((match) => match[1]);
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      status: match[2].trim(),
    }));

  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    expectationRows,
    "execution results must include exactly one row per expectation, in order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
  }
});

test("livereload integration spec execution results match automated scenarios", () => {
  const source = livereloadIntegrationSource();
  const spec = livereloadIntegrationSpec();
  const expectations = spec.match(/## Expectations\n\n([\s\S]*?)\n## Execution results/);
  const executionResults = spec.match(/## Execution results\n\n([\s\S]*)$/);

  assert.ok(expectations, "livereload spec must include expectations");
  assert.ok(executionResults, "livereload spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+[a-z]?):/gm)].map(
    (match) => match[1],
  );
  const expectationRows = [...expectations[1].matchAll(/^\| (\d+[a-z]?) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      scenario: match[2].trim(),
      passCriteria: match[3].trim(),
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+[a-z]?) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      status: match[2].trim(),
    }));
  const expectedNumbers = numericSort(automatedNumbers);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(expectationRows.map((row) => row.testNumber)).size, expectationRows.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    expectationRows.map((row) => row.testNumber),
    expectedNumbers,
    "livereload expectations must include exactly one row per automated scenario, in numbered order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    expectedNumbers,
    "livereload execution results must include exactly one row per automated scenario, in numbered order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of expectationRows) {
    assert.ok(row.scenario.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.passCriteria.length > 0, `Test ${row.testNumber} must include pass criteria`);
  }

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
  }
});

test("large-session integration spec execution results match automated scenarios", () => {
  const source = largeSessionIntegrationSource();
  const spec = largeSessionIntegrationSpec();
  const expectations = spec.match(/## Expectations\n\n([\s\S]*?)\n## Execution results/);
  const executionResults = spec.match(/## Execution results\n\n([\s\S]*)$/);

  assert.ok(expectations, "large-session spec must include expectations");
  assert.ok(executionResults, "large-session spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\((?:["'`])Test (\d+[a-z]?):/gm)].map(
    (match) => match[1],
  );
  const expectationRows = [...expectations[1].matchAll(/^\| (\d+[a-z]?) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      scenario: match[2].trim(),
      passCriteria: match[3].trim(),
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+[a-z]?) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      status: match[2].trim(),
      evidence: match[3].trim(),
    }));

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.deepEqual(
    expectationRows.map((row) => row.testNumber),
    automatedNumbers,
    "large-session expectations must include exactly one row per automated scenario, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedNumbers,
    "large-session execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of expectationRows) {
    assert.ok(row.scenario.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.passCriteria.length > 0, `Test ${row.testNumber} must include pass criteria`);
  }

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("preset integration spec execution results match automated scenarios", () => {
  const source = presetIntegrationSource();
  const spec = presetIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "preset spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+):/gm)].map((match) => match[1]);
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.deepEqual(
    sectionNumbers,
    automatedNumbers,
    "preset spec must include exactly one prose section per automated scenario, in runner order",
  );
  assert.deepEqual(
    rowNumbers,
    automatedNumbers,
    "preset execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }

  const test3Section = spec.match(/^## Test 3: ([^\n]+)$/m);
  const test3Row = resultRows.find((row) => row.testNumber === "3");
  assert.ok(test3Section, "preset spec must document the --port override scenario");
  assert.ok(test3Row, "preset execution results must include the --port override scenario");
  assert.match(test3Section[1], /preset local port/);
  assert.match(test3Row.description, /preset local port/);
  assert.match(test3Row.evidence, /ephemeral/);
  assert.match(test3Row.evidence, /8888/);
});

test("messages-format integration spec execution results match automated scenarios", () => {
  const source = messagesFormatIntegrationSource();
  const spec = messagesFormatIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "messages-format spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+):/gm)].map((match) => match[1]);
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.deepEqual(
    sectionNumbers,
    automatedNumbers,
    "messages-format spec must include exactly one prose section per automated scenario, in runner order",
  );
  assert.deepEqual(
    rowNumbers,
    automatedNumbers,
    "messages-format execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("render-messages integration spec execution results match automated scenarios", () => {
  const source = renderMessagesIntegrationSource();
  const spec = renderMessagesIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "render-messages spec must include execution results");

  const automatedScenarios = [...source.matchAll(/^\s*test\("Test (\d+): ([^"]+)"/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const sectionScenarios = [...spec.matchAll(/^## Test (\d+): ([^\n]+)$/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));

  assert.equal(new Set(automatedScenarios.map((scenario) => scenario.testNumber)).size, automatedScenarios.length);
  assert.equal(new Set(sectionScenarios.map((scenario) => scenario.testNumber)).size, sectionScenarios.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    sectionScenarios,
    automatedScenarios,
    "render-messages spec must include one prose section per automated scenario with matching titles, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedScenarios.map((scenario) => scenario.testNumber),
    "render-messages execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("agent-history integration spec titles and results match automated scenarios", () => {
  const source = agentHistoryIntegrationSource();
  const spec = agentHistoryIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "agent-history spec must include execution results");

  const automatedScenarios = [...source.matchAll(/^\s*test\("Test (\d+): ([^"]+)"/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const sectionScenarios = [...spec.matchAll(/^## Test (\d+): ([^\n]+)$/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));

  assert.equal(new Set(automatedScenarios.map((scenario) => scenario.testNumber)).size, automatedScenarios.length);
  assert.equal(new Set(sectionScenarios.map((scenario) => scenario.testNumber)).size, sectionScenarios.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    sectionScenarios,
    automatedScenarios,
    "agent-history spec must include one prose section per automated scenario with matching titles, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedScenarios.map((scenario) => scenario.testNumber),
    "agent-history execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("opencode integration spec execution results match automated scenarios", () => {
  const source = opencodeIntegrationSource();
  const spec = opencodeIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "opencode spec must include execution results");

  const automatedScenarios = [...source.matchAll(/^\s*test\("Test (\d+): ([^"]+)"/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const sectionScenarios = [...spec.matchAll(/^## Test (\d+): ([^\n]+)$/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));

  assert.equal(new Set(automatedScenarios.map((scenario) => scenario.testNumber)).size, automatedScenarios.length);
  assert.equal(new Set(sectionScenarios.map((scenario) => scenario.testNumber)).size, sectionScenarios.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    sectionScenarios,
    automatedScenarios,
    "opencode spec must include one prose section per automated scenario with matching titles, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedScenarios.map((scenario) => scenario.testNumber),
    "opencode execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("codex integration spec execution results match automated scenarios", () => {
  const source = codexIntegrationSource();
  const spec = codexIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "codex spec must include execution results");

  const automatedScenarios = [...source.matchAll(/^\s*test\("Test (\d+): ([^"]+)"/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const sectionScenarios = [...spec.matchAll(/^## Test (\d+): ([^\n]+)$/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));

  assert.equal(new Set(automatedScenarios.map((scenario) => scenario.testNumber)).size, automatedScenarios.length);
  assert.equal(new Set(sectionScenarios.map((scenario) => scenario.testNumber)).size, sectionScenarios.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    sectionScenarios,
    automatedScenarios,
    "codex spec must include one prose section per automated scenario with matching titles, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedScenarios.map((scenario) => scenario.testNumber),
    "codex execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("factory integration spec execution results match automated scenarios", () => {
  const source = factoryIntegrationSource();
  const spec = factoryIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "factory spec must include execution results");

  const automatedScenarios = [...source.matchAll(/^\s*test\("Test (\d+): ([^"]+)"/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const sectionScenarios = [...spec.matchAll(/^## Test (\d+): ([^\n]+)$/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));

  assert.equal(new Set(automatedScenarios.map((scenario) => scenario.testNumber)).size, automatedScenarios.length);
  assert.equal(new Set(sectionScenarios.map((scenario) => scenario.testNumber)).size, sectionScenarios.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    sectionScenarios,
    automatedScenarios,
    "factory spec must include one prose section per automated scenario with matching titles, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedScenarios.map((scenario) => scenario.testNumber),
    "factory execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("grok integration spec execution results match automated scenarios", () => {
  const source = grokIntegrationSource();
  const spec = grokIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "grok spec must include execution results");

  const automatedScenarios = [...source.matchAll(/^\s*test\("Test (\d+): ([^"]+)"/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const sectionScenarios = [...spec.matchAll(/^## Test (\d+): ([^\n]+)$/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));

  assert.equal(new Set(automatedScenarios.map((scenario) => scenario.testNumber)).size, automatedScenarios.length);
  assert.equal(new Set(sectionScenarios.map((scenario) => scenario.testNumber)).size, sectionScenarios.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    sectionScenarios,
    automatedScenarios,
    "grok spec must include one prose section per automated scenario with matching titles, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedScenarios.map((scenario) => scenario.testNumber),
    "grok execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("multi-source integration spec execution results match automated scenarios", () => {
  const source = multiSourceIntegrationSource();
  const spec = multiSourceIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "multi-source spec must include execution results");

  const automatedScenarios = [...source.matchAll(/^\s*test\("Test (\d+): ([^"]+)"/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const sectionScenarios = [...spec.matchAll(/^## Test (\d+): ([^\n]+)$/gm)]
    .map((match) => ({
      testNumber: match[1],
      title: match[2],
    }));
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));

  assert.equal(new Set(automatedScenarios.map((scenario) => scenario.testNumber)).size, automatedScenarios.length);
  assert.equal(new Set(sectionScenarios.map((scenario) => scenario.testNumber)).size, sectionScenarios.length);
  assert.equal(new Set(resultRows.map((row) => row.testNumber)).size, resultRows.length);
  assert.deepEqual(
    sectionScenarios,
    automatedScenarios,
    "multi-source spec must include one prose section per automated scenario with matching titles, in runner order",
  );
  assert.deepEqual(
    resultRows.map((row) => row.testNumber),
    automatedScenarios.map((scenario) => scenario.testNumber),
    "multi-source execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("index-search integration spec execution results match automated scenarios", () => {
  const source = indexSearchIntegrationSource();
  const spec = indexSearchIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "index-search spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+):/gm)].map((match) => match[1]);
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.deepEqual(
    sectionNumbers,
    automatedNumbers,
    "index-search spec must include exactly one prose section per automated scenario, in runner order",
  );
  assert.deepEqual(
    rowNumbers,
    automatedNumbers,
    "index-search execution results must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.description.length > 0, `Test ${row.testNumber} must describe the scenario`);
    assert.ok(row.evidence.length > 0, `Test ${row.testNumber} must include result evidence`);
  }
});

test("edge integration spec execution log matches automated scenarios", () => {
  const source = edgeIntegrationSource();
  const spec = edgeIntegrationSpec();
  const executionLog = spec.match(/## Execution log\n\n([\s\S]*)$/);

  assert.ok(executionLog, "edge spec must include an execution log");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+):/gm)].map((match) => match[1]);
  const resultRows = [...executionLog[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      scenario: match[2].trim(),
      status: match[3].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);
  const expectedNumbers = numericSort(automatedNumbers);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.deepEqual(
    sectionNumbers,
    expectedNumbers,
    "edge spec must include exactly one prose section per automated scenario, in numeric order",
  );
  assert.deepEqual(
    rowNumbers,
    expectedNumbers,
    "edge execution log must include exactly one row per automated scenario, in numeric order",
  );
  assert.doesNotMatch(executionLog[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.scenario.length > 0, `Test ${row.testNumber} must describe the scenario`);
  }
});

test("sidecar integration spec execution log matches automated scenarios", () => {
  const source = sidecarIntegrationSource();
  const spec = sidecarIntegrationSpec();
  const executionLog = spec.match(/## Execution log\n\n([\s\S]*)$/);

  assert.ok(executionLog, "sidecar spec must include an execution log");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+):/gm)].map((match) => match[1]);
  const resultRows = [...executionLog[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      scenario: match[2].trim(),
      status: match[3].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.deepEqual(
    sectionNumbers,
    automatedNumbers,
    "sidecar spec must include exactly one prose section per automated scenario, in runner order",
  );
  assert.deepEqual(
    rowNumbers,
    automatedNumbers,
    "sidecar execution log must include exactly one row per automated scenario, in runner order",
  );
  assert.doesNotMatch(executionLog[1], /run harness/i);

  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
    assert.ok(row.scenario.length > 0, `Test ${row.testNumber} must describe the scenario`);
  }
});

test("serve integration spec execution results match automated scenarios", () => {
  const source = serveIntegrationSource();
  const spec = serveIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "serve spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+):/gm)].map((match) => match[1]);
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.deepEqual(
    numericSort(sectionNumbers),
    numericSort(automatedNumbers),
    "serve spec must include exactly one prose section per automated scenario",
  );
  assert.deepEqual(
    numericSort(rowNumbers),
    numericSort(automatedNumbers),
    "serve execution results must include exactly one row per automated scenario",
  );
  assert.doesNotMatch(executionResults[1], /run harness/i);

  const rowsByNumber = new Map(resultRows.map((row) => [row.testNumber, row]));
  for (const row of resultRows) {
    assert.equal(row.status, "**PASS**", `Test ${row.testNumber} must have a concrete PASS result`);
  }

  const test34Section = spec.match(/^## Test 34: ([^\n]+)$/m);
  const test34Row = rowsByNumber.get("34");
  const test18Row = rowsByNumber.get("18");
  assert.ok(test34Section, "serve spec must document the sort=date alias scenario");
  assert.ok(test34Row, "serve execution results must include the sort=date alias scenario");
  assert.match(test34Section[1], /sort=date/);
  assert.match(test34Section[1], /aliases `recent`/);
  assert.match(test34Row.description, /sort=date/);
  assert.match(test34Row.evidence, /Same order as Test 16/);
  assert.ok(test18Row, "serve execution results must include invalid sort coverage");
  assert.doesNotMatch(test18Row.evidence, /`date`/);
});

test("sharing integration spec execution results match automated scenarios", () => {
  const source = sharingIntegrationSource();
  const spec = sharingIntegrationSpec();
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(executionResults, "sharing spec must include execution results");

  const automatedNumbers = [...source.matchAll(/^\s*test\("Test (\d+[a-z]?):/gm)].map(
    (match) => match[1],
  );
  const sectionNumbers = [...spec.matchAll(/^## Test (\d+[a-z]?):/gm)].map((match) => match[1]);
  const resultRows = [...executionResults[1].matchAll(/^\| (\d+[a-z]?) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      testNumber: match[1],
      description: match[2].trim(),
      status: match[3].trim(),
      evidence: match[4].trim(),
    }));
  const rowNumbers = resultRows.map((row) => row.testNumber);

  assert.equal(new Set(automatedNumbers).size, automatedNumbers.length);
  assert.equal(new Set(sectionNumbers).size, sectionNumbers.length);
  assert.equal(new Set(rowNumbers).size, rowNumbers.length);
  assert.doesNotMatch(executionResults[1], /run harness/i);

  const sections = new Set(sectionNumbers);
  const rowsByNumber = new Map(resultRows.map((row) => [row.testNumber, row]));
  for (const testNumber of automatedNumbers) {
    assert.ok(sections.has(testNumber), `sharing spec must document Test ${testNumber}`);
    const row = rowsByNumber.get(testNumber);
    assert.ok(row, `sharing execution results must include Test ${testNumber}`);
    assert.equal(row.status, "**PASS**", `Test ${testNumber} must have a concrete PASS result`);
  }

  const test4bSection = spec.match(/^## Test 4b: ([^\n]+)$/m);
  const test4bRow = rowsByNumber.get("4b");
  assert.ok(test4bSection, "sharing spec must document the tool-input redaction scenario");
  assert.match(test4bSection[1], /Tool input secrets/);
  assert.ok(test4bRow, "sharing execution results must include the tool-input redaction scenario");
  assert.match(test4bRow.description, /tool input secrets/);
  assert.match(test4bRow.evidence, /Bash tool input/);
});

test("sharing integration prerequisites match mock server scenarios", () => {
  const source = sharingIntegrationSource();
  const spec = sharingIntegrationSpec();
  const prerequisites = spec.match(/## Prerequisites\n\n([\s\S]*?)\n---/);
  const executionResults = spec.match(/## Execution Results\n\n([\s\S]*)$/);

  assert.ok(prerequisites, "sharing spec must include a prerequisites section");
  assert.ok(executionResults, "sharing spec must include execution results");

  const testBodies = [...source.matchAll(/^\s*test\("Test (\d+[a-z]?):[\s\S]*?(?=^\s*test\("Test \d+[a-z]?:|^\s*}\);)/gm)]
    .map((match) => ({
      testNumber: match[1],
      body: match[0],
    }));
  const mockUploadTests = testBodies
    .filter(({ body }) => /\bwithMock(?:Gist|Hf)Server\b/.test(body))
    .map(({ testNumber }) => testNumber);
  const localOnlyTests = testBodies
    .filter(({ body }) => !/\bwithMock(?:Gist|Hf)Server\b/.test(body))
    .map(({ testNumber }) => testNumber);

  assert.deepEqual(
    testNumberSort(mockUploadTests),
    ["3", "4", "4b", "7", "8", "9", "10", "12", "13", "14", "15", "16", "17"],
  );
  assert.deepEqual(testNumberSort(localOnlyTests), ["1", "2", "5", "6", "11", "18"]);
  assert.match(
    prerequisites[1],
    new RegExp(`${escapeRegExp(formatTestList(localOnlyTests))} remain local or structural only`),
  );
  assert.match(
    prerequisites[1],
    new RegExp(`${escapeRegExp(formatTestList(mockUploadTests))} use local mock Gist/HF upload servers`),
  );
  assert.match(prerequisites[1], /GITHUB_API_URL/);
  assert.match(prerequisites[1], /HF_API_URL/);
  assert.doesNotMatch(prerequisites[1], /Tests 1[–-]8/);
  assert.doesNotMatch(prerequisites[1], /Tests 9[–-]10 require/);
  assert.match(
    executionResults[1],
    new RegExp(`mock HTTP servers for upload tests \\(${escapeRegExp(testNumberSort(mockUploadTests).join(", "))}\\)`),
  );
  assert.doesNotMatch(executionResults[1], /upload tests \(9[–-]10\)/);
});

test("CI installs Chromium before running the explicit browser target", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const installChromium = ci.indexOf("npx playwright install --with-deps chromium");
  const runDefaultTests = ci.indexOf("run: npm test");
  const runBrowserTests = ci.indexOf("run: npm run test:browser");

  assert.notEqual(installChromium, -1, "CI must install Chromium for Playwright coverage");
  assert.notEqual(runDefaultTests, -1, "CI must keep running default tests");
  assert.notEqual(runBrowserTests, -1, "CI must run the explicit browser test target");
  assert.ok(installChromium < runDefaultTests);
  assert.ok(runDefaultTests < runBrowserTests);
});
