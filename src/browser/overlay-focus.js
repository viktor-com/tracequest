/**
 * Overlay focus lifecycle (APG dialog): record the previously focused
 * element, move focus into the overlay, trap Tab, restore on dismiss,
 * and never leave focus on a hidden node.
 *
 * Nested overlays share window.__tqOverlayStack. The top overlay stays
 * interactive; every sibling along the ancestor path to body is inert
 * (APG: windows under a modal are inert, including page content nested
 * in the same body child as a toolbar menu). Push/pop recompute from
 * the stack so Cmd+K over launch is not left inert.
 * Stack order is also paint order: later overlays get a higher z-index
 * than earlier ones (share CSS 1000 would otherwise bury Cmd+K at 500).
 *
 * Push/pop also disarm the GitHub radix-trie chord (document._tqHotkey).
 * Capture-phase overlay Escape stopPropagation, so the bubble
 * keyDownHandler never sees the key to sequenceReset — an idle g must
 * not complete g c after dismissing launch/share/palette.
 *
 * Function bodies are toString-embedded into inlined page scripts.
 */

function overlayIsDisplayed(el, root) {
  var n = el;
  while (n && n !== root && n.nodeType === 1) {
    try {
      var view = n.ownerDocument && n.ownerDocument.defaultView;
      var win = view || (typeof window !== "undefined" ? window : null);
      if (win && typeof win.getComputedStyle === "function") {
        var cs = win.getComputedStyle(n);
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
      }
    } catch (e0) {}
    n = n.parentNode;
  }
  return true;
}

export function overlayFocusable(el, root) {
  if (!el || el.disabled) return false;
  var name = (el.tagName || "").toLowerCase();
  var tab = null;
  if (typeof el.getAttribute === "function") tab = el.getAttribute("tabindex");
  if (tab === "-1") return false;
  if (el.hidden) return false;
  var n = el.parentNode;
  while (n && n !== root) {
    if (n.hidden) return false;
    n = n.parentNode;
  }
  if (!overlayIsDisplayed(el, root)) return false;
  if (name === "a") {
    var href = typeof el.getAttribute === "function" ? el.getAttribute("href") : el.href;
    return href != null && href !== "";
  }
  if (name === "button" || name === "select" || name === "textarea" || name === "iframe") return true;
  if (name === "input") {
    var type = "";
    if (typeof el.getAttribute === "function") type = el.getAttribute("type") || "";
    else if (el.type != null) type = el.type;
    return String(type).toLowerCase() !== "hidden";
  }
  return tab != null && tab !== "" && Number(tab) >= 0;
}

export function overlayTabbables(root) {
  if (!root) return [];
  var out = [];
  function walk(node) {
    if (!node || !node.tagName) return;
    if (node !== root && node.hidden) return;
    if (node !== root && overlayFocusable(node, root)) out.push(node);
    var kids = node.children || node.childNodes || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  }
  walk(root);
  return out;
}

export function overlayFrameDocument(frame) {
  if (!frame) return null;
  try {
    return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
  } catch (e0) {
    return null;
  }
}

export function overlayNestedTabbables(root) {
  var out = [];
  if (!root) return out;
  function walk(node) {
    if (!node || !node.tagName) return;
    if (node !== root && node.hidden) return;
    var name = (node.tagName || "").toLowerCase();
    if (name === "iframe") {
      var doc = overlayFrameDocument(node);
      var innerRoot = doc && (doc.body || doc.documentElement);
      if (innerRoot) {
        var tabs = overlayTabbables(innerRoot);
        for (var i = 0; i < tabs.length; i++) out.push(tabs[i]);
      }
      return;
    }
    var kids = node.children || node.childNodes || [];
    for (var j = 0; j < kids.length; j++) walk(kids[j]);
  }
  walk(root);
  return out;
}

function overlayTabIndexOf(tabs, el) {
  if (!el) return -1;
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i] === el) return i;
  }
  return -1;
}

function overlayFocusNode(el) {
  if (!el || typeof el.focus !== "function") return false;
  try { el.focus(); return true; } catch (e0) { return false; }
}

export function overlayPrevFocus(root) {
  var el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return el;
  if (root && typeof root.contains === "function" && root.contains(el)) return null;
  return el;
}

export function restoreOverlayFocus(prev, root) {
  if (prev && typeof prev.focus === "function" && prev !== document.body && prev !== document.documentElement) {
    var connected = prev.isConnected !== false;
    var buried = !!prev.hidden;
    if (!buried && typeof prev.closest === "function") {
      try { if (prev.closest("[hidden]")) buried = true; } catch (e0) {}
    }
    if (connected && !buried) {
      try { prev.focus(); } catch (e1) {}
    }
  }
  if (root && root.hidden) {
    var active = document.activeElement;
    if (active && typeof root.contains === "function" && root.contains(active)) {
      try { active.blur(); } catch (e2) {}
    }
  }
}

export function trapOverlayNestedTab(e, root) {
  if (!e || e.key !== "Tab" || !root || root.hidden) return false;
  var innerDoc = null;
  var target = e.target;
  var hostFrame = null;
  if (target && (target.tagName || "").toLowerCase() === "iframe" && typeof root.contains === "function" && root.contains(target)) {
    hostFrame = target;
    innerDoc = overlayFrameDocument(target);
  } else if (target && target.ownerDocument && target.ownerDocument !== document) {
    innerDoc = target.ownerDocument;
  }
  if (!innerDoc) return false;
  var innerRoot = innerDoc.body || innerDoc.documentElement;
  var innerTabs = overlayTabbables(innerRoot);
  var innerCur = innerDoc.activeElement;
  if (hostFrame && (!innerCur || innerCur === innerDoc.body || innerCur === innerDoc.documentElement)) {
    innerCur = null;
  }
  var innerIdx = overlayTabIndexOf(innerTabs, innerCur);
  var atStart = !innerTabs.length || innerIdx < 0 || innerCur === innerTabs[0];
  var atEnd = !innerTabs.length || innerIdx < 0 || innerCur === innerTabs[innerTabs.length - 1];
  if (e.shiftKey) {
    if (!atStart) return false;
  } else if (!atEnd) return false;
  e.preventDefault();
  if (typeof e.stopPropagation === "function") e.stopPropagation();
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
  var chrome = overlayTabbables(root);
  var chromeTarget = e.shiftKey
    ? (chrome.length ? chrome[chrome.length - 1] : root)
    : (chrome.length ? chrome[0] : root);
  overlayFocusNode(chromeTarget);
  return true;
}

export function overlayIsCommandPaletteChord(event) {
  if (!event) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  var key = event.key;
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (key === "k" || key === "K");
}

export function overlayToggleParentPalette() {
  var owner = overlayOwner();
  var pal = owner && owner.TracequestPalette;
  if (pal && typeof pal.toggle === "function") {
    pal.toggle();
    return true;
  }
  return false;
}

export function bindOverlayNestedFrameKeys(root, frame, onEscape) {
  if (!frame || typeof frame.addEventListener !== "function") return;
  function attach() {
    var doc = overlayFrameDocument(frame);
    if (!doc || doc._tqOverlayTabBound) return;
    doc._tqOverlayTabBound = true;
    if (typeof doc.addEventListener !== "function") return;
    doc.addEventListener("keydown", function (event) {
      if (!root || root.hidden || (typeof isTopOverlay === "function" && !isTopOverlay(root))) return;
      if (overlayIsCommandPaletteChord(event)) {
        event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        overlayToggleParentPalette();
        return;
      }
      if (event.key === "Tab") {
        trapOverlayNestedTab(event, root);
        return;
      }
      if (event.key === "Escape" && typeof onEscape === "function") {
        event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        onEscape();
      }
    }, true);
  }
  frame.addEventListener("load", attach);
  attach();
}

export function trapOverlayTab(e, root) {
  if (!e || e.key !== "Tab" || !root || root.hidden) return false;
  if (trapOverlayNestedTab(e, root)) return true;
  var tabs = overlayTabbables(root);
  var nested = overlayNestedTabbables(root);
  var cur = document.activeElement;
  if (!tabs.length) {
    e.preventDefault();
    if (typeof e.stopPropagation === "function") e.stopPropagation();
    if (nested.length) {
      var nestedEdge = e.shiftKey ? nested[nested.length - 1] : nested[0];
      if (overlayFocusNode(nestedEdge)) return true;
    }
    if (typeof root.focus === "function") {
      try { root.focus(); } catch (err) {}
    }
    return true;
  }
  var first = tabs[0];
  var last = tabs[tabs.length - 1];
  var inside = !!(typeof root.contains === "function" && cur && root.contains(cur));
  var inCycle = overlayTabIndexOf(tabs, cur) >= 0;
  if (nested.length && inCycle) {
    if (e.shiftKey && cur === first) {
      e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      overlayFocusNode(nested[nested.length - 1]);
      return true;
    }
    if (!e.shiftKey && cur === last) {
      e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      overlayFocusNode(nested[0]);
      return true;
    }
  }
  if (e.shiftKey) {
    if (!inside || cur === first || !inCycle) {
      e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      try { last.focus(); } catch (e1) {}
      return true;
    }
  } else if (!inside || cur === last || !inCycle) {
    e.preventDefault();
    if (typeof e.stopPropagation === "function") e.stopPropagation();
    try { first.focus(); } catch (e2) {}
    return true;
  }
  return false;
}

export function focusOverlay(root, preferred) {
  if (!root) return;
  if (preferred && typeof preferred.focus === "function") {
    try { preferred.focus(); return; } catch (e0) {}
  }
  var tabs = overlayTabbables(root);
  if (tabs.length) {
    try { tabs[0].focus(); return; } catch (e1) {}
  }
  if (typeof root.focus === "function") {
    try { root.focus(); } catch (e2) {}
  }
}

function overlayOwner() {
  try {
    if (typeof window !== "undefined" && window) return window;
  } catch (e0) {}
  try {
    if (typeof globalThis !== "undefined" && globalThis) return globalThis;
  } catch (e1) {}
  return null;
}

function getOverlayStack() {
  var owner = overlayOwner();
  if (!owner) return [];
  if (!owner.__tqOverlayStack) owner.__tqOverlayStack = [];
  return owner.__tqOverlayStack;
}

function getOverlayInerted() {
  var owner = overlayOwner();
  if (!owner) return [];
  if (!owner.__tqOverlayInerted) owner.__tqOverlayInerted = [];
  return owner.__tqOverlayInerted;
}

function overlayBodyChild(el) {
  var body = document.body;
  if (!el || !body) return el;
  var n = el;
  while (n && n.parentNode && n.parentNode !== body && n.parentNode !== document) n = n.parentNode;
  return n && n.parentNode === body ? n : el;
}

function inertOverlaySiblings(top, store) {
  var body = document.body;
  if (!top || !body || !store) return;
  var node = top;
  while (node && node !== body) {
    var parent = node.parentNode;
    if (!parent || parent === document) break;
    var kids = parent.children || parent.childNodes || [];
    for (var j = 0; j < kids.length; j++) {
      if (kids[j] === node) continue;
      if (typeof kids[j].setAttribute !== "function") continue;
      kids[j].setAttribute("inert", "");
      store.push(kids[j]);
    }
    if (parent === body) break;
    node = parent;
  }
}

function getOverlayPainted() {
  var owner = overlayOwner();
  if (!owner) return [];
  if (!owner.__tqOverlayPainted) owner.__tqOverlayPainted = [];
  return owner.__tqOverlayPainted;
}

function overlayCssZ(el) {
  if (!el) return 0;
  try {
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    var win = view || (typeof window !== "undefined" ? window : null);
    if (win && typeof win.getComputedStyle === "function") {
      var cs = win.getComputedStyle(el);
      var p = parseInt(cs && cs.zIndex, 10);
      if (!isNaN(p)) return p;
    }
  } catch (e0) {}
  if (el.style && el.style.zIndex != null && el.style.zIndex !== "") {
    var n = parseInt(el.style.zIndex, 10);
    if (!isNaN(n)) return n;
  }
  return 0;
}

function restoreOverlayStackPaint() {
  var prev = getOverlayPainted();
  for (var i = 0; i < prev.length; i++) {
    var rec = prev[i];
    if (!rec || !rec.el || !rec.el.style) continue;
    rec.el.style.zIndex = rec.z == null ? "" : rec.z;
  }
  prev.length = 0;
}

export function applyOverlayStackPaint() {
  restoreOverlayStackPaint();
  var stack = getOverlayStack();
  if (!stack.length) return;
  var prev = getOverlayPainted();
  var layers = [];
  var seen = [];
  var base = 1100; // above .hf-modal-overlay (1000) when computed z-index is unavailable
  for (var i = 0; i < stack.length; i++) {
    var child = overlayBodyChild(stack[i]);
    if (!child || seen.indexOf(child) >= 0) continue;
    seen.push(child);
    layers.push(child);
    var z = overlayCssZ(child);
    if (z > base) base = z;
  }
  for (var k = 0; k < layers.length; k++) {
    var el = layers[k];
    if (!el.style) continue;
    prev.push({ el: el, z: el.style.zIndex });
    el.style.zIndex = String(base + k);
  }
}

export function applyOverlayStackInert() {
  var prev = getOverlayInerted();
  for (var i = 0; i < prev.length; i++) {
    if (prev[i] && typeof prev[i].removeAttribute === "function") prev[i].removeAttribute("inert");
  }
  prev.length = 0;
  var stack = getOverlayStack();
  var top = stack.length ? stack[stack.length - 1] : null;
  if (!top) {
    applyOverlayStackPaint();
    return;
  }
  inertOverlaySiblings(top, prev);
  applyOverlayStackPaint();
}

export function disarmPageHotkeyChord() {
  try {
    if (typeof sequenceReset === "function") {
      sequenceReset();
      return;
    }
  } catch (e0) {}
  var doc = null;
  try {
    if (typeof document !== "undefined") doc = document;
  } catch (e1) {}
  if (!doc) {
    try {
      if (typeof globalThis !== "undefined") doc = globalThis.document;
    } catch (e2) {}
  }
  var rt = doc && doc._tqHotkey;
  if (!rt) return;
  if (rt.timer) {
    try { clearTimeout(rt.timer); } catch (e3) {}
    rt.timer = 0;
  }
  rt.path = [];
  if (rt.trie) rt.current = rt.trie;
}

export function pushOverlay(root) {
  if (!root) return getOverlayStack();
  var stack = getOverlayStack();
  var i = stack.lastIndexOf(root);
  if (i >= 0) stack.splice(i, 1);
  stack.push(root);
  applyOverlayStackInert();
  disarmPageHotkeyChord();
  return stack;
}

export function popOverlay(root) {
  var stack = getOverlayStack();
  if (!root) {
    if (stack.length) stack.pop();
  } else {
    var i = stack.lastIndexOf(root);
    if (i >= 0) stack.splice(i, 1);
  }
  applyOverlayStackInert();
  disarmPageHotkeyChord();
  return stack;
}

export function isTopOverlay(root) {
  var stack = getOverlayStack();
  return !!root && stack.length > 0 && stack[stack.length - 1] === root;
}

export function toolbarMenuPairs() {
  return [
    ["ageMenu", "ageBtn"],
    ["sourceMenu", "sourceBtn"],
    ["sortBar", "displayToggle"]
  ];
}

function toolbarMenuTrigger(menu) {
  if (!menu) return null;
  var pairs = toolbarMenuPairs();
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === menu.id) return document.getElementById(pairs[i][1]);
  }
  return null;
}

function openToolbarMenuId(exceptId) {
  var pairs = toolbarMenuPairs();
  for (var i = 0; i < pairs.length; i++) {
    if (exceptId && pairs[i][0] === exceptId) continue;
    var menu = document.getElementById(pairs[i][0]);
    if (menu && !menu.hidden) return menu;
  }
  return null;
}

export function closeToolbarMenuOverlays(exceptId) {
  var pairs = toolbarMenuPairs();
  for (var i = 0; i < pairs.length; i++) {
    if (exceptId && pairs[i][0] === exceptId) continue;
    var menu = document.getElementById(pairs[i][0]);
    var btn = document.getElementById(pairs[i][1]);
    if (menu && !menu.hidden) {
      menu.hidden = true;
      popOverlay(menu);
      restoreOverlayFocus(menu._tqPrevFocus, menu);
      menu._tqPrevFocus = null;
    } else if (menu) {
      menu.hidden = true;
    }
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
}

export function openToolbarMenuOverlay(menu) {
  if (!menu) return;
  var btn = toolbarMenuTrigger(menu);
  if (menu.hidden) {
    var prev = overlayPrevFocus(menu);
    if (!prev) prev = document.activeElement;
    menu._tqPrevFocus = prev;
  }
  menu.hidden = false;
  if (btn) btn.setAttribute("aria-expanded", "true");
  pushOverlay(menu);
  var preferred = menu.querySelector(".toolbar-option") || menu.querySelector(".sort-btn");
  focusOverlay(menu, preferred);
}

export function bindToolbarMenuOverlayKeys() {
  if (typeof document === "undefined" || !document.addEventListener) return;
  if (document._tqToolbarMenuKeys) return;
  document._tqToolbarMenuKeys = true;
  document.addEventListener("keydown", function (event) {
    var open = openToolbarMenuId();
    if (!open || !isTopOverlay(open)) return;
    if (event.key === "Tab") {
      trapOverlayTab(event, open);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      closeToolbarMenuOverlays();
    }
  }, true);
  document.addEventListener("click", function (event) {
    var open = openToolbarMenuId();
    if (!open || !isTopOverlay(open)) return;
    var t = event.target;
    if (open.contains(t)) return;
    if (t && typeof t.closest === "function" && (
      t.closest(".runs-toolbar-actions") ||
      t.closest(".rail-toolbar") ||
      t.closest(".toolbar-pop") ||
      t.closest("#qfBar")
    )) return;
    event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    closeToolbarMenuOverlays();
  }, true);
}

export function setSiblingsInert(exceptEl, on, store) {
  if (on) pushOverlay(exceptEl);
  else popOverlay(exceptEl);
  return store || [];
}

function overlayFnSrc(fn) {
  return fn.toString().replace(/^export /, "");
}

export const OVERLAY_FOCUS_SRC = [
  overlayIsDisplayed,
  overlayFocusable,
  overlayTabbables,
  overlayFrameDocument,
  overlayNestedTabbables,
  overlayTabIndexOf,
  overlayFocusNode,
  overlayPrevFocus,
  restoreOverlayFocus,
  trapOverlayNestedTab,
  overlayIsCommandPaletteChord,
  overlayToggleParentPalette,
  bindOverlayNestedFrameKeys,
  trapOverlayTab,
  focusOverlay,
  overlayOwner,
  getOverlayStack,
  getOverlayInerted,
  overlayBodyChild,
  inertOverlaySiblings,
  getOverlayPainted,
  overlayCssZ,
  restoreOverlayStackPaint,
  applyOverlayStackPaint,
  applyOverlayStackInert,
  disarmPageHotkeyChord,
  pushOverlay,
  popOverlay,
  isTopOverlay,
  toolbarMenuPairs,
  toolbarMenuTrigger,
  openToolbarMenuId,
  closeToolbarMenuOverlays,
  openToolbarMenuOverlay,
  bindToolbarMenuOverlayKeys,
  setSiblingsInert,
].map(overlayFnSrc).join("\n");
