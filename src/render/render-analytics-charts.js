export const ANALYTICS_CHARTS_JS = `
  /** Theme-resolved chart colour (see refreshChartPalette); plain fallback outside the viewer. */
  function ink(key, fallback) {
    return typeof chartInk === 'function' ? chartInk(key, fallback) : fallback;
  }
  /** The same colour at an alpha, for hex or rgb() inputs (what the palette resolves to). */
  function withAlpha(color, a) {
    var c = String(color || '');
    var m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) return '#' + m[1] + ('0' + Math.round(a * 255).toString(16)).slice(-2);
    m = c.match(/^rgba?\\(([^)]+)\\)$/i);
    if (m) {
      var parts = m[1].split(',').slice(0, 3).join(',');
      return 'rgba(' + parts + ',' + a + ')';
    }
    return c;
  }

  function drawWaveform(canvas, turns, gaps, userMsgs, maxOut, maxIn, height) {
    const HEIGHT = height;
    const MID = HEIGHT * 0.5;
    const W = canvas.parentElement?.clientWidth || 800;
    const ctx = setupHiDpiCanvas(canvas, W, HEIGHT);

    const colW = W / turns.length;
    const outRange = MID - 8;
    const inRange = MID - 8;

    ctx.fillStyle = ink('bg', 'rgba(0,0,0,0)');
    ctx.fillRect(0, 0, W, HEIGHT);

    ctx.strokeStyle = ink('grid', 'rgba(255,255,255,0.06)');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, MID);
    ctx.lineTo(W, MID);
    ctx.stroke();

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const x = i * colW;
      const color = turn.hasError ? TOOL_COLORS._error : getToolColor(turn.tool);
      const alpha = 0.35 + 0.65 * (1 - turn.cacheRatio);

      const outH = Math.max(2, (turn.output / maxOut) * outRange);
      const inH = Math.max(2, (turn.input / maxIn) * inRange);

      const outGrad = ctx.createLinearGradient(0, MID - outH, 0, MID);
      outGrad.addColorStop(0, color);
      outGrad.addColorStop(1, withAlpha(color, 0.12));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = outGrad;
      ctx.fillRect(x + 0.25, MID - outH, colW - 0.5, outH);

      ctx.fillStyle = color;
      ctx.globalAlpha = Math.min(1, alpha + 0.3);
      ctx.fillRect(x + 0.25, MID - outH, colW - 0.5, Math.min(2, outH));

      const inGrad = ctx.createLinearGradient(0, MID, 0, MID + inH);
      inGrad.addColorStop(0, withAlpha(color, 0.25));
      inGrad.addColorStop(1, withAlpha(color, 0.03));
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = inGrad;
      ctx.fillRect(x + 0.25, MID + 1, colW - 0.5, inH);

      if (turn.hasError) {
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = TOOL_COLORS._error;
        ctx.shadowColor = TOOL_COLORS._error;
        ctx.shadowBlur = 10;
        ctx.fillRect(x, MID - outH - 4, colW, 4);
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(x + colW / 2, HEIGHT - 14, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = 1;
    for (const gap of gaps) {
      const x = gap.idx * colW;
      ctx.strokeStyle = ink('gridStrong', 'rgba(255,255,255,0.08)');
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x, HEIGHT - 8);
      ctx.stroke();
      ctx.setLineDash([]);

      const label = formatDuration(gap.delta);
      ctx.font = '9px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillStyle = ink('label', '#5c5c63');
      ctx.textAlign = 'center';
      ctx.fillText(label, x, HEIGHT - 2);
    }

    for (const um of userMsgs) {
      const x = Math.min(um.idx, turns.length - 1) * colW + colW / 2;
      ctx.fillStyle = TOOL_COLORS._user;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(x, 1);
      ctx.lineTo(x + 4, 6);
      ctx.lineTo(x, 11);
      ctx.lineTo(x - 4, 6);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = ink('inkSoft', 'rgba(139, 124, 246, 0.18)');
    ctx.lineWidth = 1;
    for (let c = 1; c < userMsgs.length; c++) {
      const x = Math.min(userMsgs[c].idx, turns.length) * colW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    }

    return W;
  }

  function drawChart(canvas, chapterCosts, maxCumulative, maxSingle, height) {
    const HEIGHT = height;
    const W = canvas.parentElement?.clientWidth || 800;
    const ctx = setupHiDpiCanvas(canvas, W, HEIGHT);

    const PAD_TOP = 10;
    const PAD_BOTTOM = 4;
    const chartH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const numCh = chapterCosts.length;
    const barW = W / numCh;

    ctx.fillStyle = ink('bg', 'rgba(0,0,0,0)');
    ctx.fillRect(0, 0, W, HEIGHT);

    if (maxSingle > 0) {
      for (let i = 0; i < numCh; i++) {
        const c = chapterCosts[i];
        const barH = Math.max(1, (c.cost / maxSingle) * (chartH * 0.4));
        const x = i * barW;
        const y = HEIGHT - PAD_BOTTOM - barH;
        ctx.fillStyle = withAlpha(ink('accent', '#e8a44c'), 0.16);
        ctx.fillRect(x + 1, y, barW - 2, barH);
      }
    }

    if (maxCumulative > 0) {
      ctx.beginPath();
      ctx.moveTo(0, HEIGHT - PAD_BOTTOM);
      for (let i = 0; i < numCh; i++) {
        const x = i * barW + barW / 2;
        const y = PAD_TOP + chartH - (chapterCosts[i].cumulative / maxCumulative) * chartH;
        if (i === 0) ctx.lineTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo((numCh - 1) * barW + barW / 2, HEIGHT - PAD_BOTTOM);
      ctx.lineTo(0, HEIGHT - PAD_BOTTOM);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, PAD_TOP, 0, HEIGHT - PAD_BOTTOM);
      grad.addColorStop(0, withAlpha(ink('accent', '#e8a44c'), 0.32));
      grad.addColorStop(1, withAlpha(ink('accent', '#e8a44c'), 0.02));
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < numCh; i++) {
        const x = i * barW + barW / 2;
        const y = PAD_TOP + chartH - (chapterCosts[i].cumulative / maxCumulative) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = ink('accent', 'rgba(232, 164, 76, 0.9)');
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (numCh <= 50) {
        for (let i = 0; i < numCh; i++) {
          const x = i * barW + barW / 2;
          const y = PAD_TOP + chartH - (chapterCosts[i].cumulative / maxCumulative) * chartH;
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = ink('accent', 'rgba(232, 164, 76, 0.9)');
          ctx.fill();
        }
      }
    }

    ctx.fillStyle = ink('label', '#5c5c63');
    ctx.font = '9px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = 'left';
    const topLabel = fmtCost(maxCumulative, { prefix: '$' });
    ctx.fillText(topLabel, 4, PAD_TOP + 8);
    ctx.fillText('$0', 4, HEIGHT - PAD_BOTTOM - 2);

    return W;
  }

  function sortToolPerfEntries(entries, mode) {
    if (mode === 'errors') {
      return entries.slice().sort(function(a, b) {
        var errDiff = b[1].errors - a[1].errors;
        if (errDiff !== 0) return errDiff;
        return b[1].total - a[1].total;
      });
    }
    return entries.slice().sort(function(a, b) { return b[1].total - a[1].total; });
  }

  function buildToolPerfRow(tool, stats) {
    var color = getToolColor(tool);
    var successes = stats.total - stats.errors;
    var rate = stats.total > 0 ? (successes / stats.total * 100) : 100;
    var rateStr = fmtPct(rate);
    var rateCls = 'tool-perf-rate';
    if (rate === 100) rateCls += ' perfect';
    else if (rate >= 90) rateCls += ' good';
    else if (rate >= 70) rateCls += ' warn';
    else rateCls += ' bad';

    var isActive = activeToolPerfFilter === tool;
    var row = h('button', {
      className: 'tool-perf-row' + (isActive ? ' active' : ''),
      type: 'button',
      'aria-pressed': isActive ? 'true' : 'false',
      'aria-label': 'Filter chapters using ' + fmtMcpName(tool)
    });
    row.addEventListener('click', function(ev) {
      ev.stopPropagation();
      if (activeToolPerfFilter === tool) {
        activeToolPerfFilter = null;
        activeToolFilters.clear();
      } else {
        activeToolPerfFilter = tool;
        activeToolFilters.clear();
        activeToolFilters.add(tool);
      }
      applyFilters();
      var rows = document.querySelectorAll('.tool-perf-row');
      rows.forEach(function(r) {
        r.classList.toggle('active', r.dataset.tool === activeToolPerfFilter);
        r.setAttribute('aria-pressed', r.dataset.tool === activeToolPerfFilter ? 'true' : 'false');
      });
    });
    row.dataset.tool = tool;

    row.appendChild(h('div', { className: 'tool-perf-dot', style: 'background:' + color }));
    var toolDispName = fmtMcpName(tool);
    row.appendChild(h('span', { className: 'tool-perf-name', title: tool }, toolDispName));
    row.appendChild(h('span', { className: 'tool-perf-calls' }, String(stats.total)));
    var barWrap = h('div', { className: 'tool-perf-bar-wrap' });
    var okPct = stats.total > 0 ? (successes / stats.total * 100) : 100;
    barWrap.appendChild(h('div', { className: 'tool-perf-bar-ok', style: 'width:' + okPct + '%' }));
    if (stats.errors > 0) {
      barWrap.appendChild(h('div', { className: 'tool-perf-bar-err', style: 'width:' + (100 - okPct) + '%' }));
    }
    row.appendChild(barWrap);
    row.appendChild(h('span', { className: rateCls }, rateStr));
    var errCls = 'tool-perf-errs' + (stats.errors > 0 ? ' has-errors' : '');
    row.appendChild(h('span', { className: errCls }, stats.errors > 0 ? stats.errors + ' err' : ''));

    if (stats.retries > 0) {
      var retryEl = h('div', { className: 'tool-perf-retries' },
        '\\u21bb ' + stats.retries + ' retr' + (stats.retries === 1 ? 'y' : 'ies') +
        ' across ' + stats.chapters + ' chapter' + (stats.chapters === 1 ? '' : 's'));
      row.appendChild(retryEl);
    }

    return row;
  }

  function rebuildToolPerfTable(sortedEntries) {
    var t = document.getElementById('tool-perf-table');
    if (!t) return;
    t.innerHTML = '';
    for (var idx = 0; idx < sortedEntries.length; idx++) {
      t.appendChild(buildToolPerfRow(sortedEntries[idx][0], sortedEntries[idx][1]));
    }
  }

  function computeWaveformChapters(evts) {
    // Ordinal chapter mapping: chapters are delimited by user prompts in event
    // order (same rule as buildSessionChapters), so sessions without event
    // timestamps (e.g. Cursor) still segment correctly.
    const userMsgs = [];
    const turnToChapter = [];
    let turnCount = 0;
    for (const e of evts) {
      if (e.type === 'user' && e.text) {
        userMsgs.push({ idx: turnCount, timestamp: e.timestamp });
      } else if (e.type === 'assistant' && e.tokens) {
        turnToChapter.push(Math.max(0, userMsgs.length - 1));
        turnCount++;
      }
    }
    return { userMsgs, turnToChapter };
  }

  function renderWaveform() {
    const turns = [];

    for (const e of events) {
      if (e.type !== 'assistant' || !e.tokens) continue;
      const ts = new Date(e.timestamp).getTime();
      const tools = (e.toolCalls || []).map(tc => tc.name);
      const primaryTool = tools[0] || '_text';
      const hasError = events.some(r => r.type === 'tool_result' && r.isError && r.toolUseId != null && e.toolCalls?.some(tc => tc.id != null && tc.id === r.toolUseId));
      // No input-token data (e.g. estimated Cursor sessions): use 0.5 so the
      // bar renders at neutral mid brightness instead of the dimmest alpha.
      const cacheRatio = e.tokens.input > 0 ? e.tokens.cacheHit / e.tokens.input : 0.5;
      turns.push({
        ms: ts,
        output: e.tokens.output,
        input: e.tokens.input,
        cacheRatio,
        tool: primaryTool,
        tools,
        hasError,
        timestamp: e.timestamp,
        text: e.text,
      });
    }

    if (!turns.length) return h('div');

    const { userMsgs, turnToChapter } = computeWaveformChapters(events);

    const gaps = [];
    for (let i = 1; i < turns.length; i++) {
      const delta = turns[i].ms - turns[i - 1].ms;
      if (delta > 30000) gaps.push({ idx: i, delta });
    }

    let maxOut = 1;
    let maxIn = 1;
    for (let i = 0; i < turns.length; i++) {
      const o = turns[i].output;
      const inp = turns[i].input;
      if (o > maxOut) maxOut = o;
      if (inp > maxIn) maxIn = inp;
    }

    const wrap = h('div', { className: 'waveform-wrap' });
    wrap.appendChild(h('div', { className: 'waveform-label' }, '▲ output · ▼ input · brightness = uncached — click or focus to jump to chapter'));

    const canvas = document.createElement('canvas');
    canvas.className = 'waveform-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-label', 'Waveform chart. Use Left and Right arrows to choose a turn, then Enter or Space to jump to its chapter.');
    const HEIGHT = 200;
    wrap.appendChild(canvas);

    const tooltip = h('div', { className: 'waveform-tooltip' });
    wrap.appendChild(tooltip);

    const cursor = h('div', { className: 'waveform-cursor' });
    wrap.appendChild(cursor);

    const regionHL = document.createElement('div');
    regionHL.style.cssText = 'position:absolute;background:var(--hover);pointer-events:none;display:none;border-radius:2px;z-index:5;';
    wrap.appendChild(regionHL);

    let canvasW = 0;
    let hoveredChapter = -1;
    let keyboardTurnIdx = 0;
    setTimeout(() => { canvasW = drawWaveform(canvas, turns, gaps, userMsgs, maxOut, maxIn, HEIGHT); }, 0);
    window.addEventListener('resize', () => { canvasW = drawWaveform(canvas, turns, gaps, userMsgs, maxOut, maxIn, HEIGHT); });

    function showWaveformTurn(idx, mx, rect) {
      idx = Math.min(turns.length - 1, Math.max(0, idx));
      const turn = turns[idx];
      const oL = canvas.offsetLeft;
      const oT = canvas.offsetTop;
      const cW = rect.width / turns.length;

      cursor.style.display = 'block';
      cursor.style.left = (oL + mx) + 'px';
      cursor.style.top = oT + 'px';
      cursor.style.height = canvas.style.height;

      const chIdx = turnToChapter[idx];

      const rStart = userMsgs[chIdx] ? userMsgs[chIdx].idx : 0;
      const rEnd = chIdx + 1 < userMsgs.length ? userMsgs[chIdx + 1].idx : turns.length;
      regionHL.style.display = 'block';
      regionHL.style.left = (oL + rStart * cW) + 'px';
      regionHL.style.top = oT + 'px';
      regionHL.style.width = ((rEnd - rStart) * cW) + 'px';
      regionHL.style.height = canvas.style.height;

      if (chIdx !== hoveredChapter) {
        if (hoveredChapter >= 0) {
          const prev = document.getElementById('chapter-' + hoveredChapter);
          if (prev) prev.classList.remove('wf-hover');
        }
        hoveredChapter = chIdx;
        const chEl = document.getElementById('chapter-' + chIdx);
        if (chEl) chEl.classList.add('wf-hover');
      }

      if (turn) {
        const cacheP = ((1 - turn.cacheRatio) * 100) | 0;
        tooltip.style.display = 'block';
        const tx = Math.min(mx + 12, (canvasW || rect.width) - 220);
        tooltip.style.left = (oL + tx) + 'px';
        tooltip.style.top = (oT + 14) + 'px';
        tooltip.innerHTML =
          '<span style="color:var(--fg3)">chapter ' + (chIdx + 1) + '</span> · ' +
          (turn.timestamp ? '<b>' + formatTime(turn.timestamp) + '</b> ' : '') +
          (turn.tools.length ? turn.tools.join(', ') : 'text') +
          '<br>out: ' + fmtTokens(turn.output) +
          ' · in: ' + fmtTokens(turn.input) +
          ' · cold: ' + cacheP + '%' +
          (turn.hasError ? ' · <span style="color:#f07070">ERROR</span>' : '');
      } else {
        tooltip.style.display = 'none';
      }
      return idx;
    }

    function clearWaveformHover() {
      tooltip.style.display = 'none';
      cursor.style.display = 'none';
      regionHL.style.display = 'none';
      if (hoveredChapter >= 0) {
        const prev = document.getElementById('chapter-' + hoveredChapter);
        if (prev) prev.classList.remove('wf-hover');
        hoveredChapter = -1;
      }
    }

    canvas.addEventListener('mousemove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const idx = Math.min(turns.length - 1, Math.max(0, ((mx / rect.width) * turns.length) | 0));
      keyboardTurnIdx = showWaveformTurn(idx, mx, rect);
    });

    canvas.addEventListener('mouseleave', clearWaveformHover);
    canvas.addEventListener('blur', clearWaveformHover);

    canvas.addEventListener('focus', () => {
      const rect = canvas.getBoundingClientRect();
      const mx = ((keyboardTurnIdx + 0.5) / turns.length) * rect.width;
      showWaveformTurn(keyboardTurnIdx, mx, rect);
    });

    canvas.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        if (ev.key === 'ArrowLeft') keyboardTurnIdx = Math.max(0, keyboardTurnIdx - 1);
        if (ev.key === 'ArrowRight') keyboardTurnIdx = Math.min(turns.length - 1, keyboardTurnIdx + 1);
        if (ev.key === 'Home') keyboardTurnIdx = 0;
        if (ev.key === 'End') keyboardTurnIdx = turns.length - 1;
        const rect = canvas.getBoundingClientRect();
        const mx = ((keyboardTurnIdx + 0.5) / turns.length) * rect.width;
        showWaveformTurn(keyboardTurnIdx, mx, rect);
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        jumpToChapter(turnToChapter[keyboardTurnIdx]);
      }
    });

    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const idx = Math.min(turns.length - 1, Math.max(0, ((mx / rect.width) * turns.length) | 0));
      keyboardTurnIdx = idx;
      jumpToChapter(turnToChapter[idx]);
    });

    const usedTools = [...new Set(turns.map(t => t.tool))];
    const legend = h('div', { className: 'waveform-legend' });
    for (const tool of usedTools) {
      const name = tool.startsWith('_') ? (tool === '_text' ? 'text' : tool.slice(1)) : fmtMcpName(tool);
      const color = getToolColor(tool);
      legend.appendChild(h('div', { className: 'legend-item' },
        h('div', { className: 'legend-dot', style: 'background:' + color }),
        name
      ));
    }
    wrap.appendChild(legend);

    return wrap;
  }

  function renderCostChart() {
    const chapters = getChapters();
    if (chapters.length < 2) return h('div');

    const chapterCosts = [];
    let cumulative = 0;
    let hasCost = false;
    for (const ch of chapters) {
      const cost = estimateChapterTokenCost(session.model, ch.tokens);
      cumulative += cost;
      chapterCosts.push({ cost, cumulative });
      if (cost > 0) hasCost = true;
    }

    if (!hasCost || cumulative < 0.001) return h('div');

    const totalCostStr = fmtCost(cumulative, { prefix: '$' });
    const maxCumulative = cumulative;
    let maxSingle = 0;
    for (let i = 0; i < chapterCosts.length; i++) {
      const c = chapterCosts[i].cost;
      if (c > maxSingle) maxSingle = c;
    }

    const wrap = h('div', { className: 'cost-chart' });
    wrap.appendChild(h('div', { className: 'cost-chart-header' },
      'cost progression',
      h('span', { className: 'cost-chart-total' }, 'total: ~' + totalCostStr)
    ));

    const canvas = document.createElement('canvas');
    canvas.className = 'cost-chart-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-label', 'Cost progression chart. Use Left and Right arrows to choose a chapter, then Enter or Space to jump to it.');
    const HEIGHT = 100;
    wrap.appendChild(canvas);

    const tooltip = h('div', { className: 'cost-chart-tooltip' });
    wrap.appendChild(tooltip);

    let chartW = 0;
    let keyboardChapterIdx = 0;
    setTimeout(function() { chartW = drawChart(canvas, chapterCosts, maxCumulative, maxSingle, HEIGHT); }, 0);
    window.addEventListener('resize', function() { chartW = drawChart(canvas, chapterCosts, maxCumulative, maxSingle, HEIGHT); });

    function showCostChapter(idx, mx, rect) {
      const numCh = chapterCosts.length;
      idx = Math.min(numCh - 1, Math.max(0, idx));
      const c = chapterCosts[idx];

      tooltip.style.display = 'block';
      const costStr = fmtCost(c.cost, {
        prefix: '$',
        min: 0.001,
        fine: true,
        tinyMin: 0.001,
        tinyLabel: '<$0.001',
        zeroLabel: '<$0.001',
      });
      const cumStr = fmtCost(c.cumulative, { prefix: '$' });
      tooltip.innerHTML =
        '<b>chapter ' + (idx + 1) + '</b><br>' +
        'cost: <span style="color:var(--orange)">' + costStr + '</span> · ' +
        'cumulative: <span style="color:var(--orange)">' + cumStr + '</span>';

      const oL = canvas.offsetLeft;
      const oT = canvas.offsetTop;
      const tx = Math.min(mx + 12, (chartW || rect.width) - 180);
      tooltip.style.left = (oL + tx) + 'px';
      tooltip.style.top = (oT + 8) + 'px';
      return idx;
    }

    canvas.addEventListener('mousemove', function(ev) {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const numCh = chapterCosts.length;
      const idx = Math.min(numCh - 1, Math.max(0, ((mx / rect.width) * numCh) | 0));
      keyboardChapterIdx = showCostChapter(idx, mx, rect);
    });

    canvas.addEventListener('mouseleave', function() {
      tooltip.style.display = 'none';
    });
    canvas.addEventListener('blur', function() {
      tooltip.style.display = 'none';
    });
    canvas.addEventListener('focus', function() {
      const rect = canvas.getBoundingClientRect();
      const mx = ((keyboardChapterIdx + 0.5) / chapterCosts.length) * rect.width;
      showCostChapter(keyboardChapterIdx, mx, rect);
    });
    canvas.addEventListener('keydown', function(ev) {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        if (ev.key === 'ArrowLeft') keyboardChapterIdx = Math.max(0, keyboardChapterIdx - 1);
        if (ev.key === 'ArrowRight') keyboardChapterIdx = Math.min(chapterCosts.length - 1, keyboardChapterIdx + 1);
        if (ev.key === 'Home') keyboardChapterIdx = 0;
        if (ev.key === 'End') keyboardChapterIdx = chapterCosts.length - 1;
        const rect = canvas.getBoundingClientRect();
        const mx = ((keyboardChapterIdx + 0.5) / chapterCosts.length) * rect.width;
        showCostChapter(keyboardChapterIdx, mx, rect);
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        jumpToChapter(keyboardChapterIdx);
      }
    });

    canvas.addEventListener('click', function(ev) {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const numCh = chapterCosts.length;
      const idx = Math.min(numCh - 1, Math.max(0, ((mx / rect.width) * numCh) | 0));
      keyboardChapterIdx = idx;
      jumpToChapter(idx);
    });

    const axis = h('div', { className: 'cost-chart-axis' });
    axis.appendChild(h('span', {}, 'ch 1'));
    axis.appendChild(h('span', {}, 'ch ' + chapterCosts.length));
    wrap.appendChild(axis);

    return wrap;
  }
`;
