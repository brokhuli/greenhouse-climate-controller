/**
 * Pure time-formatting helpers for the UI. Kept out of component modules so they stay unit-testable
 * in isolation (and so component files keep fast-refresh's single-export-per-file constraint).
 */

/** Epoch seconds → local "HH:MM" (fleet-card x-axis ticks). */
export function formatClockTime(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Epoch seconds → local "HH:MM:SS" (hover readout needs sub-minute precision). */
export function formatClockSeconds(epochSeconds: number): string {
  const seconds = String(new Date(epochSeconds * 1000).getSeconds()).padStart(2, "0");
  return `${formatClockTime(epochSeconds)}:${seconds}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Epoch seconds → local "MMM D, HH:MM:SS" (detail-chart hover readout spans days). */
export function formatTimestamp(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${formatClockSeconds(epochSeconds)}`;
}
