# UI Result-State Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when deciding how empty, loading, stale, error, and partial-data states should behave. For exact route coverage and selectors, use [docs/route-state-audit-checklist.md](route-state-audit-checklist.md); for text style, use the main guide's copy patterns.

## Evidence And Action Depth

Tracequest states should expose only as much evidence and action as the user can use from that surface.

- Empty or sparse data states need one neutral state label plus the surrounding filters, counts, or worksheet context that already explain the scope. Do not add alert styling, fake rows, or long help text.
- Loading and background refresh states need compact live status near the data being refreshed. Keep existing evidence mounted when it still describes the current query.
- Stale data states need a freshness warning, not a replacement page. Preserve the last trustworthy rows or panels, mark them stale, and let the next refresh clear the status.
- Route or session load failures need one alert shell with concrete repair evidence: failed side or route, HTTP status, handle or `(missing)`, server message, and a back link.
- Blocked compare states need either a disabled local action or the compact compare error shell. Do not render a half worksheet, blank chart, or enabled command that cannot navigate.

## No Sessions Or Results

The browser index treats an empty corpus and an empty filtered result as a quiet result state, not a failure.

- Visible evidence: keep the active filter/query controls, result count, quick-filter context, and the centered `No sessions match` message. The empty state does not need status codes, diagnostics, screenshots, or source-specific explanation.
- Actions: leave existing filter-clearing controls available when they apply. Do not introduce a separate empty-state call to action unless a real recovery command exists.
- Scope: the empty message describes the mounted API result, not a hidden global corpus. If a user-driven request fails, switch to the fetch-error state instead of showing `No sessions match`.

## Loading And Refresh

Only client-refreshed surfaces need visible intermediate loading states.

- Browser index refreshes use the header live region with compact pending text while keeping the current list geometry stable.
- Server-rendered compare and `/view` pages do not need client spinners today; the server sends either a complete page or an error shell.
- Future async loading should name the work in a reserved status area and avoid shifting rows, charts, fixed bars, or paired compare columns.

## Stale Index State

Stale index or background refresh failure means the displayed data may be old, not that the current rows are unusable.

- Visible evidence: preserve the existing session rows when they still match the mounted query, and use the compact `stale data` status for freshness. Put detailed failure text in non-disruptive status detail when needed.
- Actions: do not replace the workflow with a full error unless the user-triggered query failed. Add a retry button only if the surface gains an explicit retry command; otherwise the next live refresh is the recovery path.
- Boundary: if filters, sort, pagination, or query text changed and the new request failed, the stale rows no longer describe the requested scope. Use the list-level fetch-error state instead.

## Missing Or Inaccessible Session Handles

Missing, forbidden, deleted, or unparseable session handles are route errors because the requested object cannot be inspected.

- Visible evidence: use the compact route shell with the failed handle or `(missing)`, HTTP status, server message, and the route-specific title.
- Actions: provide `back to sessions`. Do not add a retry, copy, or diagnostic action unless the route gains local state that can actually repair the failure.
- Boundary: do not render normal session detail, chapter lists, metrics, or compare panels when the requested session did not load.

## Compare Mismatch And Missing Parameters

Compare distinguishes sparse successful data from blocked comparison.

- Sparse but loaded sessions stay in the worksheet. Missing scalar values use quiet fallbacks such as `-` or `0`; zero chapters show quiet zero-quality text; empty tool counts do not invent placeholder bars.
- Missing `a` or `b`, forbidden handles, deleted sessions, parse failures, or selected compare handles that no longer resolve are blocked comparison states. They should produce the compact compare error shell or keep the local compare command disabled.
- Visible evidence for blocked comparison is the failed side, status, handle or missing query parameter, and server message. The missing parameter copy should name `a` or `b`.
- Actions: route errors provide `back to sessions`; browser-local selection mismatch should provide the existing clear-selection path or keep compare unavailable. Do not render one side of the worksheet alone.

## Rendered Session Load Errors

The rendered session viewer has no meaningful partial route state: either a session loads and renders the full viewer, or the handle fails.

- Visible evidence: use the standalone route-error shell with `session view`, `Could not load session`, HTTP status, failed handle, and server message.
- Actions: provide `back to sessions` and live reload wiring only. Keep screenshots and Playwright route-error smoke deferred while the shell remains static and link-only.
- Boundary: missing chapters, errors inside a loaded transcript, or sparse analytics are content states inside a successful session. Keep them in the normal viewer instead of replacing the page.

## Partial Data Inside Successful Results

Partial data is useful evidence when the requested object loaded successfully.

- Keep partial data inside the existing panel, table, chart, or worksheet structure so users can compare absence alongside available values.
- Use quiet fallbacks (`-`, `0`, empty bars, omitted rows, bounded snippets) instead of alert blocks when the missing value is expected from sparse source data.
- Escalate to an error shell only when the primary object or required compare side cannot load. Escalate to an inline error only when the missing data has a specific local recovery action or materially invalidates that panel.
