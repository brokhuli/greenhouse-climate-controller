# Frontend — Interactions

> **Purpose:** Define how the dashboard *behaves* — focus/keyboard, navigation,
> forms, motion, and (the high-value part) the **real-time interactions**: live
> chart updates, WebSocket reconnect/backfill UX, the connection-status indicator,
> optimistic-vs-confirmed writes, confirmation dialogs, fault/drift alerting,
> loading states, and (2b) the auth flow. Pairs with
> [`spec-frontend-components.md`](./spec-frontend-components.md) (what is
> interactive) by specifying *how it feels*. Motion tokens are defined in
> [`spec-frontend-design-tokens.md`](./spec-frontend-design-tokens.md) §6 and referenced here by name.

> **Operator-console tone.** This is a control surface, not a marketing site.
> Motion is functional (state changes, confirmations), never decorative; nothing
> animates that would distract from a streaming value or a fault. Every interaction
> respects `prefers-reduced-motion`.

---

## 1. Reduced-motion baseline

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Per-interaction reduced-motion behavior is noted inline below (e.g. charts update
their data either way; only transitions are suppressed).

---

## 2. Focus & keyboard

- **Focus ring:** a single shared `:focus-visible` ring at `--color-accent`, 2 px,
  2 px offset. Keyboard focus shows it; mouse clicks don't.
- **Tab order = reading order.** Only `tabindex` `0`/`-1`.
- **All actions keyboard-reachable** — nav, range picker, setpoint form, dialogs.
- **`Esc`** closes the topmost layer: dialog → popover → drawer.
- **Tables** support arrow-key cell traversal where they're dense (fleet/events).

---

## 3. Navigation

- **SideNav links** route client-side; the active item gets `aria-current="page"`.
- **Below `--bp-md`** the `SideNav` collapses to a top bar + hamburger drawer; the
  drawer slides in over `--motion-base`, traps focus, dims the page, and closes on
  backdrop tap / `Esc`. Body scroll locks while open.
- **Deep links resolve** — `/greenhouses/:id?range=…` restores the selected
  greenhouse and range (nginx SPA fallback,
  [architecture §3](./spec-frontend-architecture.md#3-route-tree)).

---

## 4. Live chart updates *(the core real-time behavior)*

- **Cadence:** streaming telemetry appends to the chart's ring buffer and renders at
  **≥ 1 Hz** (`P2-USE-1`). The visible window scrolls; old points fall off the
  buffer.
- **No transition animation on new points** — a live value must read as *now*, not
  ease in. Appends are immediate redraws (uPlot canvas,
  [tech-stack](./spec-frontend-tech-stack.md)).
- **Setpoint reference + bands** are drawn as static overlays (`--chart-setpoint`,
  `--chart-band-*`); a reading crossing out of band recolors the relevant
  `MetricTile`, not the line.
- **Pause on interaction:** hovering to read a value or brushing a range pauses the
  auto-scroll and shows a crosshair tooltip; it resumes shortly after pointer-leave
  so the operator isn't fighting the stream.
- **Reduced motion:** identical data behavior; only non-essential UI transitions are
  suppressed (the data is the point).

---

## 5. Connection status, reconnect & backfill

The `ConnectionStatus` indicator ([components](./spec-frontend-components.md)) is
the operator's trust signal that what they're seeing is *live*.

| State | Trigger | UI |
|---|---|---|
| **live** | socket open, frames flowing | quiet "Live" + last-update time |
| **reconnecting** | socket dropped | amber "Reconnecting…"; charts keep showing buffered data with a **gap marker** at the leading edge |
| **polling** | socket can't be established | "Live updates degraded — polling"; values refresh on the fallback REST cadence |
| **offline** | repeated failures / network down | "Disconnected"; data marked stale; a manual "Retry" appears |

- **Reconnect** uses exponential backoff (cap a few seconds).
- **Backfill on resume:** after reconnect, the affected telemetry range query
  re-runs to fill the gap, then the buffer resumes — **no silent holes**
  ([architecture §4](./spec-frontend-architecture.md#4-runtime-data-flow)).
- **a11y:** `role="status"`, `aria-live="polite"`; state has an icon + label, never
  color alone.

---

## 6. Controller offline (vs platform/socket offline)

These are distinct and must not be conflated:

- **Socket/platform offline** → `ConnectionStatus` reflects it (§5); *all* live data
  is suspect.
- **One controller offline** (telemetry absence / last-will) → only that greenhouse
  is marked **offline** (`--color-status-offline`, muted): its card dims, its detail
  charts show last-known data + a gap, and its **edit affordances disable** with the
  reason "controller offline — change will apply on reconnect" (offline edits are
  held by the platform in 2b,
  [platform crop profiles](../platform/spec-platform-crop-profiles.md)).

---

## 7. Writes — setpoint edits & profile apply

The write path *as the operator experiences it*. The platform is the
[single authority](../platform/spec-platform-crop-profiles.md);
the UI never commands actuators ([constraints](./spec-frontend-constraints.md)).

1. **Edit** in `SetpointEditForm` / `ProfileEditor`. Inputs validate live against
   crop-safe ranges surfaced by the API (`react-hook-form` + Zod); submit is blocked
   while invalid, with inline messages.
2. **Confirm.** Submitting opens a **confirmation dialog** summarizing the change
   (greenhouse, field, old → new). Writes are deliberate — no accidental one-click
   setpoint changes.
3. **Optimistic pending.** On confirm, the UI shows the new value in a **pending**
   style and disables the field; the mutation fires.
4. **Settle.**
   - **Confirmed** → pending style clears, a success toast appears, the value
     persists (the cache is reconciled from the server response).
   - **Failed** → optimistic value **rolls back**, an error toast shows the API
     message, the form stays open for retry.
5. **Attribution.** Every applied write appears in the `ActivityFeed` with who/what/
   when ([platform fleet management](../platform/spec-platform-crop-profiles.md#5-fleet-management--operator-control)).

In **2a** an edit is a thin relay; in **2b** it becomes sticky intended state and
participates in reconciliation — same UX, different backend semantics.

---

## 8. Alerts — faults & drift

- **Critical events** (fault, interlock activation) raise an **assertive** toast
  *and* land in the `ActivityFeed` and on the affected greenhouse — a toast is never
  the only record.
- **Drift (2b)** is **non-blocking**: a drift badge on the fleet card + detail
  header and an entry in the feed; no modal interruption (drift is informational,
  the platform may auto-correct,
  [platform crop profiles](../platform/spec-platform-crop-profiles.md)).
- **Toasts** auto-dismiss (info/warn) or persist until acknowledged (critical), are
  keyboard-dismissible, and stack without covering primary actions.

---

## 9. Loading, empty & error states

Consistent across views via shared primitives
([components](./spec-frontend-components.md)):

- **Loading** → `Skeleton` matching the eventual layout (skeleton cards, skeleton
  chart) — no spinners on primary views.
- **Empty** → `EmptyState` with a one-line explanation + the relevant action
  (e.g. "No greenhouses registered").
- **Error** → `ErrorState` with the cause and a **Retry**; cached data stays visible
  underneath where possible (degrade, don't blank,
  [architecture §9](./spec-frontend-architecture.md#9-failure-modes--recovery)).

---

## 10. Cards, buttons, tables, forms (standard)

- **Cards:** subtle border-color shift on hover for clickable cards
  (`--motion-instant`); static otherwise; no hover state on touch.
- **Buttons:** hover one color step (`--motion-instant`); active translateY 1 px;
  disabled = 0.5 opacity + `not-allowed` + an accessible reason; `danger` variant for
  destructive confirmations.
- **Tables (fleet/events):** sticky header; sortable columns; row hover highlight;
  keyboard traversal; virtualize when long.
- **Forms:** validate on blur + submit (not per-keystroke); inline errors announced
  via `aria-live="polite"`; an unsaved-changes guard on the profile editor.

---

## 11. Authentication (2b)

- **Login:** unauthenticated access to a gated route redirects to Keycloak; after
  login, `/auth/callback` consumes the code and returns the operator to the
  originally requested route (preserved across the redirect).
- **Role gating:** viewers see a fully functional **read-only** dashboard; write
  affordances render **disabled** with a tooltip ("operator role required") rather
  than vanishing, so the capability is discoverable.
- **Session expiry:** a 401 triggers a silent token refresh; if that fails, a
  non-destructive "session expired — sign in again" prompt appears and the current
  route is preserved. In-flight unsaved form input is not lost to an expiry.
- **2a:** none of this exists — the SPA is open on the trusted Docker network
  ([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).

---

## 12. Implementation budget

Every interaction here is achievable with CSS transitions + small React handlers +
the `ws.ts` client. No animation library, no scroll library. Live rendering cost is
bounded by uPlot's canvas redraw and the memoized series-merge
([components §5](./spec-frontend-components.md#5-performance-notes)), keeping the
≥ 1 Hz cadence (`P2-USE-1`) on a mid-tier machine at fleet scale.
