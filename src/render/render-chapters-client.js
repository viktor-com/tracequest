/** Client-side chapter filter state and matching (embedded in session viewer). */
export const CHAPTERS_CLIENT_JS = `
  let activeToolFilters = new Set();
  let searchQuery = '';
  let _searchQueryLowerSrc = null;
  let _searchQueryLowerCache = '';
  let wasteFilterActive = false;

  function chapterMatchesFilter(ch) {
    if (wasteFilterActive) {
      if (!ch.efficiency || !ch.efficiency.isWasteful) return false;
    }
    if (activeToolFilters.size > 0) {
      const hasMatch = chapterToolKeys(ch).some(t => activeToolFilters.has(t));
      if (!hasMatch) return false;
    }
    if (searchQuery) {
      if (searchQuery !== _searchQueryLowerSrc) {
        _searchQueryLowerSrc = searchQuery;
        _searchQueryLowerCache = searchQuery.toLowerCase();
      }
      const q = _searchQueryLowerCache;
      // Early-exit for short queries: if query not in token index, chapter definitely doesn't match
      if (q.length <= 2) {
        if (q.length === 1) {
          const c = q.charCodeAt(0);
          if (c < 256) {
            if (!(ch._charBits[c >>> 5] & (1 << (c & 31)))) return false;
          } else if (!ch._extraChars.has(q)) {
            return false;
          }
        } else {
          const key = (q.charCodeAt(0) << 16) | q.charCodeAt(1);
          if (!ch._tokenBigrams.has(key)) return false;
        }
      }
      if (ch._promptLower.includes(q)) return true;
      if (ch._lastAssistantTextLower.includes(q)) return true;
      for (const cmd of ch.commands) {
        if (cmd._cmdLower.includes(q)) return true;
        if (cmd._outputLower && cmd._outputLower.includes(q)) return true;
      }
      for (const path of ch._fileKeysLower) {
        if (path.includes(q)) return true;
      }
      for (const s of ch.searches) {
        if (s._queryLower.includes(q)) return true;
      }
      for (const a of ch.agents) {
        if (a._descriptionLower.includes(q)) return true;
        if (a._promptLower.includes(q)) return true;
      }
      for (const d of ch.diffs) {
        if (d._pathLower.includes(q)) return true;
        if (d.diffInfo._oldStr && d.diffInfo._oldStrLower.includes(q)) return true;
        if (d.diffInfo._newStr && d.diffInfo._newStrLower.includes(q)) return true;
        if (d.diffInfo._content && d.diffInfo._contentLower.includes(q)) return true;
      }
      for (const g of ch.gitOps) {
        if (g._messageLower && g._messageLower.includes(q)) return true;
        if (g._branchLower && g._branchLower.includes(q)) return true;
        if (g._hashLower && g._hashLower.includes(q)) return true;
        if (g._cmdLower && g._cmdLower.includes(q)) return true;
      }
      for (const w of ch.webOps) {
        if (w._urlLower && w._urlLower.includes(q)) return true;
        if (w._queryLower && w._queryLower.includes(q)) return true;
        if (w._pageTitleLower && w._pageTitleLower.includes(q)) return true;
        if (w.results) {
          for (const r of w.results) {
            if (r._titleLower.includes(q)) return true;
            if (r._urlLower.includes(q)) return true;
          }
        }
      }
      for (const t of ch._thinkingLower) {
        if (t.includes(q)) return true;
      }
      for (const m of ch.mcpOps) {
        if (m._serverLower.includes(q)) return true;
        if (m._toolLower.includes(q)) return true;
        if (m._rawNameLower.includes(q)) return true;
        for (const pv of m._paramValsLower) {
          if (pv.includes(q)) return true;
        }
      }
      return false;
    }
    return true;
  }
`;