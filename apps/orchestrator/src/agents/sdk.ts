import type { ModelPricing } from "@incidentpulse/config";
import { AgentsError, type Model, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { costOf, sumUsage } from "../cost.ts";
import type { WeeklyBudget } from "../weekly-budget.ts";

/**
 * Global Agents SDK setup. The key comes from config (which comes from the environment).
 * Tracing to OpenAI's backend is disabled: incident data stays between us and the model call;
 * observability is Langfuse (Phase 6).
 */
export function configureAgentsSdk(openaiApiKey: string): void {
  setDefaultOpenAIKey(openaiApiKey);
  setTracingDisabled(true);
}

/** Raised before an API call when there is no weekly balance left. */
export class WeeklyBudgetExhausted extends AgentsError {
  incidentStageCostUsd?: number;
  readonly spentUsd: number;
  constructor(spentUsd: number) {
    super("Weekly LLM budget exhausted");
    this.spentUsd = spentUsd;
  }
}

/**
 * Queue one provider request at a time within the worker. Tool calls in parallel specialists
 * still overlap. Charge the response before another specialist can start a model request.
 */
export function limitModelSpend(
  model: Model,
  options: {
    budget: WeeklyBudget;
    limitUsd: number;
    pricing: ModelPricing;
    now?: () => Date;
  },
): Model {
  const now = options.now ?? (() => new Date());
  let tail = Promise.resolve();
  return {
    getResponse(request) {
      const next = tail.then(async () => {
        const at = now();
        const spent = await options.budget.spentUsd(at);
        if (spent >= options.limitUsd) throw new WeeklyBudgetExhausted(spent);
        const response = await model.getResponse(request);
        await options.budget.addUsd(costOf(sumUsage([response.usage]), options.pricing), at);
        return response;
      });
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    getStreamedResponse() {
      throw new Error("Incident investigations use non-streaming responses");
    },
  };
}
