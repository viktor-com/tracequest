/**
 * Zero-dependency SGR-to-HTML converter for tmux `capture-pane -e` output.
 *
 * Terminal text is HTML-escaped BEFORE any span wrapping, so a run printing
 * <script> can never inject markup into a tracequest page. SGR coverage:
 * reset(0), bold(1), dim(2), italic(3), underline(4), reverse(7) and their
 * off-codes (22/23/24/27), fg 30-37/90-97 + default 39, bg 40-47/100-107 +
 * default 49, 256-color 38;5;n / 48;5;n, truecolor 38;2;r;g;b / 48;2;r;g;b.
 *
 * The 16 named colors and the attributes are emitted as CSS classes
 * (ansi-fg-N / ansi-bg-N / ansi-bold / ansi-dim / ansi-italic /
 * ansi-underline / ansi-reverse) so pages can theme them; 256/truecolor
 * values become inline styles from the programmatic xterm-256 palette.
 * Reverse swaps the effective fg/bg. Unknown SGR parameters and non-SGR
 * escape sequences (other CSI, OSC, DCS, ...) are dropped gracefully —
 * no escape byte ever reaches the output. Newlines are preserved as \n
 * (pages render the block with white-space:pre).
 */

const ESC = "\u001b";

/** Fresh default style state. */
function initialState() {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    reverse: false,
    fg: null, // null | {c: 0-15} | {hex: "#rrggbb"}
    bg: null,
  };
}

/** HTML-escape terminal text: &, <, >, " (text never lands in attributes). */
export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The 16 base/bright xterm colors as #rrggbb. */
const BASE16 = [
  "#000000", "#800000", "#008000", "#808000",
  "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00",
  "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

/** Two-digit lowercase hex. */
function hex2(n) {
  return n.toString(16).padStart(2, "0");
}

/**
 * xterm-256 palette entry n (0-255) as "#rrggbb", computed programmatically:
 * 0-15 base/bright, 16-231 the 6x6x6 color cube, 232-255 the gray ramp.
 */
export function xterm256Color(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const level = (v) => (v === 0 ? 0 : 55 + 40 * v);
    const r = level(Math.floor(i / 36));
    const g = level(Math.floor(i / 6) % 6);
    const b = level(i % 6);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const gray = 8 + 10 * (n - 232);
  return `#${hex2(gray)}${hex2(gray)}${hex2(gray)}`;
}

/** Clamp a parsed int into 0-255 or answer null when not a number. */
function channel(v) {
  if (!Number.isInteger(v)) return null;
  return Math.min(255, Math.max(0, v));
}

/**
 * One colon sub-parameter group (ITU T.416), consumed ATOMICALLY as a
 * unit keyed on its lead code — a sub-parameter must never leak into the
 * stream as an independent SGR code (the leak turned tmux ≥3.0 output
 * like 4:3 into phantom italic and 4:0 into a full mid-line reset).
 * 38/48 carry extended colors (38:5:n, 38:2:r:g:b, and the
 * 38:2:<colorspace>:r:g:b form); 4:n selects an underline style (0 = no
 * underline, any style renders as plain underline); every other lead
 * code (58 underline-colour, future forms) is dropped whole — tracequest
 * does not render underline colour.
 */
function applyColonGroup(state, group) {
  const lead = group[0];
  if (lead === 38 || lead === 48) {
    const target = lead === 38 ? "fg" : "bg";
    const mode = group[1];
    if (mode === 5) {
      const idx = channel(group[2]);
      if (idx !== null) {
        state[target] = idx < 16 ? { c: idx } : { hex: xterm256Color(idx) };
      }
    } else if (mode === 2) {
      // 38:2:<colorspace>:r:g:b (6+ parts) carries a color-space id.
      const off = group.length >= 6 ? 3 : 2;
      const r = channel(group[off]);
      const g = channel(group[off + 1]);
      const b = channel(group[off + 2]);
      if (r !== null && g !== null && b !== null) {
        state[target] = { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}` };
      }
    }
    return;
  }
  if (lead === 4) {
    state.underline = group[1] !== 0 && group[1] !== null;
  }
}

/** The group's single token, or null when it is absent or a colon group. */
function singleToken(group) {
  return group && group.length === 1 ? group[0] : null;
}

/**
 * Apply one SGR parameter string ("1;4;32", "38;5;208", "38:2:10:20:30",
 * "" = reset) to `state` in place. Unknown parameters are skipped.
 */
function applySgr(state, paramsStr) {
  // Split into ;-separated parameter groups; a group may carry :-separated
  // sub-parameters (ITU T.416) which are handled atomically per group.
  const groups = paramsStr.split(";").map((g) =>
    g.split(":").map((raw) => {
      const n = raw === "" ? 0 : Number.parseInt(raw, 10);
      return Number.isNaN(n) ? null : n;
    }),
  );
  let i = 0;
  while (i < groups.length) {
    if (groups[i].length > 1) {
      applyColonGroup(state, groups[i]);
      i++;
      continue;
    }
    const n = groups[i][0];
    if (n === null) {
      i++;
      continue;
    }
    if (n === 0) Object.assign(state, initialState());
    else if (n === 1) state.bold = true;
    else if (n === 2) state.dim = true;
    else if (n === 3) state.italic = true;
    else if (n === 4) state.underline = true;
    else if (n === 7) state.reverse = true;
    else if (n === 22) {
      state.bold = false;
      state.dim = false;
    } else if (n === 23) state.italic = false;
    else if (n === 24) state.underline = false;
    else if (n === 27) state.reverse = false;
    else if (n >= 30 && n <= 37) state.fg = { c: n - 30 };
    else if (n >= 90 && n <= 97) state.fg = { c: n - 90 + 8 };
    else if (n === 39) state.fg = null;
    else if (n >= 40 && n <= 47) state.bg = { c: n - 40 };
    else if (n >= 100 && n <= 107) state.bg = { c: n - 100 + 8 };
    else if (n === 49) state.bg = null;
    else if (n === 38 || n === 48) {
      const target = n === 38 ? "fg" : "bg";
      const mode = singleToken(groups[i + 1]);
      if (mode === 5) {
        const idx = channel(singleToken(groups[i + 2]));
        if (idx !== null) {
          state[target] = idx < 16 ? { c: idx } : { hex: xterm256Color(idx) };
        }
        i += 3;
        continue;
      }
      if (mode === 2) {
        const r = channel(singleToken(groups[i + 2]));
        const g = channel(singleToken(groups[i + 3]));
        const b = channel(singleToken(groups[i + 4]));
        if (r !== null && g !== null && b !== null) {
          state[target] = { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}` };
        }
        i += 5;
        continue;
      }
      // Unknown extended-color mode: drop the rest of this sequence —
      // its length is unknowable, better to ignore than to misread.
      break;
    } else if (n === 58) {
      // Semicolon-form underline colour (tmux 3.7b emits exactly these):
      // 58;5;n spans 3 parameters, 58;2;r;g;b spans 5 — consumed whole
      // and ignored, since underline colour is not rendered.
      const mode = singleToken(groups[i + 1]);
      if (mode === 5) {
        i += 3;
        continue;
      }
      if (mode === 2) {
        i += 5;
        continue;
      }
      // Unknown underline-colour form: length unknowable, drop the rest.
      break;
    }
    // Any other parameter (blink, fonts, 59 = default underline colour,
    // ...) is ignored.
    i++;
  }
}

/** Render one styled text segment as escaped text or a single span. */
function renderSegment(text, state) {
  const escaped = escapeHtml(text);
  // Reverse swaps the EFFECTIVE fg/bg; when a side is default (null) the
  // ansi-reverse class lets page CSS swap the default colors too.
  const fg = state.reverse ? state.bg : state.fg;
  const bg = state.reverse ? state.fg : state.bg;
  const classes = [];
  if (state.bold) classes.push("ansi-bold");
  if (state.dim) classes.push("ansi-dim");
  if (state.italic) classes.push("ansi-italic");
  if (state.underline) classes.push("ansi-underline");
  if (state.reverse) classes.push("ansi-reverse");
  const styles = [];
  if (fg) {
    if (fg.c !== undefined) classes.push(`ansi-fg-${fg.c}`);
    else styles.push(`color:${fg.hex}`);
  }
  if (bg) {
    if (bg.c !== undefined) classes.push(`ansi-bg-${bg.c}`);
    else styles.push(`background-color:${bg.hex}`);
  }
  if (classes.length === 0 && styles.length === 0) return escaped;
  const classAttr = classes.length ? ` class="${classes.join(" ")}"` : "";
  const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";
  return `<span${classAttr}${styleAttr}>${escaped}</span>`;
}

/**
 * Convert a `capture-pane -e` string to HTML: escaped text in one flat span
 * per styled segment (no nesting), newlines preserved as \n.
 */
export function ansiToHtml(input) {
  const src = String(input ?? "");
  const state = initialState();
  let out = "";
  let buf = "";
  const flush = () => {
    if (buf) {
      out += renderSegment(buf, state);
      buf = "";
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== ESC) {
      const code = src.charCodeAt(i);
      // Keep \n (and \t); drop \r and any other stray C0 control byte.
      if (code >= 0x20 || ch === "\n" || ch === "\t") buf += ch;
      i++;
      continue;
    }
    const next = src[i + 1];
    if (next === "[") {
      // CSI: parameter/intermediate bytes until a final byte 0x40-0x7e.
      let j = i + 2;
      while (j < src.length && !(src.charCodeAt(j) >= 0x40 && src.charCodeAt(j) <= 0x7e)) j++;
      if (j < src.length && src[j] === "m") {
        flush();
        applySgr(state, src.slice(i + 2, j));
      }
      // Non-SGR CSI (cursor moves, erases, ...) is dropped entirely.
      i = j + 1;
    } else if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
      // OSC/DCS/SOS/PM/APC: swallow until BEL or ST (ESC \).
      let j = i + 2;
      while (j < src.length && src[j] !== "\u0007" && !(src[j] === ESC && src[j + 1] === "\\")) j++;
      i = src[j] === "\u0007" ? j + 1 : Math.min(j + 2, src.length);
    } else {
      // Bare ESC or a two-byte escape (ESC c, ESC 7, ...): drop it.
      i += next === undefined ? 1 : 2;
    }
  }
  flush();
  return out;
}

/**
 * CSS palette for the emitted classes — attribute rules FIRST so a concrete
 * ansi-fg-N/ansi-bg-N (equal specificity, later rule) wins over the
 * ansi-reverse default swap. Terminal default colors are themeable via
 * --ansi-fg / --ansi-bg custom properties.
 */
export function ansiPaletteCss() {
  const rules = [
    ".ansi-bold{font-weight:bold}",
    ".ansi-dim{opacity:.6}",
    ".ansi-italic{font-style:italic}",
    ".ansi-underline{text-decoration:underline}",
    ".ansi-reverse{color:var(--ansi-bg,#1e1e1e);background-color:var(--ansi-fg,#d4d4d4)}",
  ];
  for (let n = 0; n < 16; n++) {
    rules.push(`.ansi-fg-${n}{color:${BASE16[n]}}`);
    rules.push(`.ansi-bg-${n}{background-color:${BASE16[n]}}`);
  }
  return rules.join("\n");
}
