import { describe, it, expect, afterEach } from "vitest";
import {
  formatRelativeDate,
  formatFullDate,
  formatDateTime,
  formatThreadListDate,
  hourCycleOption,
  setTimeFormatPreference,
  getTimeFormatPreference,
} from "./date";

/** 13:30 local time today, so the relative formatter renders a clock time. */
function todayAtHalfPastOne(): number {
  const d = new Date();
  d.setHours(13, 30, 0, 0);
  return d.getTime();
}

describe("time format preference", () => {
  afterEach(() => {
    setTimeFormatPreference("system");
  });

  it("defaults to following the system locale", () => {
    expect(getTimeFormatPreference()).toBe("system");
    expect(hourCycleOption()).toEqual({});
  });

  it("forces a 24-hour clock when asked", () => {
    setTimeFormatPreference("24h");
    expect(hourCycleOption()).toEqual({ hour12: false });
  });

  it("forces a 12-hour clock when asked", () => {
    setTimeFormatPreference("12h");
    expect(hourCycleOption()).toEqual({ hour12: true });
  });

  it("renders today's time as 24-hour", () => {
    setTimeFormatPreference("24h");
    const formatted = formatRelativeDate(todayAtHalfPastOne());
    expect(formatted).toContain("13");
    expect(formatted).not.toMatch(/[AP]M/i);
  });

  it("renders today's time as 12-hour", () => {
    setTimeFormatPreference("12h");
    const formatted = formatRelativeDate(todayAtHalfPastOne());
    expect(formatted).toMatch(/[AP]M/i);
    expect(formatted).toContain("1:30");
  });

  it("applies the preference to full message dates too", () => {
    setTimeFormatPreference("24h");
    expect(formatFullDate(todayAtHalfPastOne())).not.toMatch(/[AP]M/i);

    setTimeFormatPreference("12h");
    expect(formatFullDate(todayAtHalfPastOne())).toMatch(/[AP]M/i);
  });

  it("applies the preference to quoted reply headers", () => {
    // These bypassed the formatter entirely and always rendered locale default
    const at = todayAtHalfPastOne();
    setTimeFormatPreference("24h");
    expect(formatDateTime(at)).not.toMatch(/[AP]M/i);

    setTimeFormatPreference("12h");
    expect(formatDateTime(at)).toMatch(/[AP]M/i);
  });

  it("leaves non-time output alone", () => {
    setTimeFormatPreference("24h");
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatRelativeDate(yesterday.getTime())).toBe("Yesterday");
  });

  it("formats inbox rows with time today and yesterday, then date only", () => {
    const today = new Date();
    today.setHours(13, 30, 0, 0);
    expect(formatThreadListDate(today.getTime())).toMatch(/\d{1,2}:30/);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(13, 30, 0, 0);
    expect(formatThreadListDate(yesterday.getTime())).toMatch(/^Yesterday, /);

    const older = new Date();
    older.setDate(older.getDate() - 3);
    const formatted = formatThreadListDate(older.getTime());
    expect(formatted).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    expect(formatted).toMatch(/[A-Za-z]{3}/);
  });
});
