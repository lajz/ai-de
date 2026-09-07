export class LlmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Fail-closed guard: the first-party Anthropic API is only used with Zero Data
 * Retention. Turning ZDR off is a config change that also points `baseURL` at an
 * endpoint (Bedrock, a proxy) that provides the retention guarantee by other
 * means.
 */
export class DataRetentionError extends LlmError {
  constructor() {
    super(
      'zeroDataRetention:false requires a non-Anthropic baseURL — the first-party ' +
        'Anthropic API in this platform is always used with ZDR',
    );
  }
}

/** `getPrompt(name, version)` found no matching registered prompt. */
export class PromptNotFoundError extends LlmError {
  constructor(
    readonly promptName: string,
    readonly version?: string,
  ) {
    super(
      version
        ? `no prompt "${promptName}" at version "${version}"`
        : `no prompt registered under "${promptName}"`,
    );
  }
}

/** A model string outside the supported `Model` union reached the router / pricing. */
export class UnknownModelError extends LlmError {
  constructor(readonly model: string) {
    super(`unknown model "${model}" — no pricing / routing entry`);
  }
}

/**
 * The model's structured response did not validate against the caller's schema
 * (or the model never produced the extraction tool call). Carries the Zod issues
 * for logging — never the offending content.
 */
export class StructuredOutputError extends LlmError {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

/** A non-2xx (or malformed) response from an OpenAI-compatible chat endpoint. */
export class ProviderRequestError extends LlmError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`provider request failed (${status}): ${message}`);
  }
}

/** An embedding backend returned vectors whose dimension is not what we store. */
export class EmbeddingDimError extends LlmError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`embedding dimension mismatch: expected ${expected}, got ${actual}`);
  }
}

/** A non-2xx (or malformed) response from the Voyage embeddings API. */
export class EmbeddingRequestError extends LlmError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`voyage embeddings request failed (${status}): ${message}`);
  }
}
