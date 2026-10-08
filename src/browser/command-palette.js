/**
 * Command palette shell — Cmd/Ctrl+K overlay shared across served WebUI
 * surfaces. Later lanes register result kinds via
 * window.TracequestPalette.registerProvider; this module owns invocation,
 * chrome, grouping, empty/no-results, focus trap, and a11y.
 *
 * Search lane: type-to-search sessions via the identity catalog shipped in
 * the page (#tq-cmdk-catalog) plus GET /api/search?limit=8&snippets=0
 * fallback. Ranked hits with source/id/prompt identity and highlighted
 * snippets, recent on empty query, open-by-hash, pickable /view?id=
 * destinations. GET /api/search?catalog=1 remains the fallback when the
 * page catalog is absent.
 *
 * Nav-pages lane: Go to destinations for Chat (/), Runs (/sessions),
 * Compare, rendered session (/view), launch, and the current run/chat;
 * type a page name or a g/go/goto prefix; G-then-letter chords.
 *
 * Nav-run-sections lane: in-view jumps on /run and chat/session (transcript,
 * analytics, raw terminal, composer) and /view chapter anchors (#chapter-N);
 * type a section or chapter name, or a j/jump/section / ch/chapter prefix.
 */

import { SOURCE_COLORS } from "./app-chrome.js";
import { OVERLAY_FOCUS_SRC } from "./overlay-focus.js";
import { FORM_FIELD_GUARD_SRC } from "./is-form-field.js";

export const COMMAND_PALETTE_CSS = `
/* ---- command palette (Cmd/Ctrl+K) ---- */
.cmdk-trigger {
  margin-left: auto;
  align-self: center;
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 9px;
  color: var(--fg3);
  cursor: pointer;
  flex: none;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.cmdk-trigger:hover {
  color: var(--fg2);
  border-color: rgba(255, 255, 255, 0.12);
  background: var(--surface2);
}
.cmdk-trigger:focus-visible {
  outline: none;
  border-color: var(--accent);
}
.cmdk-trigger-kbd {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.4;
}
.cmdk-trigger + .new-run-btn { margin-left: 0; }

.cmdk-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 14vh 16px 16px;
  background: transparent;
  isolation: isolate;
}
.cmdk-overlay[hidden] { display: none; }
.cmdk-scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.64);
  backdrop-filter: blur(2px) saturate(0.72);
  -webkit-backdrop-filter: blur(2px) saturate(0.72);
  pointer-events: auto;
}
.cmdk {
  position: relative;
  z-index: 1;
  isolation: isolate;
  width: 100%;
  max-width: 520px;
  background: var(--surface);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 12px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.04),
    0 24px 72px rgba(0, 0, 0, 0.72);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(68vh, 520px);
}
body.cmdk-open {
  overflow: hidden;
}
.cmdk-context-wrap {
  padding: 10px 12px 0;
}
.cmdk-context-wrap[hidden] { display: none; }
.cmdk-context {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmdk-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
}
.cmdk-input {
  flex: 1;
  min-width: 0;
  width: 100%;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 16px;
  font-weight: 400;
  line-height: 1.4;
  padding: 14px 16px;
  caret-color: var(--fg);
}
.cmdk-input::placeholder { color: var(--fg3); }
.cmdk-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  margin-right: 14px;
  border: 1.5px solid var(--fg3);
  border-top-color: var(--fg);
  border-radius: 50%;
  animation: cmdk-spin 0.7s linear infinite;
}
.cmdk-spinner[hidden] { display: none; }
@keyframes cmdk-spin { to { transform: rotate(360deg); } }
.cmdk-body {
  overflow-y: auto;
  padding: 6px 0 10px;
  min-height: 48px;
}
.cmdk-list { display: flex; flex-direction: column; }
.cmdk-group + .cmdk-group { margin-top: 2px; }
.cmdk-group-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--fg3);
  padding: 8px 14px 4px;
  line-height: 1.3;
}
.cmdk-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  padding: 5px 12px;
  border: 0;
  background: transparent;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 0;
}
.cmdk-item:focus { outline: none; }
.cmdk-item[aria-selected="true"],
.cmdk-item.hl {
  background: rgba(255, 255, 255, 0.06);
}
.cmdk-item-icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--fg3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cmdk-item-icon svg { display: block; }
.cmdk-item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.cmdk-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
.cmdk-item-idline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.cmdk-item-idline .cmdk-item-title { flex: 1; min-width: 0; }
.cmdk-src {
  flex: none;
  font-size: 9px;
  font-family: var(--mono);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--fg);
  box-shadow: inset 0 0 0 999px var(--chip-tint, rgba(17, 17, 19, 0.78));
  line-height: 1.3;
}
.cmdk-sid {
  flex: none;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg);
}
.cmdk-item-sub {
  font-size: 11px;
  color: var(--fg3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmdk-mark {
  background: rgba(232, 164, 76, 0.32);
  color: var(--fg);
  border-radius: 2px;
  padding: 0 1px;
  font-style: normal;
}
.cmdk-item.cmdk-hit {
  align-items: flex-start;
  min-height: 40px;
  padding-top: 7px;
  padding-bottom: 7px;
}
.cmdk-item-keys {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
}
.cmdk-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--fg2);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}
.cmdk-key-then {
  font-size: 10px;
  color: var(--fg3);
  font-family: var(--sans);
}
.cmdk-empty {
  padding: 2px 0 0;
}
.cmdk-empty[hidden] { display: none; }
.cmdk-empty-query {
  font-size: 13px;
  color: var(--fg2);
  padding: 8px 14px 4px;
}
.cmdk-empty-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 5px 12px;
}
.cmdk-empty-row .cmdk-item-title { color: var(--fg3); }
.cmdk-empty-action {
  margin-left: auto;
  color: var(--fg);
  font-size: 13px;
}
.cmdk-jump-flash {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
  transition: outline-color 0.8s ease;
}
.tq-search {
  position: relative;
  align-self: center;
  display: flex;
  align-items: center;
  flex: none;
  z-index: 160;
}
.tq-search.in-app-top { margin-left: auto; }
.tq-search.in-app-top + .cmdk-trigger { margin-left: 0; }
.tq-search.in-cmp-header { margin-left: auto; }
.tq-search.in-cmp-header + .cmp-back { margin-left: 0; }
.tq-search.tq-search-fixed {
  position: fixed;
  top: 8px;
  right: 16px;
}
.tq-search-input {
  width: 216px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.4;
  padding: 5px 48px 5px 12px;
  outline: none;
}
.tq-search-input::placeholder { color: var(--fg3); }
.tq-search-input:focus { border-color: rgba(255, 255, 255, 0.24); }
.tq-search-kbd {
  position: absolute;
  right: 6px;
  display: flex;
  align-items: center;
  gap: 3px;
  pointer-events: none;
}
.tq-search-kbd kbd {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--fg3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  line-height: 1.5;
}
.tq-search:focus-within .tq-search-kbd { display: none; }
.tq-search-list {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: min(360px, 90vw);
  max-height: min(52vh, 360px);
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  padding: 4px;
  z-index: 1;
}
.tq-search-list[hidden] { display: none; }
.tq-search-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.tq-search-item[aria-selected="true"],
.tq-search-item.hl { background: var(--surface2); }
.tq-search-item-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tq-search-item-sub {
  display: block;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tq-search-empty {
  padding: 8px;
  font-size: 12px;
  color: var(--fg3);
}
@media print {
  .cmdk-overlay, .cmdk-trigger, .tq-search, .tq-a11y-overlay { display: none !important; }
}
.tq-a11y-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 18vh 16px 16px;
  background: transparent;
  isolation: isolate;
}
.tq-a11y-overlay[hidden] { display: none; }
.tq-a11y-scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.64);
  backdrop-filter: blur(2px) saturate(0.72);
  -webkit-backdrop-filter: blur(2px) saturate(0.72);
  pointer-events: auto;
}
.tq-a11y-dialog {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 520px;
  background: var(--surface);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 12px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.04),
    0 24px 72px rgba(0, 0, 0, 0.72);
  padding: 16px 18px 14px;
}
.tq-a11y-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.tq-a11y-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  margin: 0;
}
.tq-a11y-close {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  font-family: var(--sans);
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
}
.tq-a11y-close:hover { color: var(--fg); }
.tq-a11y-help {
  font-size: 12px;
  color: var(--fg3);
  line-height: 1.45;
  margin: 0 0 12px;
}
.tq-a11y-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--fg);
  cursor: pointer;
}
.tq-a11y-check input {
  margin: 0;
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
}
.tq-a11y-table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 14px;
  font-size: 12px;
}
.tq-a11y-table th {
  text-align: left;
  font-weight: 500;
  color: var(--fg2);
  padding: 4px 12px 4px 0;
  white-space: nowrap;
  width: 44%;
  vertical-align: top;
}
.tq-a11y-table td {
  color: var(--fg);
  padding: 4px 0;
  vertical-align: top;
}
.tq-a11y-table kbd {
  display: inline-block;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--fg2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  line-height: 1.5;
  margin-right: 2px;
}
`;

export const COMMAND_PALETTE_HTML = `<div class="tq-search" id="workspaceSearchWrap">
  <input class="tq-search-input" id="workspaceSearch" type="search" role="combobox" aria-label="Search sessions" aria-autocomplete="list" aria-controls="workspaceSearchList" aria-expanded="false" placeholder="Search sessions" autocomplete="off" autocorrect="off" spellcheck="false" data-hotkey="s,/" aria-keyshortcuts="s /">
  <span class="tq-search-kbd" aria-hidden="true"><kbd>S</kbd><kbd>/</kbd></span>
  <div class="tq-search-list" id="workspaceSearchList" role="listbox" aria-label="Search results" hidden></div>
</div>
<nav id="tqHotkeyNav" hidden aria-hidden="true">
  <button type="button" id="tqHotkeyGoC" tabindex="-1" data-hotkey="g c">Chat</button>
  <button type="button" id="tqHotkeyGoR" tabindex="-1" data-hotkey="g r">Runs</button>
  <button type="button" id="tqHotkeyGoD" tabindex="-1" data-hotkey="g d">Compare</button>
  <button type="button" id="tqHotkeyGoV" tabindex="-1" data-hotkey="g v">View</button>
  <button type="button" id="tqHotkeyGoI" tabindex="-1" data-hotkey="g i">Insights</button>
  <button type="button" id="tqHotkeyGoN" tabindex="-1" data-hotkey="g n">New run</button>
  <button type="button" id="tqHotkeyHelp" tabindex="-1" data-hotkey="?,Shift+?,Shift+/,Mod+/,Control+/,Meta+/">Keyboard shortcuts</button>
</nav>
<div class="cmdk-overlay" id="cmdkOverlay" hidden data-cmdk-state="closed">
  <div class="cmdk-scrim" id="cmdkScrim" aria-hidden="true"></div>
  <div class="cmdk" role="dialog" aria-modal="true" aria-label="Command menu">
    <div class="cmdk-context-wrap" id="cmdkContextWrap" hidden>
      <span class="cmdk-context" id="cmdkContext"></span>
    </div>
    <div class="cmdk-input-wrap">
      <input class="cmdk-input" id="cmdkInput" type="text" role="combobox" aria-expanded="true" aria-controls="cmdkList" aria-autocomplete="list" placeholder="Type a command or search..." autocomplete="off" autocorrect="off" spellcheck="false">
      <span class="cmdk-spinner" id="cmdkSpinner" hidden aria-hidden="true"></span>
    </div>
    <div class="cmdk-body">
      <div class="cmdk-empty" id="cmdkEmpty" hidden></div>
      <div class="cmdk-list" id="cmdkList" role="listbox" aria-label="Commands"></div>
    </div>
  </div>
</div>
<div class="tq-a11y-overlay" id="characterKeysOverlay" hidden>
  <div class="tq-a11y-scrim" id="characterKeysScrim" aria-hidden="true"></div>
  <div class="tq-a11y-dialog" id="characterKeysDialog" role="dialog" aria-modal="true" aria-labelledby="characterKeysTitle" tabindex="-1">
    <div class="tq-a11y-head">
      <h2 class="tq-a11y-title" id="characterKeysTitle">Keyboard shortcuts</h2>
      <button type="button" class="tq-a11y-close" id="characterKeysClose">Close</button>
    </div>
    <table class="tq-a11y-table" id="shortcutCheatsheet">
      <tbody>
        <tr><th><kbd>S</kbd> or <kbd>/</kbd></th><td>Search</td></tr>
        <tr><th><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></th><td>Command menu</td></tr>
        <tr><th><kbd>G</kbd> then <kbd>C</kbd> <kbd>R</kbd> <kbd>D</kbd> <kbd>V</kbd> <kbd>N</kbd></th><td>Go to Chat, Runs, Compare, View, New run</td></tr>
        <tr><th><kbd>J</kbd> / <kbd>K</kbd></th><td>Next / previous in the current list</td></tr>
        <tr><th><kbd>O</kbd> or <kbd>Enter</kbd></th><td>Open focused item or toggle chapter</td></tr>
        <tr><th><kbd>?</kbd> or <kbd>⌘/</kbd></th><td>Keyboard shortcuts</td></tr>
        <tr><th><kbd>Esc</kbd></th><td>Close overlay or unfocus</td></tr>
      </tbody>
    </table>
    <p class="tq-a11y-help">Deselect Character keys to turn off shortcuts that only use single characters like S, / and G then C. Shortcuts that use Control or Command are not affected.</p>
    <label class="tq-a11y-check" for="characterKeysToggle">
      <input type="checkbox" id="characterKeysToggle" checked>
      Character keys
    </label>
  </div>
</div>`;

export function parsePaletteQuery(raw) {
  const text = String(raw || "");
  const start = text.replace(/^\s+/, "");
  const go = start.match(/^(g|go|goto)\s+([\s\S]*)$/i);
  if (go) return { raw: text, q: (go[2] || "").trim(), prefix: "goto" };
  const jump = start.match(/^(j|jump|section)\s+([\s\S]*)$/i);
  if (jump) return { raw: text, q: (jump[2] || "").trim(), prefix: "jump" };
  const ch = start.match(/^(ch|chapter)\s+([\s\S]*)$/i);
  if (ch) return { raw: text, q: (ch[2] || "").trim(), prefix: "chapter" };
  const m = start.match(/^(s|session|r|run)\s+([\s\S]*)$/i);
  if (m) return { raw: text, q: (m[2] || "").trim(), prefix: "session" };
  return { raw: text, q: start.trim(), prefix: "" };
}

export function isPaletteSessionHash(value) {
  return typeof value === "string" && /^[0-9a-f]{8}$/i.test(value.trim());
}

export function sessionViewHref(hit) {
  const id = (hit && (hit.id || hit.sessionHash)) || "";
  let href = "/view?id=" + encodeURIComponent(id);
  if (hit && hit.source && hit.source !== "claude") {
    href += "&source=" + encodeURIComponent(hit.source);
  }
  return href;
}

export function firstSnippet(matches) {
  if (!matches || !matches.length) return null;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m && m.snippet) {
      return {
        text: String(m.snippet),
        matchStart: m.matchStart,
        matchLen: m.matchLen,
      };
    }
  }
  return null;
}

function escPaletteText(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function queryHighlightTokens(query) {
  const seen = new Set();
  const out = [];
  for (const part of String(query || "").trim().split(/\s+/).filter(Boolean)) {
    const bits = part.split(/[-_./]+/).filter((x) => x.length >= 2);
    const list = bits.length ? bits.concat([part]) : [part];
    for (const t of list) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

function looksLikeRawJsonl(text) {
  const t = String(text || "");
  if (/"sessionHash"\s*:/.test(t) && /"source"\s*:/.test(t)) return true;
  if (/"type"\s*:\s*"(user|assistant|system)"/.test(t)) return true;
  const trimmed = t.trim();
  return trimmed.charCodeAt(0) === 123 && /"type"\s*:/.test(trimmed);
}

export function pickSearchSnippet(hit, query) {
  const snip = firstSnippet(hit && hit.matches);
  const prompt = String((hit && hit.prompt) || "").trim();
  const tokens = queryHighlightTokens(query);
  const hasToken = (text) => {
    if (!text) return false;
    if (!tokens.length) return true;
    const lower = text.toLowerCase();
    return tokens.some((t) => lower.includes(t));
  };
  if (snip && hasToken(snip.text) && !looksLikeRawJsonl(snip.text)) return snip;
  if (prompt && hasToken(prompt)) return { text: prompt };
  if (snip && !looksLikeRawJsonl(snip.text)) return snip;
  return prompt ? { text: prompt } : snip;
}

export function highlightSnippet(text, query, matchStart, matchLen) {
  const s = String(text == null ? "" : text);
  if (Number.isFinite(matchStart) && matchStart >= 0 && matchLen > 0 && matchStart < s.length) {
    const a = s.slice(0, matchStart);
    const b = s.slice(matchStart, matchStart + matchLen);
    const c = s.slice(matchStart + matchLen);
    return escPaletteText(a) + '<mark class="cmdk-mark">' + escPaletteText(b) + "</mark>" + highlightSnippet(c, query);
  }
  const tokens = queryHighlightTokens(query);
  if (!tokens.length) return escPaletteText(s);
  const lower = s.toLowerCase();
  let best = -1;
  let bestLen = 0;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
      bestLen = token.length;
    }
  }
  if (best < 0) return escPaletteText(s);
  return escPaletteText(s.slice(0, best))
    + '<mark class="cmdk-mark">' + escPaletteText(s.slice(best, best + bestLen)) + "</mark>"
    + highlightSnippet(s.slice(best + bestLen), query);
}

export function searchHitToItem(hit, query, opts) {
  const group = (opts && opts.group) || "Sessions";
  const groupPriority = (opts && opts.groupPriority) || 80;
  const id = (hit && (hit.id || hit.sessionHash)) || "";
  const prompt = String((hit && hit.prompt) || "").trim();
  const snip = pickSearchSnippet(hit, query);
  const snippetText = snip ? snip.text : "";
  const title = prompt || "(no prompt)";
  const snippetIsTitle = snippetText && snippetText === prompt;
  return {
    id: "session-" + (id || (hit && hit.path) || "unknown"),
    kind: "session",
    ranked: true,
    group,
    groupPriority,
    title,
    titleHtml: query ? highlightSnippet(title, query) : "",
    subtitle: snippetIsTitle ? "" : snippetText,
    snippetHtml: snippetText && !snippetIsTitle
      ? highlightSnippet(snippetText, query, snip && snip.matchStart, snip && snip.matchLen)
      : "",
    identity: {
      source: (hit && hit.source) || "claude",
      id,
      model: (hit && hit.model) || "",
    },
    href: sessionViewHref(hit || {}),
    icon: "view",
    keywords: [hit && hit.source, id, hit && hit.project, hit && hit.model].filter(Boolean),
  };
}

export function scorePaletteCatalogSession(session, tokens) {
  if (!session || !tokens || !tokens.length) return 0;
  const id = String(session.id || session.sessionHash || "").toLowerCase();
  const source = String(session.source || "").toLowerCase();
  const prompt = String(session.prompt || "").toLowerCase();
  const project = String(session.project || "").toLowerCase();
  const model = String(session.model || "").toLowerCase();
  const toolList = Array.isArray(session.tools)
    ? session.tools.map((t) => String(t).toLowerCase())
    : String(session.tools || "").toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    let hit = 0;
    if (id === t) hit = 100;
    else if (id.startsWith(t)) hit = 70;
    else if (t.length >= 3 && id.includes(t)) hit = 40;
    if (source === t) hit = Math.max(hit, 35);
    else if (source.startsWith(t)) hit = Math.max(hit, 20);
    for (let k = 0; k < toolList.length; k++) {
      const tool = toolList[k];
      if (tool === t) hit = Math.max(hit, 60);
      else if (tool.startsWith(t)) hit = Math.max(hit, 45);
      else if (t.length >= 3 && tool.includes(t)) hit = Math.max(hit, 30);
    }
    if (prompt.includes(t)) hit = Math.max(hit, t.length >= 3 ? 25 : 12);
    if (project.includes(t) || model.includes(t)) hit = Math.max(hit, 15);
    if (!hit) return 0;
    score += hit;
  }
  return score;
}

export function catalogMatchSnippet(session, query) {
  const prompt = String((session && session.prompt) || "");
  const tokens = queryHighlightTokens(query);
  if (tokens.length && tokens.some((t) => prompt.toLowerCase().includes(t))) return prompt;
  const tools = session && Array.isArray(session.tools) ? session.tools : [];
  for (let i = 0; i < tools.length; i++) {
    const tool = String(tools[i] || "");
    const lower = tool.toLowerCase();
    if (tokens.some((t) => lower === t || lower.startsWith(t) || (t.length >= 3 && lower.includes(t)))) {
      return tool + (prompt ? " · " + prompt : "");
    }
  }
  return prompt || String((session && session.project) || "");
}

/** Compact interned-tools rows for in-page catalog (same identities as GET catalog=1). */
export function packSearchCatalog(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const tools = [];
  const toolIdx = new Map();
  const rows = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const rawTools = Array.isArray(s.tools) ? s.tools : [];
    const ids = new Array(rawTools.length);
    for (let j = 0; j < rawTools.length; j++) {
      const name = String(rawTools[j] || "");
      let idx = toolIdx.get(name);
      if (idx === undefined) {
        idx = tools.length;
        toolIdx.set(name, idx);
        tools.push(name);
      }
      ids[j] = idx;
    }
    rows[i] = [
      String(s.id || s.sessionHash || ""),
      String(s.source || ""),
      String(s.prompt || ""),
      String(s.model || ""),
      String(s.project || ""),
      ids,
    ];
  }
  return { t: tools, s: rows };
}

export function unpackSearchCatalog(packed) {
  if (!packed) return [];
  if (Array.isArray(packed)) return packed;
  if (Array.isArray(packed.sessions)) return packed.sessions;
  const tools = packed.t;
  const rows = packed.s;
  if (!Array.isArray(tools) || !Array.isArray(rows)) return [];
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const tids = Array.isArray(r[5]) ? r[5] : [];
    const names = new Array(tids.length);
    for (let j = 0; j < tids.length; j++) names[j] = tools[tids[j]] || "";
    out[i] = {
      id: r[0] || "",
      source: r[1] || "claude",
      prompt: r[2] || "",
      model: r[3] || "",
      project: r[4] || "",
      tools: names,
    };
  }
  return out;
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function searchCatalogEmbedScript(catalog) {
  const packed = catalog && catalog.s && catalog.t ? catalog : packSearchCatalog(catalog);
  return `<script type="application/json" id="tq-cmdk-catalog">${jsonForScript(packed)}</script>`;
}

/** Insert the identity catalog so palette JS can rank on the first key without catalog HTTP. */
export function injectSearchCatalog(html, catalog) {
  if (!html || html.includes('id="tq-cmdk-catalog"')) return html;
  const tag = "\n" + searchCatalogEmbedScript(catalog) + "\n";
  const bodyOpen = html.match(/<body[^>]*>/i);
  if (bodyOpen) {
    const at = html.indexOf(bodyOpen[0]) + bodyOpen[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const at = html.lastIndexOf("</body>");
  return at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
}

export function searchPaletteCatalog(sessions, query, limit) {
  const q = String(query || "").trim();
  const cap = Math.max(1, Math.min(Number(limit) || 8, 8));
  if (!q || !sessions || !sessions.length) return [];
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const score = scorePaletteCatalogSession(s, tokens);
    if (score > 0) scored.push({ s, score, i });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  const n = Math.min(cap, scored.length);
  for (let j = 0; j < n; j++) {
    const s = scored[j].s;
    out.push({
      id: s.id,
      sessionHash: s.id,
      source: s.source || "claude",
      prompt: s.prompt || "",
      model: s.model || "",
      project: s.project || "",
      matches: [{ type: "text", snippet: catalogMatchSnippet(s, q) }],
    });
  }
  return out;
}

export function openSessionItem(hash) {
  const id = String(hash || "").trim().toLowerCase();
  return {
    id: "session-" + id,
    kind: "session",
    ranked: true,
    group: "Sessions",
    groupPriority: 90,
    title: "Open session",
    identity: { source: "", id },
    href: "/view?id=" + encodeURIComponent(id),
    icon: "view",
    keywords: ["hash", "id", "open"],
  };
}

export const PALETTE_LAST_VIEW_KEY = "tq-cmdk-last-view";
export const PALETTE_LAST_COMPARE_KEY = "tq-cmdk-last-compare";
export const PALETTE_LAST_CHAT_KEY = "tq-cmdk-last-chat";

export function readPaletteStore(key) {
  try {
    if (typeof sessionStorage === "undefined") return "";
    return sessionStorage.getItem(key) || "";
  } catch (e) {
    return "";
  }
}

export function writePaletteStore(key, value) {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (value == null || value === "") sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(value));
  } catch (e) { /* private mode */ }
}

export function compareHrefFromParts(a, b, sa, sb) {
  let href = "/compare?a=" + encodeURIComponent(a) + "&b=" + encodeURIComponent(b);
  if (sa && sa !== "claude") href += "&sa=" + encodeURIComponent(sa);
  if (sb && sb !== "claude") href += "&sb=" + encodeURIComponent(sb);
  return href;
}

export function lastCompareHref() {
  const raw = readPaletteStore(PALETTE_LAST_COMPARE_KEY);
  if (!raw) return "";
  try {
    const o = JSON.parse(raw);
    if (!o || !o.a || !o.b) return "";
    return compareHrefFromParts(o.a, o.b, o.sa, o.sb);
  } catch (e) {
    return "";
  }
}

export function compareHref(ctx) {
  if (ctx && ctx.a && ctx.b) return compareHrefFromParts(ctx.a, ctx.b, ctx.sa, ctx.sb);
  return lastCompareHref() || "/compare";
}

export function viewHref(ctx) {
  if (ctx && ctx.viewHref) return ctx.viewHref;
  if (ctx && ctx.page === "view" && typeof location !== "undefined" && location.pathname) {
    return location.pathname + (location.search || "");
  }
  if (ctx && ctx.viewId) return "/view?id=" + encodeURIComponent(ctx.viewId);
  if (ctx && ctx.session) return "/view?id=" + encodeURIComponent(ctx.session);
  return readPaletteStore(PALETTE_LAST_VIEW_KEY) || "/view";
}

export function thisRunHref(ctx) {
  if (ctx && ctx.runId) return "/run?id=" + encodeURIComponent(ctx.runId);
  if (ctx && ctx.chatHref && /\/run\?id=/.test(ctx.chatHref)) return ctx.chatHref;
  return "";
}

export function thisChatHref(ctx) {
  if (ctx && ctx.session) return "/run?session=" + encodeURIComponent(ctx.session);
  if (ctx && ctx.page === "view" && ctx.viewId) {
    return "/run?session=" + encodeURIComponent(ctx.viewId);
  }
  return "";
}

export function rememberPaletteDestinations(ctx) {
  if (!ctx) return;
  if (ctx.page === "view") {
    const href = ctx.viewHref || (ctx.viewId ? "/view?id=" + encodeURIComponent(ctx.viewId) : "");
    if (href) writePaletteStore(PALETTE_LAST_VIEW_KEY, href);
  }
  if (ctx.page === "compare" && ctx.a && ctx.b) {
    writePaletteStore(PALETTE_LAST_COMPARE_KEY, JSON.stringify({
      a: ctx.a,
      b: ctx.b,
      sa: ctx.sa || "",
      sb: ctx.sb || "",
    }));
  }
  if (ctx.page === "run" && ctx.runId) {
    writePaletteStore(PALETTE_LAST_CHAT_KEY, "/run?id=" + encodeURIComponent(ctx.runId));
  } else if (ctx.page === "session" && ctx.session) {
    writePaletteStore(PALETTE_LAST_CHAT_KEY, "/run?session=" + encodeURIComponent(ctx.session));
  }
}

export function isPageJumpQuery(query) {
  const parsed = parsePaletteQuery(query);
  if (parsed.prefix === "goto") return true;
  const q = String(parsed.q || "").trim().toLowerCase();
  if (!q || isPaletteSessionHash(q)) return false;
  if (/^(go|goto)$/.test(q)) return true;
  return /^(go\s+to\s+|go\s+|goto\s+)?(chat|runs?|sessions?|compare|compa|comp|view|rendered|launch|new|home|inventory|diff|worksheet|pages?)\b/.test(q);
}

export function pageNavItems(ctx) {
  ctx = ctx || {};
  const lastCompare = lastCompareHref();
  const items = [
    {
      id: "goto-chat",
      kind: "nav",
      dest: "chat",
      group: "Go to",
      groupPriority: 50,
      title: "Go to Chat",
      subtitle: "Home conversation",
      icon: "chat",
      href: "/",
      shortcut: ["G", "then", "C"],
      keywords: ["home", "run", "conversation", "go", "goto", "page"],
    },
    {
      id: "goto-runs",
      kind: "nav",
      dest: "runs",
      group: "Go to",
      groupPriority: 50,
      title: "Go to Runs",
      subtitle: "Session inventory",
      icon: "runs",
      href: "/sessions",
      shortcut: ["G", "then", "R"],
      keywords: ["home", "sessions", "list", "inventory", "dashboard", "go", "goto", "page"],
    },
    {
      id: "goto-insights",
      kind: "nav",
      dest: "insights",
      group: "Go to",
      groupPriority: 50,
      title: "Go to Insights",
      subtitle: "Where agents waste time and fail",
      icon: "insights",
      href: "/insights",
      shortcut: ["G", "then", "I"],
      keywords: ["insights", "trends", "errors", "stalls", "cost", "machines", "go", "goto", "page"],
    },
    {
      id: "goto-compare",
      kind: "nav",
      dest: "compare",
      group: "Go to",
      groupPriority: 50,
      title: "Go to Compare",
      subtitle: (ctx.a && ctx.b) ? (String(ctx.a) + " · " + String(ctx.b)) : (lastCompare ? "Last pair" : "Diagnostic worksheet"),
      icon: "compare",
      href: compareHref(ctx),
      shortcut: ["G", "then", "D"],
      keywords: ["diff", "worksheet", "comparison", "go", "goto", "page"],
    },
    {
      id: "goto-view",
      kind: "nav",
      dest: "view",
      group: "Go to",
      groupPriority: 50,
      title: "Go to rendered session",
      subtitle: ctx.viewTitle || ctx.viewId || "Full session page",
      icon: "view",
      href: viewHref(ctx),
      shortcut: ["G", "then", "V"],
      keywords: ["analytics", "full page", "rendered", "viewer", "go", "goto", "page"],
    },
    {
      id: "goto-new-run",
      kind: "nav",
      dest: "launch",
      group: "Go to",
      groupPriority: 50,
      title: "New run",
      subtitle: "Open the launcher",
      icon: "plus",
      href: "/?launch=1",
      shortcut: ["G", "then", "N"],
      keywords: ["launch", "start", "agent", "go", "goto", "page", "new"],
      actionName: "launch",
    },
  ];
  const runHref = thisRunHref(ctx);
  if (runHref) {
    items.push({
      id: "goto-this-run",
      kind: "nav",
      dest: "this-run",
      group: "Go to",
      groupPriority: 52,
      title: "Go to this run",
      subtitle: ctx.runId || "Open chat",
      icon: "chat",
      href: runHref,
      keywords: ["live", "watch", "chat", "current", "open"],
    });
  }
  const liveChat = thisChatHref(ctx);
  if (liveChat && liveChat !== runHref) {
    items.push({
      id: "goto-this-chat",
      kind: "nav",
      dest: "this-chat",
      group: "Go to",
      groupPriority: 52,
      title: "Go to this chat",
      subtitle: ctx.session || ctx.viewId || "Open chat",
      icon: "chat",
      href: liveChat,
      keywords: ["live", "watch", "session", "current", "open"],
    });
  }
  const lastChat = readPaletteStore(PALETTE_LAST_CHAT_KEY);
  if (lastChat && lastChat !== runHref && lastChat !== liveChat) {
    items.push({
      id: "goto-last-chat",
      kind: "nav",
      dest: "last-chat",
      group: "Go to",
      groupPriority: 48,
      title: "Go to last chat",
      subtitle: lastChat.replace(/^\/run\?/, ""),
      icon: "chat",
      href: lastChat,
      keywords: ["recent", "previous", "run"],
    });
  }
  return items;
}

export const RUN_SECTION_CATALOG = [
  {
    dest: "transcript",
    title: "Jump to transcript",
    subtitle: "Conversation thread",
    icon: "chat",
    keywords: ["chat", "conversation", "messages", "thread", "scroll", "chatscroll", "chatthread"],
    selectors: ["#chatThread", "#chatScroll"],
  },
  {
    dest: "analytics",
    title: "Jump to analytics",
    subtitle: "Grade and charts",
    icon: "analytics",
    keywords: ["panel", "grade", "charts", "sidebar", "runanalytics"],
    selectors: ["#runAnalytics", "#analyticsToggle"],
  },
  {
    dest: "terminal",
    title: "Jump to raw terminal",
    subtitle: "tmux screen",
    icon: "terminal",
    keywords: ["screen", "ansi", "raw", "tmux", "terminaldetails"],
    selectors: ["#terminalDetails", "#runTerminal"],
  },
  {
    dest: "composer",
    title: "Jump to composer",
    subtitle: "Follow-up input",
    icon: "compose",
    keywords: ["input", "prompt", "follow-up", "status", "composerstatus", "card"],
    selectors: ["#inputText", "#composerStatus", "#inputRow", "#continueInput", ".composer-card"],
  },
  {
    dest: "history",
    title: "Jump to chat history",
    subtitle: "Earlier turns",
    icon: "chat",
    keywords: ["history", "previous", "archive", "chathistory"],
    selectors: ["#chatHistory"],
    requireVisible: true,
  },
];

export const VIEW_SECTION_CATALOG = [
  {
    dest: "summary",
    title: "Jump to summary",
    subtitle: "Session header",
    icon: "analytics",
    keywords: ["header", "stats", "meta", "overview"],
    selectors: [".stats-bar", ".header", "#app"],
  },
  {
    dest: "chapters",
    title: "Jump to chapters",
    subtitle: "Chapter list",
    icon: "chapter",
    keywords: ["chapter-0", "outline", "turns"],
    selectors: [".chapters", "#chapter-0"],
  },
];

export const CHAPTER_EMPTY_CAP = 12;
export const CHAPTER_QUERY_CAP = 24;

export function inViewGroupName(page) {
  if (page === "run") return "This run";
  if (page === "home") return "This chat";
  if (page === "runs") return "This page";
  return "This session";
}

export function isRunLikePage(page) {
  return page === "run" || page === "session" || page === "home";
}

export function chapterQueryIndex(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  const hash = /^#?chapter-(\d+)$/i.exec(s);
  if (hash) return parseInt(hash[1], 10);
  const labeled = /^(?:chapter[- ]+|ch[- ]+)(\d+)$/i.exec(s);
  if (labeled) return parseInt(labeled[1], 10) - 1;
  if (/^\d+$/.test(s)) return parseInt(s, 10) - 1;
  return null;
}

export function chapterPermalink(idx, loc) {
  const n = Number(idx);
  if (!Number.isFinite(n) || n < 0) return "";
  const hash = "#chapter-" + n;
  if (!loc) return hash;
  const path = loc.pathname || "";
  const search = loc.search || "";
  return path + search + hash;
}

export function chapterDescriptorFromElement(el) {
  if (!el || !el.id) return null;
  const m = /^chapter-(\d+)$/.exec(el.id);
  if (!m) return null;
  const promptEl = el.querySelector && el.querySelector(".chapter-prompt-text");
  const prompt = promptEl && promptEl.textContent ? String(promptEl.textContent).trim() : "";
  return { index: parseInt(m[1], 10), id: el.id, prompt };
}

export function collectChapterDescriptors(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const nodes = root.querySelectorAll('[id^="chapter-"]');
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const d = chapterDescriptorFromElement(nodes[i]);
    if (d) out.push(d);
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

export function inViewSectionItems(ctx, hasSelector) {
  ctx = ctx || {};
  const page = ctx.page;
  let catalog = [];
  if (isRunLikePage(page)) catalog = RUN_SECTION_CATALOG;
  else if (page === "view") catalog = VIEW_SECTION_CATALOG;
  const group = inViewGroupName(page);
  const out = [];
  for (let i = 0; i < catalog.length; i++) {
    const def = catalog[i];
    if (typeof hasSelector === "function") {
      let ok = false;
      for (let s = 0; s < def.selectors.length; s++) {
        try {
          if (hasSelector(def.selectors[s], def)) { ok = true; break; }
        } catch (e) { /* ignore selector probe errors */ }
      }
      if (!ok) continue;
    }
    out.push({
      id: "jump-" + def.dest,
      kind: "jump",
      dest: def.dest,
      group,
      groupPriority: 110,
      title: def.title,
      subtitle: def.subtitle,
      icon: def.icon,
      keywords: (def.keywords || []).concat(["jump", "section", "here", "in-view"]),
    });
  }
  return out;
}

export function inViewChapterItems(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const ch = list[i] || {};
    const idx = Number(ch.index);
    if (!Number.isFinite(idx) || idx < 0) continue;
    const num = idx + 1;
    const prompt = String(ch.prompt || "").trim();
    out.push({
      id: "chapter-" + idx,
      kind: "chapter",
      dest: "chapter-" + idx,
      chapterIndex: idx,
      group: "Chapters",
      groupPriority: 105,
      title: "Jump to chapter " + num,
      subtitle: prompt || ("#chapter-" + idx),
      icon: "chapter",
      href: "#chapter-" + idx,
      keywords: [
        "chapter", "chapters", "jump", "anchor", "section",
        String(num), String(idx), "chapter-" + idx, "ch" + num, "ch-" + num,
        prompt,
      ].filter(Boolean),
    });
  }
  return out;
}

export function isInViewJumpQuery(query) {
  const parsed = parsePaletteQuery(query);
  if (parsed.prefix === "jump" || parsed.prefix === "chapter") return true;
  const q = String(parsed.q || "").trim().toLowerCase();
  if (!q || isPaletteSessionHash(q)) return false;
  if (chapterQueryIndex(q) != null) return true;
  return /^(jump\s+(to\s+)?|go\s+to\s+)?(transcript|analytics|terminal|composer|history|chapters?|summary|raw)\b/.test(q)
    || /^#chapter-\d+$/i.test(q);
}

export function capChapterItems(items, query) {
  const parsed = parsePaletteQuery(query);
  const cap = parsed.q ? CHAPTER_QUERY_CAP : CHAPTER_EMPTY_CAP;
  const out = [];
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === "chapter") {
      if (n >= cap) continue;
      n++;
    }
    out.push(it);
  }
  return out;
}

/** Full inject snippet for pages that do not already embed the pieces. */
export function commandPaletteServeInject() {
  return `<style id="cmdk-css">${COMMAND_PALETTE_CSS}</style>
${COMMAND_PALETTE_HTML}
<script>
${COMMAND_PALETTE_CLIENT_JS}
</script>`;
}

/** Insert palette CSS/HTML/JS before </body> unless already mounted. */
export function injectCommandPalette(html) {
  if (!html || html.includes('<div class="cmdk-overlay" id="cmdkOverlay"')) return html;
  const snippet = commandPaletteServeInject();
  const at = html.lastIndexOf("</body>");
  return at >= 0 ? html.slice(0, at) + snippet + "\n" + html.slice(at) : html + snippet;
}

export const COMMAND_PALETTE_CLIENT_JS = `
/* --- command palette shell: Cmd/Ctrl+K overlay --- */
(function () {
  ${FORM_FIELD_GUARD_SRC}
  var overlay = document.getElementById("cmdkOverlay");
  if (!overlay) return;
  if (overlay.getAttribute("data-cmdk-bound") === "1") return;
  overlay.setAttribute("data-cmdk-bound", "1");

  var dialog = overlay.querySelector(".cmdk");
  var input = document.getElementById("cmdkInput");
  var listEl = document.getElementById("cmdkList");
  var emptyEl = document.getElementById("cmdkEmpty");
  var contextWrap = document.getElementById("cmdkContextWrap");
  var contextEl = document.getElementById("cmdkContext");
  var spinner = document.getElementById("cmdkSpinner");
  var trigger = document.getElementById("cmdkTrigger");
  var extraCtx = {};
  var providers = [];
  var items = [];
  var active = 0;
  var prevFocus = null;
  var gen = 0;
  var busyTimer = 0;

  var ICO = {
    search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    runs: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M3 8h10M3 11.5h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    compare: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="4.5" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="3.5" width="4.5" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>',
    insights: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 13V8.5M6.5 13V4M10 13V7M13.5 13V2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    chat: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 4.2h9v6.3H7.2L4.2 13V10.5H3.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    view: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 3.5h8v9H4z" stroke="currentColor" stroke-width="1.3"/><path d="M6 6.5h4M6 9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    analytics: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 12V8M8 12V4M12.5 12V6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    terminal: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 5.5 6.5 8 4 10.5M8.5 10.5H12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    compose: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 12.5 4 9.5 11.2 2.3a1.2 1.2 0 0 1 1.7 0l.8.8a1.2 1.2 0 0 1 0 1.7L6.5 12z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    go: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 8h8M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chapter: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 3.5h8v9H4zM6.5 6.5h3M6.5 9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    filter: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10L9.5 9v3.5L6.5 14V9z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    keys: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="4.5" width="11" height="7" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M5 8h.01M8 8h.01M11 8h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
  };
  var openCharacterKeysDialog = null;

  var SOURCE_COLORS = ${JSON.stringify(SOURCE_COLORS)};
  ${OVERLAY_FOCUS_SRC}
  ${parsePaletteQuery.toString()}
  ${isPaletteSessionHash.toString()}
  ${sessionViewHref.toString()}
  ${firstSnippet.toString()}
  ${escPaletteText.toString()}
  ${queryHighlightTokens.toString()}
  ${looksLikeRawJsonl.toString()}
  ${pickSearchSnippet.toString()}
  ${highlightSnippet.toString()}
  ${searchHitToItem.toString()}
  ${scorePaletteCatalogSession.toString()}
  ${catalogMatchSnippet.toString()}
  ${searchPaletteCatalog.toString()}
  ${unpackSearchCatalog.toString()}
  ${openSessionItem.toString()}
  var PALETTE_LAST_VIEW_KEY = ${JSON.stringify(PALETTE_LAST_VIEW_KEY)};
  var PALETTE_LAST_COMPARE_KEY = ${JSON.stringify(PALETTE_LAST_COMPARE_KEY)};
  var PALETTE_LAST_CHAT_KEY = ${JSON.stringify(PALETTE_LAST_CHAT_KEY)};
  ${readPaletteStore.toString()}
  ${writePaletteStore.toString()}
  ${compareHrefFromParts.toString()}
  ${lastCompareHref.toString()}
  ${compareHref.toString()}
  ${viewHref.toString()}
  ${thisRunHref.toString()}
  ${thisChatHref.toString()}
  ${rememberPaletteDestinations.toString()}
  ${isPageJumpQuery.toString()}
  ${pageNavItems.toString()}
  var RUN_SECTION_CATALOG = ${JSON.stringify(RUN_SECTION_CATALOG)};
  var VIEW_SECTION_CATALOG = ${JSON.stringify(VIEW_SECTION_CATALOG)};
  var CHAPTER_EMPTY_CAP = ${CHAPTER_EMPTY_CAP};
  var CHAPTER_QUERY_CAP = ${CHAPTER_QUERY_CAP};
  ${inViewGroupName.toString()}
  ${isRunLikePage.toString()}
  ${chapterQueryIndex.toString()}
  ${chapterPermalink.toString()}
  ${chapterDescriptorFromElement.toString()}
  ${collectChapterDescriptors.toString()}
  ${inViewSectionItems.toString()}
  ${inViewChapterItems.toString()}
  ${isInViewJumpQuery.toString()}
  ${capChapterItems.toString()}

  var searchTimer = 0;
  var searchAbort = null;
  var lastSearchKey = "";
  var lastSearchHits = null;
  var recentCache = { at: 0, sessions: [], liveSessions: [] };
  var catalogCache = { at: 0, sessions: null, pending: null };
  var RECENT_Q_KEY = "tq-cmdk-recent";
  var CATALOG_TTL_MS = 60000;

  function sourceColor(source) {
    return SOURCE_COLORS[source] || "#7a7a85";
  }
  function loadRecentQueries() {
    try {
      var raw = sessionStorage.getItem(RECENT_Q_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === "string" && x.trim(); }) : [];
    } catch (e) { return []; }
  }
  function pushRecentQuery(q) {
    q = String(q || "").trim();
    if (q.length < 2 || isPaletteSessionHash(q)) return;
    var arr = loadRecentQueries().filter(function (x) { return x !== q; });
    arr.unshift(q);
    if (arr.length > 6) arr.length = 6;
    try { sessionStorage.setItem(RECENT_Q_KEY, JSON.stringify(arr)); } catch (e2) {}
  }
  function fetchJson(url, signal) {
    var opts = { headers: { Accept: "application/json" } };
    if (signal) opts.signal = signal;
    return fetch(url, opts).then(function (r) {
      return r.ok ? r.json() : {};
    }).catch(function () { return {}; });
  }
  function fetchRecentSessions() {
    if (recentCache.at && Date.now() - recentCache.at < 15000) {
      return Promise.resolve(recentCache);
    }
    return fetchJson("/api/sessions?page=1&pageSize=8&sort=recent").then(function (data) {
      recentCache = {
        at: Date.now(),
        sessions: data.sessions || [],
        liveSessions: data.liveSessions || []
      };
      return recentCache;
    });
  }
  var searchWaiters = [];
  var searchPendingQ = "";
  function paletteSearchUrl(q) {
    return "/api/search?q=" + encodeURIComponent(q) + "&limit=8&snippets=0";
  }
  function seedCatalogFromPage() {
    var el = document.getElementById("tq-cmdk-catalog");
    if (!el) return false;
    try {
      var packed = JSON.parse(el.textContent || "null");
      var sessions = unpackSearchCatalog(packed);
      if (!sessions) return false;
      catalogCache.sessions = sessions;
      catalogCache.at = Date.now();
      return true;
    } catch (e) { return false; }
  }
  var pageCatalogReady = seedCatalogFromPage();
  function fetchSearchCatalog() {
    if (catalogCache.sessions && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
      return Promise.resolve(catalogCache.sessions);
    }
    if (pageCatalogReady && catalogCache.sessions) {
      return Promise.resolve(catalogCache.sessions);
    }
    if (catalogCache.pending) return catalogCache.pending;
    catalogCache.pending = fetchJson("/api/search?catalog=1").then(function (data) {
      catalogCache.sessions = (data && data.sessions) || [];
      catalogCache.at = Date.now();
      catalogCache.pending = null;
      return catalogCache.sessions;
    }).catch(function () {
      catalogCache.pending = null;
      return catalogCache.sessions || [];
    });
    return catalogCache.pending;
  }
  function debounceSearch(q) {
    return new Promise(function (resolve) {
      if (lastSearchKey === q && lastSearchHits) {
        resolve(lastSearchHits);
        return;
      }
      searchWaiters.push(resolve);
      searchPendingQ = q;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = 0;
        var waiters = searchWaiters;
        var want = searchPendingQ;
        searchWaiters = [];
        if (searchAbort) {
          try { searchAbort.abort(); } catch (e) {}
        }
        searchAbort = typeof AbortController === "function" ? new AbortController() : null;
        var signal = searchAbort && searchAbort.signal;
        fetchJson(paletteSearchUrl(want), signal)
          .then(function (data) {
            var hits = (data && data.results) || [];
            lastSearchKey = want;
            lastSearchHits = hits;
            for (var i = 0; i < waiters.length; i++) waiters[i](hits);
          });
      }, 80);
    });
  }
  function hitsToSessionItems(hits, q) {
    var out = [];
    var seen = Object.create(null);
    var cap = Math.min(hits.length, 8);
    for (var i = 0; i < cap; i++) {
      var item = searchHitToItem(hits[i], q, { group: "Sessions", groupPriority: 80 });
      out.push(item);
      if (item.identity && item.identity.id) seen[String(item.identity.id).toLowerCase()] = 1;
    }
    if (isPaletteSessionHash(q) && !seen[q.toLowerCase()]) {
      out.unshift(openSessionItem(q));
    }
    return out;
  }
  function recentQueryItems() {
    var qs = loadRecentQueries();
    var out = [];
    for (var i = 0; i < qs.length; i++) {
      out.push({
        id: "recent-q-" + qs[i],
        kind: "recent-query",
        group: "Recent searches",
        groupPriority: 65,
        title: qs[i],
        icon: "search",
        keepOpen: true,
        action: (function (saved) {
          return function () {
            input.value = saved;
            active = 0;
            refresh();
          };
        })(qs[i])
      });
    }
    return out;
  }
  function sessionSearchItems(query, ctx) {
    var parsed = parsePaletteQuery(query);
    if (!parsed.q) {
      return fetchRecentSessions().then(function (pack) {
        var items = recentQueryItems();
        var ranked = (pack.liveSessions || []).concat(pack.sessions || []);
        var seen = Object.create(null);
        var n = 0;
        var cap = (ctx && (isRunLikePage(ctx.page) || ctx.page === "view")) ? 4 : 8;
        for (var i = 0; i < ranked.length && n < cap; i++) {
          var s = ranked[i];
          var id = (s && (s.id || s.sessionHash)) || "";
          if (!id || seen[id]) continue;
          seen[id] = 1;
          n++;
          items.push(searchHitToItem(s, "", { group: "Recent", groupPriority: 70 }));
        }
        return items;
      });
    }
    var local = catalogCache.sessions
      ? searchPaletteCatalog(catalogCache.sessions, parsed.q, 8)
      : null;
    if (local && local.length) return Promise.resolve(hitsToSessionItems(local, parsed.q));
    function fromNetwork() {
      return debounceSearch(parsed.q).then(function (hits) {
        return hitsToSessionItems(hits, parsed.q);
      });
    }
    if (catalogCache.pending && !catalogCache.sessions) {
      return catalogCache.pending.then(function (sessions) {
        var hits = searchPaletteCatalog(sessions || [], parsed.q, 8);
        if (hits.length) return hitsToSessionItems(hits, parsed.q);
        return fromNetwork();
      });
    }
    return fromNetwork();
  }

  function isMac() {
    return /Mac|iPhone|iPad/.test(navigator.platform || "");
  }
  function isOpen() {
    return !overlay.hidden;
  }
  function escText(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function detectContext() {
    var path = location.pathname.replace(/\\/+$/, "") || "/";
    var q = new URLSearchParams(location.search);
    var ctx = { page: "other", path: path };
    if (path === "/sessions") ctx.page = "runs";
    else if (path === "/run" || path === "/") {
      if (q.get("id")) { ctx.page = "run"; ctx.runId = q.get("id"); }
      else if (q.get("session")) { ctx.page = "session"; ctx.session = q.get("session"); }
      else if (document.body.getAttribute("data-watch") === "session") ctx.page = "session";
      else if (document.body.getAttribute("data-chat-home") === "1") ctx.page = "home";
      else if (document.body.getAttribute("data-run-state")) ctx.page = "run";
      else ctx.page = "home";
    } else if (path === "/compare") {
      ctx.page = "compare";
      ctx.a = q.get("a");
      ctx.b = q.get("b");
      ctx.sa = q.get("sa");
      ctx.sb = q.get("sb");
    } else if (path === "/view") {
      ctx.page = "view";
      ctx.viewId = q.get("id") || q.get("path") || "";
    }
    var sid = document.getElementById("chatSessionId");
    if (sid && sid.textContent) ctx.identity = sid.textContent.trim();
    var viewLink = document.getElementById("viewSessionLink");
    if (viewLink && viewLink.getAttribute("href")) ctx.viewHref = viewLink.getAttribute("href");
    var runChip = document.querySelector("a[data-run-id], a[data-live-session]");
    if (runChip && runChip.getAttribute("href")) ctx.chatHref = runChip.getAttribute("href");
    var title = document.querySelector(".header-title");
    if (title && title.textContent) ctx.viewTitle = title.textContent.trim();
    for (var k in extraCtx) if (Object.prototype.hasOwnProperty.call(extraCtx, k)) ctx[k] = extraCtx[k];
    rememberPaletteDestinations(ctx);
    return ctx;
  }

  function contextLabel(ctx) {
    if (ctx.page === "run") return "Run · " + (ctx.identity || ctx.runId || "open");
    if (ctx.page === "session") return "Chat · " + (ctx.identity || ctx.session || "open");
    if (ctx.page === "view") {
      var viewId = ctx.viewId || "";
      if (viewId.length > 16) viewId = viewId.slice(0, 8);
      return "Session · " + (viewId || "open");
    }
    if (ctx.page === "compare") return "Compare";
    return "";
  }

  function flashJump(el) {
    if (!el || !el.classList) return;
    el.classList.remove("cmdk-jump-flash");
    void el.offsetWidth;
    el.classList.add("cmdk-jump-flash");
    setTimeout(function () { el.classList.remove("cmdk-jump-flash"); }, 1200);
  }

  function jump(sel, opts) {
    var el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) return false;
    if (opts && opts.openDetails) {
      var det = el.closest ? el.closest("details") : null;
      if (det) det.open = true;
      if (el.tagName && el.tagName.toLowerCase() === "details") el.open = true;
    }
    try { el.scrollIntoView({ block: opts && opts.block || "center", behavior: "smooth" }); } catch (e) {}
    if (opts && opts.focus !== false) {
      try { el.focus(); } catch (e2) {}
    }
    flashJump(el);
    return true;
  }

  function isShownEl(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.closest && el.closest("[hidden]")) return false;
    return true;
  }

  function documentHasSelector(sel, def) {
    var el = document.querySelector(sel);
    if (!isShownEl(el)) return false;
    if (def && def.requireVisible && el.hidden) return false;
    return true;
  }

  function firstShown(sels) {
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (isShownEl(el)) return el;
    }
    return null;
  }

  function scanChapters() {
    if (typeof getChapters === "function") {
      try {
        var chs = getChapters();
        if (chs && chs.length) {
          var fromFn = [];
          for (var i = 0; i < chs.length; i++) {
            fromFn.push({
              index: i,
              id: "chapter-" + i,
              prompt: (chs[i] && chs[i].prompt) || ""
            });
          }
          return fromFn;
        }
      } catch (e) {}
    }
    return collectChapterDescriptors(document);
  }

  function jumpToRunSection(dest) {
    if (dest === "transcript") {
      var scroll = document.getElementById("chatScroll");
      if (scroll) {
        try { scroll.scrollTop = 0; } catch (e0) {}
        flashJump(document.getElementById("chatThread") || scroll);
        return true;
      }
      return jump("#chatThread", { block: "start" }) || jump("#chatScroll", { block: "start" });
    }
    if (dest === "analytics") {
      var t = document.getElementById("analyticsToggle");
      var panel = document.getElementById("runAnalytics");
      var closed = !panel || panel.hidden || (t && t.getAttribute("aria-expanded") !== "true");
      if (t && closed) {
        try { t.click(); } catch (e) {}
      }
      var n = 0;
      function afterOpen() {
        if (jump("#runAnalytics", { focus: false, block: "nearest" })) return;
        if (n++ < 8) requestAnimationFrame(afterOpen);
        else jump("#analyticsToggle", { focus: false });
      }
      requestAnimationFrame(afterOpen);
      return true;
    }
    if (dest === "terminal") {
      return jump("#terminalDetails", { openDetails: true, block: "center" })
        || jump("#runTerminal", { openDetails: true, block: "center" });
    }
    if (dest === "composer") {
      var compose = firstShown(["#inputText", "#continueInput", "#homePrompt", ".composer-card", "#inputRow", "#composerStatus"]);
      if (compose) return jump(compose, { block: "end" });
      return false;
    }
    if (dest === "history") {
      return jump("#chatHistory", { block: "start" });
    }
    if (dest === "summary") {
      return jump(".stats-bar") || jump(".header") || jump("#app");
    }
    if (dest === "chapters") {
      return jump(".chapters") || jump("#chapter-0");
    }
    return false;
  }

  function jumpToChapterAnchor(idx) {
    var el = document.getElementById("chapter-" + idx);
    if (!el) return false;
    if (typeof setChapterHash === "function") {
      try { setChapterHash(idx); } catch (e) {}
    } else {
      try {
        history.replaceState(null, "", chapterPermalink(idx, location));
      } catch (e2) {
        try { location.hash = "chapter-" + idx; } catch (e3) {}
      }
    }
    if (!el.classList.contains("expanded")) {
      try { el.click(); } catch (e4) {}
    }
    function settle() {
      var next = document.getElementById("chapter-" + idx);
      if (!next) return false;
      try { next.scrollIntoView({ block: "center", behavior: "auto" }); } catch (e5) {
        try { next.scrollIntoView(true); } catch (e6) {}
      }
      if (typeof jumpToChapter === "function") {
        try { jumpToChapter(idx); } catch (e7) {}
      }
      flashJump(next);
      return true;
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!settle()) setTimeout(settle, 40);
      });
    });
    return true;
  }

  function openLauncherFromPalette() {
    var btn = document.getElementById("newRunBtn");
    if (btn) { btn.click(); return; }
    location.href = "/?launch=1";
  }

  function builtinItems(query, ctx) {
    var out = [];
    var hereGroup = inViewGroupName(ctx.page);
    var sections = inViewSectionItems(ctx, documentHasSelector);
    for (var s = 0; s < sections.length; s++) {
      sections[s].action = (function (dest) {
        return function () { jumpToRunSection(dest); };
      })(sections[s].dest);
      out.push(sections[s]);
    }
    if (ctx.page === "view") {
      var chapters = inViewChapterItems(scanChapters());
      for (var c = 0; c < chapters.length; c++) {
        chapters[c].action = (function (idx) {
          return function () { jumpToChapterAnchor(idx); };
        })(chapters[c].chapterIndex);
        out.push(chapters[c]);
      }
    }
    if (ctx.page === "runs") {
      out.push({
        id: "runs-filter",
        group: hereGroup || "This page",
        groupPriority: 100,
        title: "Focus filter",
        icon: "filter",
        action: function () {
          var f = document.getElementById("filterInput");
          if (f) f.focus();
        }
      });
    }

    var pages = pageNavItems(ctx);
    for (var p = 0; p < pages.length; p++) {
      if (pages[p].actionName === "launch") pages[p].action = openLauncherFromPalette;
      out.push(pages[p]);
    }

    var q = parsePaletteQuery(query).q;
    out.push({
      id: "search-sessions",
      group: "Search",
      groupPriority: 10,
      kind: "search",
      title: q ? "Search sessions for \\u201c" + q + "\\u201d" : "Search sessions\\u2026",
      icon: "search",
      href: q ? "/sessions?filter=" + encodeURIComponent(q) : "/sessions",
      keywords: ["find", "index", "query"]
    });
    out.push({
      id: "keyboard-shortcuts",
      group: "Accessibility",
      groupPriority: 20,
      title: "Keyboard shortcuts",
      subtitle: typeof characterKeysEnabled === "function" && !characterKeysEnabled()
        ? "Character keys off"
        : "Character keys on",
      icon: "keys",
      keywords: ["accessibility", "character keys", "hotkey", "wcag", "shortcuts", "s", "g c"],
      action: function () {
        if (typeof openCharacterKeysDialog === "function") openCharacterKeysDialog();
      }
    });
    return out;
  }

  function registerProvider(provider) {
    if (!provider || !provider.id) return;
    unregisterProvider(provider.id);
    providers.push(provider);
    providers.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    if (isOpen()) refresh();
  }
  function unregisterProvider(id) {
    providers = providers.filter(function (p) { return p.id !== id; });
  }

  registerProvider({ id: "builtin", order: 0, items: builtinItems });
  registerProvider({ id: "sessions", order: 10, items: sessionSearchItems });

  function matches(item, q) {
    if (!q) return true;
    if (item.kind === "chapter") {
      var n = chapterQueryIndex(q);
      if (n != null) return item.chapterIndex === n;
    }
    var hay = [item.title, item.subtitle].concat(item.keywords || []).join(" ").toLowerCase();
    var parts = q.toLowerCase().split(/\\s+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      if (hay.indexOf(parts[i]) === -1) return false;
    }
    return true;
  }

  function herePath() {
    try { return location.pathname + location.search; } catch (e) { return ""; }
  }
  function isCurrentHref(href) {
    if (!href || href.charAt(0) === "#") return false;
    try {
      var u = new URL(href, location.origin);
      return (u.pathname + u.search) === herePath();
    } catch (e2) { return false; }
  }
  function classFocus(query) {
    var parsed = parsePaletteQuery(query);
    var q = parsed.q || (parsed.prefix ? "" : String(query || "").trim());
    var pageQ = !!(q && isPageJumpQuery(query) && !isInViewJumpQuery(query));
    var jumpQ = !!(q && isInViewJumpQuery(query) && !isPageJumpQuery(query));
    return { parsed: parsed, pageQ: pageQ, jumpQ: jumpQ };
  }
  function assembleItems(chunks, query, ctx) {
    var focus = classFocus(query);
    var parsed = focus.parsed;
    var matchQuery = parsed.prefix ? parsed.q : query;
    var flat = [];
    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i] || [];
      for (var j = 0; j < chunk.length; j++) flat.push(chunk[j]);
    }
    var seen = Object.create(null);
    var uniq = [];
    for (var k = 0; k < flat.length; k++) {
      var it = flat[k];
      if (!it || !it.id || seen[it.id]) continue;
      seen[it.id] = 1;
      if (parsed.prefix === "session" && it.kind !== "session" && it.kind !== "search" && it.kind !== "recent-query") continue;
      if (parsed.prefix === "goto" && it.kind !== "nav" && it.kind !== "search") continue;
      if (parsed.prefix === "jump" && it.kind !== "jump" && it.kind !== "chapter" && it.kind !== "search") continue;
      if (parsed.prefix === "chapter" && it.kind !== "chapter" && it.kind !== "search") continue;
      if (focus.pageQ && (it.kind === "jump" || it.kind === "chapter")) continue;
      if (focus.jumpQ && it.kind === "nav") continue;
      if ((it.dest === "this-run" || it.dest === "this-chat") && isCurrentHref(it.href)) continue;
      if (it.ranked || it.kind === "session") {
        uniq.push(it);
        continue;
      }
      if (!matches(it, matchQuery)) continue;
      if (it.kind === "nav" && (parsed.prefix === "goto" || (matchQuery && isPageJumpQuery(query)))) {
        it = Object.assign({}, it, { groupPriority: Math.max(it.groupPriority || 0, 95) });
      }
      if ((it.kind === "jump" || it.kind === "chapter") && (parsed.prefix === "jump" || parsed.prefix === "chapter" || (matchQuery && isInViewJumpQuery(query)))) {
        it = Object.assign({}, it, { groupPriority: Math.max(it.groupPriority || 0, 118) });
      }
      if (matchQuery && (it.kind === "nav" || it.kind === "jump" || it.kind === "chapter") && !it.titleHtml) {
        it = Object.assign({}, it, { titleHtml: highlightSnippet(it.title, matchQuery) });
      }
      uniq.push(it);
    }
    return { ctx: ctx, items: capChapterItems(uniq, query) };
  }
  function collectFromProviders(query, list) {
    var ctx = detectContext();
    var jobs = list.map(function (p) {
      var res;
      try { res = p.items ? p.items(query, ctx) : []; }
      catch (e) { res = []; }
      return Promise.resolve(res);
    });
    return Promise.all(jobs).then(function (chunks) {
      return assembleItems(chunks, query, ctx);
    });
  }
  function collectItems(query) {
    return collectFromProviders(query, providers);
  }

  function groupItems(list) {
    var order = [];
    var map = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var g = it.group || "Commands";
      if (!map[g]) {
        map[g] = { name: g, priority: it.groupPriority || 0, items: [] };
        order.push(g);
      }
      if ((it.groupPriority || 0) > map[g].priority) map[g].priority = it.groupPriority || 0;
      map[g].items.push(it);
    }
    order.sort(function (a, b) {
      var d = map[b].priority - map[a].priority;
      return d !== 0 ? d : 0;
    });
    return order.map(function (name) { return map[name]; });
  }

  function keysHtml(keys) {
    if (!keys || !keys.length) return "";
    var html = '<span class="cmdk-item-keys">';
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === "then") html += '<span class="cmdk-key-then">then</span>';
      else html += '<span class="cmdk-key">' + escText(keys[i]) + "</span>";
    }
    return html + "</span>";
  }

  function itemInnerHtml(it) {
    var icon = ICO[it.icon] || ICO.go;
    var titleBlock;
    if (it.identity) {
      var src = it.identity.source
        ? '<span class="cmdk-src" style="background:' + sourceColor(it.identity.source) + '">' + escText(it.identity.source) + "</span>"
        : "";
      var sid = it.identity.id
        ? '<span class="cmdk-sid">' + escText(it.identity.id) + "</span>"
        : "";
      var titleHtml = it.titleHtml || escText(it.title);
      titleBlock = '<span class="cmdk-item-idline">' + src + sid + '<span class="cmdk-item-title">' + titleHtml + "</span></span>";
    } else {
      titleBlock = '<span class="cmdk-item-title">' + (it.titleHtml || escText(it.title)) + "</span>";
    }
    var sub = "";
    if (it.snippetHtml) sub = '<span class="cmdk-item-sub">' + it.snippetHtml + "</span>";
    else if (it.subtitle) sub = '<span class="cmdk-item-sub">' + escText(it.subtitle) + "</span>";
    return '<span class="cmdk-item-icon">' + icon + "</span>" +
      '<span class="cmdk-item-text">' + titleBlock + sub + "</span>" +
      keysHtml(it.shortcut);
  }

  function setBusy(on) {
    if (!spinner) return;
    if (on) {
      if (busyTimer) return;
      busyTimer = setTimeout(function () {
        busyTimer = 0;
        spinner.hidden = false;
      }, 90);
    } else {
      if (busyTimer) { clearTimeout(busyTimer); busyTimer = 0; }
      spinner.hidden = true;
    }
  }

  function renderList(pack) {
    var query = (input.value || "").trim();
    items = pack.items;
    var ctx = pack.ctx;
    var label = contextLabel(ctx);
    if (label) {
      contextEl.textContent = label;
      contextWrap.hidden = false;
    } else {
      contextEl.textContent = "";
      contextWrap.hidden = true;
    }

    var commands = items.filter(function (it) { return it.kind !== "search"; });
    var searchItem = null;
    for (var s = 0; s < items.length; s++) {
      if (items[s].kind === "search") { searchItem = items[s]; break; }
    }
    var noResults = query && commands.length === 0;

    listEl.innerHTML = "";
    emptyEl.innerHTML = "";
    emptyEl.hidden = true;

    var visible = [];
    if (noResults) {
      emptyEl.hidden = false;
      emptyEl.innerHTML =
        '<div class="cmdk-empty-query">Search for \\u201c' + escText(query) + "\\u201d</div>";
      if (searchItem) {
        visible.push(searchItem);
        var row = document.createElement("button");
        row.type = "button";
        row.className = "cmdk-item";
        row.id = "cmdk-opt-0";
        row.setAttribute("role", "option");
        row.setAttribute("tabindex", "-1");
        row.setAttribute("data-idx", "0");
        row.innerHTML =
          '<span class="cmdk-item-icon">' + ICO.search + "</span>" +
          '<span class="cmdk-item-text"><span class="cmdk-item-title">No results found</span></span>' +
          '<span class="cmdk-empty-action">Search sessions</span>';
        listEl.appendChild(row);
      }
    } else {
      var show = commands.slice();
      if (query && searchItem) show.push(searchItem);
      var groups = groupItems(show);
      var idx = 0;
      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        var wrap = document.createElement("div");
        wrap.className = "cmdk-group";
        wrap.setAttribute("data-group", group.name);
        var lab = document.createElement("div");
        lab.className = "cmdk-group-label";
        lab.textContent = group.name;
        wrap.appendChild(lab);
        for (var i = 0; i < group.items.length; i++) {
          var it = group.items[i];
          visible.push(it);
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cmdk-item" + (it.kind === "session" ? " cmdk-hit" : "");
          btn.id = "cmdk-opt-" + idx;
          btn.setAttribute("role", "option");
          btn.setAttribute("tabindex", "-1");
          btn.setAttribute("data-idx", String(idx));
          if (it.kind) btn.setAttribute("data-kind", it.kind);
          if (it.dest) btn.setAttribute("data-dest", it.dest);
          if (it.href) btn.setAttribute("data-href", it.href);
          if (it.chapterIndex != null) btn.setAttribute("data-chapter", String(it.chapterIndex));
          if (it.identity && it.identity.id) btn.setAttribute("data-session-id", it.identity.id);
          btn.innerHTML = itemInnerHtml(it);
          wrap.appendChild(btn);
          idx++;
        }
        listEl.appendChild(wrap);
      }
    }
    items = visible;
    if (active >= items.length) active = Math.max(0, items.length - 1);
    highlight(items.length ? active : -1);
  }

  function highlight(idx) {
    active = idx;
    var nodes = listEl.querySelectorAll(".cmdk-item");
    for (var i = 0; i < nodes.length; i++) {
      var on = i === idx;
      nodes[i].classList.toggle("hl", on);
      nodes[i].setAttribute("aria-selected", on ? "true" : "false");
    }
    var cur = idx >= 0 ? nodes[idx] : null;
    if (cur) {
      input.setAttribute("aria-activedescendant", cur.id);
      if (cur.scrollIntoView) {
        try { cur.scrollIntoView({ block: "nearest" }); } catch (e) {}
      }
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function refresh() {
    var query = input.value || "";
    overlay.setAttribute("data-cmdk-query", query);
    var my = ++gen;
    var focus = classFocus(query);
    var skipSearch = !!(focus.parsed.prefix === "goto" || focus.parsed.prefix === "jump"
      || focus.parsed.prefix === "chapter" || focus.pageQ || focus.jumpQ);
    var commandProviders = providers.filter(function (p) { return p.id !== "sessions"; });
    collectFromProviders(query, commandProviders).then(function (pack) {
      if (my !== gen) return;
      renderList(pack);
      if (skipSearch) {
        setBusy(false);
        return;
      }
      setBusy(true);
      collectItems(query).then(function (full) {
        if (my !== gen) return;
        setBusy(false);
        renderList(full);
      });
    });
  }

  function setInert(on) {
    if (on) pushOverlay(overlay);
    else popOverlay(overlay);
  }

  function openPalette() {
    if (isOpen()) {
      input.focus();
      return;
    }
    fetchSearchCatalog();
    prevFocus = overlayPrevFocus(overlay);
    if (!prevFocus) prevFocus = document.activeElement;
    overlay.hidden = false;
    overlay.setAttribute("data-cmdk-state", "open");
    document.body.classList.add("cmdk-open");
    setInert(true);
    input.value = "";
    active = 0;
    refresh();
    try { input.focus(); } catch (eOpen) {}
    requestAnimationFrame(function () { input.focus(); });
  }

  function closePalette() {
    if (!isOpen()) return;
    overlay.hidden = true;
    overlay.setAttribute("data-cmdk-state", "closed");
    overlay.setAttribute("data-cmdk-query", "");
    document.body.classList.remove("cmdk-open");
    setBusy(false);
    setInert(false);
    input.value = "";
    items = [];
    restoreOverlayFocus(prevFocus, overlay);
    prevFocus = null;
  }

  function togglePalette() {
    if (isOpen()) closePalette();
    else openPalette();
  }

  function runActive(ev) {
    var item = items[active];
    if (!item) return;
    var typed = parsePaletteQuery(input.value || "").q;
    if ((item.kind === "session" || item.kind === "search") && typed) pushRecentQuery(typed);
    if (item.kind === "session" && item.href) writePaletteStore(PALETTE_LAST_VIEW_KEY, item.href);
    if (item.keepOpen) {
      if (typeof item.action === "function") {
        try { item.action(detectContext()); } catch (e0) {}
      }
      return;
    }
    closePalette();
    if (typeof item.action === "function") {
      try { item.action(detectContext()); } catch (e) {}
      return;
    }
    if (item.href) {
      if (ev && (ev.metaKey || ev.ctrlKey)) window.open(item.href, "_blank");
      else location.href = item.href;
    }
  }

  function consumeGoChord(key) {
    var k = String(key || "").toLowerCase();
    var ctx = detectContext();
    if (k === "c") { location.href = "/"; return true; }
    if (k === "r") { location.href = "/sessions"; return true; }
    if (k === "d") { location.href = compareHref(ctx); return true; }
    if (k === "v") { location.href = viewHref(ctx); return true; }
    if (k === "i") { location.href = "/insights"; return true; }
    if (k === "n") { openLauncherFromPalette(); return true; }
    return false;
  }

  // GitHub radix trie of data-hotkey elements (g c / g r / …). Leaf fire
  // clicks the button then preventDefault — not a JS callback list.
  function bindGoChordHotkeys() {
    installPageHotkey("tqHotkeyGoC", "g c", function() { consumeGoChord("c"); });
    installPageHotkey("tqHotkeyGoR", "g r", function() { consumeGoChord("r"); });
    installPageHotkey("tqHotkeyGoD", "g d", function() { consumeGoChord("d"); });
    installPageHotkey("tqHotkeyGoV", "g v", function() { consumeGoChord("v"); });
    installPageHotkey("tqHotkeyGoI", "g i", function() { consumeGoChord("i"); });
    installPageHotkey("tqHotkeyGoN", "g n", function() { consumeGoChord("n"); });
  }
  bindGoChordHotkeys();

  // Site-wide workspace search (Linear "/" / GitHub "s,/"): data-hotkey="s,/"
  // on the search input. fireDeterminedAction focuses form fields; the
  // dispatcher preventDefault()s so s and / are the opener, not typed characters.
  function workspaceSearchInput() {
    return document.getElementById("workspaceSearch");
  }
  function installSlashSearchHotkey() {
    var bar = workspaceSearchInput();
    if (!bar) return;
    if (typeof bar.setAttribute === "function") {
      bar.setAttribute("data-hotkey", "s,/");
    }
    install(bar);
  }
  installSlashSearchHotkey();

  function mountWorkspaceSearch() {
    var wrap = document.getElementById("workspaceSearchWrap");
    if (!wrap) return;
    if (wrap.classList.contains("in-app-top") || wrap.classList.contains("in-cmp-header")) return;
    var top = document.querySelector(".app-top");
    var trigger = document.getElementById("cmdkTrigger");
    if (top) {
      if (trigger && trigger.parentNode === top && typeof top.insertBefore === "function") {
        top.insertBefore(wrap, trigger);
      } else {
        top.appendChild(wrap);
      }
      wrap.classList.remove("tq-search-fixed");
      wrap.classList.add("in-app-top");
      return;
    }
    var cmp = document.querySelector(".cmp-header");
    if (cmp) {
      var back = cmp.querySelector(".cmp-back");
      if (back && back.parentNode === cmp && typeof cmp.insertBefore === "function") {
        cmp.insertBefore(wrap, back);
      } else {
        cmp.appendChild(wrap);
      }
      wrap.classList.remove("tq-search-fixed");
      wrap.classList.add("in-cmp-header");
      return;
    }
    // Served /view rebuilds #app; keep the bar out of that tree.
    wrap.classList.add("tq-search-fixed");
  }

  function bindWorkspaceSearch() {
    var wrap = document.getElementById("workspaceSearchWrap");
    var bar = workspaceSearchInput();
    var list = document.getElementById("workspaceSearchList");
    if (!wrap || !bar || !list) return;
    mountWorkspaceSearch();
    var wsItems = [];
    var wsActive = 0;
    var wsTimer = 0;
    var wsGen = 0;

    function setExpanded(on) {
      bar.setAttribute("aria-expanded", on ? "true" : "false");
      list.hidden = !on;
    }
    function closeWsList() {
      setExpanded(false);
      wsItems = [];
      wsActive = 0;
      list.innerHTML = "";
      bar.removeAttribute("aria-activedescendant");
    }
    function highlightWs(idx) {
      wsActive = idx;
      var nodes = list.querySelectorAll(".tq-search-item");
      for (var i = 0; i < nodes.length; i++) {
        var on = i === idx;
        nodes[i].classList.toggle("hl", on);
        nodes[i].setAttribute("aria-selected", on ? "true" : "false");
      }
      var cur = nodes[idx];
      if (cur && cur.id) {
        bar.setAttribute("aria-activedescendant", cur.id);
        if (cur.scrollIntoView) {
          try { cur.scrollIntoView({ block: "nearest" }); } catch (eScr) {}
        }
      } else {
        bar.removeAttribute("aria-activedescendant");
      }
    }
    function renderWsHits(hits, q) {
      wsItems = hitsToSessionItems(hits || [], q);
      wsActive = 0;
      if (!wsItems.length) {
        list.innerHTML = '<div class="tq-search-empty">' + (q ? "No sessions match \u201c" + escText(q) + "\u201d" : "Type to search sessions") + "</div>";
        setExpanded(true);
        bar.removeAttribute("aria-activedescendant");
        return;
      }
      var html = "";
      for (var i = 0; i < wsItems.length; i++) {
        var it = wsItems[i];
        var sub = it.identity && it.identity.id
          ? escText((it.identity.source || "") + " \u00b7 " + String(it.identity.id).slice(0, 8))
          : "";
        html += '<button type="button" class="tq-search-item' + (i === 0 ? " hl" : "") + '" role="option" tabindex="-1" id="ws-opt-' + i + '" data-idx="' + i + '" aria-selected="' + (i === 0 ? "true" : "false") + '">'
          + '<span class="tq-search-item-title">' + (it.titleHtml || escText(it.title || "")) + "</span>"
          + (sub ? '<span class="tq-search-item-sub">' + sub + "</span>" : "")
          + "</button>";
      }
      list.innerHTML = html;
      setExpanded(true);
      highlightWs(0);
    }
    function typeIntoWorkspaceSearch(ch) {
      try { bar.focus(); } catch (eF) {}
      var v = String(bar.value || "");
      var start = typeof bar.selectionStart === "number" ? bar.selectionStart : v.length;
      var end = typeof bar.selectionEnd === "number" ? bar.selectionEnd : start;
      if (start > end) { var tmp = start; start = end; end = tmp; }
      bar.value = v.slice(0, start) + ch + v.slice(end);
      var caret = start + String(ch).length;
      try {
        if (typeof bar.setSelectionRange === "function") bar.setSelectionRange(caret, caret);
        else {
          bar.selectionStart = caret;
          bar.selectionEnd = caret;
        }
      } catch (eS) {}
      try {
        if (typeof Event === "function" && typeof bar.dispatchEvent === "function") {
          bar.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (eD) {}
    }
    function wsListOwnsFocus() {
      var ae = document.activeElement;
      return !!(ae && ae !== bar && list.contains(ae));
    }
    function runWsActive() {
      var it = wsItems[wsActive];
      if (it && it.href) {
        location.href = it.href;
        return;
      }
      var q = String(bar.value || "").trim();
      location.href = q ? "/sessions?filter=" + encodeURIComponent(q) : "/sessions";
    }
    function refreshWs() {
      var q = String(bar.value || "").trim();
      var my = ++wsGen;
      if (!q) {
        fetchRecentSessions().then(function (pack) {
          if (my !== wsGen) return;
          var ranked = (pack.liveSessions || []).concat(pack.sessions || []);
          renderWsHits(ranked.slice(0, 8), "");
        });
        return;
      }
      if (wsTimer) clearTimeout(wsTimer);
      wsTimer = setTimeout(function () {
        wsTimer = 0;
        debounceSearch(q).then(function (hits) {
          if (my !== wsGen) return;
          renderWsHits(hits, q);
        });
      }, 40);
    }

    bar.addEventListener("focus", function () { refreshWs(); });
    bar.addEventListener("input", function () { refreshWs(); });
    bar.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (bar.value) {
          bar.value = "";
          refreshWs();
          return;
        }
        closeWsList();
        try { bar.blur(); } catch (eBlur) {}
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!wsItems.length) return;
        highlightWs(wsActive < wsItems.length - 1 ? wsActive + 1 : 0);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!wsItems.length) return;
        highlightWs(wsActive > 0 ? wsActive - 1 : wsItems.length - 1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        runWsActive();
      }
    });
    wrap.addEventListener("keydown", function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Tab") {
        closeWsList();
        return;
      }
      if (!wsListOwnsFocus()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        closeWsList();
        try { bar.focus(); } catch (eEsc) {}
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        runWsActive();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!wsItems.length) return;
        if (e.key === "ArrowDown") highlightWs(wsActive < wsItems.length - 1 ? wsActive + 1 : 0);
        else highlightWs(wsActive > 0 ? wsActive - 1 : wsItems.length - 1);
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        typeIntoWorkspaceSearch(e.key);
      }
    }, true);
    list.addEventListener("mousedown", function (e) {
      var item = e.target.closest ? e.target.closest(".tq-search-item") : null;
      if (!item) return;
      e.preventDefault();
      var idx = parseInt(item.getAttribute("data-idx"), 10);
      if (!isNaN(idx)) wsActive = idx;
      runWsActive();
    });
    document.addEventListener("mousedown", function (e) {
      if (!wrap.contains(e.target)) closeWsList();
    });
  }
  bindWorkspaceSearch();

  function bindCharacterKeysDialog() {
    var root = document.getElementById("characterKeysOverlay");
    var toggle = document.getElementById("characterKeysToggle");
    var closeBtn = document.getElementById("characterKeysClose");
    var scrim = document.getElementById("characterKeysScrim");
    var dialogEl = root ? (document.getElementById("characterKeysDialog") || root.querySelector(".tq-a11y-dialog")) : null;
    if (!root || !toggle) return;
    var prev = null;
    function syncToggle() {
      toggle.checked = typeof characterKeysEnabled === "function" ? characterKeysEnabled() : true;
    }
    function cheatsheetInitialFocus() {
      // APG informational dialog: focus the dialog (or Close), never the
      // Character keys kill-switch — Space on open must not disable shortcuts.
      return dialogEl || closeBtn;
    }
    openCharacterKeysDialog = function openCharacterKeysDialogFn() {
      if (!root.hidden) {
        syncToggle();
        focusOverlay(root, cheatsheetInitialFocus());
        return;
      }
      prev = overlayPrevFocus(root);
      root.hidden = false;
      syncToggle();
      pushOverlay(root);
      focusOverlay(root, cheatsheetInitialFocus());
    };
    function closeCharacterKeysDialog() {
      if (root.hidden) return;
      root.hidden = true;
      popOverlay(root);
      restoreOverlayFocus(prev, root);
      prev = null;
    }
    toggle.addEventListener("change", function () {
      if (typeof setCharacterKeysEnabled === "function") setCharacterKeysEnabled(!!toggle.checked);
    });
    if (closeBtn) closeBtn.addEventListener("click", closeCharacterKeysDialog);
    if (scrim) scrim.addEventListener("click", closeCharacterKeysDialog);
    root.addEventListener("keydown", function (e) {
      if (root.hidden) return;
      if (!isTopOverlay(root)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        closeCharacterKeysDialog();
        return;
      }
      if (e.key === "Tab") trapOverlayTab(e, dialogEl || root);
    }, true);
    if (typeof applyCharacterKeysSetting === "function") applyCharacterKeysSetting();
    syncToggle();
  }
  bindCharacterKeysDialog();
  bindToolbarMenuOverlayKeys();

  // GitHub idle "?" / Linear Cmd+/ — same cheatsheet that hosts Character keys.
  // Modifier aliases stay live when Character keys is off; "?" does not.
  function bindHelpHotkeys() {
    installPageHotkey("tqHotkeyHelp", "?,Shift+?,Shift+/,Mod+/,Control+/,Meta+/", function () {
      if (typeof openCharacterKeysDialog === "function") openCharacterKeysDialog();
    });
  }
  bindHelpHotkeys();

  function onGlobalKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    var key = e.key;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (key === "k" || key === "K")) {
      e.preventDefault();
      e.stopPropagation();
      sequenceReset();
      togglePalette();
      return;
    }
    if (!isOpen()) return;
    if (!isTopOverlay(overlay)) return;
    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      closePalette();
      return;
    }
    if (key === "ArrowDown") {
      e.preventDefault();
      if (!items.length) return;
      highlight(active < items.length - 1 ? active + 1 : 0);
      return;
    }
    if (key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      highlight(active > 0 ? active - 1 : items.length - 1);
      return;
    }
    if (key === "Enter") {
      e.preventDefault();
      runActive(e);
      return;
    }
    if (key === "Tab") {
      trapOverlayTab(e, overlay);
      if (document.activeElement !== input && !overlay.contains(document.activeElement)) {
        e.preventDefault();
        try { input.focus(); } catch (eTab) {}
      }
      return;
    }
    // Printable keys insert natively on the focused combobox. GitHub
    // keyDownHandler returns on isFormField without preventDefault.
  }

  document.addEventListener("keydown", onGlobalKey, true);
  input.addEventListener("input", function () {
    active = 0;
    refresh();
  });
  listEl.addEventListener("mousemove", function (e) {
    var item = e.target.closest(".cmdk-item");
    if (!item) return;
    var idx = parseInt(item.getAttribute("data-idx"), 10);
    if (!isNaN(idx) && idx !== active) highlight(idx);
  });
  listEl.addEventListener("mousedown", function (e) {
    var item = e.target.closest(".cmdk-item");
    if (!item) return;
    e.preventDefault();
    var idx = parseInt(item.getAttribute("data-idx"), 10);
    if (!isNaN(idx)) active = idx;
    runActive(e);
  });
  overlay.addEventListener("mousedown", function (e) {
    if (e.target === overlay || (e.target && e.target.id === "cmdkScrim")) {
      e.preventDefault();
      closePalette();
    }
  });
  if (trigger) {
    var kbd = trigger.querySelector(".cmdk-trigger-kbd");
    var mac = isMac();
    if (kbd) kbd.textContent = mac ? "\\u2318K" : "Ctrl+K";
    trigger.title = mac ? "Command menu (\\u2318K)" : "Command menu (Ctrl+K)";
    trigger.setAttribute("aria-label", trigger.title);
    trigger.addEventListener("click", function (e) {
      e.preventDefault();
      openPalette();
    });
  }

  window.TracequestPalette = {
    open: openPalette,
    close: closePalette,
    toggle: togglePalette,
    isOpen: isOpen,
    registerProvider: registerProvider,
    unregisterProvider: unregisterProvider,
    setContext: function (partial) {
      extraCtx = partial && typeof partial === "object" ? partial : {};
      if (isOpen()) refresh();
    },
    getContext: detectContext,
    refresh: refresh,
    pageNavItems: pageNavItems,
    consumeGoChord: consumeGoChord,
    inViewSectionItems: inViewSectionItems,
    inViewChapterItems: inViewChapterItems,
    jumpToRunSection: jumpToRunSection,
    jumpToChapterAnchor: jumpToChapterAnchor
  };

  try { detectContext(); } catch (eBoot) {}
  if (!pageCatalogReady) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(function () { fetchSearchCatalog(); });
    else setTimeout(function () { fetchSearchCatalog(); }, 1);
  }
})();
`;
