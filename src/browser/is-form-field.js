/**
 * GitHub @github/hotkey dispatcher: radix trie of data-hotkey HTMLElements.
 *
 * keyDownHandler is the only unscoped character-shortcut dispatcher
 * (GitHub src/index.ts). Declare s,/, j, k, o, G-chords on DOM nodes via
 * data-hotkey and install() — the trie is the hotkey table. Do not add
 * sibling document keydown listeners for those keys, and do not keep a
 * JS callback list.
 *
 * The dispatcher returns without firing while a text-like input, textarea,
 * select, or contenteditable is focused. While window.__tqOverlayStack is
 * non-empty, only data-hotkey leaves whose element is inside the top
 * overlay fire (flyout Next/Prev j/k); unscoped page leaves stay idle and
 * chords do not arm. It does not stopPropagation, so the keydown still
 * reaches the focused control.
 * Unscoped form-field return also sequenceReset()s so an idle g cannot
 * complete g c after the user types in a field and blurs.
 * On Leaf fire it clicks/focuses the matching element then preventDefault().
 * Cmd/Ctrl+K is not a page hotkey — overlay capture still toggles it.
 *
 * WCAG 2.1.4 Character Key Shortcuts: unmodified letter/punctuation
 * shortcuts (s, /, g c) can be turned off via the Character keys
 * checkbox (GitHub accessibility hatch). Modifier chords stay live.
 *
 * Function bodies are toString-embedded into inlined page scripts.
 */
import { fnSrc } from "../utils/fn-src.js";

export function isFormField(element) {
  // GitHub @github/hotkey src/utils.ts: HTMLElement only (not Node/Text).
  if (typeof HTMLElement === "function") {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
  } else if (!element) {
    return false;
  }
  var name = String(element.nodeName || element.tagName || "").toLowerCase();
  var type = "";
  if (typeof element.getAttribute === "function") type = element.getAttribute("type") || "";
  else if (element.type != null) type = element.type;
  type = String(type).toLowerCase();
  return (
    name === "select"
    || name === "textarea"
    || (name === "input"
      && type !== "submit"
      && type !== "reset"
      && type !== "checkbox"
      && type !== "radio"
      && type !== "file")
    || !!element.isContentEditable
  );
}

function rootDocument() {
  if (typeof document !== "undefined") return document;
  return typeof globalThis !== "undefined" ? globalThis.document : undefined;
}

function overlayStackOwner() {
  var owner = null;
  try {
    if (typeof window !== "undefined") owner = window;
  } catch (e0) {}
  if (!owner) {
    try {
      if (typeof globalThis !== "undefined") owner = globalThis;
    } catch (e1) {}
  }
  return owner;
}

function overlayStackBusy() {
  var owner = overlayStackOwner();
  var stack = owner && owner.__tqOverlayStack;
  return !!(stack && stack.length);
}

function topOverlay() {
  var owner = overlayStackOwner();
  var stack = owner && owner.__tqOverlayStack;
  if (!stack || !stack.length) return null;
  return stack[stack.length - 1];
}

function nodeInsideOverlay(el, overlay) {
  if (!el || !overlay) return false;
  if (el === overlay) return true;
  if (typeof overlay.contains === "function") {
    try {
      if (overlay.contains(el)) return true;
    } catch (e0) {}
  }
  var n = el;
  while (n) {
    if (n === overlay) return true;
    n = n.parentNode || n.parentElement || n.host;
  }
  return false;
}

function isHiddenOverlayHost(n) {
  if (!n) return false;
  var hidden = !!n.hidden;
  if (!hidden && typeof n.hasAttribute === "function") {
    try {
      hidden = n.hasAttribute("hidden");
    } catch (e0) {}
  }
  if (!hidden) return false;
  if (n.id === "sessionFlyout") return true;
  if (typeof n.getAttribute === "function") {
    try {
      if (n.getAttribute("role") === "dialog") return true;
    } catch (e1) {}
  }
  return false;
}

/** True when a data-hotkey node lives under a closed overlay (not #tqHotkeyNav). */
function hotkeyLeafHostHidden(el) {
  var n = el && (el.parentElement || el.parentNode);
  while (n) {
    if (n.nodeType === 9) break;
    if (isHiddenOverlayHost(n)) return true;
    n = n.parentElement || n.parentNode || n.host;
  }
  return false;
}

/**
 * Overlay-busy: only fire leaves inside the top overlay (GitHub one dispatcher,
 * no capture-phase printable sibling). Idle: skip leaves under a hidden host
 * so closed-flyout Next/Prev do not steal list j/k.
 */
function hotkeyLeafMayFire(el) {
  if (!el) return false;
  var top = topOverlay();
  if (top) return nodeInsideOverlay(el, top);
  return !hotkeyLeafHostHidden(el);
}

/** GitHub src/radix-trie.ts Leaf — children are the data-hotkey HTMLElements. */
function Leaf(trie) {
  this.parent = trie;
  this.children = [];
  this.add = function add(value) {
    this.children.push(value);
    return this;
  };
  this.delete = function del(value) {
    var index = this.children.indexOf(value);
    if (index === -1) return false;
    this.children = this.children.slice(0, index).concat(this.children.slice(index + 1));
    if (this.children.length === 0 && this.parent && typeof this.parent.delete === "function") {
      this.parent.delete(this);
    }
    return true;
  };
}

function isHotkeyLeaf(node) {
  return !!(node && Array.isArray(node.children));
}

/** GitHub src/radix-trie.ts RadixTrie — edges are hotkey strings. */
function RadixTrie(parent) {
  this.parent = parent || null;
  this.children = {};
  this.get = function get(edge) {
    return this.children[edge];
  };
  this.insert = function insert(edges) {
    var currentNode = this;
    for (var i = 0; i < edges.length; i += 1) {
      var edge = edges[i];
      var nextNode = currentNode.get(edge);
      if (i === edges.length - 1) {
        if (nextNode && !isHotkeyLeaf(nextNode)) {
          currentNode.delete(nextNode);
          nextNode = null;
        }
        if (!nextNode) {
          nextNode = new Leaf(currentNode);
          currentNode.children[edge] = nextNode;
        }
        return nextNode;
      }
      if (isHotkeyLeaf(nextNode)) nextNode = null;
      if (!nextNode) {
        nextNode = new RadixTrie(currentNode);
        currentNode.children[edge] = nextNode;
      }
      currentNode = nextNode;
    }
    return currentNode;
  };
  this.delete = function delNode(node) {
    for (var edge in this.children) {
      if (!Object.prototype.hasOwnProperty.call(this.children, edge)) continue;
      if (this.children[edge] === node) {
        var success = delete this.children[edge];
        if (Object.keys(this.children).length === 0 && this.parent && typeof this.parent.delete === "function") {
          this.parent.delete(this);
        }
        return success;
      }
    }
    return false;
  };
}

var HOTKEY_CHORD_MS = 1500;

function hotkeyRuntime() {
  var doc = rootDocument();
  if (!doc) return null;
  if (!doc._tqHotkey) {
    var trie = new RadixTrie();
    doc._tqHotkey = {
      trie: trie,
      current: trie,
      path: [],
      timer: 0,
      leaves: typeof WeakMap === "function" ? new WeakMap() : [],
    };
  }
  return doc._tqHotkey;
}

function sequenceReset() {
  var rt = hotkeyRuntime();
  if (!rt) return;
  if (rt.timer) {
    try { clearTimeout(rt.timer); } catch (e0) {}
    rt.timer = 0;
  }
  rt.path = [];
  rt.current = rt.trie;
}

/** localStorage key for GitHub-style Character keys accessibility setting. */
var CHARACTER_KEYS_LS = "tq-character-keys";

function characterKeysHost() {
  try {
    if (typeof window !== "undefined" && window) return window;
  } catch (e0) {}
  try {
    if (typeof globalThis !== "undefined" && globalThis) return globalThis;
  } catch (e1) {}
  return null;
}

function readCharacterKeysStore() {
  try {
    var store = typeof localStorage !== "undefined" ? localStorage : null;
    if (!store && typeof window !== "undefined" && window && window.localStorage) store = window.localStorage;
    if (store && typeof store.getItem === "function") return store.getItem(CHARACTER_KEYS_LS);
  } catch (e0) {}
  return null;
}

function writeCharacterKeysStore(value) {
  try {
    var store = typeof localStorage !== "undefined" ? localStorage : null;
    if (!store && typeof window !== "undefined" && window && window.localStorage) store = window.localStorage;
    if (store && typeof store.setItem === "function") store.setItem(CHARACTER_KEYS_LS, value);
  } catch (e0) {}
}

/**
 * GitHub Accessibility → Keyboard shortcuts → Character keys.
 * Default on. "off" turns off unmodified character-key shortcuts
 * (s, /, g c) without affecting Control/Command chords.
 */
export function characterKeysEnabled() {
  var doc = rootDocument();
  if (doc && doc.documentElement && typeof doc.documentElement.getAttribute === "function") {
    var attr = doc.documentElement.getAttribute("data-tq-character-keys");
    if (attr === "off" || attr === "0" || attr === "false") return false;
    if (attr === "on" || attr === "1" || attr === "true") return true;
  }
  var stored = readCharacterKeysStore();
  if (stored === "off" || stored === "0" || stored === "false") return false;
  return true;
}

/** WCAG 2.1.4 character key: letter/punctuation/number/symbol, no Ctrl/Alt/Meta. */
export function isCharacterKeyEvent(event) {
  if (!event) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  var key = event.key;
  if (key == null) return false;
  return String(key).length === 1;
}

export function setCharacterKeysEnabled(on) {
  var enabled = !!on;
  var doc = rootDocument();
  if (doc && doc.documentElement && typeof doc.documentElement.setAttribute === "function") {
    doc.documentElement.setAttribute("data-tq-character-keys", enabled ? "on" : "off");
  }
  writeCharacterKeysStore(enabled ? "on" : "off");
  if (!enabled) sequenceReset();
}

function applyCharacterKeysSetting() {
  var on = characterKeysEnabled();
  var doc = rootDocument();
  if (doc && doc.documentElement && typeof doc.documentElement.setAttribute === "function") {
    doc.documentElement.setAttribute("data-tq-character-keys", on ? "on" : "off");
  }
  var host = characterKeysHost();
  if (host) {
    host.characterKeysEnabled = characterKeysEnabled;
    host.setCharacterKeysEnabled = setCharacterKeysEnabled;
  }
}

function sequenceRegister(event) {
  var rt = hotkeyRuntime();
  if (!rt) return;
  rt.path = rt.path.concat([eventToHotkeyString(event)]);
  if (rt.timer) {
    try { clearTimeout(rt.timer); } catch (e0) {}
  }
  var timerHost = typeof window !== "undefined" ? window : globalThis;
  if (timerHost && typeof timerHost.setTimeout === "function") {
    rt.timer = timerHost.setTimeout(sequenceReset, HOTKEY_CHORD_MS);
  }
}

/** GitHub src/hotkey.ts — modifier names in Control, Alt, Meta, Shift order. */
var modifierKeyNames = ["Control", "Alt", "Meta", "Shift"];
var matchApplePlatform = /Mac|iPod|iPhone|iPad/i;
var syntheticKeyNames = { " ": "Space", "+": "Plus" };
var orderedModifiers = { Control: 0, Alt: 1, Meta: 2, Shift: 3 };

/** GitHub src/macos-symbol-layer.ts — Option-layer symbols → keys on macOS English. */
var macosSymbolLayerKeys = {
  "¡": "1", "™": "2", "£": "3", "¢": "4", "∞": "5", "§": "6", "¶": "7", "•": "8", "ª": "9", "º": "0",
  "–": "-", "≠": "=", "⁄": "!", "€": "@", "‹": "#", "›": "$", "ﬁ": "%", "ﬂ": "^", "‡": "&", "°": "*",
  "·": "(", "‚": ")", "—": "_", "±": "+", "œ": "q", "∑": "w", "®": "r", "†": "t", "¥": "y", "ø": "o",
  "π": "p", "“": "[", "‘": "]", "«": "\\", "Œ": "Q", "„": "W", "´": "E", "‰": "R", "ˇ": "T", "Á": "Y",
  "¨": "U", "ˆ": "I", "Ø": "O", "∏": "P", "”": "{", "’": "}", "»": "|", "å": "a", "ß": "s", "∂": "d",
  "ƒ": "f", "©": "g", "˙": "h", "∆": "j", "˚": "k", "¬": "l", "…": ";", "æ": "'", "Å": "A", "Í": "S",
  "Î": "D", "Ï": "F", "˝": "G", "Ó": "H", "Ô": "J", "": "K", "Ò": "L", "Ú": ":", "Æ": "\"", "Ω": "z",
  "≈": "x", "ç": "c", "√": "v", "∫": "b", "µ": "m", "≤": ",", "≥": ".", "÷": "/", "¸": "Z", "˛": "X",
  "Ç": "C", "◊": "V", "ı": "B", "˜": "N", "Â": "M", "¯": "<", "˘": ">", "¿": "?",
};

/** GitHub src/macos-uppercase-layer.ts — Shift-layer symbols → keys on macOS English. */
var macosUppercaseLayerKeys = {
  "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(",
  "0": ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">",
  "/": "?", "q": "Q", "w": "W", "e": "E", "r": "R", "t": "T", "y": "Y", "u": "U", "i": "I", "o": "O",
  "p": "P", "a": "A", "s": "S", "d": "D", "f": "F", "g": "G", "h": "H", "j": "J", "k": "K", "l": "L",
  "z": "Z", "x": "X", "c": "C", "v": "V", "b": "B", "n": "N", "m": "M",
};

function hotkeyPlatform(platform) {
  if (platform != null) return String(platform);
  try {
    if (typeof navigator !== "undefined" && navigator && navigator.platform) return navigator.platform;
  } catch (e0) {}
  try {
    if (typeof window !== "undefined" && window && window.navigator && window.navigator.platform) {
      return window.navigator.platform;
    }
  } catch (e1) {}
  return "";
}

function localizeMod(hotkey, platform) {
  var safePlatform = platform;
  if (safePlatform == null) {
    var ssrSafeWindow = typeof window === "undefined" ? undefined : window;
    safePlatform = (ssrSafeWindow && ssrSafeWindow.navigator && ssrSafeWindow.navigator.platform) || "";
  }
  var localModifier = matchApplePlatform.test(String(safePlatform)) ? "Meta" : "Control";
  return String(hotkey || "").replace("Mod", localModifier);
}

function sortModifiers(hotkey) {
  return String(hotkey || "").split("+").sort(function (a, b) {
    var ia = Object.prototype.hasOwnProperty.call(orderedModifiers, a) ? orderedModifiers[a] : Infinity;
    var ib = Object.prototype.hasOwnProperty.call(orderedModifiers, b) ? orderedModifiers[b] : Infinity;
    return ia - ib;
  }).join("+");
}

/**
 * GitHub src/hotkey.ts eventToHotkeyString:
 * modifiers in Control+Alt+Meta+Shift order; macOS Alt-symbol and
 * Command+Shift uppercase layers; Space/Plus synthetic names.
 */
export function eventToHotkeyString(event, platform) {
  if (!event) return "";
  var key = event.key;
  if (key == null) return "";
  var hotkeyString = [];
  var modifiers = [!!event.ctrlKey, !!event.altKey, !!event.metaKey, !!event.shiftKey];
  for (var i = 0; i < modifiers.length; i++) {
    if (modifiers[i]) hotkeyString.push(modifierKeyNames[i]);
  }
  if (modifierKeyNames.indexOf(key) === -1) {
    var apple = matchApplePlatform.test(hotkeyPlatform(platform));
    var altNormalizedKey = key;
    if (hotkeyString.indexOf("Alt") !== -1 && apple) {
      altNormalizedKey = Object.prototype.hasOwnProperty.call(macosSymbolLayerKeys, key)
        ? macosSymbolLayerKeys[key]
        : key;
    }
    var shiftNormalizedKey = altNormalizedKey;
    if (hotkeyString.indexOf("Shift") !== -1 && apple) {
      shiftNormalizedKey = Object.prototype.hasOwnProperty.call(macosUppercaseLayerKeys, altNormalizedKey)
        ? macosUppercaseLayerKeys[altNormalizedKey]
        : altNormalizedKey;
    }
    var syntheticKey = Object.prototype.hasOwnProperty.call(syntheticKeyNames, shiftNormalizedKey)
      ? syntheticKeyNames[shiftNormalizedKey]
      : shiftNormalizedKey;
    hotkeyString.push(syntheticKey);
  }
  return hotkeyString.join("+");
}

/**
 * GitHub src/hotkey.ts normalizeHotkey:
 * Mod → Meta on Apple / Control elsewhere; modifiers sorted Control, Alt, Meta, Shift.
 */
export function normalizeHotkey(hotkey, platform) {
  return sortModifiers(localizeMod(hotkey, platform));
}

/** GitHub src/utils.ts expandHotkeyToEdges — comma aliases, space sequences. */
function expandHotkeyToEdges(hotkey) {
  var output = [];
  var acc = [""];
  var commaIsSeparator = false;
  var raw = String(hotkey || "");
  for (var i = 0; i < raw.length; i++) {
    if (commaIsSeparator && raw[i] === ",") {
      output.push(acc);
      acc = [""];
      commaIsSeparator = false;
      continue;
    }
    if (raw[i] === " ") {
      acc.push("");
      commaIsSeparator = false;
      continue;
    } else if (raw[i] === "+") {
      commaIsSeparator = false;
    } else {
      commaIsSeparator = true;
    }
    acc[acc.length - 1] += raw[i];
  }
  output.push(acc);
  var edges = [];
  for (var o = 0; o < output.length; o++) {
    var seq = [];
    for (var s = 0; s < output[o].length; s++) {
      var n = normalizeHotkey(output[o][s]);
      if (n !== "") seq.push(n);
    }
    if (seq.length > 0) edges.push(seq);
  }
  return edges;
}

/**
 * GitHub eventToHotkeyString encodes Shift+letter as "Shift+G", never "G".
 * Docs write "G then C"; install letter sequences with those encoder
 * aliases so Shift+G then c matches. Skip length-1 chords (s, o, /).
 * Not four-way G c / g C aliases — those strings never leave the encoder.
 */
function letterSequenceShiftAliases(seq) {
  if (!seq || seq.length < 2) return [];
  var shifted = [];
  var i;
  for (i = 0; i < seq.length; i++) {
    var edge = seq[i];
    if (!edge || edge.length !== 1) return [];
    var ch = edge.charAt(0);
    if (ch < "a" || ch > "z") return [];
    shifted.push("Shift+" + ch.toUpperCase());
  }
  var extra = [];
  var n = seq.length;
  var max = 1 << n;
  var mask;
  for (mask = 1; mask < max; mask++) {
    var alt = [];
    for (i = 0; i < n; i++) {
      alt.push((mask & (1 << i)) ? shifted[i] : seq[i]);
    }
    extra.push(alt);
  }
  return extra;
}

/** GitHub src/utils.ts fireDeterminedAction — hotkey-fire, then focus or click. */
function fireDeterminedAction(el, path) {
  if (!el) return;
  var cancelled = false;
  if (typeof CustomEvent === "function" && typeof el.dispatchEvent === "function") {
    try {
      var evt = new CustomEvent("hotkey-fire", { cancelable: true, detail: { path: path } });
      cancelled = !el.dispatchEvent(evt);
    } catch (e0) {}
  }
  if (cancelled) return;
  if (isFormField(el)) {
    if (typeof el.focus === "function") el.focus();
  } else if (typeof el.click === "function") {
    el.click();
  }
}

function storedLeaves(rt, element, next) {
  if (!rt) return null;
  var writing = arguments.length > 2;
  if (rt.leaves && typeof rt.leaves.get === "function") {
    if (writing) {
      if (next && typeof rt.leaves.set === "function") rt.leaves.set(element, next);
      else if (typeof rt.leaves.delete === "function") rt.leaves.delete(element);
      return next || null;
    }
    return rt.leaves.get(element) || null;
  }
  var list = rt.leaves;
  if (!Array.isArray(list)) {
    rt.leaves = [];
    list = rt.leaves;
  }
  for (var i = 0; i < list.length; i++) {
    if (list[i].el === element) {
      if (writing) {
        if (next) list[i].leaves = next;
        else list.splice(i, 1);
        return next || null;
      }
      return list[i].leaves;
    }
  }
  if (writing && next) list.push({ el: element, leaves: next });
  return writing ? (next || null) : null;
}

/** GitHub src/index.ts install — insert this data-hotkey element into the trie. */
export function install(element, hotkey) {
  if (!element) return;
  uninstall(element);
  var attr = hotkey;
  if (attr == null && typeof element.getAttribute === "function") {
    attr = element.getAttribute("data-hotkey") || "";
  }
  attr = attr || "";
  if (!attr) return;
  var existingHotkey = typeof element.getAttribute === "function"
    ? element.getAttribute("data-hotkey")
    : "";
  if (typeof element.setAttribute === "function" && !existingHotkey) {
    element.setAttribute("data-hotkey", attr);
  }
  var rt = hotkeyRuntime();
  if (!rt) return;
  var sequences = expandHotkeyToEdges(attr);
  var leaves = [];
  for (var i = 0; i < sequences.length; i++) {
    var all = [sequences[i]].concat(letterSequenceShiftAliases(sequences[i]));
    for (var a = 0; a < all.length; a++) {
      var leaf = rt.trie.insert(all[a]);
      leaf.add(element);
      leaves.push(leaf);
    }
  }
  storedLeaves(rt, element, leaves);
}

export function uninstall(element) {
  var rt = hotkeyRuntime();
  if (!rt || !element) return;
  var leaves = storedLeaves(rt, element);
  if (!leaves || !leaves.length) return;
  for (var i = 0; i < leaves.length; i++) {
    if (leaves[i] && typeof leaves[i].delete === "function") leaves[i].delete(element);
  }
  storedLeaves(rt, element, null);
}

/** Create or reuse a hidden data-hotkey element and install it into the trie. */
export function installPageHotkey(id, hotkey, onClick) {
  var doc = rootDocument();
  if (!doc || !hotkey) return null;
  var el = typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
  if (!el && typeof doc.createElement === "function") {
    el = doc.createElement("button");
    if (el) {
      el.id = id;
      el.type = "button";
      el.hidden = true;
      if (typeof el.setAttribute === "function") {
        el.setAttribute("type", "button");
        el.setAttribute("id", id);
        el.setAttribute("hidden", "");
        el.setAttribute("tabindex", "-1");
        el.setAttribute("aria-hidden", "true");
        el.setAttribute("data-hotkey", hotkey);
      }
      var parent = doc.body || doc.documentElement || doc;
      if (parent && typeof parent.appendChild === "function") parent.appendChild(el);
    }
  } else if (el && typeof el.setAttribute === "function") {
    el.setAttribute("data-hotkey", hotkey);
  }
  if (!el) return null;
  if (typeof onClick === "function" && typeof el.addEventListener === "function" && !el._tqHotkeyBound) {
    el.addEventListener("click", onClick);
    el._tqHotkeyBound = true;
  }
  install(el, hotkey);
  return el;
}

function installAllDataHotkeys(root) {
  var doc = root || rootDocument();
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  var nodes = doc.querySelectorAll("[data-hotkey]");
  if (!nodes) return;
  var len = nodes.length;
  for (var i = 0; i < len; i++) install(nodes[i]);
}

/**
 * GitHub keyDownHandler (bubble phase):
 *   if (event.defaultPrevented) return
 *   if (isFormField(event.target)) {
 *     if (!target.id) return
 *     if (!querySelector(`[data-hotkey-scope="${target.id}"]`)) return
 *   }
 *   // trie walk; leaf fires one HTMLElement then preventDefault()
 *   // overlay-busy: only leaves inside the top overlay (hotkeyLeafMayFire)
 *
 * Does not stopPropagation — the event still reaches the field.
 * Unscoped form-field return sequenceReset()s so a chord started while
 * idle cannot complete after typing and blur.
 */
export function keyDownHandler(event) {
  if (!event) return;
  if (event.defaultPrevented) return;
  if (!event.target) return;
  if (typeof Node === "function" && !(event.target instanceof Node)) return;
  if (isFormField(event.target)) {
    var target = event.target;
    var scoped = false;
    if (target.id) {
      var scopeDoc = target.ownerDocument || rootDocument();
      if (scopeDoc && typeof scopeDoc.querySelector === "function") {
        scoped = !!scopeDoc.querySelector('[data-hotkey-scope="' + target.id + '"]');
      }
    }
    if (!scoped) {
      sequenceReset();
      return;
    }
  }
  if (!characterKeysEnabled() && isCharacterKeyEvent(event)) {
    sequenceReset();
    return;
  }
  var rt = hotkeyRuntime();
  if (!rt || !rt.current || typeof rt.current.get !== "function") return;
  var overlayBusy = overlayStackBusy();
  var newTriePosition = rt.current.get(eventToHotkeyString(event));
  if (!newTriePosition) {
    sequenceReset();
    return;
  }
  if (!isHotkeyLeaf(newTriePosition)) {
    if (overlayBusy) {
      sequenceReset();
      return;
    }
    sequenceRegister(event);
    rt.current = newTriePosition;
    return;
  }
  sequenceRegister(event);
  rt.current = newTriePosition;
  var fireTarget = event.target;
  var formField = isFormField(fireTarget);
  var shouldFire = false;
  var elementToFire;
  for (var i = newTriePosition.children.length - 1; i >= 0; i -= 1) {
    elementToFire = newTriePosition.children[i];
    var scope = null;
    if (elementToFire && typeof elementToFire.getAttribute === "function") {
      scope = elementToFire.getAttribute("data-hotkey-scope");
    }
    if ((!formField && !scope) || (formField && fireTarget.id === scope)) {
      if (!hotkeyLeafMayFire(elementToFire)) continue;
      shouldFire = true;
      break;
    }
  }
  if (elementToFire && shouldFire) {
    fireDeterminedAction(elementToFire, rt.path);
    if (typeof event.preventDefault === "function") event.preventDefault();
  }
  sequenceReset();
}

export function installFormFieldHotkeyGuard() {
  var doc = rootDocument();
  if (!doc || typeof doc.addEventListener !== "function") return;
  if (doc._tqFormGuardInstalled) {
    applyCharacterKeysSetting();
    installAllDataHotkeys(doc);
    return;
  }
  var root = doc.documentElement;
  if (root && typeof root.getAttribute === "function" && root.getAttribute("data-tq-form-guard") === "1") {
    doc._tqFormGuardInstalled = true;
    applyCharacterKeysSetting();
    installAllDataHotkeys(doc);
    return;
  }
  doc._tqFormGuardInstalled = true;
  if (root && typeof root.setAttribute === "function") root.setAttribute("data-tq-form-guard", "1");
  doc.addEventListener("keydown", keyDownHandler);
  applyCharacterKeysSetting();
  installAllDataHotkeys(doc);
}

/** Injected into every inlined page bundle that owns document-level character shortcuts. */
export const FORM_FIELD_GUARD_SRC = [
  "var isFormField = " + fnSrc(isFormField) + ";",
  "var rootDocument = " + fnSrc(rootDocument) + ";",
  "var overlayStackOwner = " + fnSrc(overlayStackOwner) + ";",
  "var overlayStackBusy = " + fnSrc(overlayStackBusy) + ";",
  "var topOverlay = " + fnSrc(topOverlay) + ";",
  "var nodeInsideOverlay = " + fnSrc(nodeInsideOverlay) + ";",
  "var isHiddenOverlayHost = " + fnSrc(isHiddenOverlayHost) + ";",
  "var hotkeyLeafHostHidden = " + fnSrc(hotkeyLeafHostHidden) + ";",
  "var hotkeyLeafMayFire = " + fnSrc(hotkeyLeafMayFire) + ";",
  "var Leaf = " + fnSrc(Leaf) + ";",
  "var isHotkeyLeaf = " + fnSrc(isHotkeyLeaf) + ";",
  "var RadixTrie = " + fnSrc(RadixTrie) + ";",
  "var HOTKEY_CHORD_MS = " + HOTKEY_CHORD_MS + ";",
  "var hotkeyRuntime = " + fnSrc(hotkeyRuntime) + ";",
  "var sequenceReset = " + fnSrc(sequenceReset) + ";",
  "var CHARACTER_KEYS_LS = " + JSON.stringify(CHARACTER_KEYS_LS) + ";",
  "var characterKeysHost = " + fnSrc(characterKeysHost) + ";",
  "var readCharacterKeysStore = " + fnSrc(readCharacterKeysStore) + ";",
  "var writeCharacterKeysStore = " + fnSrc(writeCharacterKeysStore) + ";",
  "var characterKeysEnabled = " + fnSrc(characterKeysEnabled) + ";",
  "var isCharacterKeyEvent = " + fnSrc(isCharacterKeyEvent) + ";",
  "var setCharacterKeysEnabled = " + fnSrc(setCharacterKeysEnabled) + ";",
  "var applyCharacterKeysSetting = " + fnSrc(applyCharacterKeysSetting) + ";",
  "var sequenceRegister = " + fnSrc(sequenceRegister) + ";",
  "var modifierKeyNames = " + JSON.stringify(modifierKeyNames) + ";",
  "var matchApplePlatform = /Mac|iPod|iPhone|iPad/i;",
  "var syntheticKeyNames = " + JSON.stringify(syntheticKeyNames) + ";",
  "var orderedModifiers = " + JSON.stringify(orderedModifiers) + ";",
  "var macosSymbolLayerKeys = " + JSON.stringify(macosSymbolLayerKeys) + ";",
  "var macosUppercaseLayerKeys = " + JSON.stringify(macosUppercaseLayerKeys) + ";",
  "var hotkeyPlatform = " + fnSrc(hotkeyPlatform) + ";",
  "var localizeMod = " + fnSrc(localizeMod) + ";",
  "var sortModifiers = " + fnSrc(sortModifiers) + ";",
  "var eventToHotkeyString = " + fnSrc(eventToHotkeyString) + ";",
  "var normalizeHotkey = " + fnSrc(normalizeHotkey) + ";",
  "var expandHotkeyToEdges = " + fnSrc(expandHotkeyToEdges) + ";",
  "var letterSequenceShiftAliases = " + fnSrc(letterSequenceShiftAliases) + ";",
  "var fireDeterminedAction = " + fnSrc(fireDeterminedAction) + ";",
  "var storedLeaves = " + fnSrc(storedLeaves) + ";",
  "var install = " + fnSrc(install) + ";",
  "var uninstall = " + fnSrc(uninstall) + ";",
  "var installPageHotkey = " + fnSrc(installPageHotkey) + ";",
  "var installAllDataHotkeys = " + fnSrc(installAllDataHotkeys) + ";",
  "var keyDownHandler = " + fnSrc(keyDownHandler) + ";",
  "var installFormFieldHotkeyGuard = " + fnSrc(installFormFieldHotkeyGuard) + ";",
  "installFormFieldHotkeyGuard();",
].join("\n");
