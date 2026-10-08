import { sanitizePathSegment } from "./hf-adapter.js";
import { shareFetch } from "./fetch-retry.js";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GISTHOST_BASE = "https://gisthost.github.io/?";

export function gistApiUrl() {
  return (process.env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL).replace(/\/$/, "");
}

/** Build a gisthost preview URL for a gist id and optional filename. */
export function buildGistHostPreviewUrl(gistId, filename) {
  if (!gistId) return null;
  const base = `${GISTHOST_BASE}${gistId}`;
  if (filename && filename !== "index.html") return `${base}/${filename}`;
  return base;
}

/**
 * Upload rendered HTML to a GitHub Gist.
 * @returns {Promise<{url: string, id: string, previewUrl: string, filename: string}>}
 *   `url` — raw gist.github.com HTML page (not gisthost preview)
 *   `previewUrl` — gisthost rendered preview URL (primary share link)
 *   `filename` — uploaded gist file name
 */
export async function shareGist({ html, metadata, isPrivate, token, fetchImpl = fetch }) {
  if (!token) throw new Error("GitHub token required. Set GITHUB_TOKEN or run 'gh auth login'.");
  const sessionId = metadata.sessionHash || metadata.sessionId || "session";
  const source = metadata.source || "claude";
  const safeSource = sanitizePathSegment(source);
  const safeId = sanitizePathSegment(sessionId.slice(0, 8));
  const filename = `tracequest-${safeSource}-${safeId}.html`;
  const description = `${source} session — ${metadata.firstPrompt || "(no prompt)"} (${metadata.model || "unknown"}, ${metadata.durationFormatted || "—"})`;

  const res = await shareFetch(`${gistApiUrl()}/gists`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      description,
      public: !isPrivate,
      files: {
        [filename]: { content: html },
      },
    }),
  }, fetchImpl);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub Gist upload failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  if (!data?.id) {
    throw new Error("GitHub Gist upload succeeded but response missing id");
  }
  return {
    url: data.html_url,
    id: data.id,
    filename,
    previewUrl: buildGistHostPreviewUrl(data.id, filename),
  };
}
