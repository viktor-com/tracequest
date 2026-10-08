# UI Visual System And Theming Guidelines

Source of truth: [docs/ui-style-design-guidelines.md](ui-style-design-guidelines.md) is the index for UI guidance. Use this companion guide when changing Tracequest colors, typography, spacing, density, radii, shadows, or CSS custom properties. For selector names use `docs/ui-implementation-style-reference.md`; for accessibility, route state, screenshots, responsive, print, copy, diagnostics, and IA rules, use the linked guides from the main index.

## CSS Custom Properties And Token Roles

Tracequest has a small semantic token set in `src/browser/shared-css-tokens.js`. Keep it small.

- Shared screen tokens are `--bg`, `--surface`, `--surface2`, `--fg`, `--fg2`, `--fg3`, `--border`, `--accent`, `--red`, `--green`, `--orange`, `--sans`, and `--mono`. Use these before adding page-local palette values.
- Standalone browser and compare pages start from `STANDALONE_BASE_CSS`, with `--accent-dim` as the only standalone extra token today.
- Rendered session pages start from `SESSION_VIEWER_BASE_CSS`, with `--green-dim`, `--red-dim`, `--orange-dim`, and `--radius` because session detail pages reuse dim status surfaces and a common panel radius heavily.
- Print overrides live in `CSS_PRINT_ROOT_VARS`. New printable UI should read from shared tokens so print can switch to the light theme without duplicating selectors.
- Local CSS values are acceptable for component geometry, one-off alpha intensity, category maps, chart scales, or source/tool colors. Do not hard-code a hex value when it is visually and semantically the same as an existing token.

## Semantic Color Roles

Color is a diagnostic language, not decoration.

- `--bg`, `--surface`, and `--surface2` form the dark surface ladder: page background, primary panels/rows, then hover/input/nested/expanded surfaces.
- `--fg`, `--fg2`, and `--fg3` form the text ladder: primary evidence, secondary metadata, then muted helper or structural labels.
- `--accent` marks primary interaction and identity: selected filters, focused inputs, links, copied/permalink state, session A compare identity, and Tracequest brand emphasis.
- `--green` means success, healthy, live, efficient, clean, commit-related, or improved.
- `--orange` means warning, correction, moderate efficiency, cost, stale data, or session B compare identity.
- `--red` means error, failed, struggling, wasteful, or high-risk.
- Source badges, tool-family colors, and operation colors can stay local category colors because they identify data categories rather than product status. Pair them with compact text labels and do not promote every category color to a root token.

## Typography Scale

The built UI uses a compact operational scale.

- Body text is `14px` with `line-height: 1.6` in the shared base. Keep this as the default for readable prompts and page content.
- Page titles are intentionally small: browser and compare use `16px`; rendered session headers use about `15px`.
- Section titles, table labels, chips, badges, controls, and metadata generally sit between `10px` and `12px`, often uppercase and mono when they are structural labels.
- Dense row prompts and summaries usually use `12px` to `14px`. Lists should not introduce hero-scale type.
- Large numerals are reserved for summary stats, such as rendered `.stat-value` at `22px` and browser dashboard values at `15px`.
- Use `--mono` for identifiers, paths, model names, source/tool labels, filter chips, sort/pagination controls, table values, counts, costs, tokens, durations, and tabular diagnostics.

## Spacing And Density

Tracequest optimizes for scanning session evidence.

- Page frames stay constrained where they are documents: compare around `860px`, rendered session around `960px`. The `/` Runs home is a full-width inventory with compact side padding.
- Repeated rows use dense vertical rhythm: session and chapter lists use `2px` gaps; compare worksheet sections use `12px` vertical separation.
- Work surfaces use compact padding: filters around `4px 8px`, rows around `12px 16px`, dashboards around `16px 20px`, compare sections around `20px 24px`, and rendered headers around `24px 28px`.
- Metadata and chip groups wrap with `4px` to `8px` gaps. Prefer wrapping and ellipsis over widening the viewport.
- Keep controls and labels near the evidence they affect. Do not add spacer-heavy bands between filters, status text, lists, charts, and details.

## Borders, Radii, And Shadows

Chrome should clarify grouping without making the UI feel card-heavy.

- Use `--border` for ordinary panel, row, input, and control boundaries.
- Strengthen borders with low-opacity white, accent, or semantic color only for hover, active, focused, selected, or status states.
- Common radii are `10px` for primary panels and filter bars, `8px` for list rows and dropdowns, `4px` to `6px` for chips, badges, nested evidence, buttons, bars, and inputs, and `12px` for focused modal panels.
- Use left or top borders for status and compare identity when a filled surface would be too loud. Examples: error row emphasis, route error shells, chapter quality, and compare A/B cards.
- Shadows are rare. Use them for overlays and attached popups, such as suggestion menus. Do not add card shadows to normal rows, sections, charts, or dashboards.

## Table, List, And Card Density

The UI favors dense evidence structures over decorative cards.

- Tables should preserve scan geometry. Compare tables use right-aligned A values, centered labels, and left-aligned B values; values stay mono with tabular numerals.
- Lists should keep identity, status, and metrics in predictable zones. Browser rows and chapter rows use compact top metadata, one summary line, then small mono stats or chips.
- Cards are for repeated identity panels, modals, and framed tools. Do not nest card-like sections inside cards when an indented detail block, row, table, or diagnostic band will do.
- Diagnostic bands should be full-width within their owning surface and visually equal unless the page order already gives one section priority.
- Empty, sparse, loading, and error states should keep the same density as the surrounding surface. Avoid large placeholder cards for missing data.

## When To Add A Token

Add a root custom property only when it improves consistency across surfaces.

- Add or promote a token when the value is reused across browser, compare, and rendered session UI; when print needs a coordinated override; or when the value carries a stable product semantic such as surface, text, accent, border, or status.
- Keep the value local when it belongs to one component, one data category, one alpha intensity, one chart encoding, one source/tool color map, or one responsive dimension.
- Prefer deriving local tints from token hues with `rgba(...)` when no shared dim token exists for that surface. Promote the dim tint only after repeated cross-surface use makes local copies harder to review.
- Do not add tokens for every spacing or radius value. The current spacing and radius scale is conventional rather than a named spacing system; document recurring patterns here and tokenize only if drift becomes a repeated review problem.
- When adding a token, update `src/browser/shared-css-tokens.js`, this guide, and any token tests that define the screen, standalone, session, or print contract.

Before changing this guide, run the change through the `Future UI Change Review Checklist` in `docs/ui-style-design-guidelines.md`. For this file, the recurring checks are semantic token reuse, color meaning, density, print override impact, and whether a value should remain local CSS.
