import { collapseWhitespace, isDisplayableUserText } from "../parse/parse-utils.js";

/** Normalize user message content into searchable plain text (Cursor user_query tags, etc.). */
export function extractPrompt(content) {
  let t = "";
  if (typeof content === "string") t = content;
  else if (Array.isArray(content)) {
    const textParts = [];
    for (const b of content) {
      if (b.type === "text") textParts.push(b.text);
    }
    t = textParts.join(" ");
  } else if (content && typeof content === "object") {
    t = content.text || content.content || "";
  }
  t = t.trim();
  if (!t) return null;
  const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (m) {
    const inner = m[1].trim();
    const args = inner.match(/<command-args>([\s\S]*?)<\/command-args>/);
    if (args) return collapseWhitespace(args[1]) || null;
    const msg = inner.match(/<command-message>([\s\S]*?)<\/command-message>/);
    if (msg) return collapseWhitespace(msg[1]) || null;
    if (inner && !isDisplayableUserText(inner)) return null;
    return collapseWhitespace(inner);
  }
  if (!isDisplayableUserText(t)) return null;
  return collapseWhitespace(t);
}