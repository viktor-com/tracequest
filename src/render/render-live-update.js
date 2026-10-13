/**
 * In-place live update for the served session viewer (facts hnr3, hnr6).
 *
 * window.__tqViewApplySession(fresh) swaps the viewer's session data for a
 * newer parse of the same recording and patches the page WITHOUT reloading
 * the document or rebuilding #app: every section is rendered afresh, then
 * - a section whose live DOM already serializes to the fresh render is kept
 *   as is (sections holding a canvas are always swapped: their pixels are not
 *   in the markup);
 * - the chapter list is morphed node by node: unchanged chapters and nodes
 *   stay in the document, changed text is rewritten in its text node, new
 *   chapters are appended. Live-only state survives the morph: the
 *   "show more" toggles attachExpandToggles inserted, and the expanded /
 *   filter-hidden / kb-focused / highlight classes;
 * - every other section without a canvas is morphed the same way (fact
 *   hnr7) when that never puts a fresh handler-carrying element into the
 *   kept tree: a section with no handlers at all is morphed freely, one with
 *   handlers only while its shape and its handler elements' attributes are
 *   unchanged (a fresh handler may close over fresh siblings);
 * - any other section that changed (always one holding a canvas) is swapped
 *   whole.
 * So a text selection in anything that did not change, the focused field
 * with its caret, typed values and opened "show more" blocks all survive,
 * and the text in view stays where it was on screen. A selection that
 * covered text the patch rewrote is put back over the new text, and one in a
 * swapped section is carried to the same text in its replacement. An element
 * with handlers (h() on* props, or marked _tqOn where a listener is added by
 * hand) is only kept while its attributes (which carry the handler's data)
 * are unchanged. Overlays appended to <body> (share modal, palette) are
 * outside #app and are never touched. A standalone exported file defines the
 * hook too but nothing ever calls it there.
 */
/**
 * DOM morph and selection carry-over shared by the /view hook and the
 * /compare refresher (facts hnr6, hnr7, hnr8). Plain functions, no globals.
 */
export const LIVE_MORPH_JS = `
  var LIVE_ONLY_CLASSES = ['expanded', 'filter-hidden', 'kb-focused', 'highlight'];

  function liveIsToggle(node) {
    return node.nodeType === 1 && node.classList.contains('expand-toggle');
  }

  function liveSameAttrs(a, b) {
    if (a.attributes.length !== b.attributes.length) return false;
    for (var i = 0; i < b.attributes.length; i++) {
      var at = b.attributes[i];
      if (at.name !== 'class' && a.getAttribute(at.name) !== at.value) return false;
    }
    return true;
  }

  function liveSyncAttrs(a, b) {
    for (var i = a.attributes.length - 1; i >= 0; i--) {
      var name = a.attributes[i].name;
      if (!b.hasAttribute(name)) a.removeAttribute(name);
    }
    for (var j = 0; j < b.attributes.length; j++) {
      var at = b.attributes[j];
      if (at.name === 'class') continue;
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
    var cls = b.getAttribute('class');
    if (cls == null) return;
    var keep = LIVE_ONLY_CLASSES.filter(function(c) { return a.classList.contains(c) && !b.classList.contains(c); });
    var next = keep.length ? cls + ' ' + keep.join(' ') : cls;
    if (a.getAttribute('class') !== next) a.setAttribute('class', next);
  }

  // Can node a (live) stand in for node b (fresh) and be patched toward it?
  function liveCanMorph(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return a.nodeType === 3;
    if (a.tagName !== b.tagName || a.id !== b.id || a.tagName === 'CANVAS') return false;
    if (a._tqOn || b._tqOn) return !!(a._tqOn && b._tqOn) && liveSameAttrs(a, b);
    return true;
  }

  // Patch live element a in place until it renders like fresh element b.
  // Nodes of b are moved into a where a has nothing to keep.
  function liveMorph(a, b) {
    liveSyncAttrs(a, b);
    var cur = a.firstChild;
    var next = b.firstChild;
    while (next) {
      var after = next.nextSibling;
      if (!cur) {
        a.appendChild(next);
      } else if (cur.nodeType === 1 && next.nodeType === 1 && !cur._tqOn === !next._tqOn && cur.isEqualNode(next)) {
        cur = cur.nextSibling;
        while (cur && liveIsToggle(cur)) cur = cur.nextSibling;
      } else if (liveCanMorph(cur, next)) {
        if (cur.nodeType === 3) {
          if (cur.data !== next.data) cur.data = next.data;
        } else {
          liveMorph(cur, next);
        }
        cur = cur.nextSibling;
        while (cur && liveIsToggle(cur)) cur = cur.nextSibling;
      } else {
        var stale = cur;
        cur = cur.nextSibling;
        a.replaceChild(next, stale);
        // The replaced node's "show more" toggle goes with it.
        while (cur && liveIsToggle(cur)) {
          var toggle = cur;
          cur = cur.nextSibling;
          a.removeChild(toggle);
        }
      }
      next = after;
    }
    while (cur) {
      var gone = cur;
      cur = cur.nextSibling;
      a.removeChild(gone);
    }
  }

  function liveHasHandlers(el) {
    if (el._tqOn) return true;
    var all = el.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) if (all[i]._tqOn) return true;
    return false;
  }

  // Would liveMorph(a, b) only patch attributes and text in place, never
  // inserting, replacing or removing a node? Handler elements must also keep
  // their attributes: a kept handler then still matches its data.
  function liveSameShape(a, b) {
    if (!liveCanMorph(a, b)) return false;
    if (a.nodeType !== 1) return true;
    if ((a._tqOn || b._tqOn) && !liveSameAttrs(a, b)) return false;
    var cur = a.firstChild;
    var next = b.firstChild;
    while (next) {
      while (cur && liveIsToggle(cur)) cur = cur.nextSibling;
      if (!cur || !liveSameShape(cur, next)) return false;
      cur = cur.nextSibling;
      next = next.nextSibling;
    }
    while (cur && liveIsToggle(cur)) cur = cur.nextSibling;
    return !cur;
  }

  function liveNodePath(root, node) {
    var path = [];
    while (node && node !== root) {
      var parent = node.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
      node = parent;
    }
    return node === root ? path : null;
  }

  function liveNodeLength(node) {
    return node.nodeType === 3 ? node.data.length : node.childNodes.length;
  }

  function liveSelectionPoint(root, node, offset) {
    if (!node || !root.contains(node)) return null;
    var parent = node.parentNode;
    return {
      node: node,
      offset: offset,
      atEnd: offset > 0 && offset >= liveNodeLength(node),
      path: liveNodePath(root, node),
      type: node.nodeType,
      text: node.nodeType === 3 ? node.data : null,
      parentClass: parent && parent.nodeType === 1 ? parent.getAttribute('class') : null,
    };
  }

  // The reader's text selection inside root, to be put back after a patch.
  function liveSaveSelection(root) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    var anchor = liveSelectionPoint(root, sel.anchorNode, sel.anchorOffset);
    var focus = liveSelectionPoint(root, sel.focusNode, sel.focusOffset);
    return anchor && focus ? { anchor: anchor, focus: focus } : null;
  }

  // A kept node keeps its spot (a rewritten text node's boundary is clamped,
  // or moved to its new end when it was at the end); a node that was swapped
  // out is found again by its path in the fresh tree, when that is the same
  // text, or a text node under the same kind of element.
  function liveResolvePoint(root, p) {
    var node = p.node;
    if (!node.isConnected || !root.contains(node)) {
      node = root;
      for (var i = 0; p.path && node && i < p.path.length; i++) node = node.childNodes[p.path[i]];
      if (!p.path || !node || node.nodeType !== p.type) return null;
      if (p.type === 3 && node.data !== p.text) {
        var parent = node.parentNode;
        if (!parent || parent.nodeType !== 1 || parent.getAttribute('class') !== p.parentClass) return null;
      }
    }
    var len = liveNodeLength(node);
    return { node: node, offset: p.atEnd ? len : Math.min(p.offset, len) };
  }

  function liveRestoreSelection(root, saved) {
    if (!saved) return;
    var anchor = liveResolvePoint(root, saved.anchor);
    var focus = liveResolvePoint(root, saved.focus);
    if (!anchor || !focus) return;
    var sel = window.getSelection();
    if (sel.rangeCount && sel.anchorNode === anchor.node && sel.anchorOffset === anchor.offset &&
        sel.focusNode === focus.node && sel.focusOffset === focus.offset) return;
    try { sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset); } catch (e) { /* node gone */ }
  }
`;

export const LIVE_UPDATE_JS = LIVE_MORPH_JS + `
  function liveFieldKey(el, i) {
    return el.id || el.name || el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.tagName + ':' + i);
  }

  // What the reader is looking at: the text they selected when it is in
  // view, then elements of #app down the viewport from its top (below any
  // fixed bar). The first one a patch keeps is put back where it was, so the
  // visible text does not move.
  function liveViewAnchors() {
    var anchors = [];
    var sel = window.getSelection ? window.getSelection() : null;
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      var node = sel.getRangeAt(0).startContainer;
      var selEl = node.nodeType === 1 ? node : node.parentElement;
      if (selEl && app.contains(selEl)) {
        var r = selEl.getBoundingClientRect();
        if (r.bottom > 0 && r.top < window.innerHeight) anchors.push({ el: selEl, top: r.top });
      }
    }
    var x = app.getBoundingClientRect().left + Math.min(200, app.clientWidth / 2);
    for (var y = 60; y < window.innerHeight; y += 80) {
      var el = document.elementFromPoint(x, y);
      if (el && el !== app && app.contains(el)) anchors.push({ el: el, top: el.getBoundingClientRect().top });
    }
    return anchors;
  }

  // An instant jump (html scrolls smoothly); with no anchor left, keep the
  // scroll offset.
  function liveRestoreView(scroller, scrollTop, anchors) {
    var target = scrollTop;
    for (var i = 0; i < anchors.length; i++) {
      if (!anchors[i].el.isConnected) continue;
      target = scroller.scrollTop + anchors[i].el.getBoundingClientRect().top - anchors[i].top;
      break;
    }
    if (Math.abs(scroller.scrollTop - target) >= 1) scroller.scrollTo({ top: target, behavior: 'instant' });
  }

  // Patch #app toward a fresh render of every section (facts hnr6, hnr7).
  function renderInPlace() {
    chaptersCache = null;
    var fresh = SECTION_RENDERERS.map(function(renderSection) { return renderSection(); });
    var live = app.children;
    if (live.length !== fresh.length) {
      app.innerHTML = '';
      fresh.forEach(function(section) { app.appendChild(section); });
      return;
    }
    for (var i = 0; i < fresh.length; i++) {
      var old = live[i];
      var section = fresh[i];
      if ((section.classList.contains('chapters') || section.classList.contains('sv-chapters')) && old.className === section.className) {
        liveMorph(old, section);
        continue;
      }
      var canvases = section.getElementsByTagName('canvas');
      if (!canvases.length && old.outerHTML === section.outerHTML) continue;
      if (!canvases.length && !old.getElementsByTagName('canvas').length && old.tagName === section.tagName &&
          ((!liveHasHandlers(old) && !liveHasHandlers(section)) || liveSameShape(old, section))) {
        liveMorph(old, section);
        continue;
      }
      // A canvas gets its drawn height a tick after insertion: start it at
      // the height the one it replaces was drawn at, so nothing below jumps.
      var oldCanvases = old.getElementsByTagName('canvas');
      for (var c = 0; c < canvases.length && c < oldCanvases.length; c++) {
        if (!canvases[c].style.height && oldCanvases[c].style.height) canvases[c].style.height = oldCanvases[c].style.height;
      }
      app.replaceChild(section, old);
    }
  }

  window.__tqViewApplySession = function(fresh) {
    if (!fresh || !Array.isArray(fresh.events)) return;
    var scroller = document.scrollingElement || document.documentElement;
    var scrollTop = scroller.scrollTop;
    var anchors = liveViewAnchors();
    var fields = {};
    var all = app.querySelectorAll('input, textarea, select');
    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      fields[liveFieldKey(f, i)] = { value: f.value, checked: f.checked };
    }
    var active = document.activeElement;
    var activeKey = null;
    var selStart = null;
    var selEnd = null;
    if (active && active !== document.body && app.contains(active)) {
      var idx = Array.prototype.indexOf.call(all, active);
      if (idx >= 0) {
        activeKey = liveFieldKey(active, idx);
        try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) { /* not a text field */ }
      }
    }

    for (var k in session) {
      if (Object.prototype.hasOwnProperty.call(session, k) && k !== 'events' && !Object.prototype.hasOwnProperty.call(fresh, k)) delete session[k];
    }
    for (var k2 in fresh) {
      if (Object.prototype.hasOwnProperty.call(fresh, k2) && k2 !== 'events') session[k2] = fresh[k2];
    }
    // events is aliased by a closure const: replace its contents in place.
    events.length = 0;
    for (var e = 0; e < fresh.events.length; e++) events.push(fresh.events[e]);

    var selection = liveSaveSelection(app);
    renderInPlace();
    liveRestoreSelection(app, selection);
    afterRender();

    // A section that changed was swapped: carry its fields over.
    var now = app.querySelectorAll('input, textarea, select');
    for (var j = 0; j < now.length; j++) {
      var g = now[j];
      var saved = fields[liveFieldKey(g, j)];
      if (!saved) continue;
      if (g.type === 'checkbox' || g.type === 'radio') g.checked = saved.checked;
      else if (g.value !== saved.value) g.value = saved.value;
      if (activeKey && document.activeElement !== g && liveFieldKey(g, j) === activeKey) {
        g.focus({ preventScroll: true });
        if (selStart !== null) { try { g.setSelectionRange(selStart, selEnd); } catch (e2) { /* not a text field */ } }
      }
    }
    liveRestoreView(scroller, scrollTop, anchors);
    // Canvases draw and "show more" toggles attach after this; settle again
    // unless the reader scrolled in the meantime.
    var settled = scroller.scrollTop;
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        if (scroller.scrollTop === settled) liveRestoreView(scroller, settled, anchors);
      });
    });
  };
`;

/**
 * Served-page refresher for /view (fact hnr3): on a data-update it asks
 * /api/view-session whether THIS recording changed (one stat when it did
 * not) and applies a newer parse in place. Never reloads the document.
 */
export function viewLiveRefreshScript(etag) {
  const initial = JSON.stringify(String(etag || "")).replace(/</g, "\\u003c");
  return `<script>(function(){var etag=${initial},busy=false,again=false;function query(){var p=new URLSearchParams(location.search),o=new URLSearchParams();["path","id","source"].forEach(function(k){var v=p.get(k);if(v)o.set(k,v)});o.set("etag",etag);return o.toString()}function run(){if(busy){again=true;return}if(typeof window.__tqViewApplySession!=="function")return;busy=true;fetch("/api/view-session?"+query(),{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;if(d.etag)etag=d.etag;if(!d.unchanged&&d.session)window.__tqViewApplySession(d.session)}).catch(function(){}).then(function(){busy=false;if(again){again=false;run()}})}window._refreshData=run})();</script>`;
}

/**
 * Served-page refresher for /compare (facts hnr4, hnr8): when either compared
 * recording changed (one stat each via /api/view-session&check=1), fetch the
 * same URL and morph .container toward the fresh render: unchanged nodes stay
 * in the document and changed text is rewritten in its own text node, so a
 * text selection and the scroll position survive. The comparison is static
 * markup (no element handlers). The command palette overlay sits outside
 * .container and is untouched.
 */
export function compareLiveRefreshScript(etagA, etagB) {
  const etags = JSON.stringify({ a: String(etagA || ""), b: String(etagB || "") }).replace(/</g, "\\u003c");
  return `<script type="application/json" id="tq-compare-etags">${etags}</script><script>(function(){${LIVE_MORPH_JS}
var busy=false,again=false;function etags(doc){try{return JSON.parse(doc.getElementById("tq-compare-etags").textContent)}catch(e){return{}}}var current=etags(document);function changed(side){var p=new URLSearchParams(location.search),h=p.get(side);if(!h)return Promise.resolve(false);var o=new URLSearchParams();o.set("path",h);var src=p.get(side==="a"?"sa":"sb");if(src)o.set("source",src);o.set("etag",current[side]||"");o.set("check","1");return fetch("/api/view-session?"+o.toString(),{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(d){return!!(d&&!d.unchanged)})}function run(){if(busy){again=true;return}busy=true;Promise.all([changed("a"),changed("b")]).then(function(c){if(!c[0]&&!c[1])return;return fetch(location.href,{cache:"no-store"}).then(function(r){return r.ok?r.text():null}).then(function(html){if(!html)return;var doc=new DOMParser().parseFromString(html,"text/html");var next=doc.querySelector(".container"),cur=document.querySelector(".container");if(!next||!cur)return;var sc=document.scrollingElement||document.documentElement,y=sc.scrollTop;var sel=liveSaveSelection(cur);liveMorph(cur,next);liveRestoreSelection(cur,sel);current=etags(doc);if(Math.abs(sc.scrollTop-y)>=1)sc.scrollTo({top:y,behavior:"instant"})})}).catch(function(){}).then(function(){busy=false;if(again){again=false;run()}})}window._refreshData=run})();</script>`;
}
