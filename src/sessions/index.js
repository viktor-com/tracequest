import { detectLiveSessions, stampLive, pathIsLive, livePathSet } from "./live-sessions.js";
import { peekSession } from "./session-peek.js";
import { searchSessions } from "./scan-queries.js";
import { indexOpenCode } from "./session-index-opencode.js";
import {
  buildIndex,
  INDEX_VERSION,
  initIndexWriters,
} from "./index-writers.js";
import { findSessions, indexSession } from "./session-index-core.js";
export {
  sessionMtimeMs,
  sortSessionsByMtimeDesc,
  sessionListChecksum,
} from "./session-list.js";
export { detectLiveSessions, stampLive, pathIsLive, livePathSet, peekSession, buildIndex, INDEX_VERSION, searchSessions, indexOpenCode };
export { findSessions, indexSession };

import { sessionListChecksum } from "./session-list.js";

initIndexWriters({ indexSession, sessionListChecksum });