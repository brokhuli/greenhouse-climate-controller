import { describe, expect, it } from "vitest";
import {
  formatClockSeconds,
  formatClockTime,
  formatTimestamp,
  utcTzDate,
} from "../../src/lib/timeFormat";

/**
 * Epoch *seconds* for a given UTC wall-clock time. Built from UTC components (Date.UTC) to match the
 * formatters' UTC rendering, keeping the assertions timezone-independent.
 */
const utcSeconds = (hours: number, minutes: number, seconds = 0): number =>
  Date.UTC(2026, 5, 25, hours, minutes, seconds, 0) / 1000;

describe("formatClockTime", () => {
  it("renders UTC time as zero-padded HH:MM", () => {
    expect(formatClockTime(utcSeconds(9, 5))).toBe("09:05");
  });

  it("renders midnight as 00:00", () => {
    expect(formatClockTime(utcSeconds(0, 0))).toBe("00:00");
  });

  it("renders afternoon times in 24-hour form", () => {
    expect(formatClockTime(utcSeconds(14, 30))).toBe("14:30");
  });

  it("interprets its argument as epoch seconds, not milliseconds", () => {
    // 10:07 UTC → seconds, not the 1970-epoch instant that ms would give.
    expect(formatClockTime(utcSeconds(10, 7))).toBe("10:07");
  });
});

describe("formatClockSeconds", () => {
  it("renders UTC time as zero-padded HH:MM:SS", () => {
    expect(formatClockSeconds(utcSeconds(9, 5, 7))).toBe("09:05:07");
  });

  it("renders midnight as 00:00:00", () => {
    expect(formatClockSeconds(utcSeconds(0, 0, 0))).toBe("00:00:00");
  });

  it("interprets its argument as epoch seconds, not milliseconds", () => {
    expect(formatClockSeconds(utcSeconds(14, 30, 42))).toBe("14:30:42");
  });
});

/** Epoch *seconds* for a specific UTC date and time (timezone-independent assertions). */
const utcDateSeconds = (
  year: number,
  monthIndex: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): number => Date.UTC(year, monthIndex, day, hours, minutes, seconds, 0) / 1000;

describe("formatTimestamp", () => {
  it("renders 'MMM D, HH:MM:SS' in UTC", () => {
    expect(formatTimestamp(utcDateSeconds(2026, 5, 25, 14, 30, 42))).toBe("Jun 25, 14:30:42");
  });

  it("handles the January / start-of-day boundary", () => {
    expect(formatTimestamp(utcDateSeconds(2026, 0, 1, 0, 0, 0))).toBe("Jan 1, 00:00:00");
  });

  it("handles the December boundary without zero-padding the day", () => {
    expect(formatTimestamp(utcDateSeconds(2026, 11, 9, 9, 5, 7))).toBe("Dec 9, 09:05:07");
  });

  it("interprets its argument as epoch seconds, not milliseconds", () => {
    expect(formatTimestamp(utcDateSeconds(2026, 5, 25, 23, 59, 59))).toBe("Jun 25, 23:59:59");
  });
});

describe("utcTzDate (uPlot time-axis tzDate)", () => {
  // uPlot builds axis labels from a Date's *local* getters. utcTzDate must hand back a Date whose
  // local fields read the instant's UTC wall clock, so the chart axis shows UTC regardless of the
  // runner's timezone — the property asserted here holds in any TZ.
  it("maps local getters onto the instant's UTC wall clock", () => {
    const ts = Date.UTC(2026, 6, 10, 10, 0, 0) / 1000; // 2026-07-10T10:00:00Z
    const d = utcTzDate(ts);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(10);
    expect(d.getMinutes()).toBe(0);
  });

  it("takes unix seconds, like uPlot's default tzDate (not milliseconds)", () => {
    const d = utcTzDate(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getHours()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});
