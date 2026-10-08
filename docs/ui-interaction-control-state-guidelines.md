# UI Interaction And Control-State Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when adding or reviewing Tracequest controls. These rules are derived from the existing browser index, compare page, rendered session viewer, and share modal; they define interaction semantics and state behavior, not the broader visual system.

## Link Or Button

- Use a link when activation follows a stable URL or downloads a route-backed artifact. Existing examples are browser session rows, live-session rows, compare back links, compare `view full session` links, rendered-session `Export`, and rendered-session `Markdown`.
- Use a button when activation mutates local UI state, depends on transient selection, validates input, opens a modal, prints, copies, expands, sorts, filters, paginates, or runs an async command. Existing examples are sort buttons, quick filters, dashboard collapse, rendered chapter filters, expand toggles, print/share actions, modal actions, and chart/minimap jump controls.
- Keep ambiguous route-building commands as buttons until the route is valid. The browser compare action stays a disabled/enabled button because it depends on two current checkbox selections; once a route target is fixed and always valid, prefer an anchor.
- Do not put local controls inside row links. Browser compare checkboxes sit beside session-row anchors so selection and navigation remain separate hit targets.
- Use native checkboxes for durable binary selections that should not look like chips. Browser compare selection is the model: the checkbox stores selection while the row link still opens the session.

## Search And Filters

- Search text belongs in an input, not a button-like chip. Browser session filtering uses one input with an attached suggestions listbox; rendered chapter search uses a compact input in the chapter filter bar.
- Suggestions should stay attached to the input state. Use one highlighted option, update `aria-selected`, and let `Enter` or `Tab` accept the suggestion while `Escape` closes or clears local input state.
- Filter chips and sort choices are toggle buttons. Pair the visual state class with `aria-pressed`, and keep the active label stable instead of changing button width.
- Counts are status metadata, not extra buttons. Browser quick-filter counts and rendered chapter filter counts explain the current result set without adding another action target.
- Clearing filters is a command, so it is a button. It should reset the current filter state and keep the surrounding filter surface mounted.

## State Contract

- Active or selected toggle state uses `aria-pressed="true"` plus the established active class (`.active` or `.qf-active`). Do not invent a second selected vocabulary for the same pattern.
- Current pagination uses `aria-current="page"` on the current page button. Edge pagination controls use native `disabled` when they cannot move.
- Expanded and collapsed panels use a button with `aria-expanded` and a stable expanded/collapsed class on the affected surface. The label may change from `show more` to `show less`, but nearby layout must not move.
- Disabled controls use the native `disabled` attribute whenever the action is unavailable, such as zero-count grade filters, one-session compare actions, pagination edges, and share confirmation. Disabled styling lowers emphasis without changing geometry.
- Loading states should name the work in a compact live status region. Browser refresh uses `#refreshStatus[data-state="pending|stale|error"]`; share upload disables the initiating action and writes `Uploading...` in the modal status.
- Preserve visible data during background refresh failures when the current rows still describe the mounted query. Use a stale status instead of replacing the workflow with an error unless the user-triggered query itself failed.
- Copied, focused, active, disabled, and loading states must not resize rows, controls, charts, or fixed bars. Change color, border, background, opacity, or text inside reserved space.

## Reload And Live Update

- Live sessions are navigation links because they open the current session detail. The live marker itself is status, not a separate control.
- Background data refresh is status-first. Keep the list mounted, expose pending/stale/error text in the header live region, and avoid adding a reload control unless users can explicitly retry a failed user-driven request.
- Server-rendered routes do not need client loading controls. The compare page loads both sessions before sending one complete worksheet; follow `docs/route-state-audit-checklist.md` before adding any intermediate compare loading state.
- Route error shells stay compact. Their back affordance is a link because it navigates; add buttons only if the shell gains a local retry, copy, or diagnostic command.

## Hover And Focus

- Hover may strengthen text, border, background, opacity, or underline links. It must not reveal the only path to essential information or change comparison outcomes, row ordering, chart geometry, or metric values.
- Every hover affordance on an interactive control needs an equivalent focus-visible treatment or native keyboard path. Use the existing accent outline/border pattern for focus and keep it local to the active control.
- Pointer-only hints are acceptable only for secondary evidence that is also available through visible text, ARIA labels, focus tooltips, or expanded detail. Follow `docs/rendered-hover-diagnostics-audit.md` for rendered-session hover diagnostics.
- Hover controls that are intentionally hidden until pointer movement, such as chip remove affordances, must be tied to a visible parent target that already identifies what will be affected.

## Review Checklist

- Choose the native element first: anchor for fixed navigation, button for commands, input for search, checkbox for independent binary selection, select for option sets.
- Name the state with the existing contract: `aria-pressed`, `aria-expanded`, `aria-current`, `disabled`, `data-*-state`, `.active`, `.expanded`, `.collapsed`, `.copied`, or `.hl`.
- Keep local control state near the data it changes: filters with result lists, compare selection with session rows and the fixed compare bar, chart focus with chart tooltip/status text.
- Add tests against semantic state when behavior changes. Prefer ARIA attributes, disabled state, `data-*-state`, and stable selector families from `docs/ui-implementation-style-reference.md` over incidental text layout.
