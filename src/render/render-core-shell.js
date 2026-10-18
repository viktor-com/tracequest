import { sumToolCounts } from "../parse/parse-utils.js";

const SUM_TOOL_COUNTS_JS = sumToolCounts.toString();

export const CORE_SHELL_JS = `
  ${SUM_TOOL_COUNTS_JS}

  /** The run view this served page was opened from (from=/run?…), or ''. */
  function chatBackHref() {
    var root = document.documentElement;
    if (!root || !root.hasAttribute || !root.hasAttribute('data-tq-served')) return '';
    try {
      var raw = new URLSearchParams(location.search).get('from') || '';
      if (!raw || raw.charAt(0) !== '/' || raw.charAt(1) === '/') return '';
      var u = new URL(raw, location.origin);
      if (u.origin !== location.origin || u.pathname !== '/run' || !u.search) return '';
      return u.pathname + u.search + u.hash;
    } catch (_) { return ''; }
  }

  function readUrlState() {
    var params = new URLSearchParams(window.location.search);
    var hash = window.location.hash;
    var toolParam = params.get('tool');
    if (toolParam) {
      toolParam.split(',').forEach(function(t) { if (t.trim()) activeToolFilters.add(t.trim()); });
    }
    var qParam = params.get('q');
    if (qParam) searchQuery = qParam;
    if (hash && hash.match(/^#chapter-(\\d+)$/)) {
      var chIdx = parseInt(hash.slice(9), 10);
      if (!isNaN(chIdx) && chIdx >= 0) {
        expandedSet.add('ch' + chIdx);
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            var el = document.getElementById('chapter-' + chIdx);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        });
      }
    }
  }

  function buildFilterSearchParams() {
    var params = new URLSearchParams(window.location.search);
    var base = new URLSearchParams();
    if (params.get('path')) base.set('path', params.get('path'));
    else if (params.get('id')) base.set('id', params.get('id'));
    if (params.get('source')) base.set('source', params.get('source'));
    if (activeToolFilters.size > 0) base.set('tool', Array.from(activeToolFilters).join(','));
    if (searchQuery) base.set('q', searchQuery);
    return base;
  }

  // The page's own URL keeps embed=1 so a reload inside the Runs flyout stays
  // the compact embedded view, and from= so it keeps its way back to the chat;
  // permalinks (buildFilterSearchParams) never carry either.
  function pageSearchParams() {
    var base = buildFilterSearchParams();
    var own = new URLSearchParams(window.location.search);
    if (own.get('embed') === '1') base.set('embed', '1');
    if (own.get('from')) base.set('from', own.get('from'));
    return base;
  }

  function updateUrl() {
    var base = pageSearchParams();
    var hash = window.location.hash || '';
    var url = window.location.pathname + '?' + base.toString() + hash;
    history.replaceState(null, '', url);
  }

  function setChapterHash(idx) {
    var base = pageSearchParams();
    var url = window.location.pathname + '?' + base.toString() + '#chapter-' + idx;
    history.replaceState(null, '', url);
  }

  function clearChapterHash() {
    var base = pageSearchParams();
    var url = window.location.pathname + '?' + base.toString();
    history.replaceState(null, '', url);
  }

  function getPermalink(chapterIdx) {
    var base = new URL(window.location.pathname, window.location.origin);
    var params = buildFilterSearchParams();
    base.search = params.toString() ? '?' + params.toString() : '';
    base.hash = 'chapter-' + chapterIdx;
    return base.toString();
  }

  function renderHeader() {
    const s = session.stats;
    const sourceColors = { claude: '#a78bfa', codex: '#59d4a0', cursor: '#c4e86b', 'cursor-cloud': '#4dd0e1', factory: '#e0c45e', opencode: '#6ba4e8', grok: '#f07070', vktr: '#e07aa8', fx: '#94a3b8', dsh: '#7b8cf7' };
    const srcHue = sourceColors[session.source] ? 'var(--hue-' + session.source + ', ' + sourceColors[session.source] + ')' : 'var(--hue-other)';
    const srcBadge = session.source
      ? h('span', { className: 'header-agent', style: '--hue:' + srcHue }, session.source)
      : null;

    const params = new URLSearchParams(window.location.search);
    const exportUrl = '/export?' + params.toString();

    const downloadIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    downloadIcon.setAttribute('viewBox', '0 0 24 24');
    downloadIcon.innerHTML = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>';

    const exportBtn = h('a', { className: 'export-btn', href: exportUrl, title: 'Download as standalone HTML file' });
    exportBtn.appendChild(downloadIcon);
    exportBtn.appendChild(document.createTextNode('Export'));

    const printIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    printIcon.setAttribute('viewBox', '0 0 24 24');
    printIcon.innerHTML = '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>';

    const printBtn = h('button', { className: 'print-btn', title: 'Print or save as PDF' });
    printBtn.appendChild(printIcon);
    printBtn.appendChild(document.createTextNode('Print'));
    printBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      expandAllChapterDetails();
      window.print();
    });
    printBtn._tqOn = true;

    const mdUrl = '/markdown?' + params.toString();
    const mdIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mdIcon.setAttribute('viewBox', '0 0 24 24');
    mdIcon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>';

    const mdBtn = h('a', { className: 'md-btn', href: mdUrl, title: 'Download as markdown document' });
    mdBtn.appendChild(mdIcon);
    mdBtn.appendChild(document.createTextNode('Markdown'));

    const shareIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    shareIcon.setAttribute('viewBox', '0 0 24 24');
    shareIcon.innerHTML = '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>';

    const shareBtn = h('button', { className: 'hf-btn', title: 'Share session to Gist or Hugging Face' });
    shareBtn.appendChild(shareIcon);
    shareBtn.appendChild(document.createTextNode('Share'));
    shareBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      if (typeof openShareModal === 'function') openShareModal();
    });
    shareBtn._tqOn = true;

    // Served from tracequest (not an exported or shared file): a way back.
    // Markdown and Export are server routes, so only a served page offers them.
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    const inApp = !!(root && root.hasAttribute && root.hasAttribute('data-tq-served'));
    // Opened from a chat (from=/run?…): the way back is that chat, not Runs.
    const chatBack = chatBackHref();
    const backLink = !inApp ? null : chatBack
      ? h('a', { className: 'header-back', id: 'chatBackLink', href: chatBack, title: 'Back to the chat (Esc)' }, '\u2190 Back to chat')
      : h('a', { className: 'header-back', href: '/sessions' }, '\u2190 Runs');
    // The run's first prompt is its name: what was asked, in the person's words.
    let promptText = '';
    try {
      const chs = typeof getChapters === 'function' ? getChapters() : [];
      promptText = (chs[0] && chs[0].prompt) || '';
    } catch (_) { promptText = ''; }
    const project = session.cwd ? String(session.cwd).split('/').filter(Boolean).pop() : '';

    return h('div', { className: 'header' },
      backLink,
      h('div', { className: 'header-top' },
        h('div', { className: 'header-title' },
          h('span', { className: 'header-id' }, session.sessionHash || session.sessionId?.slice(0, 8) || 'session'),
          srcBadge,
          project ? h('span', { className: 'header-project', title: session.cwd }, project) : null,
          session.gitBranch ? h('span', { className: 'header-branch' }, session.gitBranch) : null
        ),
        h('div', { className: 'header-actions' }, printBtn, inApp ? mdBtn : null, inApp ? exportBtn : null, shareBtn)
      ),
      promptText ? h('h1', { className: 'header-prompt' }, promptText) : h('h1', { className: 'header-prompt is-empty' }, 'Untitled run'),
      h('div', { className: 'meta-grid' },
        metaItem('model', session.model || '—'),
        metaItem('cwd', session.cwd || '—'),
        metaItem('branch', session.gitBranch || '—'),
        metaItem('duration', sessionDurationMs() > 0 ? (session.timesEstimated ? '~' : '') + formatDuration(sessionDurationMs()) : '—'),
        metaItem('started', session.startTime && session.eventCount > 0 ? (session.timesEstimated ? '~' : '') + new Date(session.startTime).toLocaleString() : '—'),
      )
    );
  }

  function sessionDurationMs() {
    return session.summary ? session.summary.durationMs : session.durationMs;
  }

  function metaItem(label, value) {
    return h('div', { className: 'meta-item' },
      h('span', { className: 'meta-label' }, label),
      h('span', { className: 'meta-value' }, value)
    );
  }

  function renderStats() {
    const s = session.stats;
    const hasTokens = s.totalInputTokens > 0 || s.totalOutputTokens > 0;
    const est = s.tokensEstimated ? '~' : '';
    const bar = h('div', { className: 'stats-bar' },
      stat(s.userMessages, 'prompts', ''),
      stat(s.assistantTurns, 'turns', ''),
      stat(sumToolCounts(s.toolCounts), 'tool calls', ''),
      stat(hasTokens && !(s.totalInputTokens === 0 && s.tokensEstimated) ? est + fmtTokens(s.totalInputTokens) : '—', 'input tok', ''),
      stat(hasTokens ? est + fmtTokens(s.totalOutputTokens) : '—', 'output tok', ''),
      stat(s.totalCacheHit && s.totalInputTokens ? ((s.totalCacheHit / s.totalInputTokens * 100) | 0) + '%' : '—', 'cache hit', 'green'),
      stat(s.errors, 'errors', s.errors > 0 ? 'red' : ''),
    );
    if (s.tokensEstimated) {
      bar.appendChild(h('div', { className: 'stats-note' }, '~ token counts estimated from content length'));
    }
    return bar;
  }

  function stat(value, label, cls) {
    return h('div', { className: 'stat' },
      h('div', { className: 'stat-value' + (cls ? ' ' + cls : '') }, String(value)),
      h('div', { className: 'stat-label' }, label),
    );
  }

  function aggregateChapterMetrics(chapters) {
    var cleanCount = 0;
    var correctedCount = 0;
    var strugglingCount = 0;
    var totalErrors = 0;
    var totalRetries = 0;
    var totalSelfCorrections = 0;
    var totalCommits = 0;
    var wastefulCount = 0;
    var totalWasteTokens = 0;
    var allFiles = new Set();
    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i];
      var outcome = ch.outcome;
      if (outcome === 'clean') cleanCount++;
      else if (outcome === 'corrected') correctedCount++;
      else if (outcome === 'struggling') strugglingCount++;
      totalErrors += ch.errors;
      totalRetries += ch.retries || 0;
      totalSelfCorrections += ch.selfCorrections || 0;
      var gitOps = ch.gitOps;
      for (var j = 0; j < gitOps.length; j++) {
        if (gitOps[j].type === 'commit') totalCommits++;
      }
      var fileKeys = chapterFileKeys(ch);
      for (var k = 0; k < fileKeys.length; k++) allFiles.add(fileKeys[k]);
      var eff = ch.efficiency;
      if (eff && eff.isWasteful) {
        wastefulCount++;
        totalWasteTokens += eff.wasteTokens || 0;
      }
    }
    return {
      cleanCount: cleanCount,
      correctedCount: correctedCount,
      strugglingCount: strugglingCount,
      totalErrors: totalErrors,
      totalRetries: totalRetries,
      totalSelfCorrections: totalSelfCorrections,
      totalCommits: totalCommits,
      wastefulCount: wastefulCount,
      totalWasteTokens: totalWasteTokens,
      allFiles: allFiles,
    };
  }

  function renderSessionSummary() {
    const s = session.stats;
    const chapters = getChapters();
    const m = aggregateChapterMetrics(chapters);
    const wrap = h('div', { className: 'session-summary' });
    const items = [];

    if (sessionDurationMs() > 0) {
      items.push(summaryItem('duration', formatDuration(sessionDurationMs()), 'ss-duration'));
    }

    // The served view carries the per-session summary the session list shows
    // (session.summary); a standalone export without one falls back to the parse.
    const sum = session.summary;
    const totalCost = sum ? estimateCost(sum) : estimateParsedStatsCost(session.model, s);
    const costLabel = fmtCost(totalCost);
    if (costLabel) {
      items.push(summaryItem('cost', costLabel, 'ss-cost'));
    }

    const totalTok = sum ? sum.totalTokens : s.totalInputTokens + s.totalOutputTokens;
    if (totalTok > 0) {
      items.push(summaryItem('tokens', fmtTokens(totalTok), 'ss-tokens'));
    }

    if (s.errors > 0) {
      items.push(summaryItem('errors', String(s.errors), 'ss-errors'));
    }

    if (m.totalCommits > 0) {
      items.push(summaryItem('commits', String(m.totalCommits), 'ss-commits'));
    }

    if (m.allFiles.size > 0) {
      items.push(summaryItem('files', String(m.allFiles.size), ''));
    }

    const cleanCount = m.cleanCount;
    const correctedCount = m.correctedCount;
    const strugglingCount = m.strugglingCount;
    if (chapters.length > 1) {
      const qualityParts = [];
      if (cleanCount > 0) qualityParts.push(cleanCount + ' clean');
      if (correctedCount > 0) qualityParts.push(correctedCount + ' corrected');
      if (strugglingCount > 0) qualityParts.push(strugglingCount + ' struggling');
      if (qualityParts.length > 0 && (correctedCount > 0 || strugglingCount > 0)) {
        const qualityCls = strugglingCount > correctedCount ? 'ss-errors'
          : correctedCount > 0 ? 'ss-quality-mixed' : '';
        items.push(summaryItem('quality', qualityParts.join(', '), qualityCls));
      }
    }

    if (chapters._depSummary && chapters._depSummary.chains > 0) {
      const ds = chapters._depSummary;
      const chainLabel = ds.chains + ' workflow chain' + (ds.chains > 1 ? 's' : '') +
        ' (' + ds.chaptersInChains + ' of ' + chapters.length + ' ch)';
      items.push(summaryItem('workflows', chainLabel, ''));
    }

    if (m.wastefulCount > 0) {
      // Use session's actual cost-per-token ratio instead of raw rate average
      // (averaging in/out rates wildly overestimates because most tokens are cheap cached input)
      const costPerToken = totalTok > 0 && totalCost > 0 ? totalCost / totalTok : 0;
      const wasteCost = m.totalWasteTokens * costPerToken;
      let wasteLabel = m.wastefulCount + ' wasteful ch';
      if (m.totalWasteTokens > 0) wasteLabel += ' · ~' + fmtTokens(m.totalWasteTokens) + ' wasted';
      const wasteCostStr = fmtCost(wasteCost);
      if (wasteCostStr) wasteLabel += ' (' + wasteCostStr + ')';
      items.push(summaryItem('waste', wasteLabel, 'ss-waste'));
    }

    const grade = session.grade && session.grade.letter !== '-' ? session.grade : null;
    if (grade) {
      const gradeEl = h('div', { className: 'session-grade' });
      gradeEl.appendChild(h('span', { className: 'session-grade-letter ' + grade.cls }, grade.letter));
      const detailEl = h('div', { className: 'session-grade-detail' });
      detailEl.appendChild(h('span', { className: 'session-grade-score' }, grade.score + '/100'));
      detailEl.appendChild(h('span', { className: 'session-grade-note' },
        'From tool-call error rate, errors per indexed chapter and cache hit rate'));
      gradeEl.appendChild(detailEl);
      wrap.appendChild(gradeEl);
      if (items.length > 0) {
        wrap.appendChild(h('div', { className: 'session-summary-sep' }));
      }
    }

    for (let i = 0; i < items.length; i++) {
      wrap.appendChild(items[i]);
      if (i < items.length - 1) {
        wrap.appendChild(h('div', { className: 'session-summary-sep' }));
      }
    }

    return items.length > 0 || grade ? wrap : h('div');
  }

  function summaryItem(label, value, cls) {
    return h('div', { className: 'session-summary-item' + (cls ? ' ' + cls : '') },
      h('span', { className: 'ss-label' }, label),
      h('span', { className: 'ss-value' }, value)
    );
  }

  function renderActivityTimeline() {
    const timed = [];
    for (const e of events) {
      if (!e.timestamp) continue;
      const ms = new Date(e.timestamp).getTime();
      if (isNaN(ms)) continue;
      timed.push({ ms, type: e.type });
    }
    if (timed.length < 3) return h('div');

    timed.sort(function(a, b) { return a.ms - b.ms; });
    const sessionStart = timed[0].ms;
    const sessionEnd = timed[timed.length - 1].ms;
    const totalSpan = sessionEnd - sessionStart;
    if (totalSpan < 10000) return h('div'); // less than 10s — not useful

    const chapters = getChapters();
    const chapterRanges = [];
    for (const ch of chapters) {
      const s = ch.timestamp ? new Date(ch.timestamp).getTime() : 0;
      const e = ch.endTimestamp ? new Date(ch.endTimestamp).getTime() : s;
      if (s > 0) chapterRanges.push({ start: s, end: e || s });
    }

    const GAP_THRESHOLD = 120000; // 2 minutes
    const IDLE_LABEL_THRESHOLD = 300000; // 5 minutes — label these
    const gaps = [];
    for (let i = 1; i < timed.length; i++) {
      const delta = timed[i].ms - timed[i - 1].ms;
      if (delta >= GAP_THRESHOLD) {
        gaps.push({ start: timed[i - 1].ms, end: timed[i].ms, duration: delta });
      }
    }

    const segments = [];
    let segStart = sessionStart;
    for (const gap of gaps) {
      if (gap.start > segStart) {
        segments.push({ start: segStart, end: gap.start, type: 'active' });
      }
      segments.push({ start: gap.start, end: gap.end, type: 'idle', duration: gap.duration });
      segStart = gap.end;
    }
    if (segStart < sessionEnd) {
      segments.push({ start: segStart, end: sessionEnd, type: 'active' });
    }

    function formatClockTime(ms) {
      const d = new Date(ms);
      let h = d.getHours();
      const m = d.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    }

    const wrap = h('div', { className: 'activity-timeline' });
    wrap.appendChild(h('div', { className: 'activity-timeline-label' },
      'Activity — solid where the agent worked, gaps where it waited'));

    const canvas = document.createElement('canvas');
    canvas.className = 'activity-timeline-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-label', 'Activity timeline. Use Left and Right arrows to inspect time, active work, idle gaps, and chapter context. Press Enter or Space to jump to the selected chapter.');
    canvas.setAttribute('aria-describedby', 'activity-timeline-tooltip');
    const HEIGHT = 48;
    wrap.appendChild(canvas);

    const tooltip = h('div', { className: 'activity-timeline-tooltip', id: 'activity-timeline-tooltip', role: 'status', 'aria-live': 'polite' });
    wrap.appendChild(tooltip);

    function clampTime(ms) {
      return Math.min(sessionEnd, Math.max(sessionStart, ms));
    }

    const keyboardStops = [sessionStart, sessionEnd];
    for (const cr of chapterRanges) keyboardStops.push(clampTime(cr.start));
    for (const gap of gaps) {
      keyboardStops.push(clampTime(gap.start));
      keyboardStops.push(clampTime(gap.start + gap.duration / 2));
      keyboardStops.push(clampTime(gap.end));
    }
    keyboardStops.sort(function(a, b) { return a - b; });
    const uniqueKeyboardStops = [];
    for (const stop of keyboardStops) {
      if (!uniqueKeyboardStops.length || Math.abs(stop - uniqueKeyboardStops[uniqueKeyboardStops.length - 1]) > 1000) {
        uniqueKeyboardStops.push(stop);
      }
    }
    let keyboardStopIdx = 0;

    function timelineDiagnostic(ms) {
      ms = clampTime(ms);
      const hoverTime = formatClockTime(ms);

      var segInfo = '';
      for (const seg of segments) {
        if (ms >= seg.start && ms <= seg.end) {
          if (seg.type === 'idle') {
            var gapMin = Math.round(seg.duration / 60000);
            segInfo = ' \\u2014 idle gap (' + (gapMin >= 60 ? (gapMin / 60).toFixed(1) + 'h' : gapMin + 'm') + ')';
          } else {
            segInfo = ' \\u2014 active';
          }
          break;
        }
      }

      var chLabel = '';
      var chapterIdx = -1;
      for (let i = 0; i < chapterRanges.length; i++) {
        var cr = chapterRanges[i];
        var nextStart = i + 1 < chapterRanges.length ? chapterRanges[i + 1].start : sessionEnd;
        if (ms >= cr.start && (ms < nextStart || (i === chapterRanges.length - 1 && ms <= nextStart))) {
          chLabel = ' \\u2014 ch ' + (i + 1);
          chapterIdx = i;
          break;
        }
      }

      return {
        text: hoverTime + chLabel + segInfo,
        chapterIdx: chapterIdx,
      };
    }

    function showTimelineDiagnostic(ms, x, rect) {
      const W = rect.width;
      const diag = timelineDiagnostic(ms);
      tooltip.style.display = 'block';
      tooltip.textContent = diag.text;
      var left = x + 12;
      if (left + 160 > W) left = x - 160;
      tooltip.style.left = left + 'px';
      tooltip.style.top = '-28px';
      return diag;
    }

    function showKeyboardTimelineStop() {
      const rect = canvas.getBoundingClientRect();
      const ms = uniqueKeyboardStops[keyboardStopIdx] || sessionStart;
      const x = ((ms - sessionStart) / totalSpan) * rect.width;
      return showTimelineDiagnostic(ms, x, rect);
    }

    function hideTimelineDiagnostic() {
      tooltip.style.display = 'none';
    }

    function drawTimeline() {
      const W = canvas.parentElement?.clientWidth || 800;
      const ctx = setupHiDpiCanvas(canvas, W, HEIGHT);

      const tInk = typeof chartInk === 'function' ? chartInk : function (_k, f) { return f; };
      ctx.fillStyle = tInk('bg', 'rgba(0,0,0,0)');
      ctx.fillRect(0, 0, W, HEIGHT);

      function timeToX(ms) {
        return ((ms - sessionStart) / totalSpan) * W;
      }

      const barY = 12;
      const barH = 20;
      for (const seg of segments) {
        const x1 = timeToX(seg.start);
        const x2 = timeToX(seg.end);
        const w = Math.max(1, x2 - x1);
        if (seg.type === 'active') {
          const grad = ctx.createLinearGradient(x1, barY, x1, barY + barH);
          grad.addColorStop(0, tInk('active', 'rgba(139, 124, 246, 0.7)'));
          grad.addColorStop(1, tInk('activeSoft', 'rgba(139, 124, 246, 0.35)'));
          ctx.fillStyle = grad;
          ctx.beginPath();
          if (ctx.roundRect) { ctx.roundRect(x1, barY, w, barH, 3); }
          else { ctx.rect(x1, barY, w, barH); }
          ctx.fill();
        } else {
          ctx.fillStyle = tInk('grid', 'rgba(255, 255, 255, 0.02)');
          ctx.fillRect(x1, barY, w, barH);
          ctx.save();
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = tInk('gridStrong', 'rgba(255, 255, 255, 0.1)');
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, barY + barH / 2);
          ctx.lineTo(x1 + w, barY + barH / 2);
          ctx.stroke();
          ctx.restore();
          if (seg.duration >= IDLE_LABEL_THRESHOLD && w > 30) {
            var gapMinutes = Math.round(seg.duration / 60000);
            var gapLabel = gapMinutes >= 60 ? (gapMinutes / 60).toFixed(1) + 'h' : gapMinutes + 'm';
            ctx.font = '9px ' + getComputedStyle(document.body).getPropertyValue('--mono').trim().split(',')[0].replace(/'/g, '');
            ctx.fillStyle = tInk('idle', 'rgba(232, 164, 76, 0.8)');
            ctx.textAlign = 'center';
            ctx.fillText(gapLabel + ' idle', x1 + w / 2, barY + barH / 2 + 3);
          }
        }
      }

      ctx.strokeStyle = tInk('inkSoft', 'rgba(255, 255, 255, 0.15)');
      ctx.lineWidth = 1;
      for (let i = 1; i < chapterRanges.length; i++) {
        const x = timeToX(chapterRanges[i].start);
        ctx.beginPath();
        ctx.moveTo(x, barY - 2);
        ctx.lineTo(x, barY + barH + 2);
        ctx.stroke();
      }

      ctx.font = '8px ' + getComputedStyle(document.body).getPropertyValue('--mono').trim().split(',')[0].replace(/'/g, '');
      ctx.fillStyle = tInk('label', 'rgba(255, 255, 255, 0.25)');
      ctx.textAlign = 'center';
      // Only label if chapters won't overlap (min 20px apart)
      var prevLabelX = -30;
      for (let i = 0; i < chapterRanges.length; i++) {
        const x = timeToX(chapterRanges[i].start);
        if (x - prevLabelX >= 20) {
          ctx.fillText(String(i + 1), x, barY - 4);
          prevLabelX = x;
        }
      }

      const dotY = barY + barH + 6;
      const bucketCount = Math.min(W, 200);
      const bucketW = totalSpan / bucketCount;
      const buckets = new Array(bucketCount).fill(0);
      for (const t of timed) {
        const idx = Math.min(bucketCount - 1, Math.floor((t.ms - sessionStart) / bucketW));
        buckets[idx]++;
      }
      const maxBucket = Math.max(...buckets, 1);
      for (let i = 0; i < bucketCount; i++) {
        if (buckets[i] === 0) continue;
        const alpha = 0.2 + 0.8 * (buckets[i] / maxBucket);
        const x = (i / bucketCount) * W;
        const w = Math.max(1, W / bucketCount - 0.5);
        ctx.globalAlpha = Math.min(1, alpha * 1.4);
        ctx.fillStyle = tInk('active', 'rgba(139, 124, 246, 1)');
        ctx.fillRect(x, dotY, w, 3);
      }
      ctx.globalAlpha = 1;
    }

    drawTimeline();
    window.addEventListener('resize', drawTimeline);

    canvas.addEventListener('mousemove', function(ev) {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const W = rect.width;
      const ratio = x / W;
      const hoverMs = sessionStart + ratio * totalSpan;
      showTimelineDiagnostic(hoverMs, x, rect);
    });

    canvas.addEventListener('mouseleave', function() {
      if (document.activeElement !== canvas) hideTimelineDiagnostic();
    });
    canvas.addEventListener('blur', hideTimelineDiagnostic);
    canvas.addEventListener('focus', showKeyboardTimelineStop);
    canvas.addEventListener('keydown', function(ev) {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        if (ev.key === 'ArrowLeft') keyboardStopIdx = Math.max(0, keyboardStopIdx - 1);
        if (ev.key === 'ArrowRight') keyboardStopIdx = Math.min(uniqueKeyboardStops.length - 1, keyboardStopIdx + 1);
        if (ev.key === 'Home') keyboardStopIdx = 0;
        if (ev.key === 'End') keyboardStopIdx = uniqueKeyboardStops.length - 1;
        showKeyboardTimelineStop();
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        const diag = showKeyboardTimelineStop();
        if (diag.chapterIdx >= 0 && typeof jumpToChapter === 'function') jumpToChapter(diag.chapterIdx);
      }
    });

    const timesRow = h('div', { className: 'activity-timeline-times' });
    const labelCount = Math.min(8, Math.max(2, Math.floor(totalSpan / 300000))); // ~5min minimum spacing
    for (let i = 0; i <= labelCount; i++) {
      const t = sessionStart + (i / labelCount) * totalSpan;
      timesRow.appendChild(h('span', null, formatClockTime(t)));
    }
    wrap.appendChild(timesRow);

    const legend = h('div', { className: 'activity-timeline-legend' });
    function legendItem(color, text) {
      const dot = h('span', { className: 'activity-timeline-legend-dot' });
      dot.style.background = color;
      return h('span', { className: 'activity-timeline-legend-item' }, dot, text);
    }
    legend.appendChild(legendItem('var(--text-3)', 'active'));
    legend.appendChild(legendItem('var(--warn)', 'idle over 5 min'));
    legend.appendChild(legendItem('var(--line-3)', 'chapter boundary'));
    var totalIdleMs = gaps.reduce(function(s, g) { return s + g.duration; }, 0);
    var activeMs = totalSpan - totalIdleMs;
    if (totalIdleMs > 0) {
      var activeStr = formatDuration(activeMs);
      var idleStr = formatDuration(totalIdleMs);
      legend.appendChild(h('span', { className: 'activity-timeline-legend-item', style: 'margin-left: auto; color: var(--text-2);' },
        'active: ' + activeStr + ' · idle: ' + idleStr + ' (' + Math.round(totalIdleMs / totalSpan * 100) + '%)'));
    }
    wrap.appendChild(legend);

    return wrap;
  }
`;
