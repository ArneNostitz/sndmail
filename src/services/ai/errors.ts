export type AiErrorCode =
  | "NOT_CONFIGURED"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "TEMPORARY_UNAVAILABLE"
  | "NETWORK_ERROR";

export class AiError extends Error {
  code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

/** Identifies temporary provider overloads without suppressing other AI errors. */
export function isTemporaryAiUnavailableError(error: unknown): boolean {
  return error instanceof AiError && error.code === "TEMPORARY_UNAVAILABLE";
}

export function isTemporaryProviderUnavailableMessage(message: string): boolean {
  return /\b503\b/.test(message) && /\bUNAVAILABLE\b/.test(message);
}
