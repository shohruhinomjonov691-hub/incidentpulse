import { type Model, type ModelRequest, type ModelResponse, Usage } from "@openai/agents";

/** A model that replays scripted responses and records what it was asked. No network, no cost. */
export class ScriptedModel implements Model {
  requests: ModelRequest[] = [];
  private readonly script: Array<(request: ModelRequest) => ModelResponse>;

  constructor(script: Array<(request: ModelRequest) => ModelResponse>) {
    this.script = script;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedModel: script exhausted");
    return next(request);
  }

  // biome-ignore lint/correctness/useYield: streaming is not used by these tests
  async *getStreamedResponse(): AsyncGenerator<never> {
    throw new Error("streaming not supported in ScriptedModel");
  }

  /** Everything the model was shown, as one string (for "did X reach the model?" assertions). */
  seen(): string {
    return JSON.stringify(this.requests.map((r) => [r.systemInstructions, r.input]));
  }
}

export const usage = (input: number, output: number) =>
  new Usage({ requests: 1, inputTokens: input, outputTokens: output, totalTokens: input + output });

export const toolCall =
  (callId: string, name: string, args: unknown, tokens: [number, number] = [1000, 100]) =>
  (): ModelResponse => ({
    usage: usage(...tokens),
    output: [
      { type: "function_call", callId, name, arguments: JSON.stringify(args), status: "completed" },
    ],
  });

export const finalText =
  (text: string, tokens: [number, number] = [1500, 200]) =>
  (): ModelResponse => ({
    usage: usage(...tokens),
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
  });
