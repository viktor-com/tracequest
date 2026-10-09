export const MAIN_JS = `  /**
   * One titled band of the page. Bands whose content rendered nothing (an
   * empty div) are left out, so a short session reads short.
   */
  function svSection(key, title, sub) {
    const nodes = Array.prototype.slice.call(arguments, 3).filter(function (n) {
      return n && (n.childNodes ? n.childNodes.length > 0 : true);
    });
    if (!nodes.length) return h('div');
    const head = h('div', { className: 'sv-section-head' },
      h('h2', { className: 'sv-section-title' }, title),
      sub ? h('span', { className: 'sv-section-sub' }, sub) : null
    );
    return h('section', { className: 'sv-section sv-' + key, 'aria-label': title }, head, nodes);
  }

  function render() {
    app.innerHTML = '';
    chaptersCache = null;
    if (typeof refreshChartPalette === 'function') refreshChartPalette();
    app.appendChild(renderHeader());
    app.appendChild(h('div', { className: 'sv-overview' }, renderSessionSummary(), renderStats()));
    app.appendChild(svSection('errors', 'What went wrong', 'Failures grouped by cause. Click one to jump to where it first happened.', renderErrorSummary()));
    app.appendChild(svSection('timeline', 'Timeline', 'When the agent worked, waited and spent.', renderActivityTimeline(), renderWaveform(), renderCostChart()));
    app.appendChild(svSection('chapters', 'Chapters', 'One per prompt. Filter by tool or text; j and k step through.', renderFilterBar(), renderChapters()));
    app.appendChild(svSection('tools', 'Tools and files', 'What the agent used and touched.', renderToolFlow(), renderToolPerformance(), renderFileHotspot(), renderGitTimeline()));
    requestAnimationFrame(function() {
      attachExpandToggles();
      attachChapterTooltips();
      renderMiniMap();
      if (activeFileFilter) applyFileFilter();
      else applyFilters();
      requestAnimationFrame(function() { updateMiniMapViewport(); });
    });
  }`;
