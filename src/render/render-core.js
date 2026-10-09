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

  /**
   * Canvas cannot read CSS variables, so charts draw from this palette. It
   * starts with the dark design tokens and is re-resolved from the live
   * theme (refreshChartPalette) before each render; a theme switch redraws.
   */
  var CHART_PALETTE = {
    bg: 'rgba(0,0,0,0)', grid: 'rgba(237,236,236,0.07)', gridStrong: 'rgba(237,236,236,0.14)',
    label: 'rgba(237,236,236,0.45)', ink: 'rgba(237,236,236,0.62)', inkSoft: 'rgba(237,236,236,0.18)',
    active: '#c9b8a6', activeSoft: 'rgba(201,184,166,0.35)', idle: 'rgba(231,163,62,0.75)',
    accent: '#f54e00', accentSoft: 'rgba(245,78,0,0.28)', bad: '#ec5a7c', ok: '#3fae84'
  };
  function chartInk(key, fallback) {
    return (typeof CHART_PALETTE !== 'undefined' && CHART_PALETTE[key]) || fallback;
  }
  function refreshChartPalette() {
    try {
      if (typeof document === 'undefined' || typeof getComputedStyle !== 'function' || !document.body) return;
      var probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      function resolve(expr) {
        probe.style.color = '';
        probe.style.color = expr;
        var cs = getComputedStyle(probe);
        return cs && cs.color ? cs.color : '';
      }
      var map = {
        grid: 'var(--line-1)', gridStrong: 'var(--line-2)', label: 'var(--text-3)', ink: 'var(--text-2)',
        inkSoft: 'var(--line-3)', active: 'var(--text-3)', activeSoft: 'var(--line-2)',
        idle: 'var(--warn)', accent: 'var(--accent)', accentSoft: 'var(--accent-soft)', bad: 'var(--bad)', ok: 'var(--ok)'
      };
      for (var k in map) { var c = resolve(map[k]); if (c) CHART_PALETTE[k] = c; }
      if (typeof TOOL_COLORS !== 'undefined') {
        var tools = {
          Bash: '--hue-bash', Edit: '--hue-edit', Write: '--hue-edit', Read: '--hue-read', Agent: '--hue-agent',
          Grep: '--hue-grep', Glob: '--hue-grep', Skill: '--hue-agent', WebFetch: '--hue-web', WebSearch: '--hue-web',
          ToolSearch: '--hue-grep', SemanticSearch: '--hue-grep', Delete: '--bad', Await: '--hue-other', Ask: '--hue-web',
          CallMcpTool: '--hue-web', _mcp: '--hue-web', _text: '--text-3', _user: '--hue-read', _error: '--bad'
        };
        for (var t in tools) { var tc = resolve('var(' + tools[t] + ')'); if (tc) TOOL_COLORS[t] = tc; }
      }
      probe.remove();
    } catch (_) { /* keep the defaults */ }
  }
  if (typeof document !== 'undefined' && typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(function () {
      if (typeof render === 'function') render();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (typeof window !== 'undefined' && window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (typeof render === 'function') render(); });
    }
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
    Bash:       '#dfa88f',
    Edit:       '#c0a8dd',
    Write:      '#c0a8dd',
    Read:       '#9fbbe0',
    Agent:      '#e1c37a',
    Grep:       '#9fc9a2',
    Glob:       '#9fc9a2',
    Skill:      '#e1c37a',
    WebFetch:   '#8fc8d6',
    WebSearch:  '#8fc8d6',
    ToolSearch: '#9fc9a2',
    SemanticSearch: '#9fc9a2',
    Delete:     '#ec5a7c',
    Await:      '#8a877f',
    Ask:        '#8fc8d6',
    CallMcpTool: '#8fc8d6',
    _mcp:       '#8fc8d6',
    _text:      '#8a877f',
    _user:      '#9fbbe0',
    _error:     '#ec5a7c',
  };
  function getToolColor(name) {
    if (TOOL_COLORS[name]) return TOOL_COLORS[name];
    if (typeof name === 'string' && name.startsWith('mcp__')) return TOOL_COLORS._mcp;
    return TOOL_COLORS._text;
  }

`;