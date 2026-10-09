# tracequest UI guidelines

How the UI is organised and how to change it. The visual system (tokens, components, themes) is in [design-system.md](design-system.md). Read both before touching a screen.

## Who uses tracequest, and for what

People who run coding agents (Claude Code, Codex, Cursor, Droid, OpenCode, Grok) on one or more machines. They come to do five jobs:

| Job | Starts at | The answer is |
| --- | --- | --- |
| Find why a run went wrong | Runs, filter `errors:>0` or sort by grade | Session view → What went wrong: failures grouped by cause, each jumping to its chapter |
| Compare two runs of the same task | Runs, tick two rows → Compare | Compare: one-sentence verdict, then label · A · B · B vs A |
| Watch a live run | Chat | The rail of running and recent sessions, the live conversation, Stop and Kill |
| Find a past run | Runs filter, or search (`/`, ⌘K) | Matching rows, or an empty state that says how to widen the search |
| See patterns across runs and machines | Insights | Headline tiles, failure causes, retries, stalls, spend, traps |

Every screen should make its job's first step obvious and its answer the first thing on the page.

## Information architecture

```
tracequest ─┬─ Chat      /            rail of running + recent sessions → one run's live chat
            ├─ Runs      /sessions    inventory → row opens the analytics flyout → View full session
            │                         tick two rows → Compare /compare?a=…&b=…
            └─ Insights  /insights    machines, failure causes, retries, stalls, spend, traps

            /view?id=…   one session in depth (also the exported and shared file)
```

- Three sections, named the same everywhere: **Chat**, **Runs**, **Insights**. The top bar's section nav marks the current one with `aria-current="page"`. Compare and the session view belong to Runs.
- Keyboard: `g c` Chat, `g r` Runs, `g i` Insights, `g d` Compare, `g v` View, `g n` New run; `s` or `/` search; ⌘K command menu; `j`/`k` step through lists and chapters; `?` lists every shortcut.
- Exits go back to where the user came from: Compare and error pages link to Runs; the served session view shows `← Runs`. Exported and shared session files never show app navigation.

## The app shell

Every served page starts with the same top bar (`appTopHtml`): mark and wordmark, section nav with the live "N running" count, then search, plan limits, theme, ⌘K and the ink **New run** button. Insights is script-free (it is served to the hub), so it uses `appTopStaticHtml`: same look, no script-driven controls, theme follows the system.

- Plan limits collapse to one button showing the tightest windows; the per-machine breakdown opens as a popover.
- Theme: system by default; the toggle remembers the choice; `THEME_BOOT_SCRIPT` sets it before first paint.
- New run opens the launcher dialog: agent, folder, prompt, ⌘↵ to start.

## Screens

**Runs.** Two-line rows: the prompt is the title, identity sits underneath (agent hue square, readable project, model, id, error and commit badges). Numbers live in fixed right-aligned columns. Status is a dot; the word stays for screen readers. Filters combine with AND; quick filters, applied filters and the time range all write the same filter expression.

**Session view.** Header (the first prompt as the title, id, agent, project, branch, actions), overview (grade and headline numbers), What went wrong, Timeline, Chapters, Tools and files. Bands with nothing to show are left out.

**Compare.** Verdict sentence first, then the two runs (A in ink, B in the accent), then one metrics table. Differences under 5% are not coloured.

**Insights.** Range control, scope field, headline tiles, then expandable rows that open onto the example sessions behind each figure.

**Chat.** The rail on the left, one 760px reading column, the composer docked at the bottom. A live run ends on one slim composer (send or Stop); a finished one ends on the continue composer.

## States

Every list and screen handles four states. Use the design-system state components.

- **Loading:** keep the layout and show progress in place (the Runs table's scan line, skeletons, a spinner inside a control). Never blank the page.
- **Empty:** say what is empty and why, then offer the one action that fixes it (Clear filters, New run, the command that fills the Insights cache).
- **Error:** say what failed, show the failed handle and status, and give a way back. Route failures use the one route-error shell.
- **Stale:** when a background refresh fails and rows exist, keep the rows and say the data is stale in the refresh status.

## Responsive, print and accessibility

- Below 1100px the Runs table drops tokens and tools; below 760px it keeps the prompt, time and grade. The chat rail hides below 880px. Add a narrow-viewport browser test when a layout can overflow.
- Print uses the light tokens and opens every chapter of a session.
- Every hover affordance has a `:focus-visible` equivalent. Colour never carries meaning alone: status dots have words, grades have titles, deltas have numbers.
- Reduced motion turns off animation.

## Changing the UI

1. Start from the job the change serves, and the screen where that job starts.
2. Use components and tokens from `src/ui`. Add a token (for both themes) rather than a literal colour.
3. Check the screen in dark and light, at 1440px and 390px, with real local traces including a large one, and with an empty state.
4. Test behaviour, not stylesheet values: assert markup hooks, states and keyboard paths. `scripts/design-specimen.mjs` renders every component for visual review.
5. Refresh the README and `docs/ui-examples` screenshots with `npm run docs:ui-examples` when a screen's look changes.
