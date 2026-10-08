export const UI_CHAPTERS_JS = `
  function renderFilterBar() {
    const chapters = getChapters();
    const toolSet = {};
    let wastefulCount = 0;
    for (const ch of chapters) {
      if (ch.efficiency && ch.efficiency.isWasteful) wastefulCount++;
      for (const t of chapterToolKeys(ch)) {
        toolSet[t] = (toolSet[t] || 0) + ch.toolCounts[t];
      }
    }
    const priority = ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'Grep', 'Skill', 'WebSearch', 'WebFetch'];
    const sortedByCount = [];
    for (const name in toolSet) {
      if (Object.prototype.hasOwnProperty.call(toolSet, name)) sortedByCount.push(name);
    }
    sortedByCount.sort((a, b) => toolSet[b] - toolSet[a]);
    const chipNames = [];
    for (const p of priority) {
      if (toolSet[p]) chipNames.push(p);
    }
    for (const name of sortedByCount) {
      if (!chipNames.includes(name) && chipNames.length < 10) chipNames.push(name);
    }

    const bar = h('div', { className: 'filter-bar' });
    const toolsWrap = h('div', { className: 'filter-tools' });

    for (const name of chipNames) {
      const isActive = activeToolFilters.has(name);
      const chipLabel = fmtMcpName(name);
      const chip = h('button', {
        type: 'button',
        className: 'filter-chip' + (isActive ? ' active' : ''),
        'aria-label': 'Filter chapters by ' + chipLabel,
        'aria-pressed': isActive ? 'true' : 'false',
        onClick: (ev) => {
          ev.stopPropagation();
          if (activeToolFilters.has(name)) activeToolFilters.delete(name);
          else activeToolFilters.add(name);
          activeToolPerfFilter = null;
          var perfRows = document.querySelectorAll('.tool-perf-row');
          perfRows.forEach(function(r) { r.classList.remove('active'); });
          applyFilters();
        }
      }, chipLabel);
      chip.dataset.tool = name;
      toolsWrap.appendChild(chip);
    }
    if (wastefulCount > 0) {
      const wasteChip = h('button', {
        type: 'button',
        className: 'filter-chip' + (wasteFilterActive ? ' active' : ''),
        'aria-label': 'Show wasteful chapters',
        'aria-pressed': wasteFilterActive ? 'true' : 'false',
        onClick: (ev) => {
          ev.stopPropagation();
          wasteFilterActive = !wasteFilterActive;
          applyFilters();
          wasteChip.classList.toggle('active', wasteFilterActive);
          wasteChip.setAttribute('aria-pressed', wasteFilterActive ? 'true' : 'false');
        },
        style: 'border-color: rgba(232,164,76,0.3);'
      }, '\\u26a0 wasteful ' + wastefulCount);
      toolsWrap.appendChild(wasteChip);
    }
    bar.appendChild(toolsWrap);

    const searchInput = h('input', {
      className: 'filter-search',
      type: 'text',
      placeholder: 'search chapters...',
      'aria-label': 'Search chapters',
      'aria-describedby': 'filter-count',
    });
    searchInput.value = searchQuery;
    searchInput.addEventListener('input', function() {
      searchQuery = this.value;
      applyFilters();
    });
    // Bind after render(): the eval-time install in interactions-nav runs
    // before this input exists on a standalone export page.
    if (!document.getElementById('workspaceSearch')) {
      searchInput.setAttribute('data-hotkey', '/');
      if (typeof install === 'function') install(searchInput);
    }
    bar.appendChild(searchInput);

    const countEl = h('span', { className: 'filter-count', id: 'filter-count', role: 'status', 'aria-live': 'polite' });
    bar.appendChild(countEl);

    return bar;
  }

  function applyFilters() {
    const chapters = getChapters();
    let visible = 0;
    for (let i = 0; i < chapters.length; i++) {
      const el = document.getElementById('chapter-' + i);
      if (!el) continue;
      const matches = chapterMatchesFilter(chapters[i]);
      if (matches) {
        el.classList.remove('filter-hidden');
        visible++;
      } else {
        el.classList.add('filter-hidden');
      }
    }
    const countEl = document.getElementById('filter-count');
    if (countEl) {
      const hasFilter = activeToolFilters.size > 0 || searchQuery || wasteFilterActive;
      countEl.textContent = hasFilter ? visible + '/' + chapters.length : '';
    }
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(function(chip) {
      if (chip.textContent.indexOf('wasteful') !== -1) return;
      var toolKey = chip.dataset.tool || chip.textContent;
      if (activeToolFilters.has(toolKey)) {
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
      } else {
        chip.classList.remove('active');
        chip.setAttribute('aria-pressed', 'false');
      }
    });
    updateUrl();
  }

  function renderChapters() {
    const chapters = getChapters();
    const wrap = h('div', { className: 'chapters' });

    chapters.forEach((ch, idx) => {
      const expanded = expandedSet.has('ch' + idx);
      const outcome = ch.outcome || 'clean';
      const outcomeCls = outcome === 'struggling' ? 'error' : outcome;
      const outcomeLabel = outcome === 'clean' ? 'clean'
        : outcome === 'corrected' ? 'corrected'
        : outcome === 'struggling' ? 'struggling' : 'clean';

      const el = h('div', {
        id: 'chapter-' + idx,
        className: 'chapter' + (expanded ? ' expanded' : ''),
        onClick: () => {
          if (expanded) {
            expandedSet.delete('ch' + idx);
            clearChapterHash();
          } else {
            expandedSet.add('ch' + idx);
            setChapterHash(idx);
          }
          render();
        }
      });

      const toolChips = h('div', { className: 'chapter-tools' });
      const sortedTools = chapterToolKeys(ch).slice()
        .sort((a, b) => ch.toolCounts[b] - ch.toolCounts[a]);
      for (const name of sortedTools) {
        const count = ch.toolCounts[name];
        const cls = ['Bash','Read','Edit','Write','Agent'].includes(name) ? name : 'other';
        const chipLabel = fmtMcpName(name);
        toolChips.appendChild(h('span', { className: 'ch-tool ' + cls }, chipLabel + ' ' + count));
      }

      const startTime = ch.timestamp ? formatTime(ch.timestamp) : '';
      const endMs = new Date(ch.endTimestamp).getTime();
      const startMs = new Date(ch.timestamp).getTime();
      const dur = endMs - startMs;

      const patternBadges = [];
      if (ch.retries > 0) {
        patternBadges.push(h('span', { className: 'chapter-pattern-badge retry' },
          '\\u21bb ' + ch.retries + ' retr' + (ch.retries === 1 ? 'y' : 'ies')));
      }
      if (ch.selfCorrections > 0) {
        patternBadges.push(h('span', { className: 'chapter-pattern-badge correction' },
          '\\u2714 ' + ch.selfCorrections + ' self-fix' + (ch.selfCorrections === 1 ? '' : 'es')));
      }
      if (ch.efficiency && ch.efficiency.isWasteful) {
        patternBadges.push(h('span', { className: 'chapter-waste-badge' },
          '\\u26a0 waste' + (ch.efficiency.wasteTokens > 0 ? ' ~' + fmtTokens(ch.efficiency.wasteTokens) : '')));
      }
      if (ch.deps) {
        if (ch.deps.fixesFrom.length > 0) {
          var fixRef = ch.deps.fixesFrom[0];
          var badge = h('button', {
            type: 'button',
            className: 'chapter-dep-badge dep-fix',
            title: 'Fixes issues from chapter ' + (fixRef + 1),
            'aria-label': 'Jump to chapter ' + (fixRef + 1) + ' fixed by this chapter',
            onClick: function(ev) {
              ev.stopPropagation();
              var target = document.getElementById('chapter-' + fixRef);
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, '\\u2192 fixes ch ' + (fixRef + 1));
          patternBadges.push(badge);
        } else if (ch.deps.continuesFrom.length > 0) {
          var contRef = ch.deps.continuesFrom[ch.deps.continuesFrom.length - 1];
          var badge = h('button', {
            type: 'button',
            className: 'chapter-dep-badge',
            title: 'Continues work from chapter ' + (contRef + 1),
            'aria-label': 'Jump to chapter ' + (contRef + 1) + ' continued by this chapter',
            onClick: function(ev) {
              ev.stopPropagation();
              var target = document.getElementById('chapter-' + contRef);
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, '\\u2192 from ch ' + (contRef + 1));
          patternBadges.push(badge);
        }
      }

      const dotCls = 'chapter-outcome-dot dot-' + outcome;

      const head = h('div', { className: 'chapter-head' },
        h('span', { className: 'chapter-num' },
          String(idx + 1),
          h('span', { className: dotCls })
        ),
        h('div', { className: 'chapter-body' },
          h('div', { className: 'chapter-prompt' },
            h('span', { className: 'chapter-prompt-text' }, ch.prompt)
          ),
          h('div', { className: 'chapter-meta' },
            toolChips,
            ch.gitOps.length > 0
              ? (function() {
                  var commits = countGitOpsOfType(ch.gitOps, 'commit');
                  var label = commits > 0 ? '● ' + commits + ' commit' + (commits > 1 ? 's' : '') : '⑃ ' + ch.gitOps.length + ' git op' + (ch.gitOps.length > 1 ? 's' : '');
                  return h('span', { className: 'chapter-git-badge' }, label);
                })()
              : null,
            ch.mcpOps.length > 0
              ? (function() {
                  var servers = {};
                  for (var mci = 0; mci < ch.mcpOps.length; mci++) {
                    var sv = ch.mcpOps[mci].server;
                    servers[sv] = (servers[sv] || 0) + 1;
                  }
                  var svNames = Object.keys(servers);
                  var label = svNames.length === 1
                    ? svNames[0].replace(/_/g, ' ') + ' \\u00d7' + ch.mcpOps.length
                    : ch.mcpOps.length + ' MCP';
                  return h('span', { className: 'chapter-mcp-badge' }, '\\u2699 ' + label);
                })()
              : null,
            patternBadges.length > 0
              ? (function() {
                  var wrap = h('span', { className: 'chapter-patterns' });
                  patternBadges.forEach(function(b) { wrap.appendChild(b); });
                  return wrap;
                })()
              : null,
            h('span', { className: 'chapter-outcome ' + outcomeCls }, outcomeLabel),
          )
        ),
        h('div', { className: 'chapter-right' },
          h('div', { className: 'chapter-time' }, startTime),
          h('div', { className: 'chapter-turns' },
            ch.turns + ' turn' + (ch.turns !== 1 ? 's' : '') +
            (dur > 1000 ? ' · ' + formatDuration(dur) : '')
          ),
          (ch.tokens.input > 0 || ch.tokens.output > 0)
            ? h('div', { className: 'chapter-tokens' },
                fmtTokens(ch.tokens.input + ch.tokens.output) + ' tok' +
                (ch.tokens.cacheHit > 0 && ch.tokens.input > 0 ? ' · ' + fmtPct(ch.tokens.cacheHit / ch.tokens.input * 100) + ' cache' : '')
              )
            : null,
          ch.thinking.length > 0
            ? h('div', { className: 'chapter-thinking-badge' },
                '\u{1F9E0} ' + countWordsInStrings(ch.thinking).toLocaleString() + ' words'
              )
            : null,
          (function() {
            var link = h('button', {
              type: 'button',
              className: 'chapter-permalink',
              title: 'Copy link to this chapter',
              'aria-label': 'Copy link to chapter ' + (idx + 1),
              onClick: function(ev) {
                ev.stopPropagation();
                var url = getPermalink(idx);
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(url).then(function() {
                    link.textContent = '\\u2713';
                    link.classList.add('copied');
                    link.setAttribute('aria-label', 'Copied link to chapter ' + (idx + 1));
                    setTimeout(function() { link.textContent = '\\u26d3'; link.classList.remove('copied'); link.setAttribute('aria-label', 'Copy link to chapter ' + (idx + 1)); }, 1500);
                  });
                } else {
                  var tmp = document.createElement('input');
                  tmp.value = url;
                  document.body.appendChild(tmp);
                  tmp.select();
                  document.execCommand('copy');
                  document.body.removeChild(tmp);
                  link.textContent = '\\u2713';
                  link.classList.add('copied');
                  link.setAttribute('aria-label', 'Copied link to chapter ' + (idx + 1));
                  setTimeout(function() { link.textContent = '\\u26d3'; link.classList.remove('copied'); link.setAttribute('aria-label', 'Copy link to chapter ' + (idx + 1)); }, 1500);
                }
              }
            }, '\\u26d3');
            return link;
          })(),
        )
      );
      el.appendChild(head);

      const detail = h('div', { className: 'chapter-detail' });
      if (expanded) {
        buildChapterDetail(ch, idx, detail);
      }
      el.appendChild(detail);
      wrap.appendChild(el);
    });

    return wrap;
  }
`;
