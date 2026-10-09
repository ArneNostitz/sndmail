import { describe, it, expect } from "vitest";
import { parsePrFromSubject, collectBuildInfo } from "./build-info.mjs";

describe("parsePrFromSubject", () => {
  it("reads the PR number from a GitHub squash-merge subject", () => {
    expect(parsePrFromSubject("feat(settings): master-detail Accounts tab (#105)")).toBe(105);
  });

  it("reads the PR number from a classic merge commit", () => {
    expect(parsePrFromSubject("Merge pull request #103 from ArneNostitz/fix-thing")).toBe(103);
  });

  it("has no PR for an ordinary commit", () => {
    expect(parsePrFromSubject("fix: keep the two sync entry points apart")).toBeNull();
  });

  it("has no PR for an empty subject", () => {
    expect(parsePrFromSubject("")).toBeNull();
    expect(parsePrFromSubject(undefined as unknown as string)).toBeNull();
  });
});

describe("collectBuildInfo", () => {
  it("describes the checked-out build", () => {
    const info = collectBuildInfo();
    expect(typeof info.shortSha).toBe("string");
    expect(typeof info.fullSha).toBe("string");
    expect(typeof info.branch).toBe("string");
    expect(info.buildNumber === null || typeof info.buildNumber === "number").toBe(true);
    expect(typeof info.dirty).toBe("boolean");
    expect(typeof info.builtAt).toBe("string");
    expect(info.builtAt.length).toBeGreaterThan(0);
  });
});
