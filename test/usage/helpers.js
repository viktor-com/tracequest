import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadDatabaseSync } from "../../src/sessions/session-discovery-paths.js";

export function startJsonFixture(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const record = {
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.authorization || req.headers.Authorization || null,
        contentType: req.headers["content-type"] || null,
        body: raw,
      };
      requests.push(record);
      const key = `${req.method} ${url.pathname}`;
      const spec = routes[key] || routes[url.pathname] || routes["*"];
      if (!spec) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unexpected ${key}` }));
        return;
      }
      const status = spec.status ?? 200;
      const delay = spec.delayMs || 0;
      const send = () => {
        res.writeHead(status, { "Content-Type": spec.contentType || "application/json" });
        if (spec.raw != null) res.end(spec.raw);
        else res.end(JSON.stringify(spec.body ?? {}));
      };
      if (delay) setTimeout(send, delay);
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export function writeClaudeCreds(home, token, extra = {}) {
  const path = join(home, ".claude", ".credentials.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      rateLimitTier: "default_claude_max_20x",
      ...extra,
    },
  }));
  return path;
}

export function writeCodexAuth(home, token, accountId) {
  const path = join(home, ".codex", "auth.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    tokens: { access_token: token, account_id: accountId },
  }));
  return path;
}

export function writeGrokAuth(home, token, email = "user@example.com") {
  const path = join(home, ".grok", "auth.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    "https://auth.x.ai::fixture": { key: token, email },
  }));
  writeFileSync(join(home, ".grok", "settings_cache.json"), JSON.stringify({
    payload: JSON.stringify({ origin: "https://cli-chat-proxy.grok.com/v1" }),
  }));
  return path;
}

export function writeCursorTokenDb(dbPath, token) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", token);
  } finally {
    db.close();
  }
}

export const CLAUDE_USAGE_BODY = {
  five_hour: { utilization: 25.0, resets_at: "2026-09-20T21:00:00.157950+00:00" },
  seven_day: { utilization: 4.0, resets_at: "2026-09-22T22:00:00.157976+00:00" },
  limits: [
    { kind: "session", percent: 25, is_active: true, resets_at: "2026-09-20T21:00:00.157950+00:00" },
  ],
};

export const CODEX_USAGE_BODY = {
  plan_type: "plus",
  rate_limit: {
    primary: { used_percent: 12.5, window_duration_mins: 300, resets_at: 1789938000 },
    secondary: { used_percent: 40, window_duration_mins: 10080, resets_at: 1790500000 },
  },
};

export const CURSOR_USAGE_BODY = {
  billingCycleEnd: "1780000000000",
  planUsage: {
    remaining: 60,
    limit: 100,
    totalPercentUsed: 40,
  },
};

export const CURSOR_PLAN_BODY = {
  planInfo: { planName: "Pro" },
};

export const GROK_USER_BODY = {
  subscriptionTier: "SuperGrokPro",
};
