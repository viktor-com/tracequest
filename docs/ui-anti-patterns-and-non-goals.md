# UI Anti-Patterns And Non-Goals

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion note as the quick rejection checklist for changes that would pull Tracequest away from its utilitarian trace-analysis product style. Use the linked companion guides for the positive pattern to apply instead.

## Product Posture

Do not turn Tracequest surfaces into marketing or landing-page layout.

- No hero sections, value-prop blocks, onboarding panels, promotional illustrations, oversized display headlines, or split text/media layouts for the browser, compare page, or rendered session viewer.
- The first viewport should be a working inspection surface: filters and session rows, a two-session worksheet, or session evidence. If a change cannot name the trace evidence it helps inspect, it probably belongs outside the UI.
- Route headers identify the route and object; they should not explain the product, teach broad workflows, or compete with the data below them.

## Surface Shape

Avoid decorative cards when a row, table, compact panel, diagnostic band, or existing detail block already fits.

- Do not nest cards inside cards to make routine evidence feel more important. Use the density, hierarchy, and panel rules in [docs/ui-visual-system-theming-guidelines.md](ui-visual-system-theming-guidelines.md) and [docs/ui-content-density-progressive-disclosure-guidelines.md](ui-content-density-progressive-disclosure-guidelines.md).
- Do not replace scan-first session rows, compare metric rows, or rendered chapter detail with standalone tiles unless the user task changes.
- Do not add blank placeholder panels, fake rows, or decorative skeleton blocks for sparse data. Use the result-state guide's quiet fallbacks.

## Token And Visual Drift

Do not introduce uncontrolled token drift to make one feature stand out.

- Avoid new root colors, font sizes, radii, shadows, spacing scales, or dim variants unless the value has a repeated cross-surface role or print override need.
- Do not use status colors as decoration. Green, orange, red, and accent already carry diagnostic meaning; new semantic colors need a new status category, not a preference.
- Do not make one-off UI louder through larger typography, heavier shadows, filled status panels, or extra borders when page order and compact labels can carry hierarchy.

## Workflow State Boundaries

Route shells must not carry rich workflow state.

- Compare and `/view` route error shells stay terminal and compact: route context, failed side or handle, status, server message, and `back to sessions`.
- Do not render half a compare worksheet, partial rendered-session diagnostics, section spinners, hidden retry flows, or repair controls inside a route shell unless the route gains real client-side recovery behavior.
- Keep corpus filtering, compare selection, chapter search, chart jumps, and expansion state in their owning workflow surfaces. Before adding async switching or stale preservation to a server-rendered route, update [docs/route-state-audit-checklist.md](route-state-audit-checklist.md).

## Copy And Result States

Avoid verbose empty/error states.

- Empty states should say what happened in the current scope, usually with one neutral line and the existing filters or counts still visible.
- Error states should expose repair evidence: route, status, failed handle or missing parameter, server message, and one relevant navigation action. Do not add tutorials, generic troubleshooting lists, or promotional calls to action.
- Inline status text should remain operational and terse. If a state needs explanation, first check whether it is actually a route-state, result-state, workflow, or maintenance-doc decision already covered by another guide.

## Evidence And Testing Non-Goals

Static shells do not need screenshots or browser tests by default.

- Do not add screenshot examples for compact static route errors while they remain small alert shells. Follow the trigger in [docs/route-state-audit-checklist.md](route-state-audit-checklist.md) if those visuals begin changing often or gain meaningful interaction.
- Do not add Playwright/browser coverage for trivial static states that route or render tests can prove. Browser tests should be reserved for layout measurement, keyboard behavior, canvas focus, live DOM state, or narrow-width overflow risk.
- Do not refresh `docs/ui-examples/*.png` for documentation-only wording changes or static shells outside the maintained browser, compare, and rendered-session examples.

## Review Shortcut

Reject or redirect a UI proposal when its main contribution is a new visual container, page shell, token family, long explanation, or test artifact rather than better access to session evidence. Start from the guide index, pick the existing owner doc, and extend that pattern only when the current UI cannot express the trace-analysis task.
