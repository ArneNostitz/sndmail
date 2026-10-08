# Changelog

## Unreleased

- Rebrand the desktop mail client and its packaged artwork as sndmail.
- Add a native macOS background mail worker, Commonplace relay controls, and worker status reporting.
- Let any mail account add send-as aliases in Settings, with Gmail workspace-domain aliases registered directly and IMAP aliases stored locally; suggested aliases are detected from received mail.
- Add a Plugins settings tab and move the Commonplace mail relay there, with multi-inbox grants.
- Pace Gmail API reads and retry transient rate-limit and server failures with bounded backoff.
- Keep foreground mail sync available when the background worker cannot own sync.

Older release history remains available in the repository's Git history.
