/**
 * Which quoted-phrase checks start with a byte test of the session file
 * (facts flt2, flt7). No file is read here: the hub's phrase checker uses
 * this to pick the files for the sidecar's byte test.
 */
import { isGrokFamily } from "./session-layout.js";

/** Printable ASCII without `"`, `/` and `\`: in JSON text these appear only as themselves. */
export const RE_BYTE_CHECKABLE_PHRASE = /^[\x20\x21\x23-\x2e\x30-\x5b\x5d-\x7e]+$/;

/**
 * Whether sessionHasPhrase decides `session` by phraseMayOccurInFile(session.path, phrase)
 * first: a JSONL session read from its own file and a byte-checkable phrase.
 */
export function phraseByteTestApplies(session, phrase) {
  const source = session.source || "claude";
  return Boolean(session.path) && RE_BYTE_CHECKABLE_PHRASE.test(phrase)
    && source !== "opencode" && source !== "dsh" && !isGrokFamily(source);
}
