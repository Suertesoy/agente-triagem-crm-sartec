// Fake of @anthropic-ai/sdk — records every call so tests can assert whether
// the Anthropic API was reached, without any real network call.
export let callCount = 0;
export const calls = [];

export function resetAnthropicSpy() {
  callCount = 0;
  calls.length = 0;
}

export default class Anthropic {
  constructor(_opts) {}

  get messages() {
    return {
      create: async (params) => {
        callCount++;
        calls.push(params);
        return {
          content: [{ type: "text", text: "Perfeito, informação registrada. Em que posso te ajudar?" }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    };
  }
}
