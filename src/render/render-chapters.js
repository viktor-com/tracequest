import { CHAPTERS_CLIENT_JS } from "./render-chapters-client.js";

export const CHAPTERS_JS = `
  function buildChapters() {
    const chapters = buildSessionChapters({ events, startTime: session.startTime });
    enrichChaptersEfficiency(chapters);
    enrichChaptersForRender(chapters);
    return chapters;
  }

  let chaptersCache = null;

  function getChapters() {
    if (!chaptersCache) chaptersCache = buildChapters();
    return chaptersCache;
  }
${CHAPTERS_CLIENT_JS}
`;