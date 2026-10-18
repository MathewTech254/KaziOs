import { askBusiness, aiAssistantEnabled } from "./aiAssistant";
import { runTool } from "./aiTools";

/**
 * The orchestrator test. The promise being proven is the safety contract: the language model
 * chooses a tool and words the answer, but it never supplies a number. When the model is
 * present, its prose is layered on top of figures the database already computed; when it is
 * absent or fails, the deterministic answer still ships. A shop therefore gets a correct
 * figure whether or not the AI layer is healthy.
 */

jest.mock("@kazios/ai", () => ({
  chatJson: jest.fn(),
  chatCompletion: jest.fn(),
}));

jest.mock("@kazios/config", () => ({
  isAiConfigured: jest.fn(() => true),
  loadConfig: jest.fn(() => ({})),
}));

jest.mock("./aiTools", () => ({
  runTool: jest.fn(),
  TOOL_CATALOG: [
    { name: "sales_summary", description: "sales", params: "period" },
    { name: "low_stock", description: "low stock", params: "none" },
    { name: "who_owes", description: "debts", params: "none" },
    { name: "top_products", description: "top", params: "period" },
    { name: "slow_movers", description: "slow", params: "days" },
    { name: "cash_position", description: "cash", params: "period" },
    { name: "expense_summary", description: "expenses", params: "period" },
    { name: "branch_stock", description: "stock", params: "none" },
  ],
}));

import { chatCompletion, chatJson } from "@kazios/ai";
import { isAiConfigured } from "@kazios/config";

const ORG = "org-1";

beforeEach(() => {
  jest.clearAllMocks();
  (isAiConfigured as jest.Mock).mockReturnValue(true);
});

describe("askBusiness", () => {
  it("routes the question to a tool, then phrases the tool's own facts", async () => {
    (chatJson as jest.Mock).mockResolvedValue({ tool: "low_stock", params: {} });
    (runTool as jest.Mock).mockResolvedValue({
      summary: "2 products at or below the reorder level: Milk (3 left); Sugar (1 left).",
      data: { count: 2, items: [] },
    });
    (chatCompletion as jest.Mock).mockResolvedValue(
      "You are low on Milk and Sugar — time to reorder."
    );

    const result = await askBusiness(ORG, "KES", "what am I low on?");

    expect(result.tool).toBe("low_stock");
    expect(result.answer).toBe("You are low on Milk and Sugar — time to reorder.");
    expect(result.aiPhrased).toBe(true);
    // The tool received the routed params, and the facts handed to the model are the tool's.
    expect(runTool).toHaveBeenCalledWith("low_stock", { organizationId: ORG, currency: "KES" }, {});
    const phrasedFacts = (chatCompletion as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(phrasedFacts).toContain("Milk (3 left)");
  });

  it("returns the deterministic summary when the model is not configured", async () => {
    (isAiConfigured as jest.Mock).mockReturnValue(false);
    (runTool as jest.Mock).mockResolvedValue({
      summary: "You took KES 60.49 across 3 sales today.",
      data: {},
    });

    const result = await askBusiness(ORG, "KES", "how much did we sell today?");

    expect(result.aiPhrased).toBe(false);
    expect(result.answer).toBe("You took KES 60.49 across 3 sales today.");
    // No routing or phrasing calls were made at all when AI is off.
    expect(chatJson).not.toHaveBeenCalled();
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(runTool).toHaveBeenCalled();
  });

  it("still answers when the model fails to route, defaulting to a sales summary", async () => {
    (chatJson as jest.Mock).mockRejectedValue(new Error("model down"));
    (runTool as jest.Mock).mockResolvedValue({
      summary: "No sales were recorded today.",
      data: {},
    });
    (chatCompletion as jest.Mock).mockResolvedValue("No sales yet today.");

    const result = await askBusiness(ORG, "KES", "anything today?");
    expect(result.tool).toBe("sales_summary");
    expect(result.answer).toBe("No sales yet today.");
  });

  it("keeps the deterministic answer if phrasing fails after a successful tool run", async () => {
    (chatJson as jest.Mock).mockResolvedValue({ tool: "who_owes", params: {} });
    (runTool as jest.Mock).mockResolvedValue({
      summary: "1 unpaid invoice totalling KES 75.00.",
      data: {},
    });
    (chatCompletion as jest.Mock).mockRejectedValue(new Error("timeout"));

    const result = await askBusiness(ORG, "KES", "who owes me?");
    expect(result.aiPhrased).toBe(false);
    expect(result.answer).toBe("1 unpaid invoice totalling KES 75.00.");
  });

  it("ignores an unknown tool the model invents and falls back to sales_summary", async () => {
    (chatJson as jest.Mock).mockResolvedValue({ tool: "hack_the_planet", params: {} });
    (runTool as jest.Mock).mockResolvedValue({
      summary: "No sales were recorded today.",
      data: {},
    });
    (chatCompletion as jest.Mock).mockResolvedValue("Here is your day.");

    const result = await askBusiness(ORG, "KES", "how is business?");
    expect(result.tool).toBe("sales_summary");
  });

  it("rejects an empty or over-long question before spending anything", async () => {
    await expect(askBusiness(ORG, "KES", " ")).rejects.toMatchObject({ statusCode: 400 });
    await expect(askBusiness(ORG, "KES", "x".repeat(501))).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(chatJson).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe("aiAssistantEnabled", () => {
  it("reports true when a key is configured", () => {
    (isAiConfigured as jest.Mock).mockReturnValue(true);
    expect(aiAssistantEnabled()).toBe(true);
  });
  it("reports false, never throws, when config cannot be read", () => {
    (isAiConfigured as jest.Mock).mockImplementation(() => {
      throw new Error("no env");
    });
    expect(aiAssistantEnabled()).toBe(false);
  });
});
