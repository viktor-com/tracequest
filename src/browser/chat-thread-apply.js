/**
 * Incremental chat-thread patch: keep existing message/tool-card nodes
 * (same element identity) and only create, update, reorder, or remove by
 * stable data-block-key. Never assigns container.innerHTML.
 *
 * Injected into the /run and /run?session= pages via Function#toString.
 *
 * @param {Element} container
 * @param {Array<{ key: string, role?: string, className?: string, innerHTML?: string }>} items
 */
export function applyThreadItems(container, items) {
  if (!container) return;
  items = items || [];
  var have = Object.create(null);
  var kids = container.children;
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i].getAttribute("data-block-key");
    if (k) have[k] = kids[i];
  }
  var next = [];
  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var key = String(item.key);
    var role = item.role || "";
    var className = item.className || "";
    var inner = item.innerHTML || "";
    var el = have[key];
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("data-block-key", key);
      el.setAttribute("data-role", role);
      el.setAttribute("data-message-id", key);
      el.className = className;
      el.innerHTML = inner;
      el._tqHtml = inner;
    } else {
      if (el.getAttribute("data-role") !== role) el.setAttribute("data-role", role);
      if (el.getAttribute("data-message-id") !== key) el.setAttribute("data-message-id", key);
      if (el.className !== className) el.className = className;
      if (el._tqHtml !== inner) {
        el.innerHTML = inner;
        el._tqHtml = inner;
      }
    }
    if (item.eventIndex != null && item.eventIndex !== "") {
      el.setAttribute("data-event-index", String(item.eventIndex));
    }
    next.push(el);
  }
  for (var n = 0; n < next.length; n++) {
    var want = next[n];
    var at = container.children[n];
    if (at !== want) container.insertBefore(want, at || null);
  }
  while (container.children.length > next.length) {
    container.removeChild(container.lastChild);
  }
}
