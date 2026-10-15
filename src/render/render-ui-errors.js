import { ERROR_CLASSES } from "../insights/classify.js";

// The Insights error classes, so a failure row names the same cause there and here.
const ERROR_CAUSES_JS = ERROR_CLASSES.map((c) => `{ id: ${JSON.stringify(c.id)}, label: ${JSON.stringify(c.label)}, re: ${c.re} }`).join(",\n    ");

export const UI_ERRORS_JS = `
  var ERROR_CAUSES = [
    ${ERROR_CAUSES_JS}
  ];

  // The Insights class of one failed call, and the output line that names it:
  // "cd: /x: No such file or directory" rather than the "Exit code 1" above it,
  // or the Codex "Script failed / Wall time / Output: / Script error:" framing.
  function failureCause(output) {
    var text = String(output || '');
    var cls = null;
    for (var i = 0; i < ERROR_CAUSES.length && !cls; i++) if (ERROR_CAUSES[i].re.test(text)) cls = ERROR_CAUSES[i];
    var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(Boolean);
    var framing = /^(?:(?:Exit code|exit:)\\s*\\d+|Script (?:failed|completed)|Wall time [\\d.]+ seconds|Output:|Script error:)$/i;
    var line = cls ? (lines.find(function(l) { return cls.re.test(l) && !framing.test(l); }) || '') : '';
    if (!line) line = lines.find(function(l) { return !framing.test(l); }) || lines[0] || '';
    return { id: cls ? cls.id : 'other', label: cls ? cls.label : '', line: line.slice(0, 200) };
  }

  // Open the chapter as a click on it would, then bring the failed call itself
  // into view, with its output unclipped, instead of leaving the user to hunt for it.
  function revealFailure(idx, ref) {
    var el = document.getElementById('chapter-' + idx);
    if (!el) return;
    if (!expandedSet.has('ch' + idx)) toggleChapterInPlace(getChapters()[idx], idx, el);
    var target = el.querySelector('[data-failure="' + ref + '"]');
    if (!target) { jumpToChapter(idx); return; }
    var outputs = Array.from(target.querySelectorAll('.chapter-output, .chapter-mcp-output'));
    for (var n = target.nextElementSibling; n && !n.matches('.chapter-cmd, .chapter-agent'); n = n.nextElementSibling) {
      if (n.matches('.chapter-output')) outputs.push(n);
    }
    outputs.forEach(function(out) {
      var more = out.nextElementSibling;
      if (more && more.classList.contains('expand-toggle') && !out.classList.contains('expanded')) more.click();
    });
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('highlight');
    void el.offsetWidth;
    el.classList.add('highlight');
  }

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
    // same cause) collapse into one row with a count; each row opens the
    // first chapter where it happened on the failed call.
    const groups = [];
    const byKey = new Map();
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const add = (name, input, output, ref) => {
        const cause = failureCause(output);
        const key = name + '\\u0000' + cause.id + '\\u0000' + (cause.line || String(input || ''));
        let g = byKey.get(key);
        if (!g) {
          g = { chapter: i, ref: ref, name: name, input: String(input || ''), line: cause.line, label: cause.label, count: 0, inputs: new Set() };
          byKey.set(key, g);
          groups.push(g);
        }
        g.count++;
        if (input) g.inputs.add(String(input));
      };
      (ch.commands || []).forEach((c, j) => { if (!c.ok) add('Bash', c.cmd, c.output, 'cmd:' + j); });
      (ch.mcpOps || []).forEach((m, j) => { if (!m.ok) add(m.rawName || m.tool, '', m.output, 'mcp:' + j); });
      (ch.webOps || []).forEach((w, j) => { if (!w.ok) add(w.type === 'search' ? 'WebSearch' : 'WebFetch', w.url || w.query, w.output, 'web:' + j); });
      (ch.searches || []).forEach((q, j) => { if (!q.ok) add('Grep', q.query, q.output, 'grep:' + j); });
      (ch.agents || []).forEach((ag, j) => { if (ag.isError) add(ag.toolName || 'Agent', ag.description, ag.result, 'agent:' + j); });
      (ch.standaloneErrors || []).forEach((msg, j) => { add('error', '', msg, 'err:' + j); });
      (ch.failedCalls || []).forEach((f, j) => { add(f.name, f.input, f.output, 'call:' + j); });
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
          title: 'Open chapter ' + (g.chapter + 1) + ' at the failed call, where this first happened',
          'data-failure': g.chapter + '/' + g.ref,
          onClick: (ev) => { ev.stopPropagation(); revealFailure(g.chapter, g.ref); }
        },
          h('span', { className: 'error-list-count' }, g.count > 1 ? g.count + '\\u00d7' : ''),
          h('span', { className: 'error-list-tool' }, fmtMcpName(g.name)),
          h('span', { className: 'error-list-text' },
            g.label ? h('span', { className: 'error-list-cause' }, g.label) : null,
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
