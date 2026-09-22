import OpenAI from "openai";

let _client: OpenAI | null = null;

export function getAiClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI_API_KEY is not configured");
  _client = new OpenAI({ apiKey, baseURL: process.env.AI_BASE_URL || undefined });
  return _client;
}

export interface ChatOptions {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export async function chatCompletion(options: ChatOptions): Promise<string> {
  const client = getAiClient();
  const completion = await client.chat.completions.create({
    model: options.model || process.env.AI_MODEL || "gpt-4o-mini",
    messages: options.messages as any,
    max_tokens: options.maxTokens ?? 4000,
    temperature: options.temperature ?? 0.1,
    response_format: options.jsonMode ? { type: "json_object" } : undefined,
  });
  return completion.choices[0].message.content || "";
}

export async function chatJson<T>(options: ChatOptions): Promise<T> {
  const raw = await chatCompletion({ ...options, jsonMode: true });
  return JSON.parse(raw) as T;
}

export async function embedText(text: string, model = "text-embedding-3-small"): Promise<number[]> {
  const client = getAiClient();
  const res = await client.embeddings.create({ model, input: text });
  return res.data[0].embedding;
}