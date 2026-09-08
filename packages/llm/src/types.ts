/**
 * The Claude models this platform routes to. `docs/architecture.md`:
 * `claude-opus-5` is the default, `claude-sonnet-5` the cost-tuned bulk tier.
 * ZDR rules out `claude-fable-5*`.
 */
export const CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/**
 * A routing tier, decoupled from the concrete model id. `default` is the
 * high-quality path; `bulk` is the cheaper path for high-volume extraction.
 * Each provider maps a tier to one of its own model ids.
 */
export const TIERS = ['default', 'bulk'] as const;
export type Tier = (typeof TIERS)[number];

/** Overall token spend / thinking depth. Passed through to providers that support it. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type ThinkingMode = 'adaptive' | 'disabled';

/** Provider-agnostic chat turn. `content` is plain text — this platform never puts bodies in prompts as anything but text. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Emitted alongside every model call. Carries only counts, cost, and lineage —
 * never prompt or response text (`docs/architecture.md`: "the router logs
 * `{model, prompt_version, tokens, cost}` and never content"). The Langfuse sink
 * (#11) attaches here.
 */
export interface UsageRecord {
  provider: string;
  model: string;
  tier: Tier;
  /** Registry version of the system prompt used, or `null` for an ad-hoc `system` string. */
  promptVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  /** Pricing-table key the cost came from, or `null` when the model is unpriced (cost is then 0). */
  pricedFrom: string | null;
  latencyMs: number;
}

/** Pluggable usage sink. Langfuse wiring is #11 — this is just the seam. */
export type UsageSink = (record: UsageRecord) => void | Promise<void>;
