import { CORE_SHELL_JS } from "./render-core-shell.js";
import { FORM_FIELD_GUARD_SRC } from "../browser/is-form-field.js";

export const CORE_JS = `  ${FORM_FIELD_GUARD_SRC}
  const app = document.getElementById('app');
  const session = SESSION;
  const events = session.events;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('embed') === '1') {
    document.body.classList.add('embed-view');
    function bindEmbedPeekHotkeys() {
      if (window.parent === window) return;
      installPageHotkey('tqHotkeyEmbedNext', 'j,J,ArrowDown', function() {
        if (window.parent === window) return;
        window.parent.postMessage({ type: 'tq-flyout', action: 'next' }, location.origin);
      });
      installPageHotkey('tqHotkeyEmbedPrev', 'k,K,ArrowUp', function() {
        if (window.parent === window) return;
        window.parent.postMessage({ type: 'tq-flyout', action: 'prev' }, location.origin);
      });
    }
    bindEmbedPeekHotkeys();
    document.addEventListener('keydown', function(e) {
      if (window.parent === window) return;
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        window.parent.postMessage({ type: 'tq-flyout', action: 'cmdk' }, location.origin);
        return;
      }
      if (e.key !== 'Escape') return;
      if (isFormField(e.target)) return;
      e.preventDefault();
      window.parent.postMessage({ type: 'tq-flyout', action: 'close' }, location.origin);
    });
  }

  let expandedSet = new Set();

  function jumpToChapter(idx) {
    var target = document.getElementById('chapter-' + idx);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('highlight');
    void target.offsetWidth;
    target.classList.add('highlight');
  }

  function setupHiDpiCanvas(canvas, logicalWidth, logicalHeight) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = logicalWidth * dpr;
    canvas.height = logicalHeight * dpr;
    canvas.style.height = logicalHeight + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    return ctx;
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        const v = attrs[k];
        if (k === 'className') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
      }
    }
    children.flat().forEach(c => {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
${CORE_SHELL_JS}
  const TOOL_COLORS = {
    Bash:       '#59d4a0',
    Edit:       '#e0c45e',
    Write:      '#d89660',
    Read:       '#6ba4e8',
    Agent:      '#a78bfa',
    Grep:       '#7a7a85',
    Glob:       '#7a7a85',
    Skill:      '#c88abd',
    WebFetch:   '#6ba4e8',
    WebSearch:  '#6ba4e8',
    ToolSearch: '#7a7a85',
    SemanticSearch: '#7a7a85',
    Delete:     '#f07070',
    Await:      '#8b8b92',
    Ask:        '#6ba4e8',
    CallMcpTool: '#5dadec',
    _mcp:       '#5dadec',
    _text:      '#a78bfa',
    _user:      '#6ba4e8',
    _error:     '#f07070',
  };
  function getToolColor(name) {
    if (TOOL_COLORS[name]) return TOOL_COLORS[name];
    if (typeof name === 'string' && name.startsWith('mcp__')) return TOOL_COLORS._mcp;
    return TOOL_COLORS._text;
  }

`;