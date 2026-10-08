# UI Content Density And Progressive Disclosure Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when deciding how much trace evidence belongs in the first visible row, metric card, table, or detail block. For spacing tokens use `docs/ui-visual-system-theming-guidelines.md`; for evidence order use `docs/ui-information-architecture-guidelines.md`; for charts and diagnostic visuals use `docs/ui-data-diagnostics-guidelines.md`; for controls and expansion state use `docs/ui-interaction-control-state-guidelines.md`.

The built UI uses density to keep inspection fast, then reveals proof in place. Browser rows, compare tables, rendered metrics, and collapsed chapters answer "which trace matters?" Expanded details, capped snippets, charts, and output blocks answer "why?"

## Disclosure Model

- Summary surfaces should support a decision without becoming transcripts. Browser rows show identity, prompt, source/model/project context, time, stats, severity, and tool hints; compare cards identify the two sides before metrics; rendered chapter headers show prompt, outcome, tools, time, turns, and tokens.
- Expansion is for proof within the same object. Rendered chapters, tool performance, file hotspots, long outputs, diffs, MCP output, and thinking blocks reveal detail in place while preserving the original row, panel, or chart position.
- Drill-in is for changing object or artifact. Browser rows route to one rendered Session, compare routes to a two-session worksheet, and rendered export/markdown/print/share actions create artifacts; do not add transcript-level evidence to browser or compare once the user needs the rendered Session.
- The collapsed state must stay useful after expansion is available. A header such as `tool performance - 12 tools, 96% success` or `file hotspots - 18 files - 44 touches` should remain a complete summary, not just a label for hidden content.

## Tables, Lists, And Metric Cards

- Preserve scan geometry for repeated evidence. Browser session rows use predictable zones; compare metric rows keep A values, a centered label, and B values on one line; rendered tool/file rows keep label, count/rate, bar, and jump/filter affordance aligned.
- Compact metric cards should expose value, unit/label, and only one supporting status signal. Use tabular numerals and short labels; put tool inventories, cache details, file lists, and explanatory text below the primary metric group or behind expansion.
- Dense lists should prefer counts and top-N slices over unbounded inventories. Existing patterns cap visible tool summaries, searches, web ops, MCP params/output, file hotspots, git operations, commands, diffs, and thinking blocks, then show a compact `... N more` row when omitted data matters.
- Keep row and table density stable across state. Active filters, selection, stale status, expanded/collapsed panels, copied state, and hover emphasis should not resize columns, metric cells, or list rows.

## Expandable Details And Evidence Blocks

- Use expansion when the evidence is valuable but not needed for every scan: chapter detail, long command output, diffs, agent prompts, MCP output, thinking blocks, tool performance bodies, and file hotspot lists.
- The expansion control belongs next to the bounded evidence or in the panel header that summarizes it. Avoid placing a separate "details" card far away from the row or chart it explains.
- Expanded content should preserve alignment with its owner. Rendered chapter detail is indented under the chapter header; tool and file panels expand below their headers; output toggles expand the exact block they bound.
- If collapsed content is irreversibly sliced before render, include enough context to make the omission visible: a count, `... N more`, a bounded preview, or a linked/jump path to the authoritative rendered detail.
- Print/PDF should reveal diagnostic evidence instead of preserving collapsed UI state. Rendered session print rules expand chapter details and remove height caps for output, diffs, prompts, thinking, and MCP output.

## Snippets, Pre, And Code-Like Evidence

- Raw commands, search queries, file paths, diffs, tool/MCP output, thinking, and assistant response excerpts are evidence. Keep them mono where they are machine-readable, preserve line breaks with `pre-wrap`, and avoid rewriting them into prose.
- Bound raw evidence in screen views with max height, first-line previews, or explicit slice limits. The current rendered UI uses compact output blocks, diff blocks, MCP output, thinking previews, and command/search caps so one noisy chapter cannot bury the rest of the trace.
- Use status marks and counts before long text. A command row should expose pass/fail plus the command; a search row should expose matches/no matches/error; a diff row should expose path and operation before the snippet.
- Prefer wrapping raw evidence over horizontal scrolling. Code-like blocks may break long tokens or paths; summaries and labels should not force page-level horizontal overflow.

## Truncation Versus Wrapping

- Truncate when the text is a summary or identifier inside a scan row: browser prompts, model/project labels, compare prompt excerpts, tool names in narrow compare rows, file hotspot paths, and web result titles/URLs.
- Clamp when the collapsed state still needs readable prose: rendered chapter prompts and web prompts use short multi-line previews, then expansion or detail preserves more context.
- Wrap when the text is a repair handle, raw evidence, or user-copyable proof: route error handles, URLs in evidence blocks, command output, diffs, MCP params/output, thinking, and assistant response excerpts.
- Use `overflow-wrap: anywhere`, `word-break`, or `pre-wrap` inside the owning block rather than letting long paths, hashes, URLs, or command output widen the viewport.
- Never truncate the only authoritative evidence. If a value is visually shortened in a row, the full value should exist in the rendered detail, accessible label, title/focus tooltip backed by visible detail, export, markdown, print, or route error body.

## Secondary Trace Metadata

- Expose secondary metadata in the first scan only when it changes the next action: source, session ID, model/project, age, grade, error count, cost/tokens, duration, commit/file signals, selected compare side, or tool/category hints.
- Defer secondary metadata that explains "why" rather than "which": cache reads/writes, token breakdowns, retry groups, related chapters, shared files, MCP params/output, web previews, thinking blocks, detailed git operations, and file touch lists belong in rendered diagnostics or expanded chapter detail.
- Promote secondary metadata when it becomes a repair handle, filter target, jump target, or warning explanation. Examples include failed route handles, chapter links for related/git/error evidence, active file/tool filters, expensive or error-heavy rows, and missing compare parameters.
- Compare should stay pairwise. Add secondary metadata only when it helps interpret a difference between the two sessions; otherwise link to the rendered Session instead of widening the worksheet.

## Review Questions

- Can a user decide whether to open, compare, expand, or ignore this trace from the collapsed row or panel header?
- Is raw evidence bounded on screen but still reachable through expansion, rendered detail, print/export, or a clear `... N more` signal?
- Are summary strings truncated while proof strings wrap inside their own block?
- Is secondary metadata visible because it changes action, explains a warning, or repairs state, rather than because it is merely available?
- Does the change cite the owning guide instead of duplicating rules for tokens, route state, accessibility, diagnostics, screenshots, print, or workflow?

Before changing this guide, run the change through the `Future UI Change Review Checklist` in `docs/ui-style-design-guidelines.md`. For this file, the recurring checks are scan density, disclosure path, bounded evidence, truncation versus wrapping, and whether secondary trace metadata belongs in summary, expansion, or a routed artifact.
