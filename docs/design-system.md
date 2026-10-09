# tracequest design system

Source: `src/ui/tokens.js` (tokens), `src/ui/components.js` (components, icons), `src/ui/index.js` (`DESIGN_SYSTEM_CSS`). Every page embeds `DESIGN_SYSTEM_CSS` first, then its own screen stylesheet. Screen stylesheets arrange components; they do not invent colours, sizes or radii.

## Where it comes from

The values are measured from cursor.com and cursor.com/brand (computed styles, October 2026):

| | cursor.com | tracequest |
|---|---|---|
| Dark paper / ink | `#14120b` / `#edecec` | `--bg` / `--text` |
| Light paper / ink | `#f7f7f4` / `#26251e` | same tokens, light theme |
| Secondary text | ink at 60% | `--text-2` (62–64%), `--text-3` (42–46%) |
| Borders | ink at 2.5 / 10 / 20% | `--line-1` 6%, `--line-2` 10–11%, `--line-3` 20–22% |
| Cards | `#1b1913` … `#2b2923` | `--surface-1` … `--surface-4` |
| Accent | `#f54e00` | `--accent` (brand and attention only) |
| Status | ANSI green `#1f8a65`, red `#cf2d56` | `--ok`, `--bad` (lifted in dark for text contrast) |
| Type | CursorGothic 400, h1 26px −0.0125em; 14px nav | `--font-sans`, 400 headings with negative tracking; 14px body |
| Buttons | ink pill, 14px | `.ui-btn--primary` |

CursorGothic and Berkeley Mono are not bundled. The stacks name them first, so machines that have them use them, then fall back to Inter or the system UI font and to the system mono.

## Principles

1. **Paper and ink.** Two warm neutrals carry everything. Greys are ink mixed into paper, so they never shift temperature.
2. **One accent, used rarely.** Orange marks the brand and something that needs attention (high plan usage, compare side B). Selection, focus and primary actions use ink, not colour.
3. **Colour means state.** Green is success or live, red is failure, amber is waiting or idle. Agents and tools get muted categorical hues (`--hue-*`), shown as small squares, never as fills behind text.
4. **Quiet structure.** Hairlines and surface steps, no drop shadows on content. Shadows only lift overlays.
5. **Numbers are tabular.** Every figure uses `font-variant-numeric: tabular-nums`; columns of numbers align right.
6. **Motion explains.** 90–360ms, eased out. Things fade or rise into place. Nothing loops except the live dot and loading shimmer. Reduced motion turns it all off.

## Tokens

- **Type:** `--text-2xs` 11 · `xs` 12 · `sm` 13 · `md` 14 (body) · `lg` 16 · `xl` 20 · `2xl` 26 · `3xl` 36, each with a matching `--lh-*`. Weights 400 and 500 only.
- **Space:** 4px grid, `--space-0` (2) … `--space-16` (64).
- **Shape:** controls are pills (`--radius-pill`). Surfaces use `--radius-lg` (12), inner elements `--radius-md`/`sm`. Control heights 24 / 30 / 36.
- **Motion:** `--ease-out`, `--ease-in-out`; durations `--dur-1` 90 … `--dur-4` 360.
- **Layers:** sticky 20, rail 30, popover 200, dialog 400, palette 600, toast 800.

## Themes

Dark is `:root`. Light applies through `@media (prefers-color-scheme: light)` unless the user picked a theme; the app shell sets `html[data-theme="light|dark"]` and remembers it in `localStorage` (`tq-theme`). Print always uses light. Never hard-code a colour in a screen stylesheet. If a value is missing, add a token for both themes.

## Components

| Class | Use |
|---|---|
| `.ui-btn` + `--primary` / `--outline` / `--ghost` / `--danger`, `--sm` / `--lg` / `--icon` | Actions. One primary per view. |
| `.ui-input`, `.ui-textarea`, `.ui-field`, `.ui-seg` | Text entry, filters, segmented choices (ranges, views). |
| `.ui-chip`, `.ui-agent`, `.ui-badge` (`--ok`/`--warn`/`--bad`/`--accent`), `.ui-dot` (`--live`/`--idle`/`--bad`), `.ui-kbd`, `.ui-meter`, `.ui-spark` | Identity, state and small measures. |
| `.ui-card`, `.ui-section`, `.ui-stats`/`.ui-stat`, `.ui-table`, `.ui-divider` | Surfaces and data. |
| `.ui-pop`, `.ui-menu-item`, `.ui-scrim`, `.ui-dialog`, `.ui-tooltip`, `.ui-toast` | Overlays. |
| `.ui-empty`, `.ui-skel`, `.ui-spinner`, `.ui-notice`, `.ui-error-page` | Empty, loading, notice and error states. |
| `ICONS` | 16px line icons, 1.5 stroke, `currentColor`. |

## States every screen must have

- **Loading:** skeleton rows in the real layout, never a centred spinner on a blank page. Use `.ui-spinner` only inside a control.
- **Empty:** say what is empty, why, and the one action that fixes it (`.ui-empty` with a title, body and actions).
- **Error:** say what failed, show the handle that failed (path or id), and give a way back.
