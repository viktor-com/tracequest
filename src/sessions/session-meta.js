import { accumulateTermFreqs, TOKENIZER_INPUT_CAP } from "./search-tokenizer.js";

/** Push one deduped chunk into incremental index term-frequency state (JSONL/Grok scan state). */
export function pushIndexSearchChunk(state, chunk) {
  if (!chunk) return;
  let seen = state._searchChunkSeen;
  if (!seen) state._searchChunkSeen = seen = new Set();
  if (seen.has(chunk)) return;
  seen.add(chunk);
  // Accumulate into per-session term-frequency map (fact d7k).
  if (!state._tfBudget) state._tfBudget = [TOKENIZER_INPUT_CAP];
  if (!state._termFreqs) state._termFreqs = new Map();
  accumulateTermFreqs(chunk, state._termFreqs, state._tfBudget);
}

/** Canonical empty session index metadata (stored on session records). */
export function emptyIndexMeta(overrides = {}) {
  return {
    firstPrompt: null,
    model: null,
    tools: [],
    toolCounts: {},
    chapters: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
    errors: 0,
    files: 0,
    commits: 0,
    ...overrides,
  };
}

/** Mutable scan accumulator; finalized via {@link buildIndexMetaFromState}. */
export function createIndexState() {
  const z = emptyIndexMeta();
  return {
    firstPrompt: z.firstPrompt,
    model: z.model,
    tools: new Set(),
    toolsList: [],
    toolCounts: {},
    chapters: z.chapters,
    totalTokens: z.totalTokens,
    inputTokens: z.inputTokens,
    outputTokens: z.outputTokens,
    cacheReadTokens: z.cacheReadTokens,
    errors: z.errors,
    files: new Set(),
    commits: z.commits,
    firstTs: null,
    lastTs: null,
    fallbackTexts: new Set(),
    /** @type {Map<string,number>} term → frequency (fact d7k) */
    _termFreqs: new Map(),
    /** Remaining tokenizer budget in chars (fact 7et) */
    _tfBudget: [TOKENIZER_INPUT_CAP],
  };
}

function durationMsFromState(state) {
  return state.firstTs && state.lastTs
    ? new Date(state.lastTs).getTime() - new Date(state.firstTs).getTime()
    : 0;
}

/** Build stored index meta; omitted keys use {@link emptyIndexMeta} defaults. */
export function buildIndexMeta(fields = {}) {
  return emptyIndexMeta(fields);
}

/** Deduped tool name for index scan state (Set + incremental toolsList, no finalize spread). */
export function trackIndexTool(state, name) {
  if (!name || state.tools.has(name)) return;
  state.tools.add(name);
  state.toolsList.push(name);
}

/** Finalize JSONL/OpenCode accumulator state into stored index meta. */
export function buildIndexMetaFromState(state, { defaultModel = null, durationMs, tokens } = {}) {
  const files = typeof state.files === "number" ? state.files : (state.files?.size ?? 0);
  const tok = tokens ?? {
    totalTokens: state.totalTokens,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
  };
  const meta = buildIndexMeta({
    firstPrompt: state.firstPrompt,
    model: state.model || defaultModel || null,
    tools: state.toolsList,
    toolCounts: state.toolCounts,
    chapters: state.chapters,
    ...tok,
    durationMs: durationMs ?? durationMsFromState(state),
    errors: state.errors,
    files,
    commits: state.commits,
  });
  // Carry term-frequency map on the returned object (not stored in index.json — fact d7k).
  // The main thread reads this from indexSession results and feeds it to SearchIndex.
  if (state._termFreqs && state._termFreqs.size) {
    meta.termFreqs = state._termFreqs;
  }
  return meta;
}
