# UI Workflow And Task-Flow Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when deciding how a user task should move across the browser index, compare worksheet, and rendered session detail. For route hierarchy and labels, use [docs/ui-information-architecture-guidelines.md](ui-information-architecture-guidelines.md). For link-vs-button semantics and local state, use [docs/ui-interaction-control-state-guidelines.md](ui-interaction-control-state-guidelines.md). For route loading, stale, and error shells, use [docs/route-state-audit-checklist.md](route-state-audit-checklist.md).

## Workflow Spine

Tracequest has one primary inspection path: find the relevant Session, decide whether it needs single-session or paired-session analysis, then escalate from summaries to concrete evidence.

- The browser index is the discovery and selection hub. It owns corpus-level filtering, dashboard scope, quick filters, sorting, pagination, live sessions, row scanning, and compare selection.
- The compare page is a temporary diagnostic worksheet for exactly two resolved sessions. It should answer "how do these sessions differ?" before users open either transcript.
- The rendered session page is the evidence document. It owns session-level diagnostics, chapter filtering, in-page jumps, expanded chapter detail, export, markdown, print, and share flows.
- Utility outputs such as export, markdown, print, raw, and share should hang off the rendered session route unless the user is explicitly exporting a list or comparison artifact.

## Browser To Rendered Session

Browsing and indexing workflows should narrow the visible corpus in place until the user chooses a trace.

- Keep corpus refinement on the browser page. Filters, suggestions, quick filters, sort, page size, pagination, dashboard scope, and stale-refresh status all describe the same result set and should not route away from the list.
- Preserve browser context in the browser URL. Existing state uses `expr`, `sort`, `page`, and `pageSize` so reload, back, and copied list URLs return to the same triage surface.
- Make each session row sufficient for a drill-in decision: source, session ID, project/model, time, prompt, stats, tool signals, and severity badges. If a new field helps users choose a trace, prefer adding it to the row or dashboard before adding another route.
- Use the row click for single-session evidence. Browser session rows open the existing `/view` analytics in a right-hand flyout while the inventory stays; modifier-click or Open full page still route to `/view` with a stable session handle and source. Live run rows still open their chat. Rows should not expand into full transcripts inside the browser list.
- Keep compare selection parallel to row navigation. Checkboxes and the fixed compare bar select sessions without stealing the row's drill-in behavior.

## Filtering To Find A Trace

Filtering is a narrowing workflow, not a separate search-results product.

- Treat typed filters, query suggestions, quick filters, and source/model/grade chips as different inputs into the same corpus scope. Users should always be able to inspect or edit the active expression in one place.
- Keep result-set summaries attached to the current scope. Dashboard counts, quick-filter counts, empty states, and stale data messages should describe the mounted browser query rather than a hidden global corpus.
- Do not move users to a new page merely because the query is complex. Route only after the user selects a session, selects two sessions for compare, or requests an explicit artifact.
- Empty and stale states should keep the user near the query that caused them. A failed background refresh preserves visible rows when they still represent the current query; a user-driven load failure uses the list-level fetch error.

## Compare As A Temporary Worksheet

Compare is for deciding between two sessions, not for reading two full transcripts side by side.

- Start compare from the browser selection flow. The fixed bar should remain unavailable until two valid selections exist, then route to `/compare` using stable session IDs and source parameters.
- Render the worksheet only when both sessions resolve. Missing parameters or failed side loads should use the compact compare error shell; do not render a half-comparison.
- Keep the compare page focused on pairwise judgment: paired identity cards, metric rows, tool usage, and chapter quality. Add new compare evidence only when it helps users understand the difference between the two sessions.
- Use the `view full session` links when the next task is transcript reading, chapter inspection, raw evidence, export, print, or share. Do not keep adding transcript-like detail to compare after the user needs single-session evidence.
- Preserve side identity until the user leaves compare. Links to full sessions should use the selected side's stable handle; compare itself should keep A/B identity structural through placement and side colors.

## Rendered Session Detail And Local Drill-In

Rendered session workflows should stay in one page while the user is investigating the same Session.

- Keep chapter search, tool filters, waste filters, expand/collapse, related-chapter jumps, chart jumps, minimap jumps, and chapter permalinks in the rendered page. They are local investigation steps, not child routes.
- Preserve route-local context across jumps and artifacts. Existing rendered-session URLs retain `path` or `id`, `source`, active `tool`, `q`, and `#chapter-N`; export, markdown, and permalinks should keep the relevant subset.
- Escalate in place from session summary to diagnostics to chapter detail. A metric, chart segment, related-chapter badge, or permalink should focus or expand the relevant chapter rather than replacing the route.
- Create a new route only when the user is leaving the session evidence document for another object, a route-backed artifact, or an external URL.

## Summary To Evidence Escalation

Every summary should have an obvious next step to evidence.

- Browser summaries lead to either a session row drill-in or a two-session compare. Do not add browser-only summaries that cannot be traced to rows or filters.
- Compare metrics lead to the relevant side's full-session link when the user needs chapter sequence, raw commands, diffs, output, or recovery evidence.
- Rendered session summaries lead downward: session stats and charts point to chapters; chapter headers point to detail; detail rows expose commands, searches, file changes, integrations, tokens, thinking, and response evidence.
- Prefer jumps, expansion, and focused local state for evidence within the same session. Prefer route links when the evidence belongs to another session, a pair of sessions, a downloadable artifact, or an external resource.

## Stay In Page Vs Link Out

Use this decision before adding a new workflow surface.

- Stay in the current page when the user is refining a result set, changing sort/filter/page state, selecting compare candidates, expanding local detail, moving among chapters, or inspecting another view of the same session pair.
- Link to another Tracequest route when the object changes: browser to one rendered session, browser to a two-session comparison, compare side to rendered session, or rendered session to a route-backed artifact.
- Link outside Tracequest only for source evidence that already lives outside the session, such as captured web URLs. Keep external links subordinate to the local trace evidence.
- If a future workflow needs client-side async switching, stale-data preservation, or a non-terminal error state, update the route-state checklist before adding section-local spinners, partial worksheets, or hidden retry behavior.

## Review Checklist

- Is the user still working on the same corpus query, same session pair, or same rendered Session? Keep the task in page.
- Did the selected object change from a list item to a Session, from two list items to a comparison, or from one compare side to a full Session? Use a route link.
- Does every summary metric or badge provide a clear path to evidence through a row, compare side link, chapter jump, or expansion?
- Does route or hash state preserve the context a user would expect after reload, copy, export, markdown, or permalink?
- Are route-state, IA, interaction-state, diagnostic, accessibility, visual, and print concerns handled by the companion docs instead of duplicated here?
