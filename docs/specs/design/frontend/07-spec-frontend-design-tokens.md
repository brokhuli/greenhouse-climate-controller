# Frontend — Design Tokens

> **Purpose:** Single source of truth for the dashboard's visual atoms — color
> (including **status semantics** and **chart tokens**), typography, spacing, radii,
> shadows, motion, z-index, layout, and breakpoints — across the two themes (dark
> default + light). Tokens are emitted as CSS custom properties and read by
> Tailwind's theme so a theme change is a one-file edit
> ([architecture §8](./03-spec-frontend-architecture.md#8-theming-architecture)). When
> a component needs a color or spacing value it references a token — never a
> hardcoded literal.

> **Two themes only.** Unlike the portfolio's palette set, an operator console
> ships exactly **dark** (default, control-room friendly) and **light**. Both
> define the same semantic roles; only values differ. Hex values below are a
> grounded starting palette, not sacred — they exist so the contract is concrete.
>
> **Light mode uses a warm, earthy palette** (sandy beige backgrounds, warm gray
> surfaces and borders) rather than a cool blue-gray. This is intentional — it
> reinforces the greenhouse/organic character of the product in the non-default
> theme.

> **Visual reference.** The light/dark mockups in `research/frontend mockups/`
> establish the visual direction: a dense operations console with a persistent
> left rail, warm paper-like light surfaces, charcoal dark surfaces, crisp
> hairline borders, compact typography, small-radius cards, and thin chart
> strokes with subtle area fills. They are visual references only; their sample
> greenhouse content is non-normative.

All tokens emit under `:root` (theme-agnostic) or `[data-theme="…"]`
(theme-specific). The values here must clear the contrast guarantees in
[§contrast](#contrast-guarantees) before they ship — a control surface that
misreports state is worse than no dashboard.

---

## 1. Naming convention

```
--<category>-<role>[-<variant>][-<state>]
```

- **category:** `color`, `space`, `radius`, `shadow`, `font`, `text`, `motion`,
  `ease`, `z`, `border`, `chart`, `layout`.
- **role:** semantic, never visual — `bg`, `surface-1`, `fg-default`, `accent`,
  `online`, `offline`. Never `green`, `gray-700`.

**Forbidden:** color names, raw numbered scales without a role, and hardcoded hex
in any component class.

---

## 2. Color — semantic roles

| Token | Role |
|---|---|
| `--color-bg` | App canvas behind all chrome |
| `--color-shell` | Persistent shell / side-nav background |
| `--color-surface-1` | Card and panel background |
| `--color-surface-2` | Nested surface (chart plot area, table header, status block) |
| `--color-surface-3` | Hover / selected surface |
| `--color-surface-raised` | Top-bar controls, popovers, active nav in inverse contexts |
| `--color-fg-default` | Primary text |
| `--color-fg-muted` | Secondary text, axis labels |
| `--color-fg-subtle` | Tertiary text, placeholders |
| `--color-fg-on-accent` | Text over `--color-accent` |
| `--color-fg-inverse` | Text/icons over inverse active surfaces |
| `--color-accent` | Primary action, links, focus ring |
| `--color-accent-hover` | Accent hover step |
| `--color-border` | Default stroke |
| `--color-border-strong` | Focused inputs, strong dividers |
| `--color-divider` | Quiet internal separators |

### Status semantics (load-bearing)

Greenhouse/connectivity state and event severity drive these — they are the
dashboard's most important colors and must each pair an icon/label, never color
alone ([constraints](./09-spec-frontend-constraints.md)).

| Token | Meaning |
|---|---|
| `--color-status-online` | Online / healthy / OK |
| `--color-status-degraded` | Degraded (faults present, still reporting) |
| `--color-status-offline` | Offline (no telemetry / stale stream) — *neutral muted*, not alarming |
| `--color-status-drift` | Setpoint drift (2b) — intended ≠ reported |
| `--color-fault` | Critical fault / interlock activation |
| `--color-warning` | Warning-level event |
| `--color-info` | Informational event |

> **Offline is muted, not red.** An offline controller is an *absence of data*, not
> a fault; coloring it like a critical alarm trains operators to ignore real
> alarms. Reserve `--color-fault` for actual fault/interlock events.

### Dark (default)

```css
[data-theme="dark"] {
  --color-bg: #151515;
  --color-shell: #111211;
  --color-surface-1: #1b1b1a;
  --color-surface-2: #20201f;
  --color-surface-3: #2a2927;
  --color-surface-raised: #242321;

  --color-fg-default: #f5f0e7;
  --color-fg-muted: #c7bfb3;
  --color-fg-subtle: #8d867d;
  --color-fg-on-accent: #111211;
  --color-fg-inverse: #111211;

  --color-accent: #f1dfc2;
  --color-accent-hover: #ead2ad;

  --color-border: #343330;
  --color-border-strong: #4a4741;
  --color-divider: rgba(245, 240, 231, 0.10);

  --color-status-online: #9ccc65;
  --color-status-degraded: #ff8a00;
  --color-status-offline: #6b7585;   /* muted, not alarming */
  --color-status-drift: #8b5cf6;
  --color-fault: #ff4d3d;
  --color-warning: #ffb020;
  --color-info: #6ea8ff;
}
```

### Light

```css
[data-theme="light"] {
  --color-bg: #f7f2ea;
  --color-shell: #f2eadf;
  --color-surface-1: #fffdf8;
  --color-surface-2: #f5efe6;
  --color-surface-3: #ece4d8;
  --color-surface-raised: #f9f4ec;

  --color-fg-default: #111111;
  --color-fg-muted: #4f4a43;
  --color-fg-subtle: #8a8175;
  --color-fg-on-accent: #ffffff;
  --color-fg-inverse: #fffdf8;

  --color-accent: #111111;
  --color-accent-hover: #2a2927;

  --color-border: #ded6ca;
  --color-border-strong: #c8bdae;
  --color-divider: rgba(17, 17, 17, 0.10);

  --color-status-online: #111111;
  --color-status-degraded: #ff6b00;
  --color-status-offline: #8a8175;   /* muted */
  --color-status-drift: #5b2bbd;
  --color-fault: #e11900;
  --color-warning: #d97706;
  --color-info: #2563eb;
}
```

### Contrast guarantees

Per [constraints](./09-spec-frontend-constraints.md) (WCAG 2.1 AA):

- Body text (`--color-fg-default` over `--color-bg`) ≥ 7:1 in both themes.
- Muted text over `--color-surface-1` ≥ 4.5:1.
- Status/fault colors used for text or essential glyphs ≥ 4.5:1; when used as a
  fill behind a label, the label/fill pair ≥ 4.5:1.
- Checked whenever a status/fault token changes (a misread status is a safety-
  adjacent defect).

---

## 3. Chart & diagram tokens

Charts read **chart tokens**, not status colors directly, so a palette change
can't silently alter chart meaning. Series colors are distinct and colorblind-
aware.

```css
:root {
  --chart-temperature: var(--color-status-online);
  --chart-humidity: #6ea8ff;
  --chart-co2: #8b5cf6;
  --chart-par: #ff8a00;
  --chart-soil-moisture: #ff6b00;

  --chart-setpoint: var(--color-fg-muted);   /* dashed reference line */
  --chart-band-ok: rgba(156, 204, 101, 0.12);
  --chart-band-warn: rgba(255, 176, 32, 0.14);
  --chart-band-fault: rgba(255, 77, 61, 0.14);
  --chart-axis: var(--color-fg-muted);
  --chart-grid: var(--color-divider);
  --chart-gap: var(--color-border-strong);   /* live-data gap marker */
  --chart-stroke-width: 1.5px;               /* line stroke; sparklines inherit */
  --chart-reference-width: 1px;
  --chart-fill-opacity: 0.10;
  --chart-plot-height: 180px;
  --chart-sparkline-height: 40px;
}
```

The `TimeSeriesChart` ([components](./06-spec-frontend-components.md)) consumes only
these — never `--color-status-*` — so chart styling and status semantics evolve
independently.

Full charts use thin solid metric strokes, dashed setpoint/min-max references,
subtle grid lines, and a low-opacity fill under the primary series. Compact
sparklines use the same metric stroke and fill but hide axes, legends, grid, and
band shading.

---

## 4. Typography

| Token | Stack | Use |
|---|---|---|
| `--font-sans` | `"Inter", system-ui, sans-serif` | Body, UI labels, headings |
| `--font-mono` | `"JetBrains Mono", ui-monospace, monospace` | IDs, debug values, optional dense timestamps |

Numeric telemetry uses `--font-sans` with `font-variant-numeric: tabular-nums`
so digits do not jitter as values stream without making the dashboard feel like
a code editor.

### Type Scale

| Token | Size / line-height | Use |
|---|---|---|
| `--text-xs` | 11 / 1.4 | axis labels, timestamps, dense metadata |
| `--text-sm` | 12 / 1.45 | captions, card metadata, nav secondary labels |
| `--text-base` | 14 / 1.45 | body, nav items, table cells |
| `--text-md` | 16 / 1.35 | card titles, panel headings |
| `--text-lg` | 20 / 1.25 | metric values, top-bar page subtitles |
| `--text-xl` | 24 / 1.2 | view titles |
| `--text-2xl` | 32 / 1.1 | fleet summary numbers only |

### Font weights

```css
:root {
  --font-weight-regular: 400;   /* body, captions, axis labels */
  --font-weight-medium:  500;   /* nav items, card headings, badges */
  --font-weight-semibold: 600;   /* panel titles, top-bar page title */
  --font-weight-bold:    700;   /* large metric values, summary numbers */
}
```

### Section label pattern

View-section headings (e.g. "GREENHOUSES", "ACTIVE ALERTS") use a consistent
compound style — not a single token, but a named combination:
`--text-xs` + `--font-weight-medium` + `text-transform: uppercase` +
`letter-spacing: 0` + `color: --color-fg-muted`.

Components apply this via a shared utility class (`section-label`) rather than
inline styles, so the pattern can be updated in one place.

---

## 5. Spacing, radii, shadows

```css
:root {
  /* 4px linear scale */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-12: 48px;

  --radius-sm: 4px;   /* pills, inputs */
  --radius-md: 6px;   /* buttons, segmented controls */
  --radius-lg: 8px;   /* cards and panels */
  --radius-full: 9999px;

  --size-control-sm: 28px;
  --size-control-md: 36px;
  --size-icon-button: 36px;
  --size-status-dot: 10px;
}

[data-theme="dark"] {
  --shadow-sm: 0 1px 1px rgba(0,0,0,0.25);
  --shadow-md: 0 8px 24px rgba(0,0,0,0.28);
}
[data-theme="light"] {
  --shadow-sm: 0 1px 1px rgba(32,24,16,0.04);
  --shadow-md: 0 8px 24px rgba(32,24,16,0.08);
}
```

Cards are bordered first and shadowed second. Use `--shadow-sm` for raised
controls/popovers and `--shadow-md` only for overlays or detached panels; ordinary
dashboard cards use a 1px border and no visible drop shadow. Off-scale spacing
means the design is wrong, not the scale.

---

## 6. Motion

```css
:root {
  --motion-instant: 80ms;
  --motion-quick: 150ms;
  --motion-base: 220ms;

  --ease-out: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-in-out: cubic-bezier(0.45, 0, 0.55, 1);
}
```

Motion is **functional only** — state changes, toasts, dialogs. Live chart updates
are data-driven, not animated transitions. All motion respects
`prefers-reduced-motion` ([interactions](./08-spec-frontend-interactions.md)).

---

## 7. Z-index, layout & breakpoints

```css
:root {
  --z-base: 0;
  --z-sticky: 30;     /* sticky table headers, TopBar */
  --z-drawer: 40;     /* mobile nav drawer */
  --z-popover: 100;   /* ConnectionStatus popover */
  --z-dialog: 110;    /* confirmation dialogs */
  --z-toast: 120;

  --layout-max-width: none;       /* operations console fills the viewport */
  --layout-sidenav-width: 240px;
  --layout-detail-nav-width: 230px;
  --layout-side-panel-width: 320px;
  --layout-topbar-height: 64px;
  --layout-gutter: 24px;
  --layout-section-gap: 16px;
  --layout-card-gap: 16px;

  --bp-sm: 640px;
  --bp-md: 900px;    /* sidenav → top bar + drawer below this */
  --bp-lg: 1280px;
  --bp-xl: 1536px;
}
```

`--bp-md` is the canonical cutoff where `SideNav` collapses
([interactions](./08-spec-frontend-interactions.md)).

Desktop pages use a shell grid: fixed `SideNav`, fixed-height `TopBar`, and a
scrolling main canvas with `--layout-gutter` padding. Summary and greenhouse
cards use responsive CSS grids (`repeat(auto-fit, minmax(...))`) so the fleet
view densifies on wide screens without becoming a centered landing page.

---

## 8. Tailwind wiring

Tailwind v4 (CSS-first) reads the tokens:

```css
@import "tailwindcss";
@import "./tokens.css";

@theme {
  --color-bg: var(--color-bg);
  --color-shell: var(--color-shell);
  --color-surface-1: var(--color-surface-1);
  --color-surface-raised: var(--color-surface-raised);
  --color-accent: var(--color-accent);
  --color-status-online: var(--color-status-online);
  /* …all semantic + chart colors… */
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
}
```

Components write `bg-surface-1`, `text-fg-default`, `text-status-online` — never
raw hex. `prettier-plugin-tailwindcss` keeps class lists ordered.

---

## 9. Token change process

1. Edit `src/styles/tokens.css` under **both** themes if color-themed.
2. Update this document — an undocumented token is a bug.
3. Run typecheck + tests; visually check both themes.
4. Re-check contrast if the change touches a text or status color.

Removing a token requires confirming zero references (a one-line CI grep).
