# UI Design Review Note Template

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this template for a PR, commit summary, issue comment, or short persistent decision note when a UI change needs a review trail. It records what was checked; it does not replace the companion guides.

## Copy/Paste Note

```md
## UI Design Review

Changed surface:
- [ ] Browser index
- [ ] Compare page
- [ ] Rendered session viewer
- [ ] Route error shell
- [ ] Shared token/CSS layer
- [ ] Screenshot examples
- [ ] Documentation-only guidance

Applicable guides:
- Primary guide:
- Companion guide(s) or audit(s):
- Existing UI pattern extended:
- Anti-pattern or non-goal ruled out:

State and interaction decision:
- States affected:
- Accessibility/keyboard impact:
- Responsive or print impact:
- Route/result-state impact:

Evidence refreshed:
- Companion docs updated or deliberately left unchanged:
- Screenshot examples: refreshed / skipped
- Screenshot decision reason:
- Other visual evidence:

Facts and tests:
- Fact ID and tags:
- `facts check --tags "..."`
- Manual `?` facts verified:
- Targeted tests:
- `git diff --check`:

Screenshot and browser-test decision:
- Browser/Playwright tests: added / skipped
- Browser-test decision reason:
- Follow-up trigger, if deferred:
```

## Filled Example: Stale Browser Compare Selection

Use this as a compact example of the filled note format for a behavior-only UI fix.

Changed surface:
- Browser index compare selection bar and row checkboxes. The compare action stays disabled when either selected handle no longer resolves in the current result set, while the existing clear-selection control remains available.

Applicable guides:
- Primary guide: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md), browser controls and compare-selection patterns.
- Companion guides: [docs/ui-interaction-control-state-guidelines.md](ui-interaction-control-state-guidelines.md) for disabled local commands and checkbox state; [docs/ui-result-state-guidelines.md](ui-result-state-guidelines.md) for blocked local compare states.
- Existing UI pattern extended: the fixed compare bar stays mounted as local workflow state instead of routing to a half-valid compare page.
- Anti-pattern or non-goal ruled out: no route error shell, retry button, new card, or explanatory empty-state copy was added for a transient local selection mismatch.

Evidence refreshed:
- Companion docs updated or deliberately left unchanged: unchanged; the interaction and result-state guides already cover disabled compare commands and stale local selection.
- Screenshot examples: skipped.
- Screenshot decision reason: the maintained browser screenshot does not show this transient stale-selection state, and the fix does not change visible layout, tokens, copy, or the clear-selection affordance.

Facts and tests:
- Fact ID and tags: `9vh` (`@ui`, `@browser-index`, `@compare-selection`).
- `facts check --tags "compare-selection"`.
- Targeted tests: `node --test test/browser/browser-client.test.js --test-name-pattern "compare selection"`.
- `git diff --check`.

Screenshot and browser-test decision:
- Browser/Playwright tests: skipped.
- Browser-test decision reason: the VM-backed browser client test proves the live DOM disabled state and clear-selection behavior; there was no keyboard, canvas, measured overflow, narrow-width, or fixed-overlay risk requiring a real browser.
- Follow-up trigger, if deferred: add browser coverage only if compare selection gains keyboard-specific behavior, viewport-sensitive layout, or route-backed retry/recovery controls.

## Decision Prompts

- Name the changed surface first. Route browser filtering, compare worksheets, rendered diagnostics, route shells, shared tokens, screenshots, and docs-only changes through their matching companion guides from the main index.
- Treat screenshots as evidence for maintained browser, compare, and rendered-session example visuals. Skip `npm run docs:ui-examples` for docs-only wording, compact static route error shells, or behavior that does not affect those examples; cite the route-state or final-audit trigger when skipping.
- Add a browser or Playwright test when the risk needs a real browser: keyboard behavior, canvas focus, live DOM state, measured overflow, narrow-width layout, fixed overlays, or interaction that CSS and route tests cannot prove.
- Skip browser coverage when a targeted route, render, CSS, or unit test proves the contract and the UI has no browser-only state. Record that reason instead of adding a static smoke test.
- Keep deferred work tied to a trigger: richer route error interaction, recurring screenshot churn, new reusable selector families, or repeated visual drift across browser, compare, and rendered-session surfaces.
