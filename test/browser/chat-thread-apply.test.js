/**
 * Incremental thread reconcile — existing nodes keep object identity.
 * Fact anchor: ciin.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyThreadItems } from "../../src/browser/chat-thread-apply.js";

function createEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: "",
    innerHTML: "",
    _tqHtml: undefined,
    attrs: Object.create(null),
    children: [],
    parentNode: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
  };
  return el;
}

function createContainer() {
  const container = createEl("div");
  Object.defineProperty(container, "lastChild", {
    get() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
  });
  container.insertBefore = function insertBefore(node, ref) {
    if (node.parentNode === this) {
      const from = this.children.indexOf(node);
      if (from >= 0) this.children.splice(from, 1);
    } else if (node.parentNode && typeof node.parentNode.removeChild === "function") {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    if (ref == null) {
      this.children.push(node);
    } else {
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, node);
    }
    return node;
  };
  container.removeChild = function removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  };
  return container;
}

describe("incremental thread apply — applyThreadItems reconcile", () => {
  test("first paint creates keyed message nodes without assigning container.innerHTML", () => {
    const prev = global.document;
    global.document = { createElement: createEl };
    try {
      const root = createContainer();
      const assigned = [];
      Object.defineProperty(root, "innerHTML", {
        configurable: true,
        get() { return ""; },
        set(v) { assigned.push(v); },
      });
      applyThreadItems(root, [
        { key: "user:0", role: "user", className: "chat-user chat-message", innerHTML: "hello" },
        { key: "text:1", role: "assistant", className: "chat-assistant chat-message", innerHTML: "<p>hi</p>" },
      ]);
      assert.equal(assigned.length, 0, "never assigns the thread container innerHTML");
      assert.equal(root.children.length, 2);
      assert.equal(root.children[0].getAttribute("data-role"), "user");
      assert.equal(root.children[0].getAttribute("data-block-key"), "user:0");
      assert.equal(root.children[0].getAttribute("data-message-id"), "user:0");
      assert.equal(root.children[0].className, "chat-user chat-message");
      assert.equal(root.children[0].innerHTML, "hello");
      assert.equal(root.children[1].getAttribute("data-role"), "assistant");
      applyThreadItems(root, [
        { key: "user:0", role: "user", className: "chat-user chat-message", innerHTML: "hello", eventIndex: 0 },
        { key: "text:1", role: "assistant", className: "chat-assistant chat-message", innerHTML: "<p>hi</p>", eventIndex: 1 },
      ]);
      assert.equal(root.children[0].getAttribute("data-event-index"), "0");
      assert.equal(root.children[1].getAttribute("data-event-index"), "1");
    } finally {
      global.document = prev;
    }
  });

  test("append keeps prior nodes as the same objects and adds a newcomer", () => {
    const prev = global.document;
    global.document = { createElement: createEl };
    try {
      const root = createContainer();
      applyThreadItems(root, [
        { key: "user:0", role: "user", className: "chat-user chat-message", innerHTML: "hello" },
      ]);
      const first = root.children[0];
      applyThreadItems(root, [
        { key: "user:0", role: "user", className: "chat-user chat-message", innerHTML: "hello" },
        { key: "text:1", role: "assistant", className: "chat-assistant chat-message tool-card-host", innerHTML: "BAR_NEW" },
      ]);
      assert.equal(root.children.length, 2);
      assert.equal(root.children[0], first, "existing user bubble is the same element");
      assert.equal(first.getAttribute("data-block-key"), "user:0");
      assert.equal(root.children[1].innerHTML, "BAR_NEW");
    } finally {
      global.document = prev;
    }
  });

  test("in-place content growth updates innerHTML without replacing the node", () => {
    const prev = global.document;
    global.document = { createElement: createEl };
    try {
      const root = createContainer();
      applyThreadItems(root, [
        { key: "text:0", role: "assistant", className: "chat-assistant chat-message", innerHTML: "Hel" },
      ]);
      const node = root.children[0];
      applyThreadItems(root, [
        { key: "text:0", role: "assistant", className: "chat-assistant chat-message", innerHTML: "Hello world" },
      ]);
      assert.equal(root.children[0], node);
      assert.equal(node.innerHTML, "Hello world");
    } finally {
      global.document = prev;
    }
  });

  test("inserting a marker before existing tool cards keeps those cards", () => {
    const prev = global.document;
    global.document = { createElement: createEl };
    try {
      const root = createContainer();
      applyThreadItems(root, [
        { key: "tool:a", role: "tool", className: "chat-card tool-card", innerHTML: "rg" },
        { key: "tool:b", role: "tool", className: "chat-card tool-card", innerHTML: "find" },
      ]);
      const a = root.children[0];
      const b = root.children[1];
      applyThreadItems(root, [
        { key: "explore:0", role: "marker", className: "chat-marker", innerHTML: "Explored 2 searches" },
        { key: "tool:a", role: "tool", className: "chat-card tool-card", innerHTML: "rg" },
        { key: "tool:b", role: "tool", className: "chat-card tool-card", innerHTML: "find" },
      ]);
      assert.equal(root.children.length, 3);
      assert.equal(root.children[1], a);
      assert.equal(root.children[2], b);
      assert.equal(root.children[0].getAttribute("data-role"), "marker");
    } finally {
      global.document = prev;
    }
  });

  test("dropping a trailing node removes only that node", () => {
    const prev = global.document;
    global.document = { createElement: createEl };
    try {
      const root = createContainer();
      applyThreadItems(root, [
        { key: "user:0", role: "user", className: "chat-user chat-message", innerHTML: "q" },
        { key: "text:1", role: "assistant", className: "chat-assistant chat-message", innerHTML: "a" },
      ]);
      const user = root.children[0];
      applyThreadItems(root, [
        { key: "user:0", role: "user", className: "chat-user chat-message", innerHTML: "q" },
      ]);
      assert.equal(root.children.length, 1);
      assert.equal(root.children[0], user);
    } finally {
      global.document = prev;
    }
  });
});
