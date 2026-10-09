import { ANALYTICS_CHARTS_JS } from "./render-analytics-charts.js";

export const ANALYTICS_COMPOSE_JS = `
  function renderToolFlow() {
    const chapters = getChapters();

    const orderedSequence = [];
    let chIdx = -1;
    for (const e of events) {
      if (e.type === 'user' && e.text) {
        chIdx++;
      }
      if (e.type === 'assistant' && e.toolCalls && chIdx >= 0) {
        for (const tc of e.toolCalls) {
          orderedSequence.push({ tool: tc.name, chapterIdx: chIdx });
        }
      }
    }

    if (orderedSequence.length < 3) return h('div');

    const orderedBoundaries = new Set();
    let prevCh = -1;
    for (let i = 0; i < orderedSequence.length; i++) {
      if (orderedSequence[i].chapterIdx !== prevCh) {
        orderedBoundaries.add(i);
        prevCh = orderedSequence[i].chapterIdx;
      }
    }

    const toolTotals = {};
    for (const item of orderedSequence) {
      toolTotals[item.tool] = (toolTotals[item.tool] || 0) + 1;
    }

    const transitions = {};
    for (let i = 0; i < orderedSequence.length - 1; i++) {
      const from = orderedSequence[i].tool;
      const to = orderedSequence[i + 1].tool;
      if (orderedSequence[i].chapterIdx !== orderedSequence[i + 1].chapterIdx) continue;
      const key = from + '>' + to;
      transitions[key] = (transitions[key] || 0) + 1;
    }

    const sortedToolNames = [];
    for (const tool in toolTotals) {
      if (Object.prototype.hasOwnProperty.call(toolTotals, tool)) sortedToolNames.push(tool);
    }
    sortedToolNames.sort((a, b) => toolTotals[b] - toolTotals[a]);
    const numChapters = chapters.length;

    const wrap = h('div', { className: 'tool-flow' });
    wrap.appendChild(h('div', { className: 'tool-flow-header' }, 'tool usage flow'));

    const seqWrap = h('div', {
      className: 'tool-flow-sequence',
      role: 'list',
      'aria-label': 'Tool usage sequence by chapter'
    });
    const maxCells = 500;
    const step = orderedSequence.length > maxCells ? Math.ceil(orderedSequence.length / maxCells) : 1;
    for (let i = 0; i < orderedSequence.length; i += step) {
      if (orderedBoundaries.has(i) && i > 0) {
        seqWrap.appendChild(h('div', { className: 'tool-flow-divider', 'aria-hidden': 'true' }));
      }
      const item = orderedSequence[i];
      const color = getToolColor(item.tool);
      const displayName = fmtMcpName(item.tool);
      const cell = h('div', {
        className: 'tool-flow-cell',
        role: 'listitem',
        'aria-label': displayName + ' in chapter ' + (item.chapterIdx + 1),
        title: displayName + ' (ch ' + (item.chapterIdx + 1) + ')'
      });
      cell.style.background = color;
      seqWrap.appendChild(cell);
    }
    wrap.appendChild(seqWrap);

    const summaryGrid = h('div', { className: 'tool-flow-summary' });
    for (let ti = 0; ti < sortedToolNames.length && ti < 8; ti++) {
      const tool = sortedToolNames[ti];
      const count = toolTotals[tool];
      const color = getToolColor(tool);
      const avg = (count / numChapters).toFixed(1);
      const toolLabel = fmtMcpName(tool);
      const stat = h('div', { className: 'tool-flow-stat' },
        h('div', { className: 'tool-flow-stat-dot', style: 'background:' + color }),
        h('span', { className: 'tool-flow-stat-name' }, toolLabel),
        h('span', { className: 'tool-flow-stat-count' }, String(count)),
        h('span', { className: 'tool-flow-stat-avg' }, avg + '/ch')
      );
      summaryGrid.appendChild(stat);
    }
    wrap.appendChild(summaryGrid);

    const sortedTransitionKeys = [];
    for (const key in transitions) {
      if (Object.prototype.hasOwnProperty.call(transitions, key)) sortedTransitionKeys.push(key);
    }
    sortedTransitionKeys.sort((a, b) => transitions[b] - transitions[a]);
    if (sortedTransitionKeys.length > 0) {
      const transWrap = h('div', { className: 'tool-flow-transitions' });
      transWrap.appendChild(h('div', { className: 'tool-flow-transitions-label' }, 'common transitions'));
      const list = h('div', { className: 'tool-flow-transition-list' });
      for (let tri = 0; tri < sortedTransitionKeys.length && tri < 10; tri++) {
        const key = sortedTransitionKeys[tri];
        const count = transitions[key];
        const from = key.slice(0, key.indexOf('>'));
        const to = key.slice(key.indexOf('>') + 1);
        var fromLabel = fmtMcpName(from);
        var toLabel = fmtMcpName(to);
        list.appendChild(h('div', { className: 'tool-flow-transition' },
          h('span', { style: 'color:' + getToolColor(from) }, fromLabel),
          h('span', { className: 'tool-flow-transition-arrow' }, '→'),
          h('span', { style: 'color:' + getToolColor(to) }, toLabel),
          h('span', { className: 'tool-flow-transition-count' }, '×' + count)
        ));
      }
      transWrap.appendChild(list);
      wrap.appendChild(transWrap);
    }

    return wrap;
  }

  let toolPerfExpanded = false;
  let toolPerfSort = 'errors'; // 'errors' (most error-prone first) or 'usage' (most used first)
  let activeToolPerfFilter = null; // tool name being filtered on via click

  function renderToolPerformance() {
    const chapters = getChapters();

    const toolStats = {};
    for (const ch of chapters) {
      const toolKeys = chapterToolKeys(ch);
      for (let tki = 0; tki < toolKeys.length; tki++) {
        const tool = toolKeys[tki];
        const count = ch.toolCounts[tool];
        if (!toolStats[tool]) toolStats[tool] = { total: 0, errors: 0, retries: 0, chapters: 0 };
        toolStats[tool].total += count;
        toolStats[tool].chapters++;
      }
      for (const tool in ch.errorTools) {
        if (!Object.prototype.hasOwnProperty.call(ch.errorTools, tool)) continue;
        const count = ch.errorTools[tool];
        if (!toolStats[tool]) toolStats[tool] = { total: 0, errors: 0, retries: 0, chapters: 0 };
        toolStats[tool].errors += count;
      }
      for (const rg of (ch.retryGroups || [])) {
        if (!toolStats[rg.tool]) toolStats[rg.tool] = { total: 0, errors: 0, retries: 0, chapters: 0 };
        toolStats[rg.tool].retries += rg.count - 1;
      }
    }

    const toolStatNames = [];
    for (const name in toolStats) {
      if (Object.prototype.hasOwnProperty.call(toolStats, name)) toolStatNames.push(name);
    }
    if (toolStatNames.length < 2) return h('div');

    const entries = toolStatNames.map(function(name) { return [name, toolStats[name]]; });
    var sorted = sortToolPerfEntries(entries, toolPerfSort);

    var wrap = h('div', { className: 'tool-perf' + (toolPerfExpanded ? ' expanded' : '') });

    var totalCalls = 0;
    var totalErrors = 0;
    for (let tsi = 0; tsi < toolStatNames.length; tsi++) {
      const st = toolStats[toolStatNames[tsi]];
      totalCalls += st.total;
      totalErrors += st.errors;
    }
    var overallRate = totalCalls > 0 ? ((totalCalls - totalErrors) / totalCalls * 100).toFixed(0) : '100';
    var header = h('button', {
      className: 'tool-perf-header',
      type: 'button',
      'aria-expanded': toolPerfExpanded ? 'true' : 'false',
      'aria-controls': 'tool-perf-body',
      'aria-label': 'Toggle tool performance panel'
    });
    header.appendChild(h('span', { className: 'tool-perf-title' },
      'tool performance — ' + entries.length + ' tools, ' + overallRate + '% success'));
    header.appendChild(h('span', { className: 'tool-perf-toggle' },
      toolPerfExpanded ? '\\u25be' : '\\u25b8'));
    header.addEventListener('click', function(ev) {
      ev.stopPropagation();
      toolPerfExpanded = !toolPerfExpanded;
      wrap.classList.toggle('expanded');
      header.querySelector('.tool-perf-toggle').textContent = toolPerfExpanded ? '\\u25be' : '\\u25b8';
      header.setAttribute('aria-expanded', toolPerfExpanded ? 'true' : 'false');
    });
    wrap.appendChild(header);

    var body = h('div', { className: 'tool-perf-body', id: 'tool-perf-body' });

    var sortBar = h('div', { className: 'tool-perf-sort' });
    ['errors', 'usage'].forEach(function(mode) {
      var btn = h('button', {
        className: 'tool-perf-sort-btn' + (toolPerfSort === mode ? ' active' : ''),
        type: 'button',
        'aria-pressed': toolPerfSort === mode ? 'true' : 'false',
        'aria-label': 'Sort tool performance by ' + mode,
        onClick: function(ev) {
          ev.stopPropagation();
          toolPerfSort = mode;
          var newSorted = sortToolPerfEntries(entries, mode);
          rebuildToolPerfTable(newSorted);
          sortBar.querySelectorAll('.tool-perf-sort-btn').forEach(function(b) {
            b.classList.toggle('active', b.textContent === mode);
            b.setAttribute('aria-pressed', b.textContent === mode ? 'true' : 'false');
          });
        }
      }, mode);
      sortBar.appendChild(btn);
    });
    body.appendChild(sortBar);

    var table = h('div', { className: 'tool-perf-table', id: 'tool-perf-table' });

    for (var idx = 0; idx < sorted.length; idx++) {
      table.appendChild(buildToolPerfRow(sorted[idx][0], sorted[idx][1]));
    }
    body.appendChild(table);

    wrap.appendChild(body);
    return wrap;
  }

  let fileHotspotExpanded = false;
  let activeFileFilter = null; // path string or null

  function renderFileHotspot() {
    const chapters = getChapters();

    const fileMap = {};
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const fileKeys = chapterFileKeys(ch);
      for (let fki = 0; fki < fileKeys.length; fki++) {
        const path = fileKeys[fki];
        const info = ch.files[path];
        if (!fileMap[path]) fileMap[path] = { total: 0, ops: {}, chapters: new Set() };
        const fm = fileMap[path];
        fm.chapters.add(i);
        for (const op of info.ops) {
          fm.ops[op] = (fm.ops[op] || 0) + 1;
          fm.total++;
        }
      }
    }

    const filePaths = [];
    for (const path in fileMap) {
      if (Object.prototype.hasOwnProperty.call(fileMap, path)) filePaths.push(path);
    }
    if (filePaths.length < 2) return h('div');

    filePaths.sort((a, b) => fileMap[b].total - fileMap[a].total);
    const maxTouch = fileMap[filePaths[0]].total;
    const topFiles = filePaths.slice(0, 30).map(function(path) { return [path, fileMap[path]]; });
    const entries = filePaths.map(function(path) { return [path, fileMap[path]]; });

    const wrap = h('div', { className: 'file-hotspot' + (fileHotspotExpanded ? ' expanded' : '') });

    const header = h('button', {
      className: 'file-hotspot-header',
      type: 'button',
      'aria-expanded': fileHotspotExpanded ? 'true' : 'false',
      'aria-controls': 'file-hotspot-body',
      'aria-label': 'Toggle file hotspots panel',
      onClick: (ev) => {
        ev.stopPropagation();
        fileHotspotExpanded = !fileHotspotExpanded;
        wrap.classList.toggle('expanded');
        header.setAttribute('aria-expanded', fileHotspotExpanded ? 'true' : 'false');
        header.querySelector('.file-hotspot-toggle').textContent = fileHotspotExpanded ? '▾' : '▸';
      }
    });
    header.appendChild(h('span', { className: 'file-hotspot-toggle' }, fileHotspotExpanded ? '▾' : '▸'));
    header.appendChild(h('span', { className: 'file-hotspot-title' }, 'file hotspots'));
    header.appendChild(h('span', { className: 'file-hotspot-count' }, entries.length + ' files · ' + entries.reduce((s, e) => s + e[1].total, 0) + ' touches'));
    wrap.appendChild(header);

    const body = h('div', { className: 'file-hotspot-body', id: 'file-hotspot-body' });

    const bar = h('div', { className: 'file-hotspot-bar' });
    const totalTouches = entries.reduce((s, e) => s + e[1].total, 0);
    for (const [path, info] of topFiles.slice(0, 20)) {
      const pct = (info.total / totalTouches) * 100;
      if (pct < 0.5) continue;
      let maxOpName = '';
      let maxOpCount = 0;
      for (const op in info.ops) {
        if (!Object.prototype.hasOwnProperty.call(info.ops, op)) continue;
        if (info.ops[op] > maxOpCount) { maxOpCount = info.ops[op]; maxOpName = op; }
      }
      const opColors = { Read: 'var(--hue-read)', Edit: 'var(--hue-edit)', Write: 'var(--hue-bash)' };
      const color = opColors[maxOpName] || 'var(--hue-other)';
      const seg = h('div', { className: 'file-hotspot-bar-seg', title: path + ' (' + info.total + ')' });
      seg.style.width = pct + '%';
      seg.style.background = color;
      seg.style.opacity = String(0.5 + 0.5 * (info.total / maxTouch));
      bar.appendChild(seg);
    }
    body.appendChild(bar);

    const list = h('div', { className: 'file-hotspot-list' });
    for (const [path, info] of topFiles) {
      const isActive = activeFileFilter === path;
      const item = h('button', {
        className: 'file-hotspot-item' + (isActive ? ' active' : ''),
        type: 'button',
        'aria-pressed': isActive ? 'true' : 'false',
        'aria-label': 'Filter chapters touching ' + path,
        title: path + ' — ' + info.total + ' touches across ' + info.chapters.size + ' chapters',
        onClick: (ev) => {
          ev.stopPropagation();
          if (activeFileFilter === path) {
            activeFileFilter = null;
          } else {
            activeFileFilter = path;
          }
          applyFileFilter();
        }
      });

      const heatRatio = info.total / maxTouch;
      const hue = 220 - (heatRatio * 180);
      const sat = 60 + heatRatio * 30;
      const lum = 45 + heatRatio * 15;
      const dotSize = 6 + Math.round(heatRatio * 8);
      const dot = h('div', { className: 'file-hotspot-dot' });
      dot.style.background = 'hsl(' + hue + ',' + sat + '%,' + lum + '%)';
      dot.style.width = dotSize + 'px';
      dot.style.height = dotSize + 'px';
      dot.style.boxShadow = heatRatio > 0.5 ? '0 0 ' + Math.round(heatRatio * 6) + 'px hsl(' + hue + ',' + sat + '%,' + lum + '%)' : 'none';
      item.appendChild(dot);

      item.appendChild(h('span', { className: 'file-hotspot-path' }, path));

      const opsWrap = h('div', { className: 'file-hotspot-ops' });
      const opNames = [];
      for (const op in info.ops) {
        if (Object.prototype.hasOwnProperty.call(info.ops, op)) opNames.push(op);
      }
      opNames.sort((a, b) => info.ops[b] - info.ops[a]);
      for (let opi = 0; opi < opNames.length; opi++) {
        const op = opNames[opi];
        const count = info.ops[op];
        const cls = op.toLowerCase();
        opsWrap.appendChild(h('span', { className: 'file-hotspot-op ' + cls }, op[0] + count));
      }
      item.appendChild(opsWrap);

      const chList = [...info.chapters].sort((a, b) => a - b);
      const chStr = chList.length <= 4
        ? chList.map(c => c + 1).join(',')
        : chList.slice(0, 3).map(c => c + 1).join(',') + '…+' + (chList.length - 3);
      item.appendChild(h('span', { className: 'file-hotspot-chapters' }, 'ch ' + chStr));

      item.appendChild(h('span', { className: 'file-hotspot-touch' }, String(info.total)));

      list.appendChild(item);
    }
    body.appendChild(list);

    if (entries.length > 30) {
      body.appendChild(h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:6px;padding-left:10px;' }, '… ' + (entries.length - 30) + ' more files'));
    }

    wrap.appendChild(body);
    return wrap;
  }

  function renderGitTimeline() {
    const chapters = getChapters();
    const allGitOps = [];
    for (let i = 0; i < chapters.length; i++) {
      for (const op of chapters[i].gitOps) {
        allGitOps.push({ ...op, chapterIdx: i });
      }
    }
    if (allGitOps.length === 0) return h('div');

    const wrap = h('div', { className: 'git-timeline' });

    const header = h('div', { className: 'git-timeline-header' });
    header.appendChild(h('span', { className: 'git-timeline-title' }, 'git activity'));
    var commits = 0, pushes = 0, branches = 0;
    for (var gi = 0; gi < allGitOps.length; gi++) {
      var gt = allGitOps[gi].type;
      if (gt === 'commit') commits++;
      else if (gt === 'push') pushes++;
      else if (gt === 'branch-create' || gt === 'branch-switch') branches++;
    }
    var countParts = [];
    if (commits > 0) countParts.push(commits + ' commit' + (commits > 1 ? 's' : ''));
    if (pushes > 0) countParts.push(pushes + ' push' + (pushes > 1 ? 'es' : ''));
    if (branches > 0) countParts.push(branches + ' branch op' + (branches > 1 ? 's' : ''));
    if (countParts.length === 0) countParts.push(allGitOps.length + ' operation' + (allGitOps.length > 1 ? 's' : ''));
    header.appendChild(h('span', { className: 'git-timeline-count' }, countParts.join(' · ')));
    wrap.appendChild(header);

    const opsDiv = h('div', { className: 'git-timeline-ops' });
    for (const op of allGitOps.slice(0, 20)) {
      var iconCls = 'git-op-icon ';
      var icon = '';
      if (op.type === 'commit') { iconCls += 'commit'; icon = '●'; }
      else if (op.type === 'push') { iconCls += 'push'; icon = '↑'; }
      else if (op.type === 'branch-create') { iconCls += 'branch'; icon = '⑃'; }
      else if (op.type === 'branch-switch') { iconCls += 'branch'; icon = '⇢'; }
      else if (op.type === 'merge') { iconCls += 'merge'; icon = '⑂'; }
      else if (op.type === 'rebase') { iconCls += 'merge'; icon = '↻'; }
      else if (op.type === 'tag') { iconCls += 'push'; icon = '◆'; }
      else { iconCls += 'other'; icon = '·'; }

      var detail = h('span', { className: 'git-op-detail' });
      if (op.type === 'commit') {
        if (op.hash) detail.appendChild(h('span', { className: 'git-op-hash' }, op.hash.slice(0, 7)));
        detail.appendChild(h('span', { className: 'git-op-msg' }, op.message || '(no message)'));
      } else if (op.type === 'push') {
        var pushText = 'push';
        if (op.remote) pushText += ' ' + op.remote;
        if (op.branch) pushText += ' ' + op.branch;
        if (op.tags) pushText += ' --tags';
        detail.appendChild(h('span', { className: 'git-op-msg' }, pushText));
      } else if (op.type === 'branch-create') {
        detail.appendChild(h('span', { className: 'git-op-msg' }, 'create '));
        detail.appendChild(h('span', { className: 'git-op-branch-name' }, op.branch || '?'));
      } else if (op.type === 'branch-switch') {
        detail.appendChild(h('span', { className: 'git-op-msg' }, 'switch to '));
        detail.appendChild(h('span', { className: 'git-op-branch-name' }, op.branch || '?'));
      } else if (op.type === 'merge') {
        detail.appendChild(h('span', { className: 'git-op-msg' }, 'merge '));
        detail.appendChild(h('span', { className: 'git-op-branch-name' }, op.branch || '?'));
      } else if (op.type === 'rebase') {
        detail.appendChild(h('span', { className: 'git-op-msg' }, 'rebase onto '));
        detail.appendChild(h('span', { className: 'git-op-branch-name' }, op.branch || '?'));
      } else if (op.type === 'tag') {
        detail.appendChild(h('span', { className: 'git-op-msg' }, 'tag '));
        detail.appendChild(h('span', { className: 'git-op-branch-name' }, op.tag || '?'));
      } else if (op.type === 'stash') {
        detail.appendChild(h('span', { className: 'git-op-msg' }, 'stash'));
      } else {
        detail.appendChild(h('span', { className: 'git-op-msg' }, op.type));
      }

      var chapterLink = h('button', {
        className: 'git-op-chapter',
        type: 'button',
        'aria-label': 'Jump to chapter ' + (op.chapterIdx + 1) + ' for git operation',
        onClick: (function(idx) { return function(ev) {
          ev.stopPropagation();
          jumpToChapter(idx);
        }; })(op.chapterIdx)
      }, 'ch ' + (op.chapterIdx + 1));

      opsDiv.appendChild(h('div', { className: 'git-op' },
        h('span', { className: iconCls }, icon),
        detail,
        chapterLink
      ));
    }
    if (allGitOps.length > 20) {
      opsDiv.appendChild(h('div', { className: 'git-op' },
        h('span', { className: 'git-op-icon other' }, '…'),
        h('span', { className: 'git-op-detail' },
          h('span', { className: 'git-op-msg' }, (allGitOps.length - 20) + ' more operations')
        )
      ));
    }
    wrap.appendChild(opsDiv);

    return wrap;
  }

  function applyFileFilter() {
    const chapters = getChapters();
    const items = document.querySelectorAll('.file-hotspot-item');
    items.forEach(function(item) {
      const path = item.querySelector('.file-hotspot-path');
      if (!path) return;
      if (activeFileFilter && path.textContent === activeFileFilter) {
        item.classList.add('active');
        item.setAttribute('aria-pressed', 'true');
      } else {
        item.classList.remove('active');
        item.setAttribute('aria-pressed', 'false');
      }
    });

    if (activeFileFilter) {
      let visible = 0;
      for (let i = 0; i < chapters.length; i++) {
        const el = document.getElementById('chapter-' + i);
        if (!el) continue;
        const hasFile = activeFileFilter in chapters[i].files;
        const matchesOther = chapterMatchesFilter(chapters[i]);
        if (hasFile && matchesOther) {
          el.classList.remove('filter-hidden');
          visible++;
        } else {
          el.classList.add('filter-hidden');
        }
      }
      const countEl = document.getElementById('filter-count');
      if (countEl) countEl.textContent = visible + '/' + chapters.length;
    } else {
      applyFilters();
    }
  }

  var minimapEl = null;
  var minimapTooltipEl = null;
  var minimapViewportEl = null;
  var minimapBlocks = [];
  var minimapScrollTicking = false;
  var MINIMAP_THRESHOLD = 10;

  function renderMiniMap() {
    if (minimapEl && minimapEl.parentNode) minimapEl.parentNode.removeChild(minimapEl);
    if (minimapTooltipEl && minimapTooltipEl.parentNode) minimapTooltipEl.parentNode.removeChild(minimapTooltipEl);
    minimapBlocks = [];

    var chapters = getChapters();
    if (chapters.length < MINIMAP_THRESHOLD) return;

    if (!minimapTooltipEl) {
      minimapTooltipEl = document.createElement('div');
      minimapTooltipEl.className = 'minimap-tooltip';
      minimapTooltipEl.id = 'minimap-tooltip';
      minimapTooltipEl.setAttribute('role', 'status');
      minimapTooltipEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(minimapTooltipEl);
    }

    minimapEl = document.createElement('div');
    minimapEl.className = 'minimap';

    var maxTokens = 0;
    for (var i = 0; i < chapters.length; i++) {
      var tok = chapters[i].tokens.input + chapters[i].tokens.output;
      if (tok > maxTokens) maxTokens = tok;
    }
    var useTurns = maxTokens === 0;

    var maxTurns = 0;
    if (useTurns) {
      for (var i = 0; i < chapters.length; i++) {
        if (chapters[i].turns > maxTurns) maxTurns = chapters[i].turns;
      }
    }

    // Budget: approx 80vh minus padding/gaps. Each block: min 2px, max 16px.
    var viewH = window.innerHeight * 0.8;
    var gapSpace = (chapters.length - 1) * 1 + 8;
    var availH = viewH - gapSpace;
    var minH = 2;
    var maxH = Math.min(16, Math.max(minH, Math.floor(availH / chapters.length)));

    minimapViewportEl = document.createElement('div');
    minimapViewportEl.className = 'minimap-viewport';
    minimapEl.appendChild(minimapViewportEl);

    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i];
      var outcome = ch.outcome || 'clean';
      var val = useTurns
        ? (maxTurns > 0 ? ch.turns / maxTurns : 1)
        : ((ch.tokens.input + ch.tokens.output) / maxTokens);
      var height = Math.round(minH + val * (maxH - minH));

      var block = document.createElement('button');
      block.type = 'button';
      block.className = 'minimap-block mm-' + outcome;
      block.style.height = height + 'px';
      block.setAttribute('data-idx', String(i));
      block.setAttribute('aria-label', 'Jump to chapter ' + (i + 1));
      block.setAttribute('aria-describedby', 'minimap-tooltip');

      if (ch.errors > 0) {
        var errDot = document.createElement('span');
        errDot.className = 'minimap-marker mm-error';
        block.appendChild(errDot);
      }
      if (countGitOpsOfType(ch.gitOps, 'commit') > 0) {
        var commitDot = document.createElement('span');
        commitDot.className = 'minimap-marker mm-commit';
        block.appendChild(commitDot);
      }

      (function(idx) {
        block.addEventListener('click', function() {
          jumpToChapter(idx);
        });
      })(i);

      (function(idx, blockEl) {
        function showTooltip() {
          var c = chapters[idx];
          if (!c) return;
          var text = 'Ch ' + (idx + 1);
          var promptSnip = c.prompt.slice(0, 50) + (c.prompt.length > 50 ? '...' : '');
          text = text + ': ' + promptSnip;
          minimapTooltipEl.textContent = text;
          var r = blockEl.getBoundingClientRect();
          var mmRight = window.innerWidth - r.left + 8;
          minimapTooltipEl.style.top = (r.top + r.height / 2 - 12) + 'px';
          minimapTooltipEl.style.left = 'auto';
          minimapTooltipEl.style.right = mmRight + 'px';
          minimapTooltipEl.classList.add('visible');
        }
        function hideTooltip() {
          minimapTooltipEl.classList.remove('visible');
        }
        blockEl.addEventListener('mouseenter', showTooltip);
        blockEl.addEventListener('mouseleave', hideTooltip);
        blockEl.addEventListener('focus', showTooltip);
        blockEl.addEventListener('blur', hideTooltip);
      })(i, block);

      minimapBlocks.push(block);
      minimapEl.appendChild(block);
    }

    document.body.appendChild(minimapEl);
  }

  function updateMiniMapViewport() {
    if (!minimapEl || minimapBlocks.length === 0) return;
    var chapters = getChapters();
    if (chapters.length < MINIMAP_THRESHOLD) return;

    var viewTop = window.scrollY;
    var viewBottom = viewTop + window.innerHeight;
    var firstVisible = -1;
    var lastVisible = -1;

    for (var i = 0; i < chapters.length; i++) {
      var el = document.getElementById('chapter-' + i);
      if (!el || el.classList.contains('filter-hidden')) continue;
      var rect = el.getBoundingClientRect();
      var elTop = rect.top + window.scrollY;
      var elBottom = elTop + rect.height;
      if (elBottom > viewTop && elTop < viewBottom) {
        if (firstVisible === -1) firstVisible = i;
        lastVisible = i;
      }
    }

    for (var i = 0; i < minimapBlocks.length; i++) {
      if (i >= firstVisible && i <= lastVisible && firstVisible !== -1) {
        minimapBlocks[i].classList.add('mm-visible');
      } else {
        minimapBlocks[i].classList.remove('mm-visible');
      }
    }

    if (minimapViewportEl && firstVisible >= 0 && lastVisible >= 0) {
      var firstBlock = minimapBlocks[firstVisible];
      var lastBlock = minimapBlocks[lastVisible];
      if (firstBlock && lastBlock) {
        var containerRect = minimapEl.getBoundingClientRect();
        var firstRect = firstBlock.getBoundingClientRect();
        var lastRect = lastBlock.getBoundingClientRect();
        var vpTop = firstRect.top - containerRect.top;
        var vpHeight = (lastRect.top + lastRect.height) - firstRect.top;
        minimapViewportEl.style.top = vpTop + 'px';
        minimapViewportEl.style.height = vpHeight + 'px';
        minimapViewportEl.style.display = 'block';
      }
    } else if (minimapViewportEl) {
      minimapViewportEl.style.display = 'none';
    }
  }

  window.addEventListener('scroll', function() {
    if (!minimapScrollTicking) {
      minimapScrollTicking = true;
      requestAnimationFrame(function() {
        updateMiniMapViewport();
        minimapScrollTicking = false;
      });
    }
  });
  window.addEventListener('resize', function() {
    if (!minimapScrollTicking) {
      minimapScrollTicking = true;
      requestAnimationFrame(function() {
        updateMiniMapViewport();
        minimapScrollTicking = false;
      });
    }
  });
`;

export const ANALYTICS_JS = ANALYTICS_CHARTS_JS + ANALYTICS_COMPOSE_JS;
