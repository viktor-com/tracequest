# UI Data Visualization And Diagnostics Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when adding or changing Tracequest diagnostics that visualize session behavior. Pair it with the implementation vocabulary and rendered-hover audit links from the main index when diagnostics add selectors, tests, hover helpers, or focus behavior.

The common rule: every visual should explain real session evidence faster than text alone would. Do not add decorative charts, isolated gauges, or color-only verdicts.

## Evidence Principles

- Keep diagnostics close to the data they explain. Rendered session visuals belong near the session summary and chapter list; compare visuals belong after paired session identity and before low-level detail.
- Lead with a textual or numeric claim, then add the visual shape that explains it. Existing examples pair the waveform with a label and legend, cost progression with a total, tool-flow cells with counts and common transitions, and compare bars with side counts.
- Use visual density for scan speed, not for mystery. If a user cannot infer the axis, scale, status color, or side identity from nearby labels, add a compact legend or move the data into a table.
- Preserve source-backed terms: `chapter`, `turn`, `tool`, `cost`, `tokens`, `cache`, `active`, `idle`, `error`, `clean`, `corrected`, and `struggling`. Avoid abstract labels such as score bands unless the calculation is already visible elsewhere.
- Treat sparse data as evidence. Empty tool rows, zero chapter-quality segments, no-cost sessions, and sessions with no errors should render quietly with stable structure, not as blank panels or warnings.

## Analytics Canvas Charts

Use canvas for dense, continuous diagnostics where DOM rows would be too heavy: waveform, cost progression, and activity timeline.

- Canvas charts should be compact full-width bands inside quiet rendered-session surfaces. Keep labels above the canvas and legends or axis hints below it so the chart body stays available for evidence.
- The waveform pattern is for turn-level token shape: output above the center line, input below, tool color for the primary tool, brightness for uncached work, and error marks when the turn failed. Do not reuse this shape for unrelated metrics.
- The cost chart pattern is for cumulative cost over chapters plus per-chapter cost bars. Keep orange as the cost signal and include the total in the header; avoid a second color scale unless it represents a different semantic status.
- The activity timeline pattern is for elapsed session time: active work segments, dim idle gaps, chapter boundaries, time labels, and a small legend. Do not replace it with a generic progress bar because idle time and chapter context are the evidence.
- Tooltips on canvas charts should report the selected evidence point, not restate the whole chart. Keep them short: chapter, tool or phase, tokens/cost/time, cache or idle context, and error state when present.
- If a chart needs interaction, use the existing rendered-chart contract from `docs/ui-implementation-style-reference.md`: focusable canvas, explicit accessible name, local focus styling, and a nearby tooltip/status element. Do not create a hover-only canvas contract.

## Timeline And Minimap Diagnostics

Timelines and minimaps are navigation aids first and diagnostic summaries second.

- Use timelines when the x-axis is time or ordered progress. Preserve chapter boundaries and actual gaps; evenly spaced cells are acceptable only when the visual is about sequence rather than elapsed duration.
- Use the minimap for page-level chapter navigation and current-viewport awareness. Minimap blocks summarize chapter outcomes with green/orange/red, while small markers carry secondary error or commit signals.
- Keep minimap and timeline details subordinate to the expanded chapter detail. If a hover or focus tooltip contains unique diagnostic information, promote that information to chapter detail or a visible summary first.
- Keep the current hover-helper rule from `docs/rendered-hover-diagnostics-audit.md`: native `title` is only a secondary pointer hint. Required diagnostic information needs a visible, focusable, or ARIA-backed equivalent.
- Hide or simplify helper-only diagnostics on touch-sized layouts only when the same evidence remains available in the chapter list, expanded detail, summaries, or compare worksheet.

## Tool-Flow Sequences

Tool-flow visuals explain order and repetition, not success or failure by themselves.

- Use the narrow `.tool-flow-cell` strip for ordered tool calls across chapters. Insert dividers at chapter boundaries so users can see phase changes without reading every cell.
- Cap very long sequences by sampling cells as the current renderer does. When sampling is necessary, keep aggregate counts and common transitions visible so the strip remains a pattern overview, not a lossy source of truth.
- Pair each sequence strip with summary rows: tool color dot, tool label, total calls, and average per chapter. The summary is the readable fallback for dense cells.
- Put common transitions below totals. Transition chips should show `from -> to` and count; they explain repeated workflow habits better than another color strip would.
- Tool color identifies tool family. It does not imply outcome, winner, or severity. Use red/orange/green status treatments only when the data is actually error, warning, clean, corrected, or successful.

## Metric Summaries And Evidence Order

Metric summaries should answer "what happened?" before lower-level diagnostics answer "where and why?"

- Rendered session order should stay: identity and metadata, session summary stats, activity/timing, error and quality summaries, token/cost/tool/file/git diagnostics, then chapter-level evidence.
- Keep high-level metric groups numeric and compact. Use tabular numerals and short labels; reserve long explanation for expanded detail or documentation.
- Use semantic value coloring only when the metric has a clear interpretation. Cost and waste are orange, errors and struggling state are red, clean/success/commit state is green, and selection or focus is accent.
- Prefer repeated small rows for ranked diagnostics such as tool performance, file hotspots, commands, and git operations. Each row should expose the label, count or rate, and status mark needed to compare it with neighboring rows.
- Keep aggregate summaries and drill-down filters connected. If clicking a tool/file diagnostic filters chapters, preserve the same label and color between the summary row and filtered chapter evidence.

## Compare Evidence Displays

Compare visuals are paired evidence, not independent dashboards.

- Preserve the compare evidence chain: paired session identity, centered-label metric table, mirrored tool-usage bars, then chapter-quality composition. This order moves from "what is being compared" to "which differences matter" to "what explains them."
- Use a centered label when two values need row-by-row comparison. A-right, label-center, B-left alignment is the default for scalar metrics because it keeps both sessions in one scanning line.
- Use mirrored bars only when the same category appears on both sides. Bars should grow away from the shared label, and counts should remain visible so small values are not hidden by normalization.
- Use segmented bars when the parts form one whole, such as clean/corrected/struggling chapters. Always pair segments with text counts; zero-width segments still need textual evidence.
- Apply winner colors only when the metric has an explicit preference. Differences in model, output tokens, files, commits, or raw tool calls are evidence, not automatic good/bad judgments.
- Do not render partial compare worksheets. If either side cannot load or a required parameter is missing, the compact compare error shell is the correct visual state.

## Review Hooks

- For selector names and state vocabulary, use `docs/ui-implementation-style-reference.md` before adding a new chart or diagnostic family.
- For hover, focus, minimap, and tooltip decisions, use `docs/rendered-hover-diagnostics-audit.md`.
- For screenshot review, responsive, print, and route-state triggers, use the existing sections in `docs/ui-style-design-guidelines.md` and `docs/route-state-audit-checklist.md` instead of duplicating those checklists here.
