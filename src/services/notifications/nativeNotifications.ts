import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The Rust side of notifications with buttons (`src-tauri/src/notifications.rs`).
 *
 * On a bundled macOS build this is UNUserNotificationCenter; everywhere else
 * `nativeNotificationsAvailable()` says no and the caller keeps the plugin.
 * Thin on purpose — the decisions live in `notificationManager.ts`, which is
 * what the tests exercise.
 */

export const NATIVE_ACTION_EVENT = "sndmail-notification-action";

export interface NativeAction {
  id: string;
  title: string;
  /** Bring sndmail to the front when pressed (reply, open a link). */
  foreground?: boolean;
  /** Drawn in red. */
  destructive?: boolean;
}

export interface NativeCategory {
  id: string;
  actions: NativeAction[];
}

export interface NativeNotificationRequest {
  title: string;
  body: string;
  /** Which button set to attach; omit for a plain notification. */
  categoryId?: string;
  /** Handed back untouched with a press. */
  context?: unknown;
  /** Notifications sharing a group stack together in Notification Centre. */
  group?: string;
}

export interface NativeNotificationResponse {
  /** A button's id, `"default"` for a click on the body, `"dismiss"` for a swipe-away. */
  actionId: string;
  notificationId: string;
  context: unknown;
}

export async function nativeNotificationsAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("notification_native_available");
  } catch {
    return false;
  }
}

/** First call shows the system prompt; later calls answer from the stored decision. */
export function requestNativePermission(): Promise<boolean> {
  return invoke<boolean>("notification_native_request_permission");
}

export function registerNativeCategories(categories: NativeCategory[]): Promise<void> {
  return invoke("notification_native_register_categories", { categories });
}

/** Resolves with the notification's id once the centre has accepted it. */
export function showNativeNotification(request: NativeNotificationRequest): Promise<string> {
  return invoke<string>("notification_native_show", { request });
}

/**
 * Hear every press. Listens first and only then tells Rust the webview is
 * ready: a press that arrived before that — the click that *launched* sndmail —
 * is queued in Rust and comes back from the ready call, so nothing is lost
 * and nothing is heard twice.
 */
export async function listenForNativeActions(
  handler: (response: NativeNotificationResponse) => void | Promise<void>,
): Promise<UnlistenFn> {
  const unlisten = await listen<NativeNotificationResponse>(NATIVE_ACTION_EVENT, (event) => {
    void handler(event.payload);
  });
  const pending = await invoke<NativeNotificationResponse[]>("notification_native_ready");
  for (const response of pending) {
    await handler(response);
  }
  return unlisten;
}
