# sndmail background worker and Commonplace relay

On macOS, sndmail installs a per-user LaunchAgent for its bundled native `sndmail-worker` at `sndmail.app/Contents/Helpers/SndmailWorker.app/Contents/MacOS/sndmail-worker`. That path gives the helper the app bundle identity needed by Notification Center. It starts at login and runs without the main app, a WebView, or a tray window. It owns background Gmail and IMAP synchronization. The main app can still make user-initiated mail edits, but sends refresh requests to the worker and observes its committed change journal. The helper uses a five-minute catch-up timer; configured Gmail push and IMAP IDLE wake it sooner. Reconnects also trigger catch-up. Opening the main app attaches to the existing helper without restarting it.

The worker and main app use the canonical `sndmail.db` database and OS-stored encryption key. Both open the same mail store, and app links use the `sndmail://open` scheme.

Gmail synchronization spaces API GET requests at least 500 ms apart. It retries only rate-limit responses (`rateLimitExceeded` or `userRateLimitExceeded`), HTTP 429, and server errors with bounded exponential backoff. If a limit persists, the worker records a safe status and retries on a later sync cycle.

In Settings → General, **Background mail helper** is enabled by default and can be turned off. Changing it relaunches the app to transfer sync ownership. Disabling it unloads the LaunchAgent; enabling it re-installs the bundled helper. If installation or connection fails, Settings reports the error. A registered helper retains sync ownership while starting or recovering so the foreground does not race it.

## Local relay contract

Settings → General → **Commonplace mail relay** creates an explicit, revocable access profile for one selected mailbox. The app shows its random bearer token once. Creating a new grant replaces the previous `commonplace` grant. The profile file is owner-only and holds a SHA-256 token digest, selected account IDs, and scopes. Keep the token in Commonplace's credential store, not in logs or document text. The Unix socket is `~/Library/Application Support/com.anydaysomething.sndmail/worker.sock`, mode `0600`; the worker also checks that clients run as the same OS user.

Send one JSON request per line and read one JSON response per line. Responses have `{"ok":true,"data":...}` or `{"ok":false,"data":{"error":"..."}}`. The protocol version is `1`. `health` and `wake` require no profile and expose no mail content. Data operations require both `profile_id` and `token` on every request:

| Operation | Other fields | Result |
| --- | --- | --- |
| `list_accounts` | — | Accounts allowed by this profile only |
| `recent_messages` | `account_id`, optional `limit` (1–100), optional `cursor:{"date":number,"id":string}` | Recent metadata, `next_cursor` |
| `get_message` | `account_id`, `message_id` | One metadata record |
| `changes` | optional `cursor:{"seq":number}`, optional `limit` (1–100) | Durable account change events, `next_cursor`, `resync_required` |
| `subscribe` | optional `cursor:{"seq":number}` | Replay then newline-delimited live change pages on the same connection |
| `get_content` | `account_id`, `message_id` | Subject, snippet, and plain/HTML body only when `read_content` was granted |
| `search` | `query`, optional `account_id`, optional `limit` (1–100) | Account-scoped FTS hits with IDs and links only; requires `read_content` |

The default `metadata` scope excludes subjects, snippets, bodies, attachments, secrets, and one-time login codes. `read_content` must be checked separately when creating the grant; each returned content field is bounded to 8,192 characters. Search requires that same explicit scope because even a yes/no hit could reveal sensitive content. Its results contain IDs and links, with `has_more` indicating that the bounded result was truncated. Account-scoped message metadata includes a stable `sndmail://open` link. The journal retains recent change events; if a cursor is older than the retained range, `resync_required:true` means the client should page `recent_messages` again and then resume from `next_cursor`. A notification or subscription is a wake-up hint; use the cursor to recover across sleeps, crashes, or disconnections. Request lines are capped at 16 KiB, responses at 256 KiB, and idle socket operations time out.

The worker never sends mail for Commonplace. It does not expose OAuth credentials, IMAP passwords, or the local encryption key. A granted client can read only its selected mailbox and scope. The helper creates native notifications for genuinely new mail and one-time codes; the code is copied only after the user presses **Copy code**. Startup history is not announced as fresh mail. The app's filter, smart-label, and optional AI postprocessing runs from a durable queue when the main app opens, keeping those heavier jobs out of the idle helper.

macOS may not ask for notification permission when a background helper first posts. If the worker status in Settings reports permission denied, open **System Settings → Notifications → SndmailWorker** and enable **Allow Notifications**. Settings also shows the worker's sanitized notification phase, permission, and error category when available; these diagnostics never include message text or one-time codes. A successful delivery status means Notification Center accepted the request; it does not confirm a visible banner. Banner appearance and the separate **Copy code** action remain unverified until exercised on macOS.

## Verification boundary

`python3 scripts/test-worker-fixture.py <path-to-sndmail-worker>` runs the helper as a separate process against an isolated local Gmail emulator and database, with no main app. `scripts/test-worker-imap-fixture.py` exercises a local IMAP protocol emulator. These check persisted messages, FTS, change replay, restart deduplication, and OTP intent. A packaged fixture snapshot measured about 39.5 MiB RSS while active; it is not an idle baseline, and battery use with multiple live accounts has not been measured. The fixture's `OTP OS request accepted` result means Notification Center accepted the API request; it does not prove a visible banner appeared. Fixtures do not establish live provider delivery, permission acceptance, or macOS notification action acceptance. Record those separately from **Copy code** action acceptance before claiming them accepted.
