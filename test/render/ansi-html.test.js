/**
 * SGR-to-HTML converter unit tests — pure functions, no tmux needed.
 * Sample sequences mirror what tmux capture-pane -e actually emits
 * (verified empirically): multi-param SGR (1;4m), 39/49 fg/bg defaults,
 * 256-color 38;5;n and truecolor 38;2;r;g;b passed through unchanged.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ansiToHtml,
  ansiPaletteCss,
  escapeHtml,
  xterm256Color,
} from "../../src/render/ansi-html.js";

const E = "\u001b";

describe("ansi-html — text safety", () => {
  test("plain text is HTML-escaped including <script>", () => {
    assert.equal(
      ansiToHtml('<script>alert("x&y")</script>'),
      "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;",
    );
  });

  test("styled text is escaped BEFORE span wrapping", () => {
    assert.equal(
      ansiToHtml(`${E}[31m<b>&${E}[0m`),
      '<span class="ansi-fg-1">&lt;b&gt;&amp;</span>',
    );
  });

  test("escapeHtml maps the four dangerous characters", () => {
    assert.equal(escapeHtml('&<>"'), "&amp;&lt;&gt;&quot;");
  });

  test("newlines are preserved as \\n", () => {
    assert.equal(ansiToHtml(`a\nb\n${E}[32mc\nd${E}[0m\n`), 'a\nb\n<span class="ansi-fg-2">c\nd</span>\n');
  });

  test("no raw escape byte ever leaks into the output", () => {
    const nasty = [
      `${E}[31mred${E}[0m`,
      `${E}[2J${E}[H`, // non-SGR CSI
      `${E}]0;window title\u0007text`, // OSC + BEL
      `${E}]0;title${E}\\after-st`, // OSC + ST
      `${E}P1;2|dcs payload${E}\\ok`, // DCS
      `${E}7saved${E}8`, // two-byte escapes
      `truncated ${E}[31`, // CSI cut off at end of capture
      `bare ${E}`, // lone ESC at end
      `${E}[38;5m half-formed ${E}[38;2;1;2m`,
    ];
    for (const input of nasty) {
      const html = ansiToHtml(input);
      assert.ok(!html.includes(E), `escape byte leaked for ${JSON.stringify(input)}`);
    }
  });

  test("carriage returns and stray C0 controls are dropped, tabs kept", () => {
    assert.equal(ansiToHtml("a\r\nb\tc\u0001d"), "a\nb\tcd");
  });
});

describe("ansi-html — colors", () => {
  test("16-color foreground becomes an ansi-fg-N class span", () => {
    assert.equal(ansiToHtml(`${E}[31mRED${E}[0m`), '<span class="ansi-fg-1">RED</span>');
    assert.equal(ansiToHtml(`${E}[37mWHT${E}[0m`), '<span class="ansi-fg-7">WHT</span>');
  });

  test("16-color background becomes an ansi-bg-N class span", () => {
    assert.equal(ansiToHtml(`${E}[44mBLU${E}[0m`), '<span class="ansi-bg-4">BLU</span>');
  });

  test("bright colors map to classes 8-15", () => {
    assert.equal(ansiToHtml(`${E}[91mBR${E}[0m`), '<span class="ansi-fg-9">BR</span>');
    assert.equal(ansiToHtml(`${E}[97mBW${E}[0m`), '<span class="ansi-fg-15">BW</span>');
    assert.equal(ansiToHtml(`${E}[100mBG${E}[0m`), '<span class="ansi-bg-8">BG</span>');
    assert.equal(ansiToHtml(`${E}[107mBW${E}[0m`), '<span class="ansi-bg-15">BW</span>');
  });

  test("256-color 38;5;n / 48;5;n become inline xterm palette styles", () => {
    assert.equal(
      ansiToHtml(`${E}[38;5;208mORANGE${E}[0m`),
      '<span style="color:#ff8700">ORANGE</span>',
    );
    assert.equal(
      ansiToHtml(`${E}[48;5;232mGRAY${E}[0m`),
      '<span style="background-color:#080808">GRAY</span>',
    );
  });

  test("256-color indexes below 16 reuse the themeable named classes", () => {
    assert.equal(ansiToHtml(`${E}[38;5;1mR${E}[0m`), '<span class="ansi-fg-1">R</span>');
    assert.equal(ansiToHtml(`${E}[48;5;12mB${E}[0m`), '<span class="ansi-bg-12">B</span>');
  });

  test("truecolor 38;2;r;g;b / 48;2;r;g;b become inline hex styles", () => {
    assert.equal(
      ansiToHtml(`${E}[38;2;10;20;30mTC${E}[0m`),
      '<span style="color:#0a141e">TC</span>',
    );
    assert.equal(
      ansiToHtml(`${E}[48;2;255;0;128mBG${E}[0m`),
      '<span style="background-color:#ff0080">BG</span>',
    );
  });

  test("39/49 restore default fg/bg without a reset", () => {
    assert.equal(
      ansiToHtml(`${E}[31;44mAB${E}[39mCD${E}[49mEF`),
      '<span class="ansi-fg-1 ansi-bg-4">AB</span><span class="ansi-bg-4">CD</span>EF',
    );
  });

  test("xterm-256 palette is computed correctly across all three bands", () => {
    assert.equal(xterm256Color(9), "#ff0000"); // base16 bright red
    assert.equal(xterm256Color(16), "#000000"); // cube origin
    assert.equal(xterm256Color(21), "#0000ff"); // cube pure blue
    assert.equal(xterm256Color(231), "#ffffff"); // cube end
    assert.equal(xterm256Color(208), "#ff8700");
    assert.equal(xterm256Color(232), "#080808"); // gray ramp start
    assert.equal(xterm256Color(255), "#eeeeee"); // gray ramp end
  });
});

describe("ansi-html — attributes", () => {
  test("bold+underline combos share one flat span with a color", () => {
    assert.equal(
      ansiToHtml(`${E}[1;4m${E}[32mBOLDUL${E}[0m`),
      '<span class="ansi-bold ansi-underline ansi-fg-2">BOLDUL</span>',
    );
  });

  test("dim and italic map to their classes and off-codes clear them", () => {
    assert.equal(ansiToHtml(`${E}[2;3mDI${E}[22;23mplain`), '<span class="ansi-dim ansi-italic">DI</span>plain');
  });

  test("22 clears bold, 24 clears underline mid-stream", () => {
    assert.equal(
      ansiToHtml(`${E}[1;4mBU${E}[22mU${E}[24mplain`),
      '<span class="ansi-bold ansi-underline">BU</span><span class="ansi-underline">U</span>plain',
    );
  });

  test("reverse swaps the effective fg/bg and 27 turns it off", () => {
    assert.equal(
      ansiToHtml(`${E}[7mREV${E}[27mFWD`),
      '<span class="ansi-reverse">REV</span>FWD',
    );
    // fg red + reverse → red becomes the BACKGROUND of the span.
    assert.equal(
      ansiToHtml(`${E}[31;7mRV${E}[0m`),
      '<span class="ansi-reverse ansi-bg-1">RV</span>',
    );
    // fg+bg set + reverse → both swap.
    assert.equal(
      ansiToHtml(`${E}[31;44;7mRV${E}[0m`),
      '<span class="ansi-reverse ansi-fg-4 ansi-bg-1">RV</span>',
    );
  });

  test("reset splits a styled stream into separate flat spans", () => {
    assert.equal(
      ansiToHtml(`${E}[31mA${E}[0mB${E}[32mC${E}[0m`),
      '<span class="ansi-fg-1">A</span>B<span class="ansi-fg-2">C</span>',
    );
  });

  test("empty SGR parameters mean reset", () => {
    assert.equal(ansiToHtml(`${E}[31mA${E}[mB`), '<span class="ansi-fg-1">A</span>B');
  });
});

describe("ansi-html — robustness", () => {
  test("unknown SGR codes are ignored, known neighbours still apply", () => {
    // 5 (blink), 51 (framed), 73 (superscript) are unsupported → dropped.
    assert.equal(
      ansiToHtml(`${E}[5;31;51mX${E}[0m`),
      '<span class="ansi-fg-1">X</span>',
    );
    assert.equal(ansiToHtml(`${E}[73mplain${E}[0m`), "plain");
  });

  test("non-SGR escape sequences vanish without eating text", () => {
    assert.equal(ansiToHtml(`a${E}[2Jb${E}]0;title\u0007c${E}7d`), "abcd");
  });

  test("malformed extended color sequences never throw", () => {
    for (const input of [
      `${E}[38m`,
      `${E}[38;5m`,
      `${E}[38;5;999mX`,
      `${E}[38;2;1;2mX`,
      `${E}[48;9;1mX`,
      `${E}[38;5;-1mX`,
    ]) {
      assert.doesNotThrow(() => ansiToHtml(input), `threw for ${JSON.stringify(input)}`);
      assert.ok(!ansiToHtml(input).includes(E));
    }
  });

  test("colon sub-parameter color form is understood", () => {
    assert.equal(
      ansiToHtml(`${E}[38:5:208mX${E}[0m`),
      '<span style="color:#ff8700">X</span>',
    );
    assert.equal(
      ansiToHtml(`${E}[38:2:10:20:30mX${E}[0m`),
      '<span style="color:#0a141e">X</span>',
    );
  });

  test("colon underline styles map to underline only — no sub-parameter leaks", () => {
    // RENDER-001 regression: tmux ≥3.0 emits 4:x underline styles. The
    // flattened 4;3 misread turned 4:3 (curly underline) into
    // underline+italic.
    assert.equal(
      ansiToHtml(`${E}[4:3mX${E}[0m`),
      '<span class="ansi-underline">X</span>',
    );
  });

  test("a 4:0 group never leaks a full mid-line reset", () => {
    // The flattened 4;0 misread turned 4:0 (no underline) into
    // underline + FULL RESET, dropping bold+red mid-line. The group is
    // consumed atomically: B keeps bold+red, underline state unchanged.
    assert.equal(
      ansiToHtml(`${E}[1;31mA${E}[4:0mB${E}[0m`),
      '<span class="ansi-bold ansi-fg-1">A</span><span class="ansi-bold ansi-fg-1">B</span>',
    );
  });

  test("colon underline-colour groups (58:...) are dropped whole", () => {
    // The flattened 58;5;1 misread executed 5 (blink→?) and 1 (BOLD).
    assert.equal(ansiToHtml(`${E}[58:5:1mX${E}[0m`), "X");
    assert.equal(ansiToHtml(`${E}[58:2::255:0:0mX${E}[0m`), "X");
  });

  test("semicolon underline-colour codes 58/59 are consumed atomically and ignored", () => {
    // tmux 3.7b emits exactly these semicolon forms. 58;2;255;0;0 must not
    // be misread as 58, 2 (dim), 255, 0 (RESET), 0 — underline preserved.
    assert.equal(
      ansiToHtml(`${E}[4m${E}[58;2;255;0;0mX${E}[0m`),
      '<span class="ansi-underline">X</span>',
    );
    // 58;5;n spans exactly 3 parameters; a following 31 still applies.
    assert.equal(
      ansiToHtml(`${E}[58;5;208;31mX${E}[0m`),
      '<span class="ansi-fg-1">X</span>',
    );
    // 59 (default underline colour) is a single ignored parameter.
    assert.equal(
      ansiToHtml(`${E}[4;59;31mX${E}[0m`),
      '<span class="ansi-underline ansi-fg-1">X</span>',
    );
  });

  test("null/undefined input answers an empty string", () => {
    assert.equal(ansiToHtml(null), "");
    assert.equal(ansiToHtml(undefined), "");
    assert.equal(ansiToHtml(""), "");
  });
});

describe("ansi-html — CSS palette helper", () => {
  test("ansiPaletteCss covers all attribute classes and 16 fg/bg colors", () => {
    const css = ansiPaletteCss();
    for (const cls of ["ansi-bold", "ansi-dim", "ansi-italic", "ansi-underline", "ansi-reverse"]) {
      assert.ok(css.includes(`.${cls}{`), `missing .${cls}`);
    }
    for (let n = 0; n < 16; n++) {
      assert.ok(css.includes(`.ansi-fg-${n}{color:`), `missing .ansi-fg-${n}`);
      assert.ok(css.includes(`.ansi-bg-${n}{background-color:`), `missing .ansi-bg-${n}`);
    }
  });

  test("attribute rules precede color rules so explicit colors win over reverse defaults", () => {
    const css = ansiPaletteCss();
    assert.ok(css.indexOf(".ansi-reverse{") < css.indexOf(".ansi-fg-0{"));
  });
});
