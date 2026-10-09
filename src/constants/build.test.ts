import { describe, it, expect } from "vitest";
import { formatBuildLabel, buildWebUrl, type BuildInfo } from "./build";

function info(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    shortSha: "e4f8720",
    fullSha: "e4f8720abc123",
    branch: "main",
    buildNumber: 282,
    commitDate: "2026-10-09T20:25:35+02:00",
    subject: "feat(settings): master-detail Accounts tab (#105)",
    pr: 105,
    dirty: false,
    builtAt: "2026-10-09T20:30:00.000Z",
    ...overrides,
  };
}

describe("formatBuildLabel", () => {
  it("names the build number, commit and PR", () => {
    expect(formatBuildLabel(info())).toBe("#282 · e4f8720 · PR #105");
  });

  it("falls back to the branch when the commit has no PR", () => {
    expect(formatBuildLabel(info({ pr: null, subject: "fix: nothing" }))).toBe(
      "#282 · e4f8720 · main",
    );
  });

  it("leaves a detached HEAD build without a branch name", () => {
    expect(formatBuildLabel(info({ pr: null, branch: "HEAD" }))).toBe("#282 · e4f8720");
  });

  it("says so when nothing is known", () => {
    expect(
      formatBuildLabel(
        info({ buildNumber: null, shortSha: "unknown", pr: null, branch: "unknown" }),
      ),
    ).toBe("unknown build");
  });
});

describe("buildWebUrl", () => {
  it("opens the pull request when the commit came from one", () => {
    expect(buildWebUrl(info())).toBe("https://github.com/ArneNostitz/sndmail/pull/105");
  });

  it("opens the commit when there is no PR", () => {
    expect(buildWebUrl(info({ pr: null }))).toBe(
      "https://github.com/ArneNostitz/sndmail/commit/e4f8720abc123",
    );
  });

  it("has nowhere to link when the commit is unknown", () => {
    expect(buildWebUrl(info({ pr: null, fullSha: "unknown" }))).toBeNull();
  });
});
