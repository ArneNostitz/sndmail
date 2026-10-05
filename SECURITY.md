# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases | No |

We only provide security fixes for the latest release. Please keep snd up to date.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to **security@velomail.app** (or by opening a [private security advisory](https://github.com/avihaymenahem/velo/security/advisories/new) on GitHub).

Include as much of the following as possible:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive an acknowledgment within **48 hours**. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Security Model

### Local-First Architecture

snd is a desktop application. Your emails, tokens, and settings are stored locally in a SQLite database on your machine. There are no snd-operated backend servers.

### Authentication & Credentials

- **Gmail**: OAuth 2.0 with PKCE -- no client secret stored. Tokens are encrypted with AES-256-GCM before being saved to the local database.
- **IMAP/SMTP**: Passwords and app passwords are encrypted with AES-256-GCM in the local SQLite database.
- **Encryption key**: The AES-256-GCM key lives in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service) -- not on disk beside the database it protects. Installs from before v0.5 migrate their `velo.key` file into the credential store on first launch and the file is deleted. If no credential store is reachable (e.g. headless Linux with no Secret Service provider), snd falls back to the on-disk key file and logs a warning; in that configuration the encryption is obfuscation only.
- **AI API keys**: Stored in the local SQLite settings table. Keys are sent directly to the respective provider (Anthropic, OpenAI, Google) over HTTPS -- never to any snd server.

### Email Rendering

- HTML emails are sanitized with **DOMPurify** and rendered in a **sandboxed iframe** (`allow-same-origin` only -- no scripts)
- Remote images are **blocked by default** and replaced with placeholders. Users can allowlist specific senders.
- Phishing detection runs 10 heuristic rules over every link in a message. Messages with suspicious links show a warning banner, and clicking any flagged link opens a confirmation dialog showing the real destination and the reasons it was flagged before anything opens.

### Network

- All API connections use HTTPS
- Content Security Policy restricts webview network requests to known domains (googleapis.com, anthropic.com, openai.com, generativelanguage.googleapis.com, gravatar.com, googleusercontent.com)
- The Tauri HTTP plugin bypasses the CSP, so its capability is scoped to loopback addresses only -- it exists solely to reach a local AI server (Ollama / LM Studio). If you run that server on another machine, add its exact origin to `src-tauri/capabilities/default.json`.
- One-click unsubscribe requests legitimately need arbitrary hosts, so they run in Rust (`unsubscribe_one_click`) as a fixed-shape POST whose response body never reaches the webview
- No telemetry, analytics, or tracking

### Dependencies

- Frontend: React, Tailwind CSS, TipTap, Zustand, DOMPurify, lucide-react
- Backend: Tauri v2 (Rust), async-imap, lettre, mail-parser
- We monitor dependencies for known vulnerabilities and update regularly

## Scope

The following are **in scope** for security reports:

- Authentication bypass or token leakage
- Credential exposure (OAuth tokens, IMAP passwords, API keys)
- Cross-site scripting (XSS) via email content escaping the sandbox
- Remote code execution
- SQL injection in the local SQLite database
- Insecure data storage or encryption weaknesses
- Phishing detection bypasses

The following are **out of scope**:

- Vulnerabilities requiring physical access to the user's machine (local SQLite is not encrypted at rest by design -- the OS protects user files)
- Denial of service against the local application
- Issues in third-party dependencies with no demonstrated impact on snd
- Social engineering attacks

## Disclosure Policy

- We follow coordinated disclosure. Please allow us reasonable time (typically 90 days) to address the issue before public disclosure.
- We will credit reporters in release notes unless anonymity is requested.
