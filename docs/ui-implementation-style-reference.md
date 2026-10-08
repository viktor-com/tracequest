# UI Implementation Style Reference

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this implementation-side companion when naming selectors, state attributes, tokens, diagnostics, or UI test hooks. It names the vocabulary already used by Tracequest UI code so new CSS, markup, and tests extend existing conventions instead of inventing parallel names.

## Shared Naming And Tokens

- Start new screen CSS with the shared base from `src/browser/shared-css-tokens.js`: `STANDALONE_BASE_CSS` for browser and compare pages, `SESSION_VIEWER_BASE_CSS` for rendered session HTML.
- Prefer token names from `CSS_ROOT_SHARED`: `--bg`, `--surface`, `--surface2`, `--fg`, `--fg2`, `--fg3`, `--border`, `--accent`, `--red`, `--green`, `--orange`, `--sans`, and `--mono`.
- Use session-only dim tokens when a status needs a soft surface: `--green-dim`, `--red-dim`, and `--orange-dim`.
- Treat `.container` as the standalone page frame for browser, compare, and route error shells. Rendered session pages use `#app` for the primary frame.
- Use suffixes consistently: `-bar` for horizontal work surfaces, `-row` for repeated list items, `-wrap` for layout wrappers, `-btn` for compact buttons, `-badge` or `-chip` for short labels, `-stat` for metrics, `-title` and `-label` for textual hierarchy.
- Use state classes only when CSS needs them: `.active`, `.open`, `.hidden`, `.collapsed`, `.expanded`, `.copied`, and `.hl` already exist. Prefer ARIA state attributes such as `aria-pressed`, `aria-expanded`, and `aria-current` for control state.

## Browser Index Vocabulary

Primary files: `src/browser/browser-page-build.js`, `src/browser/browser-client.js`, and `src/browser/browser-client-dashboard.js`.

- Page shell: `.container`, `.header`, `.title`, `.subtitle`, and `.refresh-status`. Refresh state is exposed with `#refreshStatus[data-state="idle|pending|stale|error"]`.
- Query surface: `.filter-wrap`, `.filter-bar`, `.filter-input`, `.filter-hint`, `.filter-legend`, `.chip`, `.chip-key`, `.chip-value`, `.chip-remove`, `.negated`, `.suggestions`, `.suggestion-item`, `.suggestion-dot`, `.suggestion-label`, `.suggestion-count`, and `.hl`.
- Dashboard: `.dashboard`, `.dashboard-header`, `.dashboard-title`, `.dashboard-scope`, `.dashboard-toggle`, `.dashboard-stats`, `.dashboard-stat`, `.dashboard-stat-val`, `.dashboard-stat-label`, `.dashboard-stat-growth`, `.dashboard-tools`, `.dashboard-tools-list`, `.dashboard-tool-chip`, and `.dashboard-tool-count`.
- Home harness usage: `#usageRow.usage-row` is emitted by `appTopHtml` under the shared app top on `/`, `/run`, and the Runs inventory, outside `#dashboard`. Each installed harness is `.usage-widget` (`data-harness`, optional `data-host`, `.is-unauth` when signed out) with `.usage-widget-id`, `.usage-widget-plan`, `.usage-widget-hint`, and one `.usage-window` per plan window (`.is-limiting` on the limiting window, `.usage-window-name`, `.usage-meter`, `.usage-meter-val`, `.usage-meter-label`, `.usage-window-reset`). Top-bar chips stay `.app-limits` / `.app-limit-chip`.
- Quick filters and sorting: `.qf-bar`, `.qf-row`, `.qf-section`, `.qf-section-label`, `.qf-chip`, `.qf-grade`, `.qf-active`, `.qf-disabled`, `.qf-error-toggle`, `.qf-clear`, `.sort-bar`, `.sort-label`, and `.sort-btn`.
- Session list: `.session-row-wrap`, `.compare-cb`, `.session-row`, `.session-top`, `.session-source`, `.session-id`, `.session-model`, `.session-project`, `.session-spacer`, `.session-time`, `.session-size`, `.session-prompt`, `.session-stats`, `.session-stat`, `.session-tools`, `.session-tool`, `.tool-sparkline`, and `.tool-spark-seg`.
- Browser status naming: keep row severity as additive classes on `.session-row`, such as `.has-errors`, `.has-commits`, and `.expensive`. Keep short visual labels as `.session-badge`, `.error-badge`, `.commit-badge`, `.cost-badge`, and `.session-grade-badge.grade-a` through `.grade-f`.
- Compare selection and pagination: `.compare-bar`, `.compare-bar-info`, `.compare-btn`, `.compare-clear`, `.pagination`, `.page-btn`, `.page-info`, `.page-size-wrap`, and `.page-size-select`.
- Session flyout: `#sessionFlyout.session-flyout`, `.session-flyout-head`, `#sessionFlyoutTitle`, `#sessionFlyoutSub`, `#sessionFlyoutOpen`, `#sessionFlyoutPrev`, `#sessionFlyoutNext`, `#sessionFlyoutClose`, `#sessionFlyoutStatus`, `#sessionFlyoutFrame`, `body.session-peek-open`, and `.session-row-wrap.is-selected`. The flyout iframe loads `/view?embed=1` (`body.embed-view`).

## Compare Vocabulary

Primary files: `src/browser/compare-page.js` and `src/browser/compare-page-css.js`.

- Use the `cmp-` prefix for compare-only selectors. This keeps the compare worksheet separate from browser rows and rendered session chapters.
- Page shell: `.cmp-header`, `.cmp-title`, `.cmp-subtitle`, and `.cmp-back`.
- Paired identity cards: `.cmp-sessions`, `.cmp-session`, `.session-b`, `.cmp-session-label`, `.cmp-session-id`, `.cmp-session-model`, `.cmp-session-prompt`, `.cmp-session-link`, and `.cmp-source-badge`.
- Repeated worksheet sections: `.cmp-section` and `.cmp-section-title`. Do not introduce louder card names for individual compare blocks unless the page gains a distinct interaction mode.
- Metric table: `.cmp-table`, `.cmp-col-headers`, `.cmp-col-a`, `.cmp-col-label`, `.cmp-col-b`, `.cmp-label`, `.cmp-val`, `.delta-good`, and `.delta-bad`.
- Tool comparison: `.tool-cmp-row`, `.tool-cmp-name`, `.tool-cmp-bar-wrap`, `.tool-cmp-left`, `.tool-cmp-right`, `.tool-cmp-bar`, and `.tool-cmp-count`.
- Chapter quality: `.cmp-outcome`, `.cmp-outcome-side`, `.cmp-outcome-bar`, `.cmp-outcome-seg.clean`, `.cmp-outcome-seg.corrected`, `.cmp-outcome-seg.struggling`, `.cmp-outcome-legend`, `.cmp-outcome-legend-item`, and `.cmp-outcome-dot`.

## Insights Vocabulary

Primary file: `src/browser/insights-page.js`.

- Use the `ins-` prefix for insights-only selectors. The page is server-rendered and ships no script; drill-down is native `<details>`.
- Page shell and scope: `.ins-header`, `.ins-title`, `.ins-subtitle`, `.ins-lede`, `.ins-scope`, `.ins-scope-input`, `.ins-chip` (current range or machine uses `aria-current="true"`), and `.ins-note` with `role="status"`. The frame carries `data-insights-state="ready|empty"`.
- Figures: `.ins-tiles` / `.ins-tile` for the headline, `.ins-facts` for inline figures, `.ins-bars` / `.ins-bar-row` / `.ins-bar-head` / `.ins-bar-fill` for ranked bars, `.ins-cols` for the active-time histogram, `.ins-table` for machines and expensive sessions, and `.ins-traps` / `.ins-trap` (`data-trap`). Every section root carries `data-insight="<id>"`.
- Machine state is a dot plus a label, never color alone: `.ins-state[data-state="local|fresh|stale|failing|never"]`.
- Example sessions: `.ins-examples` of `.ins-example` links to `/view`, each with `.ins-example-src` (`source@host`), `.ins-example-prompt`, and `.ins-example-note`.

## Rendered Session Vocabulary

Primary files: `src/render/render-session-rules.js`, `src/render/render-session-css.js`, `src/render/render-ui-chapters.js`, `src/render/render-ui-detail.js`, and `src/render/render-analytics-compose.js`.

- Page shell and summary: `#app`, `.header`, `.header-top`, `.header-title`, `.header-actions`, `.meta-grid`, `.meta-item`, `.meta-label`, `.meta-value`, `.stats-bar`, `.stat`, `.stat-value`, `.stat-label`, and `.stats-note`.
- Export and sharing controls: `.export-btn`, `.print-btn`, `.md-btn`, `.hf-btn`, `.hf-modal-overlay`, `.hf-modal`, `.hf-modal-title`, `.hf-modal-label`, `.hf-modal-input`, `.hf-modal-status`, `.hf-modal-actions`, `.hf-modal-share`, and `.hf-modal-cancel`.
- Chapter list: `.filter-bar`, `.filter-chip`, `.filter-chip.active`, `.filter-count`, `.chapters`, `.chapter`, `.chapter-head`, `.chapter-num`, `.chapter-body`, `.chapter-prompt`, `.chapter-prompt-text`, `.chapter-meta`, `.chapter-tools`, `.ch-tool`, `.chapter-right`, `.chapter-time`, `.chapter-turns`, and `.chapter-tokens`.
- Chapter state and details: `.chapter.expanded`, `.chapter.kb-focused`, `.chapter-detail`, `.chapter-permalink`, `.copied`, `.chapter-outcome`, `.chapter-outcome-dot`, `.chapter-patterns`, `.chapter-pattern-badge`, `.chapter-quality`, `.chapter-efficiency`, `.chapter-waste-badge`, and `.chapter-token-detail`.
- Dense diagnostic panels should keep their existing nouns before adding new ones: `.analysis-*`, `.tool-perf-*`, `.file-hotspot-*`, `.git-*`, `.minimap-*`, `.activity-*`, and `.error-*` families are preferred over generic `.card-*` or `.panel-*` names.
- Keep print-specific behavior in `render-session-css.js` when new selectors introduce controls, modals, hover helpers, fixed overlays, collapsed bodies, or canvas visuals.

## Route-State And Error Shell Vocabulary

Primary files: `src/routes/route-handlers-pages.js`, `src/browser/compare-page.js`, and `docs/route-state-audit-checklist.md`.

- Browser fetch failures stay inside the browser list surface with `.fetch-error`; empty result sets use `.empty`.
- Compare route failures use `.cmp-error`, `.cmp-error-title`, `.cmp-error-status`, `.cmp-error-handle`, `.cmp-error-message`, and `.cmp-error-link` with `role="alert"` and `data-compare-state="error"`.
- Rendered session route failures use `.route-error`, `.route-error-kicker`, `.route-error-title`, `.route-error-status`, `.route-error-handle`, `.route-error-message`, and `.route-error-link` with `role="alert"` and `data-view-state="error"`.
- Keep route error shells compact. Add a new `data-*-state` attribute when a route gains a distinct state contract; do not overload row or chapter classes to describe route-level state.

## Diagnostics Vocabulary

- Diagnostic color classes should describe domain state, not paint choice: `.clean`, `.corrected`, `.struggling`, `.error`, `.retry`, `.correction`, `.eff-good`, `.eff-ok`, `.eff-bad`, `.up`, and `.down`.
- For rendered hover and focus diagnostics, prefer an existing family before adding a new prefix: `.tool-flow-*`, `.minimap-*`, `.activity-*`, `.waveform-*`, `.cost-*`, `.error-streak-*`, and `.error-dot`.
- Keep pointer hints secondary. Native `title` is acceptable for repeated visual cells only when the same information exists in visible text, ARIA labels, a focus tooltip, or expanded detail.
- For canvas diagnostics, use a focusable canvas with an explicit accessible name and a nearby tooltip/status element when keyboard users need the same selected-point feedback as pointer users.
- Tests should target stable selectors and state attributes from this reference, not incidental text layout. Prefer `data-*-state`, ARIA state, and family selectors such as `.cmp-error`, `.route-error`, `.chapter.expanded`, and `.refresh-status[data-state="stale"]`.

## Command Palette Vocabulary

Primary file: `src/browser/command-palette.js`. Mounted from the Runs inventory, run/chat pages, compare, and served `/view` (not standalone export HTML).

- Overlay and dialog: `#cmdkOverlay.cmdk-overlay`, `.cmdk`, `#cmdkInput.cmdk-input`, `#cmdkList.cmdk-list`, `#cmdkEmpty.cmdk-empty`, `#cmdkContext.cmdk-context`, `#cmdkSpinner.cmdk-spinner`.
- Trigger in the shared app bar: `#cmdkTrigger.cmdk-trigger`, `.cmdk-trigger-kbd`.
- Site-wide workspace search (idle `/`, not Cmd+K): `#workspaceSearchWrap.tq-search`, `#workspaceSearch.tq-search-input`, `#workspaceSearchList.tq-search-list`, `.tq-search-item`, `.tq-search-kbd`. Mounted with the palette on served pages; `.in-app-top` / `.in-cmp-header` / `.tq-search-fixed`.
- Result chrome: `.cmdk-group`, `.cmdk-group-label`, `.cmdk-item`, `.cmdk-item-icon`, `.cmdk-item-title`, `.cmdk-item-sub`, `.cmdk-item-keys`, `.cmdk-key`.
- Session search hits: `.cmdk-item.cmdk-hit`, `.cmdk-item-idline`, `.cmdk-src`, `.cmdk-sid`, `.cmdk-mark`, `[data-kind="session"]`, `[data-session-id]`. Groups: `Recent`, `Recent searches`, `Sessions`, `Search`.
- Page jumps: `[data-kind="nav"]`, `[data-dest="chat|runs|compare|view|launch|this-run|this-chat|last-chat"]`, `[data-href]`. Group: `Go to`. G-then chords `C`/`R`/`D`/`V`/`N`.
- State: `#cmdkOverlay[data-cmdk-state="open|closed"]`, `body.cmdk-open`, `.cmdk-item[aria-selected="true"]` / `.hl`. Later result kinds register through `window.TracequestPalette.registerProvider`. Search hits come from `GET /api/search?q=`; empty query recents from `GET /api/sessions`.

## Adding New Selectors

- First ask whether an existing family can carry the new UI: `session-*` for browser rows, `cmp-*` for compare, `chapter-*` for rendered chapter content, `hf-*` for share modal controls, and `route-error-*` for rendered route failure shells.
- Add the smallest new noun that describes the domain object users inspect. Avoid generic names like `.card`, `.panel`, `.box`, `.item`, or `.content` unless the surrounding family makes the role unambiguous.
- Keep naming local to the owning surface. Do not reuse `.header`, `.filter-bar`, or `.container` semantics across a new embedded widget if that widget can be named under its own family.
- Document any new selector family here when it becomes reusable, appears in tests, or carries a state contract.
