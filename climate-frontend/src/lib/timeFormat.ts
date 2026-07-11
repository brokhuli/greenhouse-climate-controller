/**
 * Pure time-formatting helpers for the UI. Kept out of component modules so they stay unit-testable
 * in isolation (and so component files keep fast-refresh's single-export-per-file constraint).
 *
 * Timestamps are rendered in **UTC** — the greenhouse's simulated wall-clock frame. The controller's
 * simulated clock is UTC-framed (`simulation.start_ts` is stamped `Z`) and its day/night model reads
 * it in UTC (see `derivations.ts` day-window logic), so a run started at "11:00" must also *display*
 * as 11:00 regardless of the operator's browser timezone; formatting in local time would shift the
 * whole clock by the browser's offset.
 */

/** Epoch seconds → UTC "HH:MM" (fleet-card x-axis ticks). */
export function formatClockTime(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  const hours = String(at.getUTCHours()).padStart(2, "0");
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Epoch seconds → UTC "HH:MM:SS" (hover readout needs sub-minute precision). */
export function formatClockSeconds(epochSeconds: number): string {
  const seconds = String(new Date(epochSeconds * 1000).getUTCSeconds()).padStart(2, "0");
  return `${formatClockTime(epochSeconds)}:${seconds}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Epoch seconds → UTC "MMM D, HH:MM:SS" (detail-chart hover readout spans days). */
export function formatTimestamp(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${formatClockSeconds(epochSeconds)}`;
}

/**
 * uPlot `tzDate` that renders a `time: true` x-axis in UTC. uPlot builds axis tick labels (and aligns
 * tick boundaries) from a Date's *local* getters, so — matching the UTC hover/tick formatters above —
 * we return a Date shifted by the local offset: its local fields then read the true UTC wall clock.
 * Without this the chart axis alone would drift back to browser-local time while everything else reads
 * UTC. (Fine around DST for display; the axis is labels, not arithmetic.)
 */
export function utcTzDate(epochSeconds: number): Date {
  const at = new Date(epochSeconds * 1000);
  return new Date(at.getTime() + at.getTimezoneOffset() * 60_000);
}
