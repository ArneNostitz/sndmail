/**
 * The fix number: which build of the current version this is.
 *
 * The version itself (`0.4.21`) is the release; this counts the fixes shipped
 * on top of it, so a build can be told apart from the one before it without
 * pretending to be a new release. Bump it in every PR that changes behaviour.
 *
 * It is also written to `bundle.macOS.bundleVersion` in `tauri.conf.json`
 * (what Finder's Get Info shows) and onto `package.json`'s version as
 * `0.4.21+013` (what every `npm run` prints) — a test keeps the three in step.
 */
export const FIX_NUMBER = "013";
