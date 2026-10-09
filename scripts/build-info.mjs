/**
 * Build provenance, collected from git at build time.
 *
 * `vite.config.ts` and `vitest.config.ts` inject the result as `__BUILD_INFO__`
 * via `define`, so the running app can say exactly which commit (and PR) it was
 * built from — no generated files, no gitignore churn. The parse helper is
 * exported so tests can cover it; everything falls back to "unknown" when git
 * is unavailable (e.g. building from a source tarball).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pull the PR number out of a commit subject.
 *
 * GitHub squash merges end with `(#105)`; classic merge commits start with
 * `Merge pull request #103 from …`. Anything else has no PR to point at.
 */
export function parsePrFromSubject(subject) {
  if (typeof subject !== "string" || subject.length === 0) return null;
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+)/.exec(subject);
  if (merge) return Number(merge[1]);
  return null;
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function collectBuildInfo() {
  const fullSha = git(["rev-parse", "HEAD"]);
  const shortSha = git(["rev-parse", "--short", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const count = git(["rev-list", "--count", "HEAD"]);
  const commitDate = git(["log", "-1", "--pretty=%cI"]);
  const subject = git(["log", "-1", "--pretty=%s"]);
  const status = git(["status", "--porcelain"]);
  return {
    shortSha: shortSha || "unknown",
    fullSha: fullSha || "unknown",
    branch: branch || "unknown",
    buildNumber: count ? Number(count) : null,
    commitDate: commitDate || null,
    subject: subject || "unknown",
    pr: subject ? parsePrFromSubject(subject) : null,
    dirty: status === null ? false : status.length > 0,
    builtAt: new Date().toISOString(),
  };
}
