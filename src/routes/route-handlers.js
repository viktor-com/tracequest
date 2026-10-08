import { lrClients } from "../server/server-live-reload.js";

export {
  handleIndex,
  handleLaunch,
  handleRun,
  handleSessions,
  handleView,
  handleExport,
  handleMarkdown,
  handleRaw,
  handleCompare,
} from "./route-handlers-pages.js";

export function handleLivereload(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write("data: connected\n\n");
  lrClients.add(res);
  req.on("close", () => lrClients.delete(res));
}