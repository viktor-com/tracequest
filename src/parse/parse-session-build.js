function charsFromToolResults(toolCalls, toolResultsByUseId) {
  let chars = 0;
  for (const tc of toolCalls) {
    const results = toolResultsByUseId.get(tc.id);
    if (!results) continue;
    for (const r of results) chars += (r.text || "").length;
  }
  return chars;
}

export function buildSession({ sessionId, cwd, model, gitBranch, events, source }) {
  const { startTime, endTime, stats } = processSessionEvents(events);

  return {
    sessionId,
    source,
    cwd,
    model,
    gitBranch,
    // Sources with no event timestamps (Cursor) get null bounds, not the 1970 epoch.
    startTime: startTime === null ? null : new Date(startTime).toISOString(),
    endTime: endTime === null ? null : new Date(endTime).toISOString(),
    durationMs: startTime === null ? 0 : endTime - startTime,
    eventCount: events.length,
    events,
    stats,
  };
}

/** One events[] scan for bounds, prefetch, and count stats; assistant loop estimates tokens. */
function processSessionEvents(events) {
  const toolResultsByUseId = new Map();
  let hasOutput = false;
  let hasInput = false;
  const assistants = [];
  const toolCounts = {};
  let userMessages = 0;
  let assistantTurns = 0;
  let errors = 0;
  let startTime = 0;
  let endTime = 0;
  let hasTs = false;

  for (const e of events) {
    if (e.timestamp) {
      const t = new Date(e.timestamp).getTime();
      if (Number.isFinite(t)) {
        if (!hasTs) {
          startTime = endTime = t;
          hasTs = true;
        } else {
          if (t < startTime) startTime = t;
          if (t > endTime) endTime = t;
        }
      }
    }
    if (e.type === "user") userMessages++;
    if (e.type === "tool_result") {
      if (e.isError) errors++;
      if (e.toolUseId) {
        let list = toolResultsByUseId.get(e.toolUseId);
        if (!list) {
          list = [];
          toolResultsByUseId.set(e.toolUseId, list);
        }
        list.push(e);
      }
    } else if (e.type === "assistant") {
      assistants.push(e);
      assistantTurns++;
      if (e.tokens?.output > 0) hasOutput = true;
      if (e.tokens?.input > 0) hasInput = true;
      for (const tc of e.toolCalls || []) {
        toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
      }
    }
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheHit = 0;
  let tokensEstimated = false;

  if (assistants.length > 0) {
    for (const e of assistants) {
      if (!e.tokens) e.tokens = { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 };
      if (!hasOutput) {
        let chars = (e.text || "").length;
        for (const tc of e.toolCalls || []) {
          chars += (tc.name || "").length + (tc.input || "").length + 20;
        }
        e.tokens.output = Math.max(1, Math.round(chars / 4));
        e.tokens.estimated = true;
      }
      if (!hasInput) {
        const chars = charsFromToolResults(e.toolCalls || [], toolResultsByUseId);
        if (chars > 0) e.tokens.input = Math.round(chars / 4);
      }
      totalInputTokens += e.tokens.input;
      totalOutputTokens += e.tokens.output;
      totalCacheHit += e.tokens.cacheHit;
      if (e.tokens.estimated) tokensEstimated = true;
    }
  }

  return {
    startTime: hasTs ? startTime : null,
    endTime: hasTs ? endTime : null,
    stats: {
      userMessages,
      assistantTurns,
      totalInputTokens,
      totalOutputTokens,
      totalCacheHit,
      errors,
      toolCounts,
      tokensEstimated,
    },
  };
}