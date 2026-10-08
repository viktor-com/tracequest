import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { esc, withLiveReload } from "../../src/server/server-html-helpers.js";

const LR_SCRIPT_MARKER = '<script>(function(){var retries=0';

describe("server-html-helpers esc", () => {
  it("returns the same string when no characters need escaping", () => {
    assert.equal(esc("no special chars"), "no special chars");
    assert.equal(esc("plain-text_123"), "plain-text_123");
  });

  it("escapes ampersands", () => {
    assert.equal(esc("a & b"), "a &amp; b");
    assert.equal(esc("&"), "&amp;");
  });

  it("escapes less-than signs", () => {
    assert.equal(esc("a < b"), "a &lt; b");
    assert.equal(esc("<tag>"), "&lt;tag&gt;");
  });

  it("escapes greater-than signs", () => {
    assert.equal(esc("a > b"), "a &gt; b");
  });

  it("escapes double quotes", () => {
    assert.equal(esc('a " b'), "a &quot; b");
  });

  it("escapes all four HTML-significant characters in one pass", () => {
    assert.equal(esc('&<>"'), "&amp;&lt;&gt;&quot;");
    assert.equal(esc('mixed & < > " chars'), "mixed &amp; &lt; &gt; &quot; chars");
  });

  it("coerces non-strings via String() before escaping", () => {
    assert.equal(esc(123), "123");
    assert.equal(esc(null), "null");
    assert.equal(esc(undefined), "undefined");
    assert.equal(esc(""), "");
  });

  it("does not double-escape existing entities", () => {
    assert.equal(esc("&amp; already escaped"), "&amp;amp; already escaped");
  });
});

describe("server-html-helpers withLiveReload", () => {
  const standardHtml = `<!DOCTYPE html>
<html><body>content</body>
</html>`;

  it("inserts the livereload script before </body> in standard tracequest HTML", () => {
    const result = withLiveReload(standardHtml);
    const scriptIdx = result.indexOf(LR_SCRIPT_MARKER);
    const bodyCloseIdx = result.indexOf("</body>");
    assert.ok(scriptIdx !== -1);
    assert.ok(bodyCloseIdx !== -1);
    assert.ok(scriptIdx < bodyCloseIdx);
  });

  it("appends the script when HTML has no </body> tag", () => {
    const html = "<div>no body</div>";
    const result = withLiveReload(html);
    assert.equal(result.startsWith(html), true);
    assert.ok(result.includes(LR_SCRIPT_MARKER));
    assert.ok(result.endsWith("</script>"));
  });

  it("inserts before the last </body> when closing markup is non-standard", () => {
    const html = "<html><body>first</body><body>second</body></html>";
    const result = withLiveReload(html);
    const scriptIdx = result.indexOf(LR_SCRIPT_MARKER);
    const lastBody = result.lastIndexOf("</body>");
    assert.ok(scriptIdx < lastBody);
    assert.equal(result.split(LR_SCRIPT_MARKER).length, 2);
  });

  it("preserves original document content outside the injection point", () => {
    const marker = "<main id='trace'>session view</main>";
    const html = `<!DOCTYPE html><html><body>${marker}</body></html>`;
    const result = withLiveReload(html);
    assert.ok(result.includes(marker));
    assert.ok(result.startsWith("<!DOCTYPE html>"));
  });

  it("embeds EventSource wiring for reload and data-update", () => {
    const result = withLiveReload(standardHtml);
    assert.ok(result.includes('new EventSource("/__livereload")'));
    assert.ok(result.includes('e.data==="reload"'));
    assert.ok(result.includes('e.data==="data-update"'));
    assert.ok(result.includes("window._refreshData"));
    assert.ok(result.includes("window._stayLoaded"), "live chat pages can suppress document reload");
    assert.ok(result.includes('if(!window._stayLoaded)location.reload()'));
  });

  it("uses the fast suffix path for known </body>\\n</html> endings", () => {
    const knownSuffix = "\n</body>\n</html>";
    const html = `<!DOCTYPE html><html><body>x${knownSuffix}`;
    const fast = withLiveReload(html);
    const fallback = withLiveReload(html.replace(knownSuffix, "</body></html>"));
    assert.ok(fast.includes(LR_SCRIPT_MARKER));
    assert.ok(fallback.includes(LR_SCRIPT_MARKER));
    assert.ok(fast.indexOf(LR_SCRIPT_MARKER) < fast.indexOf("</body>"));
  });

  it("only adds one script block per invocation", () => {
    const once = withLiveReload(standardHtml);
    const twice = withLiveReload(once);
    assert.equal(once.split(LR_SCRIPT_MARKER).length, 2);
    assert.equal(twice.split(LR_SCRIPT_MARKER).length, 3);
  });

  it("leaves html byte-identical except for the injected script region", () => {
    const result = withLiveReload(standardHtml);
    const stripped = result.replace(
      /<script>\(function\(\)\{var retries=0[\s\S]*?<\/script>/,
      ""
    );
    assert.equal(stripped, standardHtml);
  });
});