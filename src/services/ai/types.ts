export type AiProvider = "claude" | "openai" | "gemini" | "ollama" | "copilot";

export interface AiCompletionRequest {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
}

export interface AiProviderClient {
  complete(req: AiCompletionRequest): Promise<string>;
  testConnection(): Promise<boolean>;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  claude: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-3.8-flash",
  ollama: "llama3.2",
  copilot: "openai/gpt-4o-mini",
};

export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<Exclude<AiProvider, "ollama">, ModelOption[]> = {
  claude: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o Mini" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  gemini: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  copilot: [
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (Low)" },
    { id: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano (Low)" },
    { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini (High)" },
    { id: "openai/gpt-4o", label: "GPT-4o (High)" },
    { id: "openai/gpt-4.1", label: "GPT-4.1 (High)" },
  ],
};

/**
 * Model ids that the provider has shut down, mapped to the replacement Google
 * names in its deprecation table. A stored setting can outlive the model it
 * names — sndmail shipped the 2.5 preview ids for months after both were turned
 * off, so every Gemini call failed with a 404 until the user re-picked a model.
 * Applied wherever a stored model id is read, so the retired id is never sent.
 */
export const RETIRED_MODELS: Record<string, string> = {
  // Shut down 2025-11-18 / 2026-02-17; Google recommends 3.6 Flash, sndmail's default is newer
  "gemini-2.5-flash-preview-05-20": "gemini-3.8-flash",
  "gemini-2.5-flash-preview-09-25": "gemini-3.8-flash",
  // Shut down 2025-12-02
  "gemini-2.5-pro-preview-03-25": "gemini-3.1-pro-preview",
  "gemini-2.5-pro-preview-05-06": "gemini-3.1-pro-preview",
  "gemini-2.5-pro-preview-06-05": "gemini-3.1-pro-preview",
  // Shut down 2026-03-09
  "gemini-3-pro-preview": "gemini-3.1-pro-preview",
  // Shut down 2026-05-25 / 2026-03-31
  "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite-preview-09-2025": "gemini-3.5-flash-lite",
};

/** The model id to actually call for a stored setting: the replacement if the id has been retired. */
export function resolveModelId(modelId: string): string {
  return RETIRED_MODELS[modelId] ?? modelId;
}

export const MODEL_SETTINGS: Record<Exclude<AiProvider, "ollama">, string> = {
  claude: "claude_model",
  openai: "openai_model",
  gemini: "gemini_model",
  copilot: "copilot_model",
};
