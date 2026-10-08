export const MAIN_JS = `  function render() {
    app.innerHTML = '';
    chaptersCache = null;
    app.appendChild(renderHeader());
    app.appendChild(renderSessionSummary());
    app.appendChild(renderActivityTimeline());
    app.appendChild(renderStats());
    app.appendChild(renderGitTimeline());
    app.appendChild(renderErrorSummary());
    app.appendChild(renderWaveform());
    app.appendChild(renderToolFlow());
    app.appendChild(renderToolPerformance());
    app.appendChild(renderCostChart());
    app.appendChild(renderFileHotspot());
    app.appendChild(renderFilterBar());
    app.appendChild(renderChapters());
    requestAnimationFrame(function() {
      attachExpandToggles();
      attachChapterTooltips();
      renderMiniMap();
      if (activeFileFilter) applyFileFilter();
      else applyFilters();
      requestAnimationFrame(function() { updateMiniMapViewport(); });
    });
  }`;
