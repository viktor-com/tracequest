// Per-session file work of a search, run off the main thread of the search
// daemon and of serve (search-daemon facts, fact flt1): the same snippetScan,
// near-words scorer and quoted-phrase check the in-process search runs.
import { parentPort } from "node:worker_threads";
import { nearTermScorer, phraseCandidateScan, sessionHasPhrase, setScanLineCacheSize, snippetScan } from "./scan-queries.js";

// A few cached sessions per worker suffice, and at most 48 M characters of their lines (fact mem1).
setScanLineCacheSize(16, 48 * 1024 * 1024);

parentPort.on("message", ({ id, requests, near, phrase, phraseScans }) => {
  if (phraseScans) {
    // A quoted search's candidates (phraseCandidateScan); null where it threw (the search does it then).
    const scans = phraseScans.map((request) => {
      try {
        return phraseCandidateScan(request);
      } catch {
        return null;
      }
    });
    parentPort.postMessage({ id, scans });
    return;
  }
  if (phrase) {
    // sessionHasPhrase of each session; null where it threw (checked by the caller instead).
    // A session the check throws on fails the whole job: the caller retries or reports it.
    let found = null;
    try {
      found = phrase.sessions.map((session, k) => {
        const start = phrase.from?.[k];
        return start ? sessionHasPhrase(session, phrase.phrase, start.from, start) : sessionHasPhrase(session, phrase.phrase);
      });
    } catch {
      found = null;
    }
    parentPort.postMessage({ id, found });
    return;
  }
  if (near) {
    let scores = null;
    try {
      const scorer = nearTermScorer(...near.args, { useCache: false });
      scores = near.sessions.map((session) => scorer(session));
    } catch {
      // Scored by the search itself.
    }
    parentPort.postMessage({ id, scores });
    return;
  }
  const scans = requests.map((request) => {
    try {
      return [...snippetScan(request)];
    } catch {
      return null;
    }
  });
  parentPort.postMessage({ id, scans });
});
