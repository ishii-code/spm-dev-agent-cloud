import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

export const openai = new OpenAI({
  apiKey: apiKey ?? "",
});

export function hasOpenAiKey(): boolean {
  return Boolean(apiKey);
}
