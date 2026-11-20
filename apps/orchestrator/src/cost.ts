import type { ModelPricing } from "@incidentpulse/config";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
}

/** Minimal shape of the Agents SDK Usage object (kept loose so tests can pass plain objects). */
export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  requests?: number;
  inputTokensDetails?: Array<Record<string, unknown>> | Record<string, unknown>;
}

export function sumUsage(usages: readonly UsageLike[]): TokenUsage {
  const total: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 0 };
  for (const u of usages) {
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.requests += u.requests ?? 1;
    const details = Array.isArray(u.inputTokensDetails)
      ? u.inputTokensDetails
      : [u.inputTokensDetails ?? {}];
    for (const d of details) {
      const cached = d?.cached_tokens;
      if (typeof cached === "number") total.cachedInputTokens += cached;
    }
  }
  return total;
}

/** USD for the given usage. Cached input tokens are billed at the cached rate. */
export function costOf(usage: TokenUsage, pricing: ModelPricing): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return (
    (uncached * pricing.inputPerM +
      cached * pricing.cachedInputPerM +
      usage.outputTokens * pricing.outputPerM) /
    1_000_000
  );
}
