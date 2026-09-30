import { getCalendarProvider } from "./providerFactory";
import type { CalendarEventData, CreateEventInput } from "./types";
import type { DbCalendar } from "@/services/db/calendars";
import { upsertCalendarEvent } from "@/services/db/calendarEvents";

export interface CalendarEventDraft {
  summary: string;
  description: string;
  location: string;
  startTime: string;
  endTime: string;
  calendarId?: string;
}

export async function saveProviderCalendarEvent(
  accountId: string,
  calendarId: string | null,
  event: CalendarEventData,
): Promise<void> {
  await upsertCalendarEvent({
    accountId,
    googleEventId: event.remoteEventId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startTime: event.startTime,
    endTime: event.endTime,
    isAllDay: event.isAllDay,
    status: event.status,
    organizerEmail: event.organizerEmail,
    attendeesJson: event.attendeesJson,
    htmlLink: event.htmlLink,
    calendarId,
    remoteEventId: event.remoteEventId,
    etag: event.etag,
    icalData: event.icalData,
    uid: event.uid,
  });
}

/** Create remotely first, then cache the exact provider response locally. */
export async function createCalendarEvent(
  accountId: string,
  calendars: DbCalendar[],
  draft: CalendarEventDraft,
): Promise<void> {
  const provider = await getCalendarProvider(accountId);
  const selected = draft.calendarId
    ? calendars.find((calendar) => calendar.id === draft.calendarId)
    : undefined;
  const target = selected ?? calendars.find((calendar) => calendar.is_primary) ?? calendars[0];
  const input: CreateEventInput = {
    summary: draft.summary,
    description: draft.description || undefined,
    location: draft.location || undefined,
    startTime: draft.startTime,
    endTime: draft.endTime,
  };
  const created = await provider.createEvent(target?.remote_id ?? "primary", input);
  await saveProviderCalendarEvent(accountId, target?.id ?? null, created);
  window.dispatchEvent(new CustomEvent("sndmail-calendar-sync-done"));
}
