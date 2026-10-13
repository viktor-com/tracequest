import { detectLiveSessions, stampLive, pathIsLive, livePathSet } from "./live-sessions.js";
import { peekSession } from "./session-peek.js";
import { searchSessions } from "./scan-queries.js";
import { indexOpenCode } from "./session-index-opencode.js";
import {
  buildIndex,
  buildIndexAsync,
  INDEX_VERSION,
  initIndexWriters,
} from "./index-writers.js";
import { findSessions, findSessionsAsync, findSessionsInRootsAsync, indexSession } from "./session-index-core.js";
export {
  sessionMtimeMs,
  sortSessionsByMtimeDesc,
  sessionListChecksum,
} from "./session-list.js";
export { detectLiveSessions, stampLive, pathIsLive, livePathSet, peekSession, buildIndex, INDEX_VERSION, searchSessions, indexOpenCode };
export { findSessions, findSessionsAsync, findSessionsInRootsAsync, buildIndexAsync, indexSession };

import { sessionListChecksum } from "./session-list.js";

initIndexWriters({ indexSession, sessionListChecksum });

// The server resolves its asynchronous twins from the functions it already
// holds (hotModules exposes the synchronous API only), so a deps object
// carrying the real findSessions/buildIndex can discover and index without
// blocking the event loop (fact hsa1); injected test doubles have no twin.
findSessions.async = findSessionsAsync;
findSessions.inRootsAsync = findSessionsInRootsAsync;
buildIndex.async = buildIndexAsync;