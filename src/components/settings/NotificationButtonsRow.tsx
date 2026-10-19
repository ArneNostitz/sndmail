import { useEffect, useState } from "react";
import {
  getNativeNotificationFailure,
  sendTestNotification,
  type NotificationBackend,
} from "@/services/notifications/notificationManager";
import { notify } from "@/stores/toastStore";

/**
 * Whether notifications carry buttons here — and why not, if not — with a
 * way to see one. The backend is decided once, at start-up, by
 * notificationManager; only a bundled macOS build gets the native one.
 */
export function NotificationButtonsRow({ backend }: { backend: NotificationBackend }) {
  const [os, setOs] = useState("");
  const failure = getNativeNotificationFailure();
  useEffect(() => {
    import("@tauri-apps/plugin-os")
      .then(({ platform }) => setOs(platform()))
      .catch(() => {});
  }, []);

  let note: string;
  if (backend === "native") {
    note =
      "Reply, Archive and Copy code sit on the notification. macOS hides a banner's buttons until you hover, so sndmail asks for the Alerts style; System Settings → Notifications → sndmail is where to change it.";
  } else if (backend === "plugin") {
    note =
      os === "macos"
        ? failure
          // The centre was there and said no — almost always an unsigned
          // build, which it cannot identify. Saying "development build"
          // here would send the user looking in the wrong place.
          ? `The macOS notification centre turned this build down (${failure}), so notifications are plain text. An app bundle has to be code-signed before the centre will accept it.`
          : "Buttons need the installed app: a development build runs outside an app bundle, which the macOS notification centre refuses, so notifications here are plain text."
        : "Notifications are plain text on this platform. The buttons live in sndmail's own toasts instead.";
  } else {
    note =
      "Notifications are off, or the system has not allowed them. On macOS, check System Settings → Notifications → sndmail.";
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <p className="text-xs text-text-tertiary">{note}</p>
      <button
        onClick={async () => {
          const sent = await sendTestNotification();
          notify("info", sent === "off" ? "Notifications are off" : "Test notification sent");
        }}
        className="shrink-0 text-xs px-3 py-1.5 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-secondary border border-border-primary"
      >
        Send a test
      </button>
    </div>
  );
}
