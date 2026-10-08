# Route-State Audit Checklist

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this checklist when changing route shells or client refresh behavior for the browser index, compare page, or rendered session viewer. The goal is to keep non-happy-path states compact, explicit, and visually consistent with the main UI style guide.

## Browser Index

- [x] browser empty state: `render()` shows a centered `.empty` message, `No sessions match`, when the current API/filter result has no rows.
- [x] API empty envelope: `/api/sessions` returns a valid zeroed payload for an empty corpus, so the browser can render the same empty state without special routing.
- [x] fetch-error banner: `fetchSessions()` checks non-OK responses, records `_fetchError`, and `render()` replaces the list with a centered `.fetch-error` banner plus an em dash count.
- [x] live/data refresh path: `window._refreshData()` debounces `data-update` events, refetches `/api/sessions`, and rerenders with the current filter, sort, and page state.
- [x] loading refresh visibility: `/api/sessions` refetches update the header `#refreshStatus` live region with compact pending text while keeping the mounted element width stable.
- [x] stale-data error nuance: background live refresh failures preserve the existing rows and mark the header status as stale data; user-driven fetch failures such as changed filters, sort, or pagination still use the centered fetch-error list state instead of showing misleading stale rows for a different query.

## Compare Page

- [x] compare empty states: valid but sparse sessions stay in the worksheet. Empty tool counts render the Tool usage section without invented rows, missing scalar values use existing fallbacks such as `-` or `0`, and zero-chapter sessions render quiet `0 clean`, `0 corrected`, and `0 struggling` chapter-quality text.
- [x] compare route error state: `/compare` load failures for either side render a standalone compare shell with `.cmp-error`, `role="alert"`, `data-compare-state="error"`, the failed side, HTTP status, failed handle, message, and back link.
- [x] partial worksheet prevention: compare load errors do not render `.cmp-sessions` or the metric table, because every compare visual assumes two loaded session summaries.
- [x] missing compare parameters: missing `a` or `b` query parameters render the same compact compare error shell as load failures, but the message names the missing parameter (`a` or `b`) so copied or edited compare URLs can be fixed without guessing which side failed.
- [x] compare loading and refresh state: verified server-rendered route behavior. `handleCompare()` loads both sessions before sending one complete `comparePage()` response, and the page has no client-side session switching or async data refresh path. The only post-render update hook is dev live-reload injection, so there is no user-visible intermediate refresh state to design until compare gains client-side switching or async refresh.

## Rendered Session Viewer

- [x] rendered session route error state: `/view` load failures render a standalone session-view shell with `.route-error`, `role="alert"`, `data-view-state="error"`, HTTP status, failed handle, message, back link, and live reload wiring.
- [x] plain-text error replacement: missing, forbidden, deleted, or parse-error sessions use the rendered HTML error shell instead of leaving users on a plain-text response for the visual route.
- [x] successful rendered sessions remain self-contained: the normal `/view` route still sends `renderHTML(session)` with the existing inline CSS/JS session viewer.
- [x] route error screenshot decision: route error shells are not part of the regular screenshot refresh workflow while they remain compact static alert shells. The current checklist and route/integration assertions cover the stable contract: status, failed handle, message, back link, and live reload where applicable. Add a dedicated error-state screenshot only if route error visuals start changing often, gain meaningful interaction, or become visually rich enough that the happy-path browser, compare, and rendered-session examples no longer cover the design risk.
- [x] route error keyboard smoke decision: current focused route tests assert shell content, and route error shells only expose a normal back link plus live reload wiring. Add Playwright coverage only if route error pages gain controls or local state beyond the back link and live reload.

## Review Rule

Before changing this checklist, run the documentation change through the `Future UI Change Review Checklist` in `docs/ui-style-design-guidelines.md`. For this file, the recurring checks are state coverage, route-state decisions, screenshot visual review triggers, and facts/tests evidence.

When a route state changes, check the relevant source and test path together:

- Browser index: `src/browser/browser-client.js`, `src/browser/browser-page-build.js`, and `test/browser/browser-client-dashboard.test.js`.
- Compare page: `src/browser/compare-page.js`, `src/browser/compare-page-css.js`, `src/routes/route-handlers-pages.js`, and `test/routes/route-handlers-pages.test.js`.
- Rendered session viewer: `src/routes/route-handlers-pages.js`, `src/render.js`, and `test/routes/route-handlers-pages.test.js`.

Keep new gaps explicit in this file. Prefer checklist entries that name the visible state, the current behavior, and the condition that would justify implementation work.
