import { chapterFileKeys } from "./chapter-keys.js";

/**
 * Browser-render enrichment after buildSessionChapters (deps, filter cache, token index).
 * Not used by compare/markdown — only HTML chapter UI.
 */
export function enrichChaptersForRender(chapters) {
  const EMPTY_DEPS = { continuesFrom: [], fixesFrom: [], sharedFiles: {} };
  function addChapterTokens(charBits, bigrams, extraChars, str) {
    if (!str) return;
    const len = str.length;
    for (let i = 0; i < len; i++) {
      const c = str.charCodeAt(i);
      if (c < 256) charBits[c >>> 5] |= 1 << (c & 31);
      else extraChars.add(str[i]);
      if (i + 1 < len) bigrams.add((c << 16) | str.charCodeAt(i + 1));
    }
  }

  function cacheLowerAndToken(charBits, bigrams, extraChars, raw) {
    const str = (raw || "").toLowerCase();
    addChapterTokens(charBits, bigrams, extraChars, str);
    return str;
  }
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chFiles = chapterFileKeys(ch);
    if (chFiles.length === 0 && ch.errors === 0) {
      ch.deps = EMPTY_DEPS;
      continue;
    }

    const lookback = Math.max(0, i - 10);
    const continuesRefs = new Set();
    const fixesRefs = new Set();
    const sharedFiles = {};
    for (let j = lookback; j < i; j++) {
      const prev = chapters[j];
      let prevFileSet = prev._fileKeysSet;
      if (!prevFileSet) {
        prev._fileKeysSet = prevFileSet = new Set(chapterFileKeys(prev));
      }
      const shared = [];
      for (const f of chFiles) {
        if (prevFileSet.has(f)) shared.push(f);
      }
      if (shared.length > 0) {
        sharedFiles[j] = shared;
        if (
          shared.length >= Math.min(2, chFiles.length) ||
          shared.length >= chFiles.length * 0.5
        ) {
          continuesRefs.add(j);
        }
      }

      if (prev.outcome === "struggling" || prev.errors >= 2) {
        if (shared.length > 0) {
          fixesRefs.add(j);
          // Remove from continuesFrom to avoid double-labeling
          continuesRefs.delete(j);
        }
      }
    }
    if (
      continuesRefs.size === 0 &&
      fixesRefs.size === 0 &&
      Object.keys(sharedFiles).length === 0
    ) {
      ch.deps = EMPTY_DEPS;
    } else {
      ch.deps = {
        continuesFrom: Array.from(continuesRefs),
        fixesFrom: Array.from(fixesRefs),
        sharedFiles,
      };
    }
  }

  const chainOf = new Array(chapters.length).fill(-1);
  let chainCount = 0;
  for (let i = 0; i < chapters.length; i++) {
    const deps = chapters[i].deps;
    const continuesFrom = deps.continuesFrom;
    const fixesFrom = deps.fixesFrom;
    if (continuesFrom.length === 0 && fixesFrom.length === 0) continue;
    let existingChain = -1;
    for (let r = 0; r < continuesFrom.length; r++) {
      const ref = continuesFrom[r];
      if (chainOf[ref] >= 0) {
        existingChain = chainOf[ref];
        break;
      }
    }
    if (existingChain < 0) {
      for (let r = 0; r < fixesFrom.length; r++) {
        const ref = fixesFrom[r];
        if (chainOf[ref] >= 0) {
          existingChain = chainOf[ref];
          break;
        }
      }
    }
    if (existingChain >= 0) {
      chainOf[i] = existingChain;
    } else {
      const seed = continuesFrom.length > 0 ? continuesFrom[0] : fixesFrom[0];
      chainOf[seed] = chainCount;
      chainOf[i] = chainCount;
      chainCount++;
    }
  }
  const chainsSet = new Set();
  let chaptersInChains = 0;
  for (let i = 0; i < chainOf.length; i++) {
    if (chainOf[i] >= 0) {
      chainsSet.add(chainOf[i]);
      chaptersInChains++;
    }
  }
  const workflowChainCount = chainsSet.size;
  if (chapters.length > 0) {
    chapters._depSummary = { chains: workflowChainCount, chaptersInChains };
  }

  for (const ch of chapters) {
    const charBits = (ch._charBits = new Uint32Array(8));
    const bigrams = (ch._tokenBigrams = new Set());
    const extraChars = (ch._extraChars = new Set());
    ch._promptLower = cacheLowerAndToken(charBits, bigrams, extraChars, ch.prompt);
    ch._lastAssistantTextLower = cacheLowerAndToken(
      charBits,
      bigrams,
      extraChars,
      ch.lastAssistantText,
    );
    const fileKeys = chapterFileKeys(ch);
    const fileKeysLower = new Array(fileKeys.length);
    for (let fi = 0; fi < fileKeys.length; fi++) {
      const lower = (fileKeys[fi] || "").toLowerCase();
      fileKeysLower[fi] = lower;
      addChapterTokens(charBits, bigrams, extraChars, lower);
    }
    ch._fileKeysLower = fileKeysLower;
    for (const cmd of ch.commands) {
      cmd._cmdLower = cacheLowerAndToken(charBits, bigrams, extraChars, cmd.cmd);
      cmd._outputLower = cacheLowerAndToken(charBits, bigrams, extraChars, cmd.output);
    }
    for (const s of ch.searches) {
      s._queryLower = cacheLowerAndToken(charBits, bigrams, extraChars, s.query);
    }
    for (const a of ch.agents) {
      a._descriptionLower = cacheLowerAndToken(charBits, bigrams, extraChars, a.description);
      a._promptLower = cacheLowerAndToken(charBits, bigrams, extraChars, a.prompt);
    }
    for (const d of ch.diffs) {
      d._pathLower = cacheLowerAndToken(charBits, bigrams, extraChars, d.path);
      if (d.diffInfo) {
        d.diffInfo._oldStrLower = cacheLowerAndToken(charBits, bigrams, extraChars, d.diffInfo.oldStr);
        d.diffInfo._newStrLower = cacheLowerAndToken(charBits, bigrams, extraChars, d.diffInfo.newStr);
        d.diffInfo._contentLower = cacheLowerAndToken(
          charBits,
          bigrams,
          extraChars,
          d.diffInfo.content,
        );
      }
    }
    for (const g of ch.gitOps) {
      g._messageLower = cacheLowerAndToken(charBits, bigrams, extraChars, g.message);
      g._branchLower = cacheLowerAndToken(charBits, bigrams, extraChars, g.branch);
      g._hashLower = cacheLowerAndToken(charBits, bigrams, extraChars, g.hash);
      g._cmdLower = cacheLowerAndToken(charBits, bigrams, extraChars, g.cmd);
    }
    for (const w of ch.webOps) {
      w._urlLower = cacheLowerAndToken(charBits, bigrams, extraChars, w.url);
      w._queryLower = cacheLowerAndToken(charBits, bigrams, extraChars, w.query);
      w._pageTitleLower = cacheLowerAndToken(charBits, bigrams, extraChars, w.pageTitle);
      if (w.results) {
        for (const r of w.results) {
          r._titleLower = cacheLowerAndToken(charBits, bigrams, extraChars, r.title);
          r._urlLower = cacheLowerAndToken(charBits, bigrams, extraChars, r.url);
        }
      }
    }
    ch._thinkingLower = ch.thinking.map((t) => {
      const lower = (t || "").toLowerCase();
      addChapterTokens(charBits, bigrams, extraChars, lower);
      return lower;
    });
    for (const m of ch.mcpOps) {
      m._serverLower = cacheLowerAndToken(charBits, bigrams, extraChars, m.server);
      m._toolLower = cacheLowerAndToken(charBits, bigrams, extraChars, m.tool);
      m._rawNameLower = cacheLowerAndToken(charBits, bigrams, extraChars, m.rawName);
      const params = m.params;
      const paramVals = [];
      if (params) {
        for (const k in params) {
          if (Object.prototype.hasOwnProperty.call(params, k)) {
            const pv = String(params[k] || "").toLowerCase();
            paramVals.push(pv);
            addChapterTokens(charBits, bigrams, extraChars, pv);
          }
        }
      }
      m._paramValsLower = paramVals;
    }
  }
}