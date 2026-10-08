export const UI_ERRORS_JS = `
  function renderErrorSummary() {
    const chapters = getChapters();
    const totalErrors = chapters.reduce((sum, ch) => sum + ch.errors, 0);
    if (totalErrors === 0) return h('div');

    const toolErrors = {};
    for (const ch of chapters) {
      for (const tool in ch.errorTools) {
        if (!Object.prototype.hasOwnProperty.call(ch.errorTools, tool)) continue;
        const count = ch.errorTools[tool];
        toolErrors[tool] = (toolErrors[tool] || 0) + count;
      }
    }

    const streaks = [];
    let streakStart = -1;
    let errorChapterCount = 0;
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i].errors > 0) {
        errorChapterCount++;
        if (streakStart < 0) streakStart = i;
      } else {
        if (streakStart >= 0 && i - streakStart >= 2) {
          streaks.push({ start: streakStart, end: i - 1, length: i - streakStart });
        }
        streakStart = -1;
      }
    }
    if (streakStart >= 0 && chapters.length - streakStart >= 2) {
      streaks.push({ start: streakStart, end: chapters.length - 1, length: chapters.length - streakStart });
    }

    const inStreak = new Set();
    for (const s of streaks) {
      for (let i = s.start; i <= s.end; i++) inStreak.add(i);
    }

    const wrap = h('div', { className: 'error-summary' });

    const header = h('div', { className: 'error-summary-header' });
    header.appendChild(h('span', { className: 'error-summary-title' }, 'errors'));
    header.appendChild(h('span', { className: 'error-summary-count' },
      totalErrors + ' error' + (totalErrors !== 1 ? 's' : '') +
      ' across ' + errorChapterCount + ' chapter' + (errorChapterCount !== 1 ? 's' : '')
    ));
    wrap.appendChild(header);

    const body = h('div', { className: 'error-summary-body' });

    const toolNames = [];
    for (const tool in toolErrors) {
      if (Object.prototype.hasOwnProperty.call(toolErrors, tool)) toolNames.push(tool);
    }
    toolNames.sort((a, b) => toolErrors[b] - toolErrors[a]);
    if (toolNames.length > 0) {
      const toolList = h('div', { className: 'error-tools-list' });
      for (let ti = 0; ti < Math.min(toolNames.length, 6); ti++) {
        const tool = toolNames[ti];
        const count = toolErrors[tool];
        var errToolLabel = fmtMcpName(tool);
        toolList.appendChild(h('span', { className: 'error-tool-chip' }, errToolLabel + ' ' + count));
      }
      body.appendChild(toolList);
    }

    if (streaks.length > 0) {
      const streakWrap = h('div', { className: 'error-streaks' });
      for (const s of streaks) {
        const badge = h('button', {
          type: 'button',
          className: 'error-streak-badge',
          'aria-label': 'Jump to error streak from chapter ' + (s.start + 1) + ' to chapter ' + (s.end + 1),
          onClick: (ev) => {
            ev.stopPropagation();
            jumpToChapter(s.start);
          }
        }, 'streak: ch ' + (s.start + 1) + '-' + (s.end + 1) + ' (' + s.length + ' chapters)');
        streakWrap.appendChild(badge);
      }
      body.appendChild(streakWrap);
    }

    wrap.appendChild(body);

    const timeline = h('div', { className: 'error-timeline' });
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const hasErr = ch.errors > 0;
      const isInStreak = inStreak.has(i);
      const dotCls = hasErr ? (isInStreak ? 'error-dot streak' : 'error-dot has-error') : 'error-dot no-error';
      const label = 'Jump to chapter ' + (i + 1) + (hasErr ? ' with ' + ch.errors + ' error' + (ch.errors > 1 ? 's' : '') : ' with no errors');
      const dot = h('button', {
        type: 'button',
        className: dotCls,
        title: 'Ch ' + (i + 1) + (hasErr ? ': ' + ch.errors + ' error' + (ch.errors > 1 ? 's' : '') : ''),
        'aria-label': label,
        onClick: (ev) => {
          ev.stopPropagation();
          jumpToChapter(i);
        }
      });
      if (hasErr && ch.errors > 1) {
        const size = Math.min(14, 8 + ch.errors);
        dot.style.width = size + 'px';
        dot.style.height = size + 'px';
      }
      timeline.appendChild(dot);
    }
    wrap.appendChild(timeline);

    return wrap;
  }
`;
