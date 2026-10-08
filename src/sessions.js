/**
 * Public package entry (`tracequest/sessions` and tracequest-api).
 * Stable surface only — internal helpers live under `./sessions/`.
 */
export {
  findSessions,
  buildIndex,
  searchSessions,
  peekSession,
  sortSessionsByMtimeDesc,
} from "./sessions/index.js";