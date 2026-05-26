import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export const anthropic = new Anthropic({
  apiKey: apiKey ?? "",
});

export function hasApiKey(): boolean {
  return Boolean(apiKey);
}
