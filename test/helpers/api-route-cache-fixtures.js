import { mock } from 'node:test';

export function sessionRow(path, project, source = 'claude') {
  return {
    path,
    mtime: new Date('2026-05-01T12:00:00Z'),
    size: 512,
    source,
    project,
    file: path.split('/').pop(),
  };
}

function mockFilteredFindSessions(rows) {
  return mock.fn((filter) => {
    if (!filter) return rows;
    return rows.filter((s) => (s.project || '').includes(filter));
  });
}

function mockBuildIndex(mapEntry) {
  return mock.fn((sessions) => {
    const index = new Map();
    for (const s of sessions) {
      index.set(s.path, mapEntry(s));
    }
    return index;
  });
}

function fullIndexEntry(s) {
  return {
    firstPrompt: `prompt ${s.file}`,
    model: 'claude-sonnet-4-6',
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
  };
}

function searchIndexEntry(s) {
  return {
    firstPrompt: `prompt ${s.file}`,
    model: 'claude-sonnet-4-6',
  };
}

export function makeFilteredApiDeps(rows) {
  return {
    findSessions: mockFilteredFindSessions(rows),
    buildIndex: mockBuildIndex(fullIndexEntry),
    rows,
  };
}

export function makeSearchDeps(rows) {
  return {
    findSessions: mockFilteredFindSessions(rows),
    buildIndex: mockBuildIndex(searchIndexEntry),
  };
}

export function makeFilteredIndexDeps(rows) {
  const browserPage = mock.fn(() => '<!DOCTYPE html><html><body>index-page</body></html>');
  return { ...makeFilteredApiDeps(rows), browserPage };
}