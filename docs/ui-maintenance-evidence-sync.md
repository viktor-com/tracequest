# UI Maintenance Evidence Sync

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this note after a UI change to keep the guide package, evidence artifacts, facts, and tests moving together. This file owns the maintenance workflow; the linked companion docs own the design rules.

## Change Intake

- Name the owning surface before editing: browser index, compare page, rendered session viewer, route error shell, shared token layer, screenshot example, or documentation-only guidance.
- Read the companion docs that own the changed behavior. Update only the docs whose contract changed; cite unchanged guidance instead of copying it.
- For UI changes that need a review trail, fill or cite [docs/ui-design-review-note-template.md](ui-design-review-note-template.md) in the PR, commit summary, issue, or persistent decision note.
- Add or update a focused fact before the repo change. Use tags that match the behavior under review, such as `route-state`, `result-state`, `visual-examples`, `playwright`, `theming`, `implementation-vocabulary`, or a surface-specific tag.
- Keep state vocabulary explicit. Name whether the state is happy, empty, sparse, loading, stale, error, partial-data, selected, focused, expanded, disabled, copied, hover, print, or narrow-width.

## Evidence Matrix

| Change signal | Keep in sync |
| --- | --- |
| Shared colors, fonts, print roots, or repeated CSS values changed | Update `docs/ui-visual-system-theming-guidelines.md`, `src/browser/shared-css-tokens.js`, and the relevant CSS/token tests such as `node --test test/browser/shared-css-tokens.test.js`; include print CSS checks when rendered-session print output changes. |
| Browser index filtering, sorting, refresh, dashboard, selection, or pagination changed | Check `docs/ui-interaction-control-state-guidelines.md`, `docs/ui-result-state-guidelines.md`, and `docs/route-state-audit-checklist.md`; pair the change with focused browser unit coverage or a Playwright test when real layout, keyboard, or live DOM state matters. |
| Compare worksheet, compare route errors, or compare sparse data changed | Update the compare section in the main guide only when the visual contract changes; otherwise update `docs/ui-result-state-guidelines.md` or `docs/route-state-audit-checklist.md`; verify route tests and add browser coverage only for layout or interaction risk. |
| Rendered session chapters, diagnostics, hover helpers, canvases, or print behavior changed | Check `docs/ui-data-diagnostics-guidelines.md`, `docs/rendered-hover-diagnostics-audit.md`, and print guidance; pair pointer behavior with keyboard coverage when a chart, canvas, hover helper, or expandable diagnostic gains interaction. |
| Empty, loading, stale, error, or partial-data behavior changed | Update route-state and result-state facts together with `docs/ui-result-state-guidelines.md` or `docs/route-state-audit-checklist.md`; prove the visible contract with the smallest route, client, render, or Playwright test that exercises that state. |
| Reusable selector, state attribute, test hook, or diagnostic family changed | Update `docs/ui-implementation-style-reference.md` in the same change so implementation vocabulary, CSS, markup, and tests use the same nouns. Prefer stable selectors, ARIA state, and `data-*-state` attributes over incidental text. |
| Browser, compare, or rendered-session example visuals intentionally changed | Run `npm run docs:ui-examples`, review the changed screenshot examples beside the code change, and commit the PNGs only when the visual difference is intentional. Keep route error screenshots deferred unless their checklist trigger is met. |
| Documentation-only UI guidance changed | Link any new companion note from the main guide index, keep a backlink to the main guide, verify the focused docs fact, and skip browser or CSS tests unless the change fixes a broken reference to code or commands. |

## Minimum Verification

- Always run `facts check --tags "<target>"` for the focused UI fact tag, manually verify any `?` fact by reading the relevant files, then tag the fact `@implemented` only after the evidence matches.
- Always run `git diff --check` before committing.
- For screenshots, `npm run docs:ui-examples` is verification only when the maintained example surface changed; otherwise cite the route-error or final-audit deferral in the relevant doc.
- For CSS-only contracts, prefer targeted Node tests that inspect generated CSS, selectors, media queries, token roots, truncation rules, or print rules.
- For browser-only risk, prefer a single focused Playwright test through `npm run test:browser -- --test-name-pattern "<pattern>"` that exercises keyboard behavior, measured overflow, canvas focus, live DOM state, or narrow-width layout.

## Commit Evidence

Each UI maintenance commit should leave a short trail: the fact ID and tag checked, the companion docs touched or intentionally left alone, screenshot refresh decision, targeted tests run, and any deferred route/result-state or visual evidence trigger. Use the design review note template when that trail needs consistent fields, and keep it in the commit message or review summary so the next maintainer can see why the package stayed in sync.
