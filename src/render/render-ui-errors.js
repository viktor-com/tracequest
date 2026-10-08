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

    // The failures themselves, so "why did this go wrong" is answered here
    // instead of by scrolling every chapter. Identical failures (same tool,
    // same first output line) collapse into one row with a count; each row
    // jumps to the first chapter where it happened.
    const groups = [];
    const byKey = new Map();
    const firstLineOf = (text) => (String(text || '').split('\\n').find(function(l) { return l.trim(); }) || '').trim().slice(0, 200);
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const add = (name, input, output) => {
        const line = firstLineOf(output);
        const key = name + '\\u0000' + (line || String(input || ''));
        let g = byKey.get(key);
        if (!g) {
          g = { chapter: i, name: name, input: String(input || ''), line: line, count: 0, inputs: new Set() };
          byKey.set(key, g);
          groups.push(g);
        }
        g.count++;
        if (input) g.inputs.add(String(input));
      };
      for (const c of ch.commands || []) if (!c.ok) add('Bash', c.cmd, c.output);
      for (const m of ch.mcpOps || []) if (!m.ok) add(m.rawName || m.tool, '', m.output);
      for (const w of ch.webOps || []) if (!w.ok) add(w.type === 'search' ? 'WebSearch' : 'WebFetch', w.url || w.query, w.output);
      for (const q of ch.searches || []) if (!q.ok) add('Grep', q.query, q.output);
      for (const ag of ch.agents || []) if (ag.isError) add(ag.toolName || 'Agent', ag.description, ag.result);
      for (const msg of ch.standaloneErrors || []) add('error', '', msg);
    }
    groups.sort((x, y) => y.count - x.count || x.chapter - y.chapter);
    const shown = groups.slice(0, 6);
    if (shown.length > 0) {
      const list = h('ol', { className: 'error-list' });
      for (const g of shown) {
        const inputs = Array.from(g.inputs);
        const what = g.line || (inputs[0] || '').slice(0, 160);
        const where = inputs.length > 1
          ? inputs.length + ' different calls, e.g. ' + inputs[0].slice(0, 80)
          : (g.line && inputs[0] ? inputs[0].slice(0, 160) : '');
        const row = h('button', {
          type: 'button',
          className: 'error-list-item',
          title: 'Jump to chapter ' + (g.chapter + 1) + ', where this first happened',
          onClick: (ev) => { ev.stopPropagation(); jumpToChapter(g.chapter); }
        },
          h('span', { className: 'error-list-count' }, g.count > 1 ? g.count + '\\u00d7' : ''),
          h('span', { className: 'error-list-tool' }, fmtMcpName(g.name)),
          h('span', { className: 'error-list-text' },
            h('code', null, what),
            where ? h('span', { className: 'error-list-out' }, where) : null
          ),
          h('span', { className: 'error-list-ch' }, 'ch ' + (g.chapter + 1))
        );
        list.appendChild(h('li', null, row));
      }
      body.appendChild(list);
      const rest = groups.length - shown.length;
      if (rest > 0) {
        body.appendChild(h('div', { className: 'error-list-more' }, rest + ' other kind' + (rest === 1 ? '' : 's') + ' of failure in the chapters below'));
      }
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
