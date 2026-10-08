import { safeSlice } from "../parse/parse-utils.js";
import { chapterFileKeys, chapterToolKeys } from "./chapter-keys.js";
import { countSelfCorrections, isSameCallTarget, isSimilarCallEntry } from "./chapter-patterns.js";

export function countGitOpsOfType(gitOps, type) {
  let n = 0;
  for (let i = 0; i < gitOps.length; i++) {
    if (gitOps[i].type === type) n++;
  }
  return n;
}

export function countOkCommands(commands) {
  let n = 0;
  for (let i = 0; i < commands.length; i++) {
    if (commands[i].ok) n++;
  }
  return n;
}

/** Detect same-tool retries with similar inputs; sets ch.retries, ch.retryGroups, and ch.selfCorrections. */
export function detectChapterRetries(ch) {
  const seq = ch._callSeq;
  ch.retries = 0;
  ch.retryGroups = [];
  let selfCorrections = 0;
  if (!seq || seq.length < 2) {
    ch.selfCorrections = 0;
    return;
  }

  let i = 0;
  while (i < seq.length) {
    if (seq[i].isError) {
      const errName = seq[i].name;
      for (let k = i + 1; k < Math.min(i + 4, seq.length); k++) {
        if (seq[k].name === errName) {
          if (isSameCallTarget(seq[i], seq[k]) && !seq[k].isError) {
            selfCorrections++;
            break;
          }
        }
      }
    }

    let j = i + 1;
    const baseName = seq[i].name;
    const group = [i];
    while (j < seq.length && j - i < 8) {
      if (seq[j].name === baseName && isSimilarCallEntry(seq[i], seq[j])) {
        group.push(j);
      }
      j++;
    }
    if (group.length >= 2) {
      ch.retries += group.length - 1;
      ch.retryGroups.push({ tool: baseName, count: group.length, input: safeSlice(seq[i].input, 60) });
      i = group[group.length - 1] + 1;
    } else {
      i++;
    }
  }
  ch.selfCorrections = selfCorrections;
}

/** Classify chapter outcome: clean | corrected | struggling. */
export function classifyChapterOutcome(ch) {
  if (ch.selfCorrections === undefined) {
    ch.selfCorrections = countSelfCorrections(ch._callSeq || []);
  }

  if (ch.errors === 0 && ch.retries === 0) {
    ch.outcome = "clean";
  } else if (ch.selfCorrections > 0 && ch.selfCorrections >= ch.errors * 0.5) {
    ch.outcome = "corrected";
  } else if (ch.corrected) {
    ch.outcome = "corrected";
  } else if (ch.retries >= 3 || ch.errors >= 3) {
    ch.outcome = "struggling";
  } else if (ch.selfCorrections > 0) {
    ch.outcome = "corrected";
  } else if (ch.errors >= 2 && ch.selfCorrections === 0) {
    ch.outcome = "struggling";
  } else if (ch.errors === 1 && ch.turns > 1) {
    ch.outcome = "corrected";
  } else if (ch.retries > 0 && ch.retries < 3) {
    ch.outcome = "corrected";
  } else if (ch.errors > 0) {
    ch.outcome = "corrected";
  } else {
    ch.outcome = "clean";
  }
}

/** Compute per-chapter efficiency metrics; mutates ch.efficiency. */
export function computeChapterEfficiency(ch, avgTokPerChapter) {
  const chTok = ch.tokens.input + ch.tokens.output;
  const fileCount = chapterFileKeys(ch).length;
  const commitCount = countGitOpsOfType(ch.gitOps, "commit");
  const editWriteCount = (ch.toolCounts.Edit || 0) + (ch.toolCounts.Write || 0);
  let callCount = 0;
  const toolKeys = chapterToolKeys(ch);
  for (let i = 0; i < toolKeys.length; i++) callCount += ch.toolCounts[toolKeys[i]] || 0;
  const failedRetries = ch.retries;

  const tokPerFile = fileCount > 0 ? Math.round(chTok / fileCount) : 0;
  const tokPerCommit = commitCount > 0 ? Math.round(chTok / commitCount) : 0;
  const errorTokens = ch.errors > 0 && callCount > 0 ? Math.round(chTok * (ch.errors / callCount)) : 0;

  const wasteReasons = [];
  const highTokens = chTok > avgTokPerChapter * 1.5 && avgTokPerChapter > 0;

  if (
    highTokens &&
    fileCount === 0 &&
    commitCount === 0 &&
    editWriteCount === 0 &&
    ch.commands.length === 0 &&
    ch.agents.length === 0
  ) {
    wasteReasons.push("high tokens, no file changes or actions");
  }
  if (failedRetries >= 3 && ch.selfCorrections === 0) {
    wasteReasons.push(failedRetries + " failed retries without resolution");
  }
  if (ch.thinking.length > 0 && callCount === 0) {
    wasteReasons.push("reasoning with no tool actions");
  }
  if (ch.errors >= 3 && ch.selfCorrections === 0) {
    wasteReasons.push(ch.errors + " errors, no self-correction");
  }
  if ((ch.toolCounts.Read || 0) >= 6 && editWriteCount === 0 && commitCount === 0 && highTokens) {
    wasteReasons.push("heavy reading with no edits");
  }

  let effScore = 100;
  if (callCount > 0) {
    effScore -= Math.min(40, (ch.errors / callCount) * 200);
  }
  if (callCount > 0) {
    effScore -= Math.min(25, (ch.retries / callCount) * 150);
  }
  if (chTok > 0 && avgTokPerChapter > 0) {
    const productivity = editWriteCount + commitCount + countOkCommands(ch.commands);
    const tokRatio = chTok / avgTokPerChapter;
    if (tokRatio > 2 && productivity <= 1) {
      effScore -= Math.min(25, (tokRatio - 1) * 10);
    }
  }
  if (ch.selfCorrections > 0 && ch.errors > 0) {
    effScore += Math.min(10, (ch.selfCorrections / ch.errors) * 10);
  }

  effScore = Math.max(0, Math.min(100, Math.round(effScore)));
  const isWasteful = wasteReasons.length > 0 || effScore < 40;

  ch.efficiency = {
    score: effScore,
    isWasteful,
    wasteReasons,
    tokPerFile,
    tokPerCommit,
    errorTokens,
    wasteTokens: isWasteful ? Math.round(chTok * Math.max(0.2, 1 - effScore / 100)) : 0,
  };
}

/**
 * Retry/outcome enrichment shared by compare, markdown, and HTML render.
 * Requires ch._callSeq until this returns.
 */
export function enrichChaptersQualityCore(chapters) {
  for (const ch of chapters) {
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    delete ch._callSeq;
  }
}

/**
 * Per-chapter efficiency scores (HTML viewer only — deferred off compare/markdown paths).
 */
export function enrichChaptersEfficiency(chapters) {
  let totalTokAll = 0;
  for (const ch of chapters) {
    totalTokAll += ch.tokens.input + ch.tokens.output;
  }
  const avgTokPerChapter = chapters.length > 0 ? totalTokAll / chapters.length : 0;
  for (const ch of chapters) {
    computeChapterEfficiency(ch, avgTokPerChapter);
  }
}

export function enrichChaptersQuality(chapters) {
  enrichChaptersQualityCore(chapters);
  enrichChaptersEfficiency(chapters);
}

/**
 * @typedef {object} ChapterQualitySummary
 * @property {number} chapters
 * @property {number} retries
 * @property {number} clean
 * @property {number} corrected
 * @property {number} struggling
 * @property {number} files
 * @property {number} commits
 */

/** Aggregate chapter-quality metrics from enriched chapters (compare page, tests). */
export function summarizeChapterQuality(chapters) {
  let retries = 0;
  let clean = 0;
  let corrected = 0;
  let struggling = 0;
  const files = new Set();
  let commits = 0;

  for (const ch of chapters) {
    retries += ch.retries || 0;
    if (ch.outcome === "clean") clean++;
    else if (ch.outcome === "corrected") corrected++;
    else if (ch.outcome === "struggling") struggling++;
    for (const f of chapterFileKeys(ch)) files.add(f);
    commits += countGitOpsOfType(ch.gitOps, "commit");
  }

  return {
    chapters: chapters.length,
    retries,
    clean,
    corrected,
    struggling,
    files: files.size,
    commits,
  };
}