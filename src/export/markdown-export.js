import { safeSlice, truncateFirstPrompt, countWordsInStrings, sumToolCounts, joinFirstLines } from "../parse/parse-utils.js";
import { estimateParsedStatsCost, fmtTokens, fmtCost, formatDuration, fmtMcpName } from "../filter/filter-formats.js";
import { chapterFileKeys } from "../chapters/chapter-keys.js";
import { buildSessionChapters } from "../chapters/session-chapters.js";
import { sessionHash } from "../sessions/session-hash.js";

function fmtDurationMd(ms) {
  return formatDuration(ms, {
    floorSeconds: true,
    includeSeconds: true,
    alwaysShowMinutes: true,
    subSecondLabel: "< 1s",
    zeroLabel: "< 1s",
  });
}

/** Session title, metadata table, and summary stats block. */
const EMPTY_MARKDOWN_STATS = {
  userMessages: 0,
  assistantTurns: 0,
  toolCounts: {},
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheHit: 0,
  errors: 0,
};

export function buildMarkdownHeader(session) {
  const lines = [];
  const s = { ...EMPTY_MARKDOWN_STATS, ...(session.stats ?? {}) };
  const toolCounts = s.toolCounts ?? {};

  lines.push(`# Session ${session.sessionHash || (session.path ? sessionHash(session.path) : "") || session.sessionId?.slice(0, 8) || "unknown"}`);
  lines.push("");

  const meta = [];
  if (session.model) meta.push(`**Model:** ${session.model}`);
  if (session.source) meta.push(`**Source:** ${session.source}`);
  if (session.startTime) meta.push(`**Date:** ${new Date(session.startTime).toLocaleString()}`);
  if (session.durationMs > 0) meta.push(`**Duration:** ${fmtDurationMd(session.durationMs)}`);
  if (session.cwd) meta.push(`**Working directory:** \`${session.cwd}\``);
  if (session.gitBranch) meta.push(`**Branch:** \`${session.gitBranch}\``);

  const totalCost = estimateParsedStatsCost(session.model, s);
  const costStr = fmtCost(totalCost);
  if (costStr) meta.push(`**Estimated cost:** ${costStr}`);

  if (meta.length) {
    lines.push(meta.join("  \n"));
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  const statParts = [];
  statParts.push(`- **Prompts:** ${s.userMessages}`);
  statParts.push(`- **Turns:** ${s.assistantTurns}`);
  const totalToolCalls = sumToolCounts(toolCounts);
  statParts.push(`- **Tool calls:** ${totalToolCalls}`);
  const totalTok = s.totalInputTokens + s.totalOutputTokens;
  if (totalTok > 0) {
    statParts.push(
      `- **Tokens:** ${fmtTokens(totalTok)} (${fmtTokens(s.totalInputTokens)} in, ${fmtTokens(s.totalOutputTokens)} out)`,
    );
  }
  if (s.totalCacheHit > 0 && s.totalInputTokens > 0) {
    statParts.push(`- **Cache hit:** ${Math.round(s.totalCacheHit / s.totalInputTokens * 100)}%`);
  }
  if (s.errors > 0) statParts.push(`- **Errors:** ${s.errors}`);
  const toolKeys = Object.keys(toolCounts);
  if (toolKeys.length) {
    toolKeys.sort((a, b) => toolCounts[b] - toolCounts[a]);
    const toolParts = [];
    for (let ti = 0; ti < toolKeys.length; ti++) {
      const n = toolKeys[ti];
      toolParts.push(`${fmtMcpName(n)} (${toolCounts[n]})`);
    }
    statParts.push(`- **Tools:** ${toolParts.join(", ")}`);
  }
  lines.push(statParts.join("\n"));
  lines.push("");

  return lines;
}

/** One chapter section (prompt, git, files, diffs, commands, web, MCP, agents, thinking, response). */
export function renderMarkdownChapter(ch, chapterIndex) {
  const lines = [];
  const i = chapterIndex;

  lines.push(`## Chapter ${i + 1}`);
  lines.push("");

  if (ch.prompt) {
    const promptLines = ch.prompt.split("\n");
    const promptLimit = 10;
    for (let pi = 0; pi < promptLines.length && pi < promptLimit; pi++) {
      lines.push(`> ${promptLines[pi]}`);
    }
    if (promptLines.length > promptLimit) lines.push("> ...");
    lines.push("");
  }

  const chMeta = [];
  if (ch.timestamp) chMeta.push(new Date(ch.timestamp).toLocaleTimeString());
  if (ch.turns > 0) chMeta.push(`${ch.turns} turn${ch.turns !== 1 ? "s" : ""}`);
  const dur = ch.endTimestamp && ch.timestamp
    ? new Date(ch.endTimestamp).getTime() - new Date(ch.timestamp).getTime()
    : 0;
  if (dur > 1000) chMeta.push(fmtDurationMd(dur));
  if (ch.outcome && ch.outcome !== "clean") chMeta.push(`outcome: ${ch.outcome}`);
  if (chMeta.length) {
    lines.push(`*${chMeta.join(" | ")}*`);
    lines.push("");
  }

  if (ch.gitOps.length > 0) {
    lines.push("### Git");
    lines.push("");
    for (const op of ch.gitOps) {
      if (op.type === "commit") {
        const hashStr = op.hash ? "`" + op.hash.slice(0, 7) + "`" : "";
        lines.push("- **commit** " + hashStr + " " + (op.message || "(no message)"));
      } else if (op.type === "push") {
        lines.push(`- **push** ${op.remote || ""} ${op.branch || ""}${op.tags ? " --tags" : ""}`);
      } else if (op.type === "branch-create") {
        lines.push(`- **branch** create \`${op.branch || ""}\``);
      } else if (op.type === "branch-switch") {
        lines.push(`- **checkout** \`${op.branch || ""}\``);
      } else if (op.type === "merge") {
        lines.push(`- **merge** \`${op.branch || ""}\``);
      } else if (op.type === "rebase") {
        lines.push(`- **rebase** onto \`${op.branch || ""}\``);
      } else if (op.type === "tag") {
        lines.push(`- **tag** \`${op.tag || ""}\``);
      } else {
        lines.push(`- **${op.type}**`);
      }
    }
    lines.push("");
  }

  const fileKeys = chapterFileKeys(ch);
  if (fileKeys.length > 0) {
    lines.push("### Files");
    lines.push("");
    for (let fi = 0; fi < fileKeys.length; fi++) {
      const path = fileKeys[fi];
      const info = ch.files[path];
      const opCount = {};
      info.ops.forEach(o => { opCount[o] = (opCount[o] || 0) + 1; });
      let opStr = "";
      let opFirst = true;
      for (const op in opCount) {
        if (!Object.prototype.hasOwnProperty.call(opCount, op)) continue;
        if (!opFirst) opStr += ", ";
        opFirst = false;
        const c = opCount[op];
        opStr += op.toLowerCase() + (c > 1 ? ` x${c}` : "");
      }
      lines.push(`- \`${path}\` — ${opStr}`);
    }
    lines.push("");
  }

  if (ch.diffs.length > 0) {
    lines.push("### Changes");
    lines.push("");
    for (const d of ch.diffs.slice(0, 8)) {
      lines.push(`**\`${d.path}\`** (${d.name === "Write" ? "write" : "edit"})`);
      lines.push("");
      if (d.name === "Edit" && d.diffInfo) {
        if (d.diffInfo.oldStr) {
          lines.push("```diff");
          for (const line of d.diffInfo.oldStr.split("\n")) {
            lines.push(`- ${line}`);
          }
          if (d.diffInfo.newStr) {
            for (const line of d.diffInfo.newStr.split("\n")) {
              lines.push(`+ ${line}`);
            }
          }
          lines.push("```");
          lines.push("");
        }
      } else if (d.name === "Write" && d.diffInfo && d.diffInfo.content) {
        lines.push("```");
        lines.push(joinFirstLines(d.diffInfo.content, 8));
        lines.push("```");
        lines.push("");
      }
    }
    if (ch.diffs.length > 8) {
      lines.push(`*...and ${ch.diffs.length - 8} more changes*`);
      lines.push("");
    }
  }

  if (ch.commands.length > 0) {
    lines.push("### Commands");
    lines.push("");
    for (const cmd of ch.commands.slice(0, 12)) {
      lines.push(`**[${cmd.ok ? "ok" : "FAIL"}]** \`${truncateFirstPrompt(cmd.cmd)}\``);
      if (cmd.output) {
        lines.push("");
        lines.push("```");
        lines.push(joinFirstLines(cmd.output, 4));
        lines.push("```");
      }
      lines.push("");
    }
    if (ch.commands.length > 12) {
      lines.push(`*...and ${ch.commands.length - 12} more commands*`);
      lines.push("");
    }
  }

  if (ch.errors > 0) {
    let errShown = 0;
    let wroteErrorsHeader = false;
    for (let ci = 0; ci < ch.commands.length; ci++) {
      const cmd = ch.commands[ci];
      if (cmd.ok) continue;
      if (!wroteErrorsHeader) {
        lines.push("### Errors");
        lines.push("");
        wroteErrorsHeader = true;
      }
      if (errShown < 5) {
        lines.push(`- \`${safeSlice(cmd.cmd, 120)}\``);
        if (cmd.output) {
          lines.push(`  > ${truncateFirstPrompt(joinFirstLines(cmd.output, 1))}`);
        }
        errShown++;
      }
    }
    for (const errText of ch.standaloneErrors || []) {
      if (errShown >= 5) break;
      if (!wroteErrorsHeader) {
        lines.push("### Errors");
        lines.push("");
        wroteErrorsHeader = true;
      }
      lines.push(`- **session:** ${safeSlice(joinFirstLines(errText, 1), 200)}`);
      errShown++;
    }
    if (wroteErrorsHeader) lines.push("");
  }

  if (ch.webOps.length > 0) {
    lines.push("### Web");
    lines.push("");
    for (const w of ch.webOps.slice(0, 6)) {
      if (w.type === "fetch") {
        lines.push(`- **Fetch** ${w.url || ""}${w.pageTitle ? ` — ${w.pageTitle}` : ""}`);
        if (w.prompt) lines.push(`  *${safeSlice(w.prompt, 120)}*`);
      } else if (w.type === "search") {
        lines.push(`- **Search** "${w.query || ""}"`);
        if (w.results) {
          for (const r of w.results.slice(0, 3)) {
            lines.push(`  - [${r.title}](${r.url})`);
          }
        }
      }
    }
    lines.push("");
  }

  if (ch.mcpOps.length > 0) {
    lines.push("### Integrations (MCP)");
    lines.push("");
    for (const m of ch.mcpOps.slice(0, 10)) {
      const status = m.ok ? "OK" : "FAIL";
      const serverLabel = m.server.replace(/_/g, " ");
      const toolLabel = m.tool.replace(/_/g, " ");
      lines.push(`- **[${status}]** \`${serverLabel}\` → ${toolLabel}`);
      let paramStr = "";
      let paramN = 0;
      for (const pk in m.params) {
        if (!Object.hasOwn(m.params, pk)) continue;
        if (paramN > 0) paramStr += ", ";
        paramStr += `${pk}: ${safeSlice(m.params[pk], 80)}`;
        if (++paramN >= 3) break;
      }
      if (paramStr) lines.push(`  ${paramStr}`);
      if (m.output && m.output.length > 0) {
        const preview = safeSlice(m.output.split("\n").slice(0, 2).join(" "), 120);
        lines.push(`  > ${preview}`);
      }
    }
    lines.push("");
  }

  if (ch.agents.length > 0) {
    lines.push("### Subagents");
    lines.push("");
    for (const a of ch.agents) {
      const status = a.isError ? "FAIL" : a.completed ? "OK" : "pending";
      lines.push(`- **[${status}]** ${a.description || "(unnamed)"}${a.subagentType ? ` (${a.subagentType})` : ""}`);
      if (a.prompt) lines.push(`  > ${safeSlice(a.prompt, 150)}`);
    }
    lines.push("");
  }

  if (ch.thinking.length > 0) {
    const totalWords = countWordsInStrings(ch.thinking);
    lines.push(`### Thinking (${totalWords.toLocaleString()} words)`);
    lines.push("");
    for (const t of ch.thinking.slice(0, 2)) {
      const preview = safeSlice(joinFirstLines(t, 6), 500);
      lines.push("```");
      lines.push(preview);
      lines.push("```");
      lines.push("");
    }
    if (ch.thinking.length > 2) {
      lines.push(`*...and ${ch.thinking.length - 2} more thinking blocks*`);
      lines.push("");
    }
  }

  if (ch.lastAssistantText) {
    lines.push("### Response");
    lines.push("");
    lines.push(safeSlice(ch.lastAssistantText, 800));
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines;
}

/** Chapter bodies from a parsed session (uses buildSessionChapters). */
export function buildMarkdownChapterSections(session) {
  const chapters = buildSessionChapters(session);
  const lines = [];
  lines.push("---");
  lines.push("");
  for (let i = 0; i < chapters.length; i++) {
    lines.push(...renderMarkdownChapter(chapters[i], i));
  }
  return lines;
}

export function buildMarkdownFooter() {
  const lines = [];
  lines.push(`*Exported from [tracequest](https://github.com/viktor-com/tracequest) on ${new Date().toLocaleDateString()}*`);
  lines.push("");
  return lines;
}

export function generateMarkdown(session) {
  const lines = [
    ...buildMarkdownHeader(session),
    ...buildMarkdownChapterSections(session),
    ...buildMarkdownFooter(),
  ];
  return lines.join("\n");
}
