export const UI_DETAIL_JS = `
  function buildChapterDetail(ch, _idx, detail) {
    var outcome = ch.outcome || 'clean';

    if (ch.retries > 0 || ch.selfCorrections > 0) {
      var qDiv = h('div', { className: 'chapter-quality' });
      var qLabel = outcome === 'struggling' ? 'struggling'
        : outcome === 'corrected' ? 'self-corrected' : 'minor issues';
      qDiv.appendChild(h('div', { className: 'chapter-quality-label ' + outcome }, qLabel));
      if (ch.retryGroups.length > 0) {
        var retryDiv = h('div', { className: 'chapter-quality-retries' });
        for (var ri = 0; ri < ch.retryGroups.length && ri < 4; ri++) {
          var rg = ch.retryGroups[ri];
          retryDiv.appendChild(h('span', { className: 'chapter-retry-chip' },
            rg.tool + ' \\u00d7' + rg.count + (rg.input ? ' (' + rg.input.slice(0, 30) + (rg.input.length > 30 ? '...' : '') + ')' : '')));
        }
        qDiv.appendChild(retryDiv);
      }
      if (ch.selfCorrections > 0) {
        qDiv.appendChild(h('div', { className: 'chapter-quality-corrections' },
          '\\u2714 ' + ch.selfCorrections + ' error' + (ch.selfCorrections === 1 ? '' : 's') + ' detected and resolved'));
      }
      detail.appendChild(qDiv);
    }

    if (ch.deps && (ch.deps.continuesFrom.length > 0 || ch.deps.fixesFrom.length > 0)) {
      var depDiv = h('div', { className: 'chapter-dep-section' });
      depDiv.appendChild(h('div', { className: 'chapter-dep-section-title' }, 'related chapters'));
      if (ch.deps.fixesFrom.length > 0) {
        for (var fi = 0; fi < ch.deps.fixesFrom.length; fi++) {
          var ref = ch.deps.fixesFrom[fi];
          var row = document.createElement('div');
          row.style.marginBottom = '3px';
          var link = h('button', {
            type: 'button',
            className: 'chapter-dep-link',
            'aria-label': 'Jump to chapter ' + (ref + 1) + ' fixed by this chapter',
            onClick: (function(r) { return function(ev) {
              ev.stopPropagation();
              var target = document.getElementById('chapter-' + r);
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }; })(ref)
          }, '\\u2714 fixes ch ' + (ref + 1));
          row.appendChild(link);
          var shared = ch.deps.sharedFiles[ref] || [];
          if (shared.length > 0) {
            row.appendChild(h('span', { className: 'chapter-dep-shared-files' },
              '(' + shared.slice(0, 3).join(', ') + (shared.length > 3 ? ' +' + (shared.length - 3) : '') + ')'));
          }
          depDiv.appendChild(row);
        }
      }
      if (ch.deps.continuesFrom.length > 0) {
        for (var ci2 = 0; ci2 < ch.deps.continuesFrom.length; ci2++) {
          var ref2 = ch.deps.continuesFrom[ci2];
          var row2 = document.createElement('div');
          row2.style.marginBottom = '3px';
          var link2 = h('button', {
            type: 'button',
            className: 'chapter-dep-link',
            'aria-label': 'Jump to chapter ' + (ref2 + 1) + ' continued by this chapter',
            onClick: (function(r) { return function(ev) {
              ev.stopPropagation();
              var target = document.getElementById('chapter-' + r);
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }; })(ref2)
          }, '\\u2192 continues ch ' + (ref2 + 1));
          row2.appendChild(link2);
          var shared2 = ch.deps.sharedFiles[ref2] || [];
          if (shared2.length > 0) {
            row2.appendChild(h('span', { className: 'chapter-dep-shared-files' },
              '(' + shared2.slice(0, 3).join(', ') + (shared2.length > 3 ? ' +' + (shared2.length - 3) : '') + ')'));
          }
          depDiv.appendChild(row2);
        }
      }
      detail.appendChild(depDiv);
    }

    if (ch.efficiency && (ch.efficiency.isWasteful || ch.efficiency.score < 70)) {
      var effDiv = h('div', { className: 'chapter-efficiency' });
      var effHeader = h('div', { className: 'chapter-efficiency-header' });
      var scoreLabel = ch.efficiency.score >= 70 ? 'moderate efficiency'
        : ch.efficiency.score >= 40 ? 'low efficiency' : 'wasteful';
      effHeader.appendChild(h('span', { className: 'chapter-efficiency-label' }, scoreLabel));
      effHeader.appendChild(h('span', { className: 'chapter-efficiency-score' }, ch.efficiency.score + '/100'));
      effDiv.appendChild(effHeader);

      var barWrap = h('div', { className: 'chapter-efficiency-bar-wrap' });
      var barCls = ch.efficiency.score >= 70 ? 'eff-good' : ch.efficiency.score >= 40 ? 'eff-ok' : 'eff-bad';
      var bar = h('div', { className: 'chapter-efficiency-bar ' + barCls });
      bar.style.width = Math.max(2, ch.efficiency.score) + '%';
      barWrap.appendChild(bar);
      effDiv.appendChild(barWrap);

      var metricsDiv = h('div', { className: 'chapter-efficiency-metrics' });
      if (ch.efficiency.tokPerFile > 0) {
        var valCls = ch.efficiency.tokPerFile > 500000 ? 'val-bad' : '';
        metricsDiv.appendChild(h('span', { className: 'chapter-efficiency-metric' },
          'tokens/file: ',
          h('span', { className: 'chapter-efficiency-metric-value ' + valCls }, fmtTokens(ch.efficiency.tokPerFile))
        ));
      }
      if (ch.efficiency.tokPerCommit > 0) {
        var valCls2 = ch.efficiency.tokPerCommit > 1000000 ? 'val-bad' : '';
        metricsDiv.appendChild(h('span', { className: 'chapter-efficiency-metric' },
          'tokens/commit: ',
          h('span', { className: 'chapter-efficiency-metric-value ' + valCls2 }, fmtTokens(ch.efficiency.tokPerCommit))
        ));
      }
      if (ch.efficiency.errorTokens > 0) {
        metricsDiv.appendChild(h('span', { className: 'chapter-efficiency-metric' },
          'error tokens: ',
          h('span', { className: 'chapter-efficiency-metric-value val-bad' }, '~' + fmtTokens(ch.efficiency.errorTokens))
        ));
      }
      if (ch.efficiency.wasteTokens > 0) {
        metricsDiv.appendChild(h('span', { className: 'chapter-efficiency-metric' },
          'est. wasted: ',
          h('span', { className: 'chapter-efficiency-metric-value val-bad' }, '~' + fmtTokens(ch.efficiency.wasteTokens))
        ));
      }
      if (metricsDiv.childNodes.length > 0) effDiv.appendChild(metricsDiv);

      if (ch.efficiency.wasteReasons.length > 0) {
        var reasonsDiv = h('div', { className: 'chapter-efficiency-reasons' });
        for (var wr = 0; wr < ch.efficiency.wasteReasons.length; wr++) {
          reasonsDiv.appendChild(h('span', { className: 'chapter-efficiency-reason' }, ch.efficiency.wasteReasons[wr]));
        }
        effDiv.appendChild(reasonsDiv);
      }
      detail.appendChild(effDiv);
    }

    var fileKeys = chapterFileKeys(ch);
    if (fileKeys.length) {
      var filesDiv = h('div', { className: 'chapter-files' });
      filesDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'files'));
      for (var fei = 0; fei < fileKeys.length; fei++) {
        var path = fileKeys[fei];
        var info = ch.files[path];
        var opCount = {};
        info.ops.forEach(function(o) { opCount[o] = (opCount[o] || 0) + 1; });
        var opStr = '';
        var opFirst = true;
        for (var op in opCount) {
          if (!Object.prototype.hasOwnProperty.call(opCount, op)) continue;
          if (!opFirst) opStr += ', ';
          opFirst = false;
          var opN = opCount[op];
          opStr += op.toLowerCase() + (opN > 1 ? ' \\u00d7' + opN : '');
        }
        filesDiv.appendChild(h('div', { className: 'chapter-file' },
          path,
          h('span', { className: 'chapter-file-ops' }, opStr)
        ));
        if (info.output) {
          filesDiv.appendChild(h('div', { className: 'chapter-output' }, info.output));
        }
      }
      detail.appendChild(filesDiv);
    }

    if (ch.gitOps.length > 0) {
      var gitDiv = h('div', { className: 'chapter-git-ops' });
      gitDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'git'));
      for (var gi = 0; gi < ch.gitOps.length; gi++) {
        var op = ch.gitOps[gi];
        var iconCls = 'chapter-git-op-icon ';
        var icon = '';
        if (op.type === 'commit') { iconCls += 'commit'; icon = '\\u25cf'; }
        else if (op.type === 'push') { iconCls += 'push'; icon = '\\u2191'; }
        else if (op.type === 'branch-create' || op.type === 'branch-switch') { iconCls += 'branch'; icon = '\\u2443'; }
        else if (op.type === 'merge' || op.type === 'rebase') { iconCls += 'merge'; icon = '\\u2442'; }
        else { icon = '\\u00b7'; }

        var desc = '';
        if (op.type === 'commit') {
          desc = (op.hash ? op.hash.slice(0, 7) + ' ' : '') + (op.message || '(no message)');
        } else if (op.type === 'push') {
          desc = 'push' + (op.remote ? ' ' + op.remote : '') + (op.branch ? ' ' + op.branch : '') + (op.tags ? ' --tags' : '');
        } else if (op.type === 'branch-create') {
          desc = 'create branch ' + (op.branch || '');
        } else if (op.type === 'branch-switch') {
          desc = 'switch to ' + (op.branch || '');
        } else if (op.type === 'merge') {
          desc = 'merge ' + (op.branch || '');
        } else if (op.type === 'rebase') {
          desc = 'rebase onto ' + (op.branch || '');
        } else if (op.type === 'tag') {
          desc = 'tag ' + (op.tag || '');
        } else if (op.type === 'stash') {
          desc = 'stash';
        } else {
          desc = op.type;
        }

        gitDiv.appendChild(h('div', { className: 'chapter-git-op' },
          h('span', { className: iconCls }, icon),
          desc
        ));
      }
      detail.appendChild(gitDiv);
    }

    if (ch.agents.length) {
      var agentsDiv = h('div', { className: 'chapter-agents' });
      agentsDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'subagents'));
      for (var ai = 0; ai < ch.agents.length; ai++) {
        var a = ch.agents[ai];
        var statusCls = a.isError ? 'fail' : (a.completed ? 'ok' : 'pending');
        var statusIcon = a.isError ? '\\u2717' : (a.completed ? '\\u2713' : '\\u25e6');
        var typeBadge = a.subagentType ? h('span', { className: 'chapter-agent-type' }, a.subagentType) : null;
        var toolBadge = a.toolName !== 'Agent' ? h('span', { className: 'chapter-agent-type' }, a.toolName) : null;
        agentsDiv.appendChild(h('div', { className: 'chapter-agent' },
          h('span', { className: 'chapter-agent-status ' + statusCls }, statusIcon),
          h('span', { className: 'chapter-agent-desc' }, a.description || '(unnamed)'),
          typeBadge,
          toolBadge
        ));
        if (a.prompt) {
          agentsDiv.appendChild(h('div', { className: 'chapter-agent-prompt' }, a.prompt.slice(0, 200)));
        }
        if (a.result && a.completed) {
          agentsDiv.appendChild(h('div', { className: 'chapter-output' }, joinFirstLines(a.result, 4)));
        }
      }
      detail.appendChild(agentsDiv);
    }

    if (ch.diffs.length) {
      var diffsDiv = h('div', { className: 'chapter-diffs' });
      diffsDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'changes'));
      for (var di = 0; di < ch.diffs.length && di < 6; di++) {
        var d = ch.diffs[di];
        var label = d.name === 'Write' ? 'write' : 'edit';
        diffsDiv.appendChild(h('div', { className: 'chapter-diff-header' },
          h('span', { className: 'chapter-diff-path' }, d.path),
          h('span', { className: 'chapter-diff-op' }, label)
        ));
        if (d.name === 'Edit' && d.diffInfo.oldStr) {
          var diffBlock = h('div', { className: 'chapter-diff-block' });
          diffBlock.appendChild(h('div', { className: 'chapter-diff-del' }, d.diffInfo.oldStr));
          if (d.diffInfo.newStr) {
            diffBlock.appendChild(h('div', { className: 'chapter-diff-add' }, d.diffInfo.newStr));
          }
          diffsDiv.appendChild(diffBlock);
        } else if (d.name === 'Write' && d.diffInfo.content) {
          diffsDiv.appendChild(h('div', { className: 'chapter-diff-block' },
            h('div', { className: 'chapter-diff-add' }, joinFirstLines(d.diffInfo.content, 6))
          ));
        }
      }
      if (ch.diffs.length > 6) {
        diffsDiv.appendChild(h('div', { className: 'chapter-diff-header' },
          h('span', { className: 'chapter-diff-op' }, '\\u2026 ' + (ch.diffs.length - 6) + ' more changes')
        ));
      }
      detail.appendChild(diffsDiv);
    }

    if (ch.searches.length) {
      var searchDiv = h('div', { className: 'chapter-commands' });
      searchDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'searches'));
      for (var si = 0; si < ch.searches.length && si < 6; si++) {
        var s = ch.searches[si];
        var sLabel = s.matches > 0 ? s.matches + ' match' + (s.matches !== 1 ? 'es' : '') : (s.ok ? 'no matches' : 'error');
        searchDiv.appendChild(h('div', { className: 'chapter-cmd' },
          h('span', { className: 'chapter-cmd-status ' + (s.ok ? 'ok' : 'fail') }, s.ok ? '\\u2713' : '\\u2717'),
          s.query.slice(0, 100),
          h('span', { className: 'chapter-search-count' }, sLabel)
        ));
        if (s.output) {
          searchDiv.appendChild(h('div', { className: 'chapter-output' }, joinFirstLines(s.output, 3)));
        }
      }
      detail.appendChild(searchDiv);
    }

    if (ch.webOps.length) {
      var webDiv = h('div', { className: 'chapter-web' });
      webDiv.appendChild(h('div', { className: 'chapter-web-label' }, 'web'));
      for (var wi = 0; wi < ch.webOps.length && wi < 6; wi++) {
        var w = ch.webOps[wi];
        var opDiv = h('div', { className: 'chapter-web-op' + (w.ok ? '' : ' error') });
        var wTypeBadge = h('span', { className: 'chapter-web-type ' + w.type }, w.type);
        if (w.type === 'fetch') {
          var headerRow = h('div', {});
          headerRow.appendChild(wTypeBadge);
          if (w.url) {
            var wLink = h('a', { className: 'chapter-web-url', href: w.url, target: '_blank', rel: 'noopener' }, w.url.slice(0, 80) + (w.url.length > 80 ? '...' : ''));
            wLink.addEventListener('click', function(ev) { ev.stopPropagation(); });
            headerRow.appendChild(wLink);
          }
          opDiv.appendChild(headerRow);
          if (w.pageTitle) {
            opDiv.appendChild(h('div', { className: 'chapter-web-title' }, w.pageTitle));
          }
          if (w.prompt) {
            opDiv.appendChild(h('div', { className: 'chapter-web-prompt' }, w.prompt));
          }
          if (w.preview) {
            opDiv.appendChild(h('div', { className: 'chapter-web-preview' }, w.preview));
          }
        } else if (w.type === 'search') {
          var headerRow2 = h('div', {});
          headerRow2.appendChild(wTypeBadge);
          headerRow2.appendChild(h('span', { className: 'chapter-web-query' }, w.query.slice(0, 100)));
          if (w.resultCount) {
            headerRow2.appendChild(h('span', { className: 'chapter-web-count' }, w.resultCount + ' result' + (w.resultCount !== 1 ? 's' : '')));
          }
          opDiv.appendChild(headerRow2);
          if (w.results && w.results.length) {
            var resultsDiv = h('div', { className: 'chapter-web-results' });
            for (var wri = 0; wri < w.results.length && wri < 3; wri++) {
              var r = w.results[wri];
              var resultRow = h('div', { className: 'chapter-web-result' });
              resultRow.appendChild(h('span', { className: 'chapter-web-result-title' }, r.title));
              if (r.url) {
                var rLink = h('a', { className: 'chapter-web-result-url', href: r.url, target: '_blank', rel: 'noopener' }, r.url.replace(/^https?:\\/\\//, '').slice(0, 40));
                rLink.addEventListener('click', function(ev) { ev.stopPropagation(); });
                resultRow.appendChild(rLink);
              }
              resultsDiv.appendChild(resultRow);
            }
            opDiv.appendChild(resultsDiv);
          }
        }
        webDiv.appendChild(opDiv);
      }
      if (ch.webOps.length > 6) {
        webDiv.appendChild(h('div', { className: 'chapter-web-op' },
          h('span', { className: 'chapter-web-type fetch' }, '... ' + (ch.webOps.length - 6) + ' more')
        ));
      }
      detail.appendChild(webDiv);
    }

    if (ch.mcpOps.length) {
      var mcpDiv = h('div', { className: 'chapter-mcp' });
      mcpDiv.appendChild(h('div', { className: 'chapter-mcp-label' }, 'integrations'));
      for (var mi = 0; mi < ch.mcpOps.length && mi < 10; mi++) {
        var mop = ch.mcpOps[mi];
        var mcpCard = h('div', { className: 'chapter-mcp-op' + (mop.ok ? '' : ' mcp-error') });
        var mcpHeader = h('div', { className: 'chapter-mcp-header' });
        mcpHeader.appendChild(h('span', { className: 'chapter-mcp-server' }, mop.server.replace(/_/g, ' ')));
        mcpHeader.appendChild(h('span', { className: 'chapter-mcp-tool' }, mop.tool.replace(/_/g, ' ')));
        mcpHeader.appendChild(h('span', { className: 'chapter-mcp-status ' + (mop.ok ? 'ok' : 'fail') }, mop.ok ? '\\u2713' : '\\u2717'));
        mcpCard.appendChild(mcpHeader);
        var paramKeys = Object.keys(mop.params);
        if (paramKeys.length) {
          var paramsDiv = h('div', { className: 'chapter-mcp-params' });
          for (var pk = 0; pk < paramKeys.length && pk < 4; pk++) {
            var pKey = paramKeys[pk];
            var pVal = mop.params[pKey];
            paramsDiv.appendChild(h('span', {}, h('span', { className: 'chapter-mcp-param-key' }, pKey + ': '), h('span', { className: 'chapter-mcp-param-val' }, (pVal || '').slice(0, 120))));
          }
          mcpCard.appendChild(paramsDiv);
        }
        if (mop.output) {
          var mcpOut = safeSlice(joinFirstLines(mop.output, 4), 300);
          mcpCard.appendChild(h('div', { className: 'chapter-mcp-output' }, mcpOut));
        }
        mcpDiv.appendChild(mcpCard);
      }
      if (ch.mcpOps.length > 10) {
        mcpDiv.appendChild(h('div', { className: 'chapter-mcp-op' },
          h('span', { className: 'chapter-mcp-tool' }, '\\u2026 ' + (ch.mcpOps.length - 10) + ' more')
        ));
      }
      detail.appendChild(mcpDiv);
    }

    var cmds = ch.commands.slice(0, 8);
    if (cmds.length) {
      var cmdsDiv = h('div', { className: 'chapter-commands' });
      cmdsDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'commands'));
      for (var cmi = 0; cmi < cmds.length; cmi++) {
        var cmd = cmds[cmi];
        cmdsDiv.appendChild(h('div', { className: 'chapter-cmd' },
          h('span', { className: 'chapter-cmd-status ' + (cmd.ok ? 'ok' : 'fail') }, cmd.ok ? '\\u2713' : '\\u2717'),
          cmd.cmd.slice(0, 120)
        ));
        if (cmd.output) {
          cmdsDiv.appendChild(h('div', { className: 'chapter-output' }, joinFirstLines(cmd.output, 4)));
        }
      }
      if (ch.commands.length > 8) {
        cmdsDiv.appendChild(h('div', { className: 'chapter-cmd' },
          h('span', { className: 'chapter-cmd-status ok' }, ''),
          '\\u2026 ' + (ch.commands.length - 8) + ' more'
        ));
      }
      detail.appendChild(cmdsDiv);
    }

    if (ch.standaloneErrors && ch.standaloneErrors.length) {
      var seDiv = h('div', { className: 'chapter-commands' });
      seDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'errors'));
      for (var sei = 0; sei < ch.standaloneErrors.length; sei++) {
        seDiv.appendChild(h('div', { className: 'chapter-cmd' },
          h('span', { className: 'chapter-cmd-status fail' }, '\\u2717'),
          ch.standaloneErrors[sei].slice(0, 300)
        ));
      }
      detail.appendChild(seDiv);
    }

    if (ch.tokens.input > 0 || ch.tokens.output > 0) {
      var tokDiv = h('div', { className: 'chapter-token-detail' });
      tokDiv.appendChild(h('div', { className: 'chapter-files-label' }, 'tokens'));
      var parts = [
        'input: ' + fmtTokens(ch.tokens.input),
        'output: ' + fmtTokens(ch.tokens.output),
      ];
      if (ch.tokens.cacheHit > 0) parts.push('cache read: ' + fmtTokens(ch.tokens.cacheHit));
      if (ch.tokens.cacheWrite > 0) parts.push('cache write: ' + fmtTokens(ch.tokens.cacheWrite));
      var total = ch.tokens.input + ch.tokens.output;
      parts.push('total: ' + fmtTokens(total));
      tokDiv.appendChild(h('div', { className: 'chapter-token-breakdown' }, parts.join(' \\u00b7 ')));

      var cost = estimateChapterTokenCost(session.model, ch.tokens);
      const costLabel = fmtCost(cost, { min: 0.001 });
      if (costLabel) {
        tokDiv.appendChild(h('div', { className: 'chapter-token-cost' }, costLabel));
      }
      detail.appendChild(tokDiv);
    }

    if (ch.thinking.length) {
      var thinkDiv = h('div', { className: 'chapter-thinking' });
      var totalWords = countWordsInStrings(ch.thinking);
      var countLabel = ch.thinking.length === 1
        ? totalWords.toLocaleString() + ' words'
        : ch.thinking.length + ' blocks \\u00b7 ' + totalWords.toLocaleString() + ' words';
      thinkDiv.appendChild(h('div', { className: 'chapter-thinking-header' },
        h('span', { className: 'chapter-thinking-icon' }, '\\u{1F9E0}'),
        h('span', { className: 'chapter-files-label' }, 'thinking'),
        h('span', { className: 'chapter-thinking-count' }, countLabel)
      ));
      for (var ti = 0; ti < ch.thinking.length && ti < 3; ti++) {
        var preview = safeSlice(joinFirstLines(ch.thinking[ti], 5), 400);
        thinkDiv.appendChild(h('div', { className: 'chapter-thinking-block' }, preview));
      }
      if (ch.thinking.length > 3) {
        thinkDiv.appendChild(h('div', { className: 'chapter-thinking-more' }, '\\u2026 ' + (ch.thinking.length - 3) + ' more thinking blocks'));
      }
      detail.appendChild(thinkDiv);
    }

    if (ch.lastAssistantText) {
      detail.appendChild(h('div', { className: 'chapter-response' }, ch.lastAssistantText.slice(0, 500)));
    }
  }

  function expandAllChapterDetails() {
    var chapters = getChapters();
    for (var i = 0; i < chapters.length; i++) {
      var el = document.getElementById('chapter-' + i);
      if (!el) continue;
      var detail = el.querySelector('.chapter-detail');
      if (detail && detail.childNodes.length === 0) {
        buildChapterDetail(chapters[i], i, detail);
      }
    }
    attachExpandToggles();
  }

  window.addEventListener('beforeprint', function() {
    expandAllChapterDetails();
  });
`;
