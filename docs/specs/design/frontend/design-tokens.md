# Frontend — Design Tokens

> **Purpose:** Single source of truth for the dashboard's visual atoms — color
> (including **status semantics** and **chart tokens**), typography, spacing, radii,
> shadows, motion, z-index, layout, and breakpoints — across the two themes (dark
> default + light). Tokens are emitted as CSS custom properties and read by
> Tailwind's theme so a theme change is a one-file edit
> ([architecture §8](./spec-frontend-architecture.md#8-theming-architecture)). When
> a component needs a color or spacing value it references a token — never a
> hardcoded literal.

> **Two themes only.** Unlike the portfolio's palette set, an operator console
> ships exactly **dark** (default, control-room friendly) and **light**. Both
> define the same semantic roles; only values differ. Hex values below are a
> grounded starting palette, not sacred — they exist so the contract is concrete.

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
| `--color-bg` | App background |
| `--color-surface-1` | Card background |
| `--color-surface-2` | Nested surface (chart background, table header) |
| `--color-surface-3` | Hover / selected surface |
| `--color-fg-default` | Primary text |
| `--color-fg-muted` | Secondary text, axis labels |
| `--color-fg-subtle` | Tertiary text, placeholders |
| `--color-fg-on-accent` | Text over `--color-accent` |
| `--color-accent` | Primary action, links, focus ring |
| `--color-accent-hover` | Accent hover step |
| `--color-border` | Default stroke |
| `--color-border-strong` | Focused inputs, strong dividers |

### Status semantics (load-bearing)

Greenhouse/connectivity state and event severity drive these — they are the
dashboard's most important colors and must each pair an icon/label, never color
alone ([constraints](./spec-frontend-constraints.md)).

| Token | Meaning |
|---|---|
| `--color-status-online` | Online / healthy / OK |
| `--color-status-degraded` | Degraded (faults present, still reporting) |
| `--color-status-offline` | Offline (no telemetry / last-will) — *neutral muted*, not alarming |
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
  --color-bg: #0b0f14;
  --color-surface-1: #121821;
  --color-surface-2: #19212c;
  --color-surface-3: #232d3a;

  --color-fg-default: #e6eaf0;
  --color-fg-muted: #9aa4b2;
  --color-fg-subtle: #6b7585;
  --color-fg-on-accent: #ffffff;

  --color-accent: #3b82f6;
  --color-accent-hover: #2f6fe0;

  --color-border: #232d3a;
  --color-border-strong: #34404f;

  --color-status-online: #4ade80;
  --color-status-degraded: #f5b454;
  --color-status-offline: #6b7585;   /* muted, not alarming */
  --color-status-drift: #c084fc;
  --color-fault: #f87171;
  --color-warning: #f5b454;
  --color-info: #60a5fa;
}
```

### Light

```css
[data-theme="light"] {
  --color-bg: #f4f6f9;
  --color-surface-1: #ffffff;
  --color-surface-2: #eef1f5;
  --color-surface-3: #e2e7ee;

  --color-fg-default: #15181f;
  --color-fg-muted: #4b5160;
  --color-fg-subtle: #767c8c;
  --color-fg-on-accent: #ffffff;

  --color-accent: #2563eb;
  --color-accent-hover: #1d4ed8;

  --color-border: #d7dde5;
  --color-border-strong: #b3bcc8;

  --color-status-online: #16a34a;
  --color-status-degraded: #c4881a;
  --color-status-offline: #767c8c;   /* muted */
  --color-status-drift: #9333ea;
  --color-fault: #c0392b;
  --color-warning: #c4881a;
  --color-info: #2563eb;
}
```

### Contrast guarantees

Per [constraints](./spec-frontend-constraints.md) (WCAG 2.1 AA):

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
  --chart-series-1: var(--color-accent);
  --chart-series-2: #f59e0b;
  --chart-series-3: #10b981;
  --chart-series-4: #a855f7;
  --chart-series-5: #ef4444;

  --chart-setpoint: var(--color-fg-muted);   /* setpoint reference line */
  --chart-band-ok: rgba(74, 222, 128, 0.10); /* in-band shading */
  --chart-band-warn: rgba(245, 180, 84, 0.12);
  --chart-band-fault: rgba(248, 113, 113, 0.12);
  --chart-axis: var(--color-fg-muted);
  --chart-grid: var(--color-border);
  --chart-gap: var(--color-border-strong);   /* live-data gap marker */
}
```

The `TimeSeriesChart` ([components](./spec-frontend-components.md)) consumes only
these — never `--color-status-*` — so chart styling and status semantics evolve
independently.

---

## 4. Typography

| Token | Stack | Use |
|---|---|---|
| `--font-sans` | `"Inter", system-ui, sans-serif` | Body, UI labels, headings |
| `--font-mono` | `"JetBrains Mono", ui-monospace, monospace` | Numeric readouts, timestamps, IDs |

Numeric telemetry uses `--font-mono` with **tabular figures** so digits don't
jitter as values stream.

### Type scale (1.2 ratio, 16 px base)

| Token | Size / line-height | Use |
|---|---|---|
| `--text-xs` | 12 / 1.4 | axis labels, meta |
| `--text-sm` | 13 / 1.5 | table cells, captions |
| `--text-base` | 16 / 1.5 | body |
| `--text-md` | 18 / 1.4 | metric values |
| `--text-lg` | 22 / 1.3 | section headings |
| `--text-xl` | 28 / 1.2 | view titles |

---

## 5. Spacing, radii, shadows

```css
:root {
  /* 4px linear scale */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-12: 48px;

  --radius-sm: 4px;   /* pills, inputs */
  --radius-md: 8px;   /* buttons */
  --radius-lg: 12px;  /* cards */
  --radius-full: 9999px;
}

[data-theme="dark"] {
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
  --shadow-md: 0 4px 14px rgba(0,0,0,0.5);
}
[data-theme="light"] {
  --shadow-sm: 0 1px 2px rgba(20,24,32,0.06);
  --shadow-md: 0 4px 14px rgba(20,24,32,0.10);
}
```

Off-scale spacing means the design is wrong, not the scale.

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
`prefers-reduced-motion` ([interactions](./spec-frontend-interactions.md)).

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

  --layout-max-width: 1440px;     /* operator screens run wide */
  --layout-sidenav-width: 220px;
  --layout-gutter: 24px;

  --bp-sm: 640px;
  --bp-md: 900px;    /* sidenav → top bar + drawer below this */
  --bp-lg: 1280px;
}
```

`--bp-md` is the canonical cutoff where `SideNav` collapses
([interactions](./spec-frontend-interactions.md)).

---

## 8. Tailwind wiring

Tailwind v4 (CSS-first) reads the tokens:

```css
@import "tailwindcss";
@import "./tokens.css";

@theme {
  --color-bg: var(--color-bg);
  --color-surface-1: var(--color-surface-1);
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
