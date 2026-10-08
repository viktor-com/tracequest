import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractUserQuery } from "../../src/parse/parse-grok.js";

describe("extractUserQuery (grok)", () => {
  test("returns trimmed plain text when no XML wrappers", () => {
    assert.equal(extractUserQuery("plain question"), "plain question");
    assert.equal(extractUserQuery("  padded prompt  "), "padded prompt");
  });

  test("extracts inner text from user_query tags", () => {
    assert.equal(extractUserQuery("<user_query>inner prompt</user_query>"), "inner prompt");
    assert.equal(
      extractUserQuery("<user_query>  spaced inner  </user_query>"),
      "spaced inner",
    );
  });

  test("preserves multiline content inside user_query", () => {
    assert.equal(
      extractUserQuery("<user_query>\nline one\nline two\n</user_query>"),
      "line one\nline two",
    );
  });

  test("finds user_query when surrounded by other text", () => {
    assert.equal(
      extractUserQuery("noise before <user_query>actual ask</user_query> trailing"),
      "actual ask",
    );
  });

  test("returns null for top-level XML without user_query", () => {
    assert.equal(extractUserQuery("<system>hidden</system>"), null);
    assert.equal(extractUserQuery("<assistant>reply only</assistant>"), null);
    assert.equal(extractUserQuery("<user_query>unclosed"), null);
  });

  test("returns null when user_query inner is XML-only", () => {
    assert.equal(extractUserQuery("<user_query><local>xml</local></user_query>"), null);
    assert.equal(extractUserQuery("<user_query><nested><deep/></nested></user_query>"), null);
  });

  test("extracts command-args inside user_query", () => {
    assert.equal(
      extractUserQuery("<user_query><command-args>run tests</command-args></user_query>"),
      "run tests",
    );
    assert.equal(
      extractUserQuery("<user_query><command-args>\nlint --fix\n</command-args></user_query>"),
      "lint --fix",
    );
  });

  test("extracts command-message inside user_query", () => {
    assert.equal(
      extractUserQuery("<user_query><command-message>deploy prod</command-message></user_query>"),
      "deploy prod",
    );
  });

  test("prefers command-args over command-message when both present", () => {
    assert.equal(
      extractUserQuery(
        "<user_query><command-args>from args</command-args><command-message>from msg</command-message></user_query>",
      ),
      "from args",
    );
  });

  test("returns null for empty command-args or command-message", () => {
    assert.equal(
      extractUserQuery("<user_query><command-args></command-args></user_query>"),
      null,
    );
    assert.equal(
      extractUserQuery("<user_query><command-args>   </command-args></user_query>"),
      null,
    );
    assert.equal(
      extractUserQuery("<user_query><command-message></command-message></user_query>"),
      null,
    );
  });

  test("allows angle brackets in plain text that does not start with <", () => {
    assert.equal(extractUserQuery("fix <template> in file.ts"), "fix <template> in file.ts");
  });

  test("empty and whitespace-only inputs yield empty string", () => {
    assert.equal(extractUserQuery(""), "");
    assert.equal(extractUserQuery("   "), "");
    assert.equal(extractUserQuery("\n\t  \n"), "");
  });

  test("empty user_query pair yields empty string not null", () => {
    assert.equal(extractUserQuery("<user_query></user_query>"), "");
    assert.equal(extractUserQuery("<user_query>   </user_query>"), "");
  });

  test("first user_query block wins when multiple pairs appear", () => {
    assert.equal(
      extractUserQuery("<user_query>first ask</user_query><user_query>second ask</user_query>"),
      "first ask",
    );
  });

  test("angle brackets inside user_query inner are kept when inner does not start with <", () => {
    assert.equal(
      extractUserQuery("<user_query>replace <Component /> in App.tsx</user_query>"),
      "replace <Component /> in App.tsx",
    );
  });

  test("command-message is used when command-args tag is absent", () => {
    assert.equal(
      extractUserQuery("<user_query><command-message>slash /deploy</command-message></user_query>"),
      "slash /deploy",
    );
    assert.equal(
      extractUserQuery("<user_query>noise <command-message>only msg</command-message></user_query>"),
      "only msg",
    );
  });

  test("unclosed command-args inside user_query yields null (inner starts with <)", () => {
    assert.equal(extractUserQuery("<user_query><command-args>run without close"), null);
  });
});