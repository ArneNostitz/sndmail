# Opening mail from other apps

sndmail registers the `sndmail` URL scheme alongside `mailto` in its desktop bundle.

```text
sndmail://open?account=<accountId>&thread=<threadId>&message=<messageId>
```

`account` and `thread` are required; `message` is optional. Encode each identifier
with URLSearchParams or equivalent URL encoding. These are the local sndmail database
IDs (`accounts.id`, `threads.id`, and `messages.id`), not email addresses or RFC
Message-ID headers. Right-click an individual message or a thread in the message
list to copy its link; individual-message context menus also offer the IDs as JSON.
From a list row, the link targets the exact message represented by that row: in
Inbox this is the incoming message shown in the row preview, even when a later
reply was sent; in other folders it is the latest real message, excluding read
receipts. The row's account is used for the link.

The receiver validates that the thread belongs to the account and that the optional
message belongs to both. Deleted, unsynced, mismatched, and read-receipt-only targets
show an error. A valid link activates sndmail, opens the conversation even outside the
current list, and expands/scrolls to the requested message in either reading layout.
No content, credentials, or executable commands are accepted in the link.
The link reuses the existing `sndmail://` scheme and is useful only on a device
where the linked message is available in the local mailbox.

Mail links use the `sndmail://open` scheme. The native deep-link plugin retains a cold-start URL until account
loading finishes. Running instances accept OS URL events and single-instance
forwarding; duplicate deliveries are coalesced. Existing mailto composition remains.

On macOS, changing this scheme requires a new application bundle installed and
registered with LaunchServices. A frontend rebuild alone cannot update an already
installed application's Info.plist or its running code. The integration must report
an unsupported/outdated installed app rather than claim a selected message opened.
