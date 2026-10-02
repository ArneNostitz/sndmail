import { describe, expect, it } from "vitest";
import { AiError, isTemporaryAiUnavailableError, isTemporaryProviderUnavailableMessage } from "./errors";

describe("temporary AI provider outage classification", () => {
  it("recognizes Gemini's 503 UNAVAILABLE response", () => {
    expect(isTemporaryProviderUnavailableMessage(
      '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
    )).toBe(true);
  });

  it("does not classify unrelated provider errors as temporary overload", () => {
    expect(isTemporaryProviderUnavailableMessage("401 authentication failed")).toBe(false);
    expect(isTemporaryProviderUnavailableMessage("503 backend error")).toBe(false);
    expect(isTemporaryProviderUnavailableMessage("429 RESOURCE_EXHAUSTED")).toBe(false);
  });

  it("only suppresses errors explicitly classified as temporary unavailability", () => {
    expect(isTemporaryAiUnavailableError(new AiError("TEMPORARY_UNAVAILABLE", "retry later"))).toBe(true);
    expect(isTemporaryAiUnavailableError(new AiError("NETWORK_ERROR", "connection failed"))).toBe(false);
    expect(isTemporaryAiUnavailableError(new Error("temporary outage"))).toBe(false);
  });
});
