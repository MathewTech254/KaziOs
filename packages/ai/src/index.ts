import OpenAI from "openai";

export type AIProvider = "openai" | "nvidia";

let _client: OpenAI | null = null;
let _provider: AIProvider | null = null;

// For testing: resets the cached client so the next getAiClient() call creates a new one.
export function __resetAiClientForTesting(): void {
  _client = null;
  _provider = null;
}

const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_DEFAULT_MODEL = "nvidia/nemotron-4-340b-reward";

export function resolveProvider(): AIProvider {
  const raw = process.env.AI_PROVIDER || "openai";
  if (raw !== "openai" && raw !== "nvidia") {
    throw new Error(`Unsupported AI_PROVIDER "${raw}". Use "openai" or "nvidia".`);
  }
  return raw;
}

export function getAiClient(): OpenAI {
  const provider = resolveProvider();

  // Recreate client if the provider changed between calls. Environment variables
  // are stable in a running process, but being defensive keeps tests deterministic.
  if (_client && _provider === provider) return _client;

  let apiKey: string;
  let baseURL: string | undefined;

  if (provider === "nvidia") {
    apiKey = process.env.NVIDIA_API_KEY || process.env.AI_API_KEY || "";
    baseURL = process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL;
    if (!apiKey) {
      throw new Error(
        "NVIDIA_API_KEY is not configured. Set NVIDIA_API_KEY (or AI_API_KEY) for the nvidia provider."
      );
    }
  } else {
    apiKey = process.env.AI_API_KEY || "";
    baseURL = process.env.AI_BASE_URL || undefined;
    if (!apiKey) {
      throw new Error("AI_API_KEY is not configured");
    }
  }

  _client = new OpenAI({ apiKey, baseURL });
  _provider = provider;
  return _client;
}

export function resolveModel(optionsModel?: string): string {
  const provider = resolveProvider();
  if (provider === "nvidia") {
    return optionsModel || process.env.NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL;
  }
  return optionsModel || process.env.AI_MODEL || "gpt-4o-mini";
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
    model: resolveModel(options.model),
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
