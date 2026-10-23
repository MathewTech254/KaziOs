let captureCreate: jest.Mock;
let captureOptions: any;

jest.mock("openai", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation((options: any) => {
      captureOptions = options;
      return {
        chat: {
          completions: {
            get create() {
              return captureCreate;
            },
          },
        },
      };
    }),
  };
});

import OpenAI from "openai";
import {
  chatCompletion,
  chatJson,
  getAiClient,
  resolveModel,
  resolveProvider,
  type AIProvider,
  __resetAiClientForTesting,
} from "./index";

const MockedOpenAI = OpenAI as jest.Mock;

function resetEnv() {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_MODEL;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_BASE_URL;
  delete process.env.NVIDIA_MODEL;
}

beforeEach(() => {
  resetEnv();
  __resetAiClientForTesting();
  jest.clearAllMocks();
  captureCreate = jest.fn().mockResolvedValue({
    choices: [{ message: { content: "test response" } }],
  });
  captureOptions = undefined;
});

afterEach(() => {
  resetEnv();
});

describe("resolveProvider", () => {
  it("defaults to openai when AI_PROVIDER is unset", () => {
    expect(resolveProvider()).toBe("openai");
  });

  it("returns openai when AI_PROVIDER=openai", () => {
    process.env.AI_PROVIDER = "openai";
    expect(resolveProvider()).toBe("openai");
  });

  it("returns nvidia when AI_PROVIDER=nvidia", () => {
    process.env.AI_PROVIDER = "nvidia";
    expect(resolveProvider()).toBe("nvidia");
  });

  it.each(["anthropic", "groq", "cohere", "INVALID"])(
    "throws for unsupported provider %s",
    (provider: string) => {
      process.env.AI_PROVIDER = provider;
      expect(() => resolveProvider()).toThrow(
        `Unsupported AI_PROVIDER "${provider}". Use "openai" or "nvidia".`
      );
    }
  );
});

describe("resolveModel", () => {
  it("uses AI_MODEL default gpt-4o-mini for openai", () => {
    process.env.AI_PROVIDER = "openai";
    expect(resolveModel()).toBe("gpt-4o-mini");
  });

  it("uses AI_MODEL when set for openai", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_MODEL = "gpt-4o";
    expect(resolveModel()).toBe("gpt-4o");
  });

  it("uses options.model override for openai", () => {
    process.env.AI_PROVIDER = "openai";
    expect(resolveModel("custom-model")).toBe("custom-model");
  });

  it("uses NVIDIA_DEFAULT_MODEL for nvidia when unset", () => {
    process.env.AI_PROVIDER = "nvidia";
    expect(resolveModel()).toBe("nvidia/nemotron-4-340b-reward");
  });

  it("uses NVIDIA_MODEL when set for nvidia", () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_MODEL = "meta/llama-3.1-405b-instruct";
    expect(resolveModel()).toBe("meta/llama-3.1-405b-instruct");
  });

  it("uses options.model override for nvidia", () => {
    process.env.AI_PROVIDER = "nvidia";
    expect(resolveModel("custom-nvidia-model")).toBe("custom-nvidia-model");
  });
});

describe("getAiClient", () => {
  it("throws AI_API_KEY not configured for openai with no key", () => {
    process.env.AI_PROVIDER = "openai";
    expect(() => getAiClient()).toThrow("AI_API_KEY is not configured");
  });

  it("throws NVIDIA_API_KEY not configured for nvidia with no key", () => {
    process.env.AI_PROVIDER = "nvidia";
    expect(() => getAiClient()).toThrow(
      "NVIDIA_API_KEY is not configured"
    );
  });

  it("creates OpenAI client with AI_API_KEY and no baseURL for openai", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test-123";
    const client = getAiClient();
    expect(client).toBeDefined();
    expect(captureOptions).toMatchObject({
      apiKey: "sk-test-123",
      baseURL: undefined,
    });
  });

  it("creates OpenAI client with AI_BASE_URL for openai", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test-123";
    process.env.AI_BASE_URL = "https://custom.openai.example.com/v1";
    const client = getAiClient();
    expect(client).toBeDefined();
    expect(captureOptions).toMatchObject({
      apiKey: "sk-test-123",
      baseURL: "https://custom.openai.example.com/v1",
    });
  });

  it("creates OpenAI client with NVIDIA_API_KEY and default base URL for nvidia", () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "nvapi-test-123";
    const client = getAiClient();
    expect(client).toBeDefined();
    expect(captureOptions).toMatchObject({
      apiKey: "nvapi-test-123",
      baseURL: "https://integrate.api.nvidia.com/v1",
    });
  });

  it("uses NVIDIA_BASE_URL when set for nvidia", () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "nvapi-test-123";
    process.env.NVIDIA_BASE_URL = "https://custom.nvidia.example.com/v1";
    const client = getAiClient();
    expect(client).toBeDefined();
    expect(captureOptions).toMatchObject({
      apiKey: "nvapi-test-123",
      baseURL: "https://custom.nvidia.example.com/v1",
    });
  });

  it("falls back to AI_API_KEY for nvidia when NVIDIA_API_KEY is unset", () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.AI_API_KEY = "sk-test-123";
    const client = getAiClient();
    expect(client).toBeDefined();
    expect(captureOptions).toMatchObject({
      apiKey: "sk-test-123",
      baseURL: "https://integrate.api.nvidia.com/v1",
    });
  });

  it("caches the client for the same provider", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test-123";
    const first = getAiClient();
    const second = getAiClient();
    expect(first).toBe(second);
    expect(MockedOpenAI).toHaveBeenCalledTimes(1);
  });

  it("recreates the client when provider changes", () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test-123";
    const first = getAiClient();

    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "nvapi-test-123";
    const second = getAiClient();

    expect(first).not.toBe(second);
    expect(MockedOpenAI).toHaveBeenCalledTimes(2);
  });
});

describe("chatCompletion", () => {
  it("sends the right model for openai", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test-123";
    captureCreate.mockResolvedValue({
      choices: [{ message: { content: "Hello!" } }],
    });

    const result = await chatCompletion({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result).toBe("Hello!");
    expect(captureCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
      })
    );
  });

  it("sends the right model for nvidia", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "nvapi-test-123";
    captureCreate.mockResolvedValue({
      choices: [{ message: { content: "Hello!" } }],
    });

    const result = await chatCompletion({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result).toBe("Hello!");
    expect(captureCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "nvidia/nemotron-4-340b-reward",
      })
    );
  });

  it("uses options.model override", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test-123";
    captureCreate.mockResolvedValue({
      choices: [{ message: { content: "OK" } }],
    });

    await chatCompletion({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4o",
    });

    expect(captureCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o",
      })
    );
  });
});

describe("chatJson", () => {
  it("parses JSON response", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test-123";
    captureCreate.mockResolvedValue({
      choices: [{ message: { content: '{"answer":42}' } }],
    });

    const result = await chatJson<{ answer: number }>({
      messages: [{ role: "user", content: "What is the answer?" }],
    });

    expect(result).toEqual({ answer: 42 });
  });
});