import { homedir } from "node:os";
import { resolveOpenCodeDbPath } from "../sessions/session-discovery-paths.js";
import { parseSession } from "../parse.js";
import { renderHTML } from "../render.js";
import { findSessions, peekSession, buildIndex, searchSessions } from "../sessions.js";
import {
  modVersion,
  startLiveReloadWatchers,
  defaultDataRoots,
} from "./server-live-reload.js";
import { createHotModuleSnapshotImporter } from "./hot-module-snapshot.js";

const __srcDir = new URL("..", import.meta.url);
const home = homedir();

/** Session filesystem roots watched for live index updates (--serve). */
export const dataRoots = defaultDataRoots(home);

export const openCodeDbPath = resolveOpenCodeDbPath(home);

export { modVersion, lrClients, triggerDataUpdate } from "./server-live-reload.js";

/** Start serve-only live-reload watchers. Importing server modules has no fs.watch side effects. */
export function startServerLiveReloadWatchers() {
  startLiveReloadWatchers({ srcDir: __srcDir, dataRoots, openCodeDbPath });
}

let _initialFilter = null;

export function setInitialFilter(filter) {
  _initialFilter = filter || null;
}

export function getInitialFilter() {
  return _initialFilter;
}

// --- Hot module reloading ---

const _hotModuleImporter = createHotModuleSnapshotImporter(__srcDir);

let _lastV = -1;
let _mods = {
  parseSession,
  renderHTML,
  findSessions,
  peekSession,
  buildIndex,
  searchSessions,
  browserPage: null,
  runPage: null,
};

export async function hotModules() {
  const v = modVersion();
  if (v === _lastV) return _mods;
  const [p, r, s, bp, rp] = await _hotModuleImporter.importEntries(v, [
    "parse.js",
    "render.js",
    "sessions.js",
    "browser/browser-page.js",
    "browser/run-page.js",
  ]);
  if (modVersion() === v) {
    _mods = {
      parseSession: p.parseSession,
      renderHTML: r.renderHTML,
      findSessions: s.findSessions,
      peekSession: s.peekSession,
      buildIndex: s.buildIndex,
      searchSessions: s.searchSessions,
      browserPage: bp.browserPage,
      runPage: rp.runPage,
      chatHomePage: rp.chatHomePage,
      liveSessionPage: rp.liveSessionPage,
    };
    _lastV = v;
  }
  return _mods;
}

/** @internal — drop hotModules memo when tests restore modVersion (tests only) */
export function resetHotModulesCacheForTests() {
  _hotModuleImporter.reset();
  _lastV = -1;
  _mods = {
    parseSession,
    renderHTML,
    findSessions,
    peekSession,
    buildIndex,
    searchSessions,
    browserPage: null,
    runPage: null,
  };
}
