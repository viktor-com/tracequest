import {
  handleLivereload,
  handleIndex,
  handleLaunch,
  handleRun,
  handleSessions,
  handleView,
  handleExport,
  handleMarkdown,
  handleRaw,
  handleCompare,
} from "./route-handlers.js";
import { handleApiSessions, handleApiSearch } from "./route-handlers-api.js";
import {
  handleApiAgents,
  handleApiRuns,
  handleApiRunsInput,
  handleApiRunsKill,
  handleApiRunsSession,
  handleApiRunsSnapshot,
  handleApiSessionsLive,
} from "./route-handlers-launch.js";
import { handleApiUsageLimits } from "./route-handlers-usage.js";
import { handleApiInsights, handleInsights } from "./route-handlers-insights.js";

export const ROUTE_MAP = {
  "/__livereload": handleLivereload,
  "/": handleIndex,
  "/sessions": handleSessions,
  "/launch": handleLaunch,
  "/run": handleRun,
  "/view": handleView,
  "/export": handleExport,
  "/markdown": handleMarkdown,
  "/raw": handleRaw,
  "/compare": handleCompare,
  "/insights": handleInsights,
  "/api/insights": handleApiInsights,
  "/api/sessions": handleApiSessions,
  "/api/sessions/live": handleApiSessionsLive,
  "/api/search": handleApiSearch,
  "/api/agents": handleApiAgents,
  "/api/usage-limits": handleApiUsageLimits,
  "/api/runs": handleApiRuns,
  "/api/runs/snapshot": handleApiRunsSnapshot,
  "/api/runs/session": handleApiRunsSession,
  "/api/runs/kill": handleApiRunsKill,
  "/api/runs/input": handleApiRunsInput,
};