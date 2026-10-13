/**
 * Which sessions have a measured duration (facts durut, insut).
 *
 * Cursor and Cursor cloud transcripts record no event timestamps: the index's
 * durationMs for them is a file birthtime/mtime or session_meta
 * createdAt/updatedAt bound (weeks for a cloud agent whose PR merged later),
 * not a span anything ran for. Every page shows such a session without a
 * duration and counts no time for it; the index entry keeps the bound.
 */
const UNTIMED_SOURCES = new Set(["cursor", "cursor-cloud"]);

/** True when the source's transcripts carry event timestamps. */
export function sourceRecordsEventTimes(source) {
  return !UNTIMED_SOURCES.has(source);
}

/** The duration a page shows for a session of `source`: 0 when nothing measured it. */
export function measuredDurationMs(source, durationMs) {
  return sourceRecordsEventTimes(source) ? durationMs || 0 : 0;
}
