import { setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";

/**
 * Global Agents SDK setup. The key comes from config (which comes from the environment).
 * Tracing to OpenAI's backend is disabled: incident data stays between us and the model call;
 * observability is Langfuse (Phase 6).
 */
export function configureAgentsSdk(openaiApiKey: string): void {
  setDefaultOpenAIKey(openaiApiKey);
  setTracingDisabled(true);
}
