export class LlmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Fail-closed guard: the first-party Anthropic API is only ever used with Zero
 * Data Retention. Turning ZDR off is a config change that also points `baseURL`
 * at an endpoint (Bedrock, a proxy) providing the guarantee another way.
 */
export class DataRetentionError extends LlmError {
  constructor() {
    super('zeroDataRetention:false requires a non-Anthropic baseURL (Bedrock / proxy)');
  }
}

/** `getPrompt(name, version)` found no matching registered prompt. */
export class PromptNotFoundError extends LlmError {
  constructor(
    readonly promptName: string,
    readonly version?: string,
  ) {
    super(
      version ? `no prompt "${promptName}" at version "${version}"` : `no prompt "${promptName}"`,
    );
  }
}

/** A model string with no pricing-table entry reached a place that needs one. */
export class UnknownModelError extends LlmError {
  constructor(readonly model: string) {
    super(`unknown model "${model}" — no pricing entry`);
  }
}

/**
 * A structured response failed schema validation, or the model never produced
 * the extraction tool call. `issues` carries the Zod issues for logging — never
 * the offending content.
 */
export class StructuredOutputError extends LlmError {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

/** A non-2xx (or malformed) response from an HTTP model/embedding backend. Status only — no body. */
export class ProviderRequestError extends LlmError {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`provider request failed (${status}): ${detail}`);
  }
}

/** An embedding backend returned vectors of the wrong dimension. */
export class EmbeddingDimError extends LlmError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`embedding dimension mismatch: expected ${expected}, got ${actual}`);
  }
}
