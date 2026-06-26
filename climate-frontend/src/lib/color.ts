/**
 * Pure color helpers for the UI. Kept in `lib/` so they stay unit-testable in isolation, away from
 * the canvas/DOM glue that consumes them.
 */

/** Apply an alpha to a hex color → "rgba(r, g, b, a)" (chart fills fade the accent out). */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? hex.replace(/./g, (channel) => channel + channel) : hex;
  if (full.length !== 6) return color; // non-hex input: leave unchanged
  const red = parseInt(full.slice(0, 2), 16);
  const green = parseInt(full.slice(2, 4), 16);
  const blue = parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
