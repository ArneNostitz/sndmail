export type TimeFormat = "system" | "12h" | "24h";

/**
 * Clock preference, applied to every time the app renders.
 *
 * Held here rather than read from the store so the formatters stay pure
 * functions callable from anywhere, including outside React.
 */
let timeFormat: TimeFormat = "system";

export function setTimeFormatPreference(format: TimeFormat): void {
  timeFormat = format;
}

export function getTimeFormatPreference(): TimeFormat {
  return timeFormat;
}

/**
 * `hour12` for Intl, or undefined to let the locale decide.
 */
export function hourCycleOption(): { hour12?: boolean } {
  if (timeFormat === "24h") return { hour12: false };
  if (timeFormat === "12h") return { hour12: true };
  return {};
}

/**
 * Format a unix timestamp (milliseconds) into a relative date string.
 */
export function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  // Today: show time
  if (isSameDay(date, now)) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...hourCycleOption(),
    });
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return "Yesterday";
  }

  // Within last 7 days: show day name
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }

  // Same year: show month + day
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  // Older: show full date
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Compact inbox timestamp: time today, time plus label yesterday, date otherwise. */
export function formatThreadListDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const formatTime = (value: Date) => value.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...hourCycleOption(),
  });

  if (isSameDay(date, now)) return formatTime(date);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) return `Yesterday, ${formatTime(date)}`;

  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return date.toLocaleDateString(undefined, options);
}

/**
 * Full local date and time — used for quoted headers in replies and forwards.
 */
export function formatDateTime(timestamp: number | string): string {
  return new Date(timestamp).toLocaleString(undefined, hourCycleOption());
}

/**
 * Format a unix timestamp into a full date string for message headers.
 */
export function formatFullDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...hourCycleOption(),
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
