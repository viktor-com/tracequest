# UI Information Architecture And Navigation Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when changing page hierarchy, route-level navigation, session identity, compare context, or how dense trace evidence is grouped. For visual styling, route error and refresh state details, and selector vocabulary, use the companion links in the main index.

## Who opens tracequest and why

People open tracequest to do one of five jobs. Every surface should make its job's first step obvious.

| Job | Starts at | Answer is |
| --- | --- | --- |
| Find why a run went wrong | Runs (`/sessions`), filter `errors:>0` or sort by grade | `/view` errors panel: grouped failures with counts, each jumping to its chapter |
| Compare two runs of the same task | Runs, tick two rows, Compare | `/compare`: one-sentence verdict, then metrics with B-vs-A deltas |
| Watch a live run | Chat (`/`) | the chat view with the rail of running and recent sessions |
| Find a past run | Runs filter or the top-bar search (`/`, ⌘K) | the matching rows, or an empty state that says how to widen the search |
| See patterns across runs and machines | Insights (`/insights`) | tiles and grouped failure causes, or an empty state with the command that fills the cache |

## Page Hierarchy

Tracequest has three sections, named the same everywhere: **Chat**, **Runs** and **Insights**. Every served app page carries the section nav (`appNavHtml`) in its top bar with `aria-current="page"` on the current section, and the CommandPalette's g-chords jump between them (`g c` Chat, `g r` Runs, `g i` Insights) from anywhere except a text field or an open overlay.

```
Chat  (/)            rail of running + recent sessions → chat for one run (/run?id= or ?session=)
Runs  (/sessions)    inventory table → row opens analytics flyout → "Open full page" /view
                     tick two rows → /compare?a=…&b=…
Insights (/insights) machine health, failure causes, retries, stalls, spend
/view?id=…           one session, in depth (also the exported/shared document)
```

- `/sessions` is the Runs inventory: app bar, Runs heading, composed chrome (filters, dashboard, quick filters, sort), the inventory table, and pagination. The fixed compare bar is a contextual action surface, not another page section.
- `/` is Chat: the live chat surface with the agent rail. It opens the most relevant run (a tracequest-launched run first, then a running session, then the newest session).
- `/compare?a=...&b=...` is a server-rendered diagnostic worksheet. It renders only after both sessions resolve and reads as a one-sentence verdict, paired identity cards, metrics with deltas, tool usage, and chapter quality. Load failures or missing parameters use the compact compare error shell instead of a partial worksheet.
- `/view?path=...` or `/view?id=...` is the session viewer. It reads as back link (served only), session header and actions, metadata, session summary and diagnostics, the errors panel, chapter filters, then chapter rows with in-place details. Export, markdown, and raw routes are utility outputs, not separate navigation surfaces.

Route error pages belong to the route that failed. Keep them terminal and compact: route context, failure title, status, failed handle, message, and a return path to Runs.

## Route Headers And Back Links

Headers should identify the current route before they introduce controls.

- App bar (Chat, Runs, run chat): wordmark, section nav, live counter, plan-limit chips, then search, theme toggle, ⌘K and `+ New run` on the right. The page crumb (`Runs`, `sessions`) stays in the DOM for screen readers but is visually replaced by the nav.
- Plan windows sit in one scrollable line under the app bar (`#usageRow`): harness, plan, a small meter per window with used % and reset time. Never let it wrap into a block taller than one line.
- Compare header: `tracequest` (links to Runs), `session comparison`, then `swap A and B` (also the `s` key) and `back to sessions`, which returns to `/sessions`, the list the comparison was started from.
- Insights header: `tracequest / insights` with the section nav on the right. The page ships no script, so it has no keyboard jumps or theme toggle; it follows the system theme.
- Rendered session header: `tracequest` plus the session hash or short ID is the primary title. Source, model, cwd, branch, duration, and start time belong in the source badge and meta grid; page actions stay to the right.
- Route error shells: use the compact route-error title pattern instead of recreating the full happy-path header.

The served session viewer shows `← Runs` above its header. The route marks the document with `data-tq-served`; exported and shared files do not carry it, so they never show a link that would lead nowhere. Print hides it.

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
- Keep exits simple: `back to sessions` returns to Runs (`/sessions`); `view full session` opens the selected side in the rendered session viewer; `swap A and B` reloads with the sides exchanged.
- Lead with the answer. The verdict sentence names which run was longer, more expensive and had more errors. Differences under 5% are not coloured, so red and green only mark gaps worth reading.
- If compare gains client-side swapping or async loading, place transient state above the worksheet and update the route-state checklist before adding section-local spinners or partial charts.

## Session Identity

Show session identity before evidence, and keep load handles separate from user-facing labels.

- Browser rows identify source, session ID, model/project, time, prompt, stats, and tools in that order.
- Compare cards identify side, session ID, source, model, prompt excerpt, and full-session link in parallel order on both sides.
- Rendered session headers identify the product and session hash or short ID first, then source and metadata. Detailed evidence starts after identity is established.
- Prefer a session hash or short session ID for visible identity. Use raw paths and missing handles mainly as load/error repair information, where overflow wrapping is expected.
- Source badges are identity markers, not status badges. Keep them compact, sentence case, mono, a quiet tint of the source hue (`box-shadow: inset 0 0 0 999px var(--chip-tint)`), and adjacent to the session ID or title they qualify. Compare uses the same pill as the Runs list.
- Show projects as people read them. Encoded folders (`-Users-me--kandev-tasks-<uuid>`) display through `prettyProject` (no home prefix, 8-character UUIDs); the raw value stays in the title and is still what filters match.

## Dense Trace Information Grouping

Dense trace evidence should move from broad context to specific proof.

- Browser index groups collection-level controls before rows: filters and query syntax, dashboard scope, quick filters, live rows, sort, results, and pagination. Do not put expanded chapter detail in the browser list.
- Session rows group identity first, then the prompt, then compact stats and tool chips. Status badges and severity borders annotate the row without changing that order.
- Compare groups evidence metric-by-metric after identity: summary metrics, tool usage, then chapter-quality composition. This keeps numeric verdicts ahead of explanatory visuals.
- Rendered session pages group session-level diagnostics before chapter-level evidence. Chapter detail stays in-place under the chapter header, ordered as quality/context, related chapters, efficiency, files/git/subagents, changes/searches/web/integrations, commands, tokens/thinking, and response evidence.
- Diagnostic bands, detail rows, and nested evidence should use existing data-visualization and diagnostics guidance instead of creating new navigation layers for every evidence type.

Before changing this guide, run the change through the `Future UI Change Review Checklist` in `docs/ui-style-design-guidelines.md`. For this file, the recurring checks are route hierarchy, session identity, jump-state preservation, compare context, and whether the new content belongs here or in the route-state, diagnostics, or implementation vocabulary documents.
