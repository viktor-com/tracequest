/**
 * Worker thread that redacts one hub response body (facts hrd1, hrd2). The
 * body arrives as text, or as a recording path that is read here, so a
 * multi-hundred-MB /raw download never touches the server's event loop. The
 * redacted body goes back as UTF-8 bytes, transferred rather than copied.
 */
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { redactBody } from "./redact-body.js";

parentPort.on("message", ({ id, text, path, kind }) => {
  try {
    const src = path != null ? readFileSync(path, "utf8") : typeof text === "string" ? text : Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString("utf8");
    const out = Buffer.from(redactBody(src, kind), "utf8");
    // Small Buffers share a pooled ArrayBuffer and cannot be transferred.
    const own = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength;
    parentPort.postMessage({ id, out }, own ? [out.buffer] : []);
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err) });
  }
});
