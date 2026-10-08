/**
 * Join named bundle segments into one script block.
 * @param {{ id: string, source: string }[]} parts
 * @param {{ spaced?: boolean }} [opts] — when true (default), separate segments with blank lines
 * @returns {string}
 */
export function joinBundleParts(parts, { spaced = true } = {}) {
  if (!spaced) {
    return parts.map((p) => p.source).join("");
  }
  const lines = [""];
  for (const part of parts) {
    lines.push(part.source);
    lines.push("");
  }
  return lines.join("\n");
}