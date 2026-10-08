import { shortToolPath } from "../parse/parse-utils.js";

/** `split(/\s+/)[0] || ""` without allocating (Bash isSameTarget). */
export function bashSplitFirstToken(s) {
  if (!s) return "";
  let i = 0;
  const len = s.length;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    i++;
  }
  if (i > 0) return "";
  const start = i;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
    i++;
  }
  return s.slice(start, i);
}

/** `trim().split(/\s+/).slice(0, 2).join(" ")` without array alloc (Bash isSimilarInput). */
export function bashFirstTwoTokens(s) {
  if (!s) return "";
  let i = 0;
  const len = s.length;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    i++;
  }
  if (i >= len) return "";
  const start0 = i;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
    i++;
  }
  const t0 = s.slice(start0, i);
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    i++;
  }
  if (i >= len) return t0;
  const start1 = i;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
    i++;
  }
  return t0 + " " + s.slice(start1, i);
}

/** Word-boundary regex for user redo/correction prompts (avoids "node", "nothing", etc.). */
export const CORRECTION_HINT_RE =
  /\b(no|wrong|idiot|revert|undo|actually|instead)\b|not what/i;

export function markUserPromptCorrections(chapters) {
  for (let i = 0; i < chapters.length - 1; i++) {
    const next = chapters[i + 1].prompt;
    if (CORRECTION_HINT_RE.test(next)) {
      chapters[i].corrected = true;
    }
  }
}

/** Shared Edit/Write/Read/Bash/generic comparison for isSameTarget and isSimilarInput. */
export function compareToolTargets(input1, input2, toolName, mode, keys) {
  const minLen = mode === "same" ? 0 : 1;
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    const p1 = keys?.path1 ?? shortToolPath(input1);
    const p2 = keys?.path2 ?? shortToolPath(input2);
    return p1 === p2 && p1.length > minLen;
  }
  if (toolName === "Bash") {
    const cmd1 = keys?.bash1 ?? (mode === "same" ? bashSplitFirstToken(input1) : bashFirstTwoTokens(input1));
    const cmd2 = keys?.bash2 ?? (mode === "same" ? bashSplitFirstToken(input2) : bashFirstTwoTokens(input2));
    return cmd1 === cmd2 && cmd1.length > minLen;
  }
  const limit = mode === "same" ? 30 : 40;
  const s1 = input1.slice(0, limit);
  const s2 = input2.slice(0, limit);
  if (mode === "same") return s1 === s2;
  let matches = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) matches++;
  }
  return matches / Math.max(s1.length, s2.length) > 0.5;
}

/** True when two _callSeq entries target the same file/resource (uses precomputed keys when present). */
export function isSameCallTarget(a, b) {
  if (!a.input || !b.input) return false;
  const toolName = a.name;
  const keys = {};
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    keys.path1 = a._path !== undefined ? a._path : (a._path = shortToolPath(a.input));
    keys.path2 = b._path !== undefined ? b._path : (b._path = shortToolPath(b.input));
  } else if (toolName === "Bash") {
    keys.bash1 = a._bashFirst !== undefined ? a._bashFirst : (a._bashFirst = bashSplitFirstToken(a.input));
    keys.bash2 = b._bashFirst !== undefined ? b._bashFirst : (b._bashFirst = bashSplitFirstToken(b.input));
  }
  return compareToolTargets(a.input, b.input, toolName, "same", keys);
}

/** True when two _callSeq entries are similar enough to count as a retry (uses precomputed keys when present). */
export function isSimilarCallEntry(a, b) {
  if (!a.input && !b.input) return true;
  if (!a.input || !b.input) return false;
  if (a.input === b.input) return true;
  const toolName = a.name;
  const keys = {};
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    keys.path1 = a._path !== undefined ? a._path : (a._path = shortToolPath(a.input));
    keys.path2 = b._path !== undefined ? b._path : (b._path = shortToolPath(b.input));
  } else if (toolName === "Bash") {
    keys.bash1 = a._bashTwo !== undefined ? a._bashTwo : (a._bashTwo = bashFirstTwoTokens(a.input));
    keys.bash2 = b._bashTwo !== undefined ? b._bashTwo : (b._bashTwo = bashFirstTwoTokens(b.input));
  }
  return compareToolTargets(a.input, b.input, toolName, "similar", keys);
}

/** Count self-corrections: error followed by successful fix on same file/tool target. */
export function countSelfCorrections(seq) {
  let count = 0;
  for (let i = 0; i < seq.length; i++) {
    if (!seq[i].isError) continue;
    const errName = seq[i].name;
    for (let k = i + 1; k < Math.min(i + 4, seq.length); k++) {
      if (seq[k].name === errName) {
        if (isSameCallTarget(seq[i], seq[k]) && !seq[k].isError) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

export function isSameTarget(input1, input2, toolName) {
  if (!input1 || !input2) return false;
  return compareToolTargets(input1, input2, toolName, "same");
}

export function isSimilarInput(input1, input2, toolName) {
  if (!input1 && !input2) return true;
  if (!input1 || !input2) return false;
  if (input1 === input2) return true;
  return compareToolTargets(input1, input2, toolName, "similar");
}