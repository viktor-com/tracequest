// Terminal double for Codex's paste-burst and cancellation behavior. The
// served-browser test can also run against a native Codex binary, offline.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const id = randomUUID();
const dir = path.join(process.env.HOME, ".codex/sessions/2026/10/15");
fs.mkdirSync(dir, { recursive: true });
const fd = fs.openSync(path.join(dir, `rollout-${id}.jsonl`), "a");
const row = (type, payload) => fs.writeSync(fd, JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + "\n");
row("session_meta", { id, cwd: process.cwd(), model_provider: "local" });
let input = "", pending = "", pasted = false, lastTyped = 0, running = false, dialog = false, timer;
function submit(text) {
  row("event_msg", { type: "user_message", message: text });
  row("event_msg", { type: "task_started" });
  console.log(`\nUSER: ${text}`);
  if (text.startsWith("LONG_REPLY")) {
    running = true;
    timer = setInterval(() => console.log("Still generating"), 150);
  } else {
    row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Native local reply." }] });
    row("event_msg", { type: "task_complete" });
    console.log("Native local reply.\nReady");
  }
}
function interrupt() {
  clearInterval(timer);
  running = false;
  dialog = false;
  row("event_msg", { type: "turn_aborted" });
  console.log("Conversation interrupted\nReady");
}
submit(process.argv.at(-1));
process.stdin.setRawMode(true);
process.stdin.on("data", chunk => {
  pending += chunk.toString();
  while (pending.length) {
    if (pending.startsWith("\x1b[200~")) {
      const end = pending.indexOf("\x1b[201~");
      if (end < 0) return;
      input += pending.slice(6, end);
      pending = pending.slice(end + 6);
      pasted = true;
      continue;
    }
    if ("\x1b[200~".startsWith(pending) && pending.length > 1) return;
    const c = pending[0];
    pending = pending.slice(1);
    if (c === "\x03") {
      if (running) { dialog = true; console.log("Task is still running\n1. Cancel task\nenter select · esc back"); }
      continue;
    }
    if (c === "\x1b") {
      if (dialog) dialog = false;
      else if (running) interrupt();
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (dialog) { interrupt(); continue; }
      if (!pasted && Date.now() - lastTyped < 50) continue;
      const text = input;
      input = "";
      pasted = false;
      if (text) submit(text);
      continue;
    }
    input += c;
    lastTyped = Date.now();
    process.stdout.write(c);
  }
});
