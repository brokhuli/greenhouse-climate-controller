import { describe, expect, it } from "vitest";
import { formatClockSeconds, formatClockTime, formatTimestamp } from "../../src/lib/timeFormat";

/** Epoch *seconds* for a given local wall-clock time (keeps assertions timezone-independent). */
const localSeconds = (hours: number, minutes: number, seconds = 0): number =>
  new Date(2026, 5, 25, hours, minutes, seconds, 0).getTime() / 1000;

describe("formatClockTime", () => {
  it("renders local time as zero-padded HH:MM", () => {
    expect(formatClockTime(localSeconds(9, 5))).toBe("09:05");
  });

  it("renders midnight as 00:00", () => {
    expect(formatClockTime(localSeconds(0, 0))).toBe("00:00");
  });

  it("renders afternoon times in 24-hour form", () => {
    expect(formatClockTime(localSeconds(14, 30))).toBe("14:30");
  });

  it("interprets its argument as epoch seconds, not milliseconds", () => {
    // 10:07 local → seconds, not the 1970-epoch instant that ms would give.
    expect(formatClockTime(localSeconds(10, 7))).toBe("10:07");
  });
});

describe("formatClockSeconds", () => {
  it("renders local time as zero-padded HH:MM:SS", () => {
    expect(formatClockSeconds(localSeconds(9, 5, 7))).toBe("09:05:07");
  });

  it("renders midnight as 00:00:00", () => {
    expect(formatClockSeconds(localSeconds(0, 0, 0))).toBe("00:00:00");
  });

  it("interprets its argument as epoch seconds, not milliseconds", () => {
    expect(formatClockSeconds(localSeconds(14, 30, 42))).toBe("14:30:42");
  });
});

/** Epoch *seconds* for a specific local date and time (timezone-independent assertions). */
const localDateSeconds = (
  year: number,
  monthIndex: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): number => new Date(year, monthIndex, day, hours, minutes, seconds, 0).getTime() / 1000;

describe("formatTimestamp", () => {
  it("renders 'MMM D, HH:MM:SS' in local time", () => {
    expect(formatTimestamp(localDateSeconds(2026, 5, 25, 14, 30, 42))).toBe("Jun 25, 14:30:42");
  });

  it("handles the January / start-of-day boundary", () => {
    expect(formatTimestamp(localDateSeconds(2026, 0, 1, 0, 0, 0))).toBe("Jan 1, 00:00:00");
  });

  it("handles the December boundary without zero-padding the day", () => {
    expect(formatTimestamp(localDateSeconds(2026, 11, 9, 9, 5, 7))).toBe("Dec 9, 09:05:07");
  });

  it("interprets its argument as epoch seconds, not milliseconds", () => {
    expect(formatTimestamp(localDateSeconds(2026, 5, 25, 23, 59, 59))).toBe("Jun 25, 23:59:59");
  });
});
