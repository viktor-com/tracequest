/** Cached file paths on a chapter, falling back to Object.keys when unset. */
export function chapterFileKeys(ch) {
  return ch._fileKeys || Object.keys(ch.files);
}

/** Cached tool names on a chapter, falling back to Object.keys when unset. */
export function chapterToolKeys(ch) {
  return ch._toolKeys || Object.keys(ch.toolCounts);
}