# Opening mail from other apps

snd registers the `snd` URL scheme alongside `mailto` in its desktop bundle.

```text
snd://open?account=<accountId>&thread=<threadId>&message=<messageId>
```

`account` and `thread` are required; `message` is optional. Encode each identifier
with URLSearchParams or equivalent URL encoding. These are the local snd database
IDs (`accounts.id`, `threads.id`, and `messages.id`), not email addresses or RFC
Message-ID headers. Right-click a message to copy its link or its IDs as JSON.

The receiver validates that the thread belongs to the account and that the optional
message belongs to both. Deleted, unsynced, mismatched, and read-receipt-only targets
show an error. A valid link activates snd, opens the conversation even outside the
current list, and expands/scrolls to the requested message in either reading layout.
No content, credentials, or executable commands are accepted in the link.

The native deep-link plugin retains a cold-start URL until migrations and account
loading finish. Running instances accept OS URL events and single-instance
forwarding; duplicate deliveries are coalesced. Existing mailto composition remains.

The legacy `velo://` scheme remains accepted for links created by older installs.

On macOS, changing this scheme requires a new application bundle installed and
registered with LaunchServices. A frontend rebuild alone cannot update an already
installed application's Info.plist or its running code. The integration must report
an unsupported/outdated installed app rather than claim a selected message opened.
