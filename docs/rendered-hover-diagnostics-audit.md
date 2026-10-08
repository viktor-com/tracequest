# Rendered Hover Diagnostics Audit

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. This audit records the rendered-session hover-only details that remain after the accessibility pass. Keep hover helpers compact, but do not make them the only path to diagnostic information.

## Decisions

- Tool-flow sequence cells keep their compact hover `title` labels for pointer users, and each cell also exposes the same tool/chapter label through ARIA list semantics. The detailed sequence is supporting context; aggregate tool counts and common transitions remain visible below the strip.
- Chapter hover previews are intentionally non-essential. The tooltip duplicates a compact subset of data available in the chapter header, expanded chapter detail, dependency badges, file/tool sections, error summaries, efficiency markers, and keyboard chapter navigation.
- Expanded chapter detail is the authoritative surface for chapter diagnostics. New chapter metadata should appear there first, then optionally in hover previews when it helps pointer scanning.
- Native browser `title` is acceptable only as a secondary pointer hint. If the value is unique diagnostic content, add a visible, focusable, or ARIA-backed equivalent.
- Hover helpers that disappear on touch-sized layouts must not hide required information. If a future helper contains required information, make it tap or keyboard accessible before shipping.

## Follow-Up Checklist

Before changing this audit, run the documentation change through the `Future UI Change Review Checklist` in `docs/ui-style-design-guidelines.md`. For this file, the recurring checks are component consistency, accessibility and keyboard parity, print behavior, screenshot visual review triggers, and facts/tests evidence.

- When adding a rendered-session hover detail, identify the authoritative non-hover surface in the same change.
- When adding a dense diagnostic strip, prefer one focusable summary or ARIA list semantics over hundreds of tab stops.
- When adding a tooltip, hide it in print unless it contains information that is not printed elsewhere.
- During review, check pointer hover, keyboard focus, screen-reader labels, small-screen behavior, and print behavior for the new surface.
