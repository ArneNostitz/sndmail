/**
 * The fix number: which build of the current version this is.
 *
 * The version itself (`0.4.21`) is the release; this counts the fixes shipped
 * on top of it, so a build can be told apart from the one before it without
 * pretending to be a new release. Bump it in every PR that changes behaviour.
 *
 * It is also written to `bundle.macOS.bundleVersion` in `tauri.conf.json`
 * (what Finder's Get Info shows) and onto `package.json`'s version as
 * `0.4.21+016` (what every `npm run` prints) — a test keeps the three in step.
 */
export const FIX_NUMBER = "017";

export type BuildInfo = {
  shortSha: string;
  fullSha: string;
  branch: string;
  /** Monotonic commit count — the build number shown in About. */
  buildNumber: number | null;
  commitDate: string | null;
  subject: string;
  /** PR the commit came from (GitHub squash `(#105)` / `Merge pull request #n`). */
  pr: number | null;
  /** True when the build tree had uncommitted changes. */
  dirty: boolean;
  builtAt: string;
};

/**
 * Build provenance, stamped in at build time by `scripts/build-info.mjs` and
 * injected through `define` in `vite.config.ts` / `vitest.config.ts`. The
 * typeof guard keeps the module loadable anywhere the define is absent.
 */
declare const __BUILD_INFO__: BuildInfo | undefined;

const FALLBACK_BUILD_INFO: BuildInfo = {
  shortSha: "unknown",
  fullSha: "unknown",
  branch: "unknown",
  buildNumber: null,
  commitDate: null,
  subject: "unknown",
  pr: null,
  dirty: false,
  builtAt: "",
};

export const BUILD_INFO: BuildInfo =
  typeof __BUILD_INFO__ === "undefined" ? FALLBACK_BUILD_INFO : __BUILD_INFO__;

export const REPO_URL = "https://github.com/ArneNostitz/sndmail";

/** `#283 · 35b0dd7 · PR #105` — everything needed to place a build. */
export function formatBuildLabel(info: BuildInfo): string {
  const parts: string[] = [];
  if (info.buildNumber !== null) parts.push(`#${info.buildNumber}`);
  if (info.shortSha && info.shortSha !== "unknown") parts.push(info.shortSha);
  if (info.pr !== null) parts.push(`PR #${info.pr}`);
  else if (info.branch && info.branch !== "unknown" && info.branch !== "HEAD") parts.push(info.branch);
  return parts.length > 0 ? parts.join(" · ") : "unknown build";
}

/** Where to open this build on GitHub: its PR if known, else its commit. */
export function buildWebUrl(info: BuildInfo): string | null {
  if (info.pr !== null) return `${REPO_URL}/pull/${info.pr}`;
  if (info.fullSha && info.fullSha !== "unknown") return `${REPO_URL}/commit/${info.fullSha}`;
  return null;
}
