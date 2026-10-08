# UI Information Architecture And Navigation Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when changing page hierarchy, route-level navigation, session identity, compare context, or how dense trace evidence is grouped. For visual styling, route error and refresh state details, and selector vocabulary, use the companion links in the main index.

## Page Hierarchy

Tracequest has three primary UI surfaces:

- `/` is the Runs home: a list-first inventory of sessions/runs. Its vertical order is app bar, Runs heading, composed chrome (filters, dashboard, quick filters, sort), the inventory table, and pagination. The fixed compare bar is a contextual action surface, not another page section. `/` is not a landing page and not the full-page session viewer.
- `/compare?a=...&b=...` is a server-rendered diagnostic worksheet. It should render only after both sessions resolve, then read as paired identity cards, metrics, tool usage, and chapter quality. Load failures or missing parameters use the compact compare error shell instead of a partial worksheet.
- `/view?path=...` or `/view?id=...` is the self-contained rendered session viewer. It reads as session header and actions, metadata, session summary and diagnostics, chapter filters, then chapter rows with in-place details. Export, markdown, and raw routes are utility outputs, not separate navigation surfaces.

Route error pages belong to the route that failed. Keep them terminal and compact: route context, failure title, status, failed handle, message, and a return path to the browser index.

## Route Headers And Back Links

Headers should identify the current route before they introduce controls.

- Browser index header: `tracequest`, a dynamic count subtitle, and the compact refresh status share one baseline. The subtitle is result-state metadata, not prose.
- Compare header: `tracequest`, `session comparison`, and a right-aligned `back to sessions` link. Do not add breadcrumbs inside the paired session cards; the two cards already establish the comparison context.
- Rendered session header: `tracequest` plus the session hash or short ID is the primary title. Source, model, cwd, branch, duration, and start time belong in the source badge and meta grid; page actions stay to the right.
- Route error shells: use the compact route-error title pattern instead of recreating the full happy-path header.

Use `back to sessions` for exits from compare and route error shells. The rendered session viewer currently has no back link because it is also a standalone/exportable document; add one only if the viewer gains an explicit in-app navigation mode.

## Reload And Live Update Controls

Live update affordances should stay close to the route state they describe.

- Browser data refresh uses the header `#refreshStatus` live region. Keep pending, stale, and failed refresh status compact and stable in width so the session list does not move.
- Browser rows stay visible during failed background refreshes when they still describe the current query; user-driven query failures use the list-level fetch-error state described in the route-state checklist.
- Compare is server-rendered. Do not introduce a visible loading or reload control unless compare gains client-side session switching or async refresh.
- Rendered session and route error pages may include live-reload wiring in served development pages, but that mechanism is not product navigation. Do not expose it as a visible control unless users can intentionally refresh route data.

When refresh behavior changes, update or cite `docs/route-state-audit-checklist.md` rather than duplicating its state matrix here.

## Jump Navigation And Permalinks

Drill-in and in-page jumps should preserve the user's inspection context.

- Browser session rows are the primary drill-in to session analytics. A row click opens a right-hand `#sessionFlyout` that embeds the existing `/view` evidence (summary, diagnostics, charts, chapters) while the Runs inventory stays on screen. The row `href` still points at `/view` for modifier-click / open-in-new-tab / Open full page. Compare checkboxes sit beside rows as a parallel selection mode and must not replace the row link.
- Compare session cards exit through `view full session` links that carry the same stable session handle used by the compare route.
- Rendered session chapters are in-page destinations, not child pages. Chapter permalinks use `#chapter-N`; related-chapter badges, waveform/cost/activity chart jumps, minimap jumps, and keyboard chapter navigation should converge on the same chapter row.
- Chapter jumps should preserve active query state such as `path`, `source`, `tool`, and `q`. A jump may expand or focus a chapter, but it should not clear filters or move the user to a different route.
- Use route changes only when the user is changing surface: browser to rendered session, browser to compare, or compare to rendered session.

## Compare Context

Compare pages depend on two valid session summaries. Keep side identity visible and structural.

- Session A is left/accent, session B is right/orange. Preserve that identity in the paired cards and repeated column headers instead of adding large decorative A/B labels.
- Start every compare page with `.cmp-sessions`. Users need the two session IDs, source badges, models, prompt excerpts, and full-session links before they can trust the metric rows.
- Repeat side labels only where they help scanning: metric table column headers, tool comparison rows, and chapter-quality sides. Avoid prose explanations between every section.
- Keep exits simple: `back to sessions` returns to the browser index; `view full session` opens the selected side in the rendered session viewer.
- If compare gains client-side swapping or async loading, place transient state above the worksheet and update the route-state checklist before adding section-local spinners or partial charts.

## Session Identity

Show session identity before evidence, and keep load handles separate from user-facing labels.

- Browser rows identify source, session ID, model/project, time, prompt, stats, and tools in that order.
- Compare cards identify side, session ID, source, model, prompt excerpt, and full-session link in parallel order on both sides.
- Rendered session headers identify the product and session hash or short ID first, then source and metadata. Detailed evidence starts after identity is established.
- Prefer a session hash or short session ID for visible identity. Use raw paths and missing handles mainly as load/error repair information, where overflow wrapping is expected.
- Source badges are identity markers, not status badges. Keep them compact, uppercase, and adjacent to the session ID or title they qualify.

## Dense Trace Information Grouping

Dense trace evidence should move from broad context to specific proof.

- Browser index groups collection-level controls before rows: filters and query syntax, dashboard scope, quick filters, live rows, sort, results, and pagination. Do not put expanded chapter detail in the browser list.
- Session rows group identity first, then the prompt, then compact stats and tool chips. Status badges and severity borders annotate the row without changing that order.
- Compare groups evidence metric-by-metric after identity: summary metrics, tool usage, then chapter-quality composition. This keeps numeric verdicts ahead of explanatory visuals.
- Rendered session pages group session-level diagnostics before chapter-level evidence. Chapter detail stays in-place under the chapter header, ordered as quality/context, related chapters, efficiency, files/git/subagents, changes/searches/web/integrations, commands, tokens/thinking, and response evidence.
- Diagnostic bands, detail rows, and nested evidence should use existing data-visualization and diagnostics guidance instead of creating new navigation layers for every evidence type.

Before changing this guide, run the change through the `Future UI Change Review Checklist` in `docs/ui-style-design-guidelines.md`. For this file, the recurring checks are route hierarchy, session identity, jump-state preservation, compare context, and whether the new content belongs here or in the route-state, diagnostics, or implementation vocabulary documents.
