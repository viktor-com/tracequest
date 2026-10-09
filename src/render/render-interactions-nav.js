/** Chapter tooltips and keyboard navigation (injected into session viewer bundle). */
import { FORM_FIELD_GUARD_SRC } from "../browser/is-form-field.js";

export const INTERACTIONS_NAV_JS = `
  ${FORM_FIELD_GUARD_SRC}
  const TOOL_DOT_COLORS = {
    Bash: 'var(--hue-bash)', Read: 'var(--hue-read)', Edit: 'var(--hue-edit)', Write: 'var(--hue-edit)',
    Agent: 'var(--hue-agent)', Grep: 'var(--hue-grep)', Skill: 'var(--hue-agent)', WebSearch: 'var(--hue-web)',
    WebFetch: 'var(--hue-web)', TaskCreate: 'var(--hue-agent)',
    SemanticSearch: 'var(--hue-grep)', Delete: 'var(--bad)', Await: 'var(--hue-other)',
    Ask: 'var(--hue-web)', CallMcpTool: 'var(--hue-web)'
  };

  var tooltipEl = null;
  var tooltipTimer = null;
  var tooltipVisible = false;

  function getTooltipEl() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'chapter-tooltip';
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function showChapterTooltip(chapterIdx, anchorEl) {
    var chapters = getChapters();
    var ch = chapters[chapterIdx];
    if (!ch) return;

    var tip = getTooltipEl();
    var html = '';

    var promptRaw = ch.prompt || '';
    var promptNl = promptRaw.indexOf('\\n');
    var promptFirst = promptNl < 0 ? promptRaw : promptRaw.slice(0, promptNl);
    var promptLine = promptFirst.slice(0, 80);
    if (promptLine.length < promptFirst.length) promptLine += '...';
    html += '<div class="chapter-tooltip-prompt">' + esc(promptLine) + '</div>';

    var toolKeys = chapterToolKeys(ch);
    var toolNames = toolKeys.slice().sort(function(a, b) { return ch.toolCounts[b] - ch.toolCounts[a]; });
    if (toolNames.length > 0) {
      html += '<div class="chapter-tooltip-tools">';
      for (var i = 0; i < Math.min(toolNames.length, 8); i++) {
        var tColor = TOOL_DOT_COLORS[toolNames[i]] || (typeof toolNames[i] === 'string' && toolNames[i].startsWith('mcp__') ? 'var(--hue-web)' : 'var(--hue-other)');
        var tTitle = fmtMcpName(toolNames[i]);
        html += '<span class="chapter-tooltip-tool" style="background:' + tColor + '" title="' + esc(tTitle) + ' ' + ch.toolCounts[toolNames[i]] + '"></span>';
      }
      if (toolNames.length > 8) html += '<span style="color:var(--fg3);font-size:10px">+' + (toolNames.length - 8) + '</span>';
      html += '</div>';
    }

    if (ch.errors > 0) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">errors</span><span class="chapter-tooltip-value errors">' + ch.errors + '</span></div>';
    }

    var filePaths = chapterFileKeys(ch);
    if (filePaths.length > 0) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">files</span><span class="chapter-tooltip-value">' + filePaths.length + ' file' + (filePaths.length !== 1 ? 's' : '') + '</span></div>';
      html += '<div class="chapter-tooltip-files">';
      for (var fi = 0; fi < Math.min(filePaths.length, 3); fi++) {
        var short = shortToolPath(filePaths[fi]);
        html += '<div class="chapter-tooltip-file">' + esc(short) + '</div>';
      }
      if (filePaths.length > 3) html += '<div class="chapter-tooltip-file" style="color:var(--fg3)">+' + (filePaths.length - 3) + ' more</div>';
      html += '</div>';
    }

    if (ch.mcpOps.length > 0) {
      var mcpServers = {};
      for (var mti = 0; mti < ch.mcpOps.length; mti++) { mcpServers[ch.mcpOps[mti].server] = (mcpServers[ch.mcpOps[mti].server] || 0) + 1; }
      var mcpSummary = '';
      var mcpFirst = true;
      for (var srv in mcpServers) {
        if (!Object.prototype.hasOwnProperty.call(mcpServers, srv)) continue;
        if (!mcpFirst) mcpSummary += ', ';
        mcpFirst = false;
        mcpSummary += srv.replace(/_/g, ' ') + ' \\u00d7' + mcpServers[srv];
      }
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">MCP</span><span class="chapter-tooltip-value" style="color:var(--hue-web)">' + esc(mcpSummary) + '</span></div>';
    }

    var endMs = new Date(ch.endTimestamp).getTime();
    var startMs = new Date(ch.timestamp).getTime();
    var dur = endMs - startMs;
    if (dur > 1000) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">duration</span><span class="chapter-tooltip-value">' + formatDuration(dur) + '</span></div>';
    }
    var totalTok = ch.tokens.input + ch.tokens.output;
    if (totalTok > 0) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">tokens</span><span class="chapter-tooltip-value">' + fmtTokens(totalTok) + '</span></div>';
    }

    if (ch.deps && ch.deps.fixesFrom.length > 0) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">fixes</span><span class="chapter-tooltip-value" style="color:var(--green)">ch ' + ch.deps.fixesFrom.map(function(r){return r+1;}).join(', ') + '</span></div>';
    } else if (ch.deps && ch.deps.continuesFrom.length > 0) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">continues</span><span class="chapter-tooltip-value" style="color:var(--accent)">ch ' + ch.deps.continuesFrom.map(function(r){return r+1;}).join(', ') + '</span></div>';
    }

    var outcome = ch.outcome || 'clean';
    html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">quality</span><span class="chapter-tooltip-value ' + outcome + '">' + outcome + '</span></div>';

    if (ch.efficiency && ch.efficiency.isWasteful) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">efficiency</span><span class="chapter-tooltip-value" style="color:var(--orange)">' + ch.efficiency.score + '/100 \\u26a0</span></div>';
    } else if (ch.efficiency && ch.efficiency.score < 70) {
      html += '<div class="chapter-tooltip-row"><span class="chapter-tooltip-label">efficiency</span><span class="chapter-tooltip-value" style="color:var(--fg2)">' + ch.efficiency.score + '/100</span></div>';
    }

    tip.innerHTML = html;

    var rect = anchorEl.getBoundingClientRect();
    var tipW = 300;
    var tipH = tip.offsetHeight || 150;

    var left = rect.left + 40;
    var top = rect.bottom + 6;

    if (left + tipW > window.innerWidth - 16) {
      left = window.innerWidth - tipW - 16;
    }
    if (left < 8) left = 8;
    if (top + tipH > window.innerHeight - 16) {
      top = rect.top - tipH - 6;
    }

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.add('visible');
    tooltipVisible = true;
  }

  function hideChapterTooltip() {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    if (tooltipEl) {
      tooltipEl.classList.remove('visible');
    }
    tooltipVisible = false;
  }

  function attachChapterTooltips() {
    var chapterEls = document.querySelectorAll('.chapter');
    chapterEls.forEach(function(el) {
      var idx = parseInt(el.id.replace('chapter-', ''), 10);
      if (isNaN(idx)) return;

      el.addEventListener('mouseenter', function() {
        if (el.classList.contains('expanded')) return;
        tooltipTimer = setTimeout(function() {
          if (!el.classList.contains('expanded')) {
            showChapterTooltip(idx, el);
          }
        }, 300);
      });

      el.addEventListener('mouseleave', function() {
        hideChapterTooltip();
      });
    });
  }

  window.addEventListener('scroll', function() {
    if (tooltipVisible) hideChapterTooltip();
  }, { passive: true });

  let focusedChapterIdx = -1;

  function getVisibleChapterIndices() {
    var chapters = getChapters();
    var visible = [];
    for (var i = 0; i < chapters.length; i++) {
      var el = document.getElementById('chapter-' + i);
      if (el && !el.classList.contains('filter-hidden')) visible.push(i);
    }
    return visible;
  }

  function setFocusedChapter(idx) {
    if (focusedChapterIdx >= 0) {
      var prev = document.getElementById('chapter-' + focusedChapterIdx);
      if (prev) prev.classList.remove('kb-focused');
    }
    focusedChapterIdx = idx;
    if (idx >= 0) {
      var el = document.getElementById('chapter-' + idx);
      if (el) {
        el.classList.add('kb-focused');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  function clearFocus() {
    if (focusedChapterIdx >= 0) {
      var prev = document.getElementById('chapter-' + focusedChapterIdx);
      if (prev) prev.classList.remove('kb-focused');
    }
    focusedChapterIdx = -1;
  }

  // Native Enter/Space activation — do not steal Enter from these while a chapter is kb-focused.
  function isActionControl(el) {
    if (!el) return false;
    var name = (el.tagName || '').toLowerCase();
    if (name === 'button' || name === 'a' || name === 'summary' || name === 'canvas') return true;
    var role = '';
    if (typeof el.getAttribute === 'function') role = (el.getAttribute('role') || '').toLowerCase();
    return role === 'button' || role === 'link' || role === 'menuitem';
  }

  function toggleFocusedChapter() {
    if (focusedChapterIdx < 0) return false;
    var key = 'ch' + focusedChapterIdx;
    if (expandedSet.has(key)) {
      expandedSet.delete(key);
      clearChapterHash();
    } else {
      expandedSet.add(key);
      setChapterHash(focusedChapterIdx);
    }
    render();
    requestAnimationFrame(function() {
      setFocusedChapter(focusedChapterIdx);
    });
    return true;
  }

  function stepChapter(down) {
    var visible = getVisibleChapterIndices();
    if (!visible.length) return;
    if (focusedChapterIdx < 0) {
      setFocusedChapter(down ? visible[0] : visible[visible.length - 1]);
      return;
    }
    var currentPos = visible.indexOf(focusedChapterIdx);
    if (currentPos < 0) {
      setFocusedChapter(visible[0]);
      return;
    }
    var nextPos = down ? currentPos + 1 : currentPos - 1;
    if (nextPos >= 0 && nextPos < visible.length) {
      setFocusedChapter(visible[nextPos]);
    }
  }

  // Slash-to-search is independent of whether any chapter is visible.
  // Served pages own / via #workspaceSearch; standalone export still
  // focuses chapter search when that bar is absent.
  if (!document.getElementById('workspaceSearch')) {
    var chapterSearch = document.querySelector('.filter-search');
    if (chapterSearch) {
      if (typeof chapterSearch.getAttribute === 'function' && !chapterSearch.getAttribute('data-hotkey')) {
        chapterSearch.setAttribute('data-hotkey', '/');
      }
      install(chapterSearch);
    }
  }
  installPageHotkey('tqHotkeyChapterNext', 'j,J', function() { stepChapter(true); });
  installPageHotkey('tqHotkeyChapterPrev', 'k,K', function() { stepChapter(false); });
  installPageHotkey('tqHotkeyChapterOpen', 'o,O', function() { toggleFocusedChapter(); });

  document.addEventListener('keydown', function(ev) {
    if (document.body && document.body.classList && document.body.classList.contains('cmdk-open')) return;
    var searchInput = document.querySelector('.filter-search');
    var isInSearch = document.activeElement === searchInput;
    var editing = isFormField(ev.target) || isFormField(document.activeElement);

    if (ev.key === 'Escape') {
      if (isInSearch) {
        searchInput.blur();
        if (searchQuery) {
          searchQuery = '';
          searchInput.value = '';
          applyFilters();
        }
        clearFocus();
        return;
      }
      if (editing) return;
      clearFocus();
      return;
    }

    if (isInSearch || editing) return;

    if (ev.key === 'Enter') {
      if (isActionControl(ev.target || document.activeElement)) return;
      if (toggleFocusedChapter()) ev.preventDefault();
    }
  });
`;