import { shareFetch } from "./fetch-retry.js";

const DEFAULT_HF_API_URL = "https://huggingface.co";
/** HF inline commit size limit; larger files use preupload. */
export const HF_PREUPLOAD_THRESHOLD = 1_048_576;

export function hfApiUrl() {
  return (process.env.HF_API_URL || DEFAULT_HF_API_URL).replace(/\/$/, "");
}

const README_CARD = `---
license: mit
tags:
- agent-traces
- tracequest
task_categories:
- text-generation
---

# tracequest sessions

Agent session traces shared via [tracequest](https://github.com/viktor-com/tracequest).
`;

/** Sanitize a path segment (alphanumeric, hyphen, underscore only). */
export function sanitizePathSegment(seg) {
  const s = String(seg || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-");
  return s || "unknown";
}

function parseRepo(repo) {
  const parts = String(repo || "").split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("HF repo must be namespace/repo (e.g. user/tracequest-sessions)");
  return { namespace: parts[0], repo: parts[1] };
}

/** GET /api/whoami-v2 to resolve default repo namespace. */
export async function resolveHfUsername(token, fetchImpl = fetch) {
  const res = await shareFetch(`${hfApiUrl()}/api/whoami-v2`, {
    headers: { Authorization: `Bearer ${token}` },
  }, fetchImpl);
  if (!res.ok) throw new Error(`HF whoami failed (${res.status})`);
  const data = await res.json();
  return data.name || data.fullname || null;
}

async function repoExists(namespace, repo, token, fetchImpl) {
  const res = await shareFetch(`${hfApiUrl()}/api/datasets/${namespace}/${repo}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, fetchImpl);
  return res.ok;
}

async function createDatasetRepo(namespace, repo, isPrivate, token, username, fetchImpl) {
  const body = { name: repo, type: "dataset", private: !!isPrivate };
  if (namespace !== username) body.organization = namespace;

  const res = await shareFetch(`${hfApiUrl()}/api/repos/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, fetchImpl);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HF repo create failed (${res.status}): ${text || res.statusText}`);
  }
}

async function preuploadFile(namespace, repo, path, content, token, fetchImpl) {
  const size = Buffer.byteLength(content, "utf8");
  const sample = content.slice(0, 512);
  const res = await shareFetch(`${hfApiUrl()}/api/datasets/${namespace}/${repo}/preupload/main`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files: [{ path, size, sample }] }),
  }, fetchImpl);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HF preupload failed (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  const fileInfo = data.files?.[0];
  if (!fileInfo?.uploadUrl) throw new Error("HF preupload missing uploadUrl");

  const putRes = await shareFetch(fileInfo.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: content,
  }, fetchImpl);
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`HF preupload PUT failed (${putRes.status}): ${text || putRes.statusText}`);
  }

  return { path, oid: fileInfo.oid };
}

async function buildFileOperation(namespace, repo, path, content, token, fetchImpl) {
  const size = Buffer.byteLength(content, "utf8");
  if (size >= HF_PREUPLOAD_THRESHOLD) {
    const uploaded = await preuploadFile(namespace, repo, path, content, token, fetchImpl);
    return { operation: "addOrUpdate", path: uploaded.path, oid: uploaded.oid };
  }
  return { operation: "addOrUpdate", path, content };
}

/**
 * Upload rendered HTML + JSON sidecar to a Hugging Face dataset repo.
 * @returns {Promise<{url: string}>}
 */
export async function shareHf({
  html,
  metadata,
  sidecar,
  repo,
  isPrivate,
  token,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error("Hugging Face token required. Set HF_TOKEN or log in via huggingface-cli.");

  const username = await resolveHfUsername(token, fetchImpl);
  let targetRepo = repo;
  if (!targetRepo) {
    if (!username) throw new Error("Could not resolve HF username; pass --hf-repo");
    targetRepo = `${username}/tracequest-sessions`;
  }

  const { namespace, repo: repoName } = parseRepo(targetRepo);
  const exists = await repoExists(namespace, repoName, token, fetchImpl);
  const isNew = !exists;

  if (isNew) {
    await createDatasetRepo(namespace, repoName, isPrivate, token, username, fetchImpl);
  }

  const source = sanitizePathSegment(metadata.source || "claude");
  const sessionId = sanitizePathSegment(metadata.sessionHash || metadata.sessionId || "session");
  const htmlPath = `sessions/${source}/${sessionId}.html`;
  const jsonPath = `sessions/${source}/${sessionId}.json`;
  const jsonContent = JSON.stringify(sidecar, null, 2);

  const operations = [
    await buildFileOperation(namespace, repoName, htmlPath, html, token, fetchImpl),
    await buildFileOperation(namespace, repoName, jsonPath, jsonContent, token, fetchImpl),
  ];
  if (isNew) {
    operations.push({ operation: "addOrUpdate", path: "README.md", content: README_CARD });
  }

  const res = await shareFetch(`${hfApiUrl()}/api/datasets/${namespace}/${repoName}/commit/main`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operations }),
  }, fetchImpl);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HF commit failed (${res.status}): ${body || res.statusText}`);
  }

  const url = `${hfApiUrl()}/datasets/${namespace}/${repoName}/blob/main/${htmlPath}`;
  return { url, repo: `${namespace}/${repoName}`, isNew };
}

/** Build JSON sidecar for HF dataset. */
export function buildHfSidecar(metadata) {
  return {
    sessionId: metadata.sessionId,
    sessionHash: metadata.sessionHash,
    source: metadata.source,
    model: metadata.model,
    project: metadata.project,
    firstPrompt: metadata.firstPrompt,
    eventCount: metadata.eventCount,
    errorCount: metadata.errorCount,
    tools: metadata.tools,
    filePaths: metadata.filePaths,
    gitBranch: metadata.gitBranch,
    costEstimate: metadata.costEstimate,
    chapterCount: metadata.chapterCount,
    grade: metadata.grade,
    timestamp: metadata.timestamp,
    durationMs: metadata.duration,
    inputTokens: metadata.inputTokens,
    outputTokens: metadata.outputTokens,
    cacheTokens: metadata.cacheTokens,
  };
}
