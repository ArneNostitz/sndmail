import { describe, it, expect } from "vitest";
import { DEFAULT_MODELS, PROVIDER_MODELS, RETIRED_MODELS, resolveModelId } from "./types";

describe("resolveModelId", () => {
  it("passes a current id through untouched", () => {
    expect(resolveModelId("gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(resolveModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("maps the 2.5 preview ids snd used to ship to a live model", () => {
    expect(resolveModelId("gemini-2.5-flash-preview-05-20")).toBe("gemini-3.8-flash");
    expect(resolveModelId("gemini-2.5-pro-preview-05-06")).toBe("gemini-3.1-pro-preview");
  });

  it("never points a retired id at another retired id", () => {
    for (const replacement of Object.values(RETIRED_MODELS)) {
      expect(RETIRED_MODELS[replacement]).toBeUndefined();
    }
  });
});

describe("model lists", () => {
  it("offers no retired id and defaults to one that is offered", () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      for (const m of models) expect(RETIRED_MODELS[m.id]).toBeUndefined();
      expect(models.map((m) => m.id)).toContain(DEFAULT_MODELS[provider as keyof typeof PROVIDER_MODELS]);
    }
  });
});
