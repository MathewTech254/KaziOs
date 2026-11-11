import { chatCompletion, chatJson } from "@kazios/ai";
import { isAiConfigured, loadConfig } from "@kazios/config";
import { AppError } from "../middleware/errorHandler";
import { getRedis } from "../lib/redis";
import { runTool, TOOL_CATALOG, type ToolContext, type ToolParams } from "./aiTools";

interface ConversationTurn {
  question: string;
  answer: string;
  tool: string;
  ts: string;
}

const CONVERSATION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_CONVERSATION_TURNS = 5;

async function getConversationTurns(sessionId: string): Promise<ConversationTurn[]> {
  try {
    const redis = getRedis();
    if (!redis) return [];
    const raw = await redis.get(`conv:${sessionId}`);
    if (!raw) return [];
    return JSON.parse(raw) as ConversationTurn[];
  } catch {
    // Redis unavailable or unparseable: no memory for this session.
    return [];
  }
}

async function appendConversationTurn(sessionId: string, turn: ConversationTurn): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const key = `conv:${sessionId}`;
    const raw = await redis.get(key);
    const turns: ConversationTurn[] = raw ? (JSON.parse(raw) as ConversationTurn[]) : [];
    turns.push(turn);
    const trimmed = turns.slice(-MAX_CONVERSATION_TURNS);
    await redis.set(key, JSON.stringify(trimmed), "EX", CONVERSATION_TTL_SECONDS);
  } catch {
    // Conversation memory is best-effort; never break the answer because of it.
  }
}

/** Common misspellings and fragments the model should not have to guess at. */
const TYPO_MAP: Record<string, string> = {
  salse: "sales",
  sale: "sales",
  revanue: "revenue",
  revnue: "revenue",
  incom: "income",
  stok: "stock",
  invce: "invoice",
  invoce: "invoice",
  custmer: "customer",
  cust: "customer",
  paymnt: "payment",
  paymet: "payment",
  expenes: "expense",
  availble: "available",
  availbale: "available",
  owe: "owes",
  debt: "owes",
  best: "top",
  till: "cash",
};

/**
 * Cleans up a raw user question before routing: lowercases, collapses whitespace,
 * fixes common typos, and normalises period words. This lets the assistant give a
 * useful answer even from a rough, typo-ridden or fragmented query.
 */
export function normalizeQuestion(question: string): string {
  let q = question.toLowerCase().trim();
  q = q.replace(/\s+/g, " ");
  q = q
    .split(" ")
    .map((w) => TYPO_MAP[w] ?? w)
    .join(" ");
  q = q
    .replace(/\bthis week\b/g, "this_week")
    .replace(/\blast week\b/g, "last_week")
    .replace(/\bthis month\b/g, "this_month")
    .replace(/\blast month\b/g, "last_month")
    .replace(/\ball time\b/g, "all_time")
    .replace(/\byesterday\b/g, "yesterday")
    .replace(/\btoday\b/g, "today");
  return q;
}

/**
 * Keyword-based pre-routing for common patterns. Runs before the model so that
 * obvious questions (\"low stock\", \"who owes me\") always get the right tool even
 * when the model struggles with JSON output on some providers.
 */
function keywordRoute(question: string): RouteDecision | null {
  const q = question.toLowerCase();

  const patterns: Array<[RegExp, RouteDecision]> = [
    [/\b(low|running.?out|reorder|need.?stock|stock.?level)\b/, { tool: "low_stock", params: {} }],
    [/\b(who.?owes|unpaid|outstanding|debt|money.?owed|owes.?me)\b/, { tool: "who_owes", params: {} }],
    [/\b(lowest|deepest|minimum|top.?down)\b/, { tool: "lowest_stock", params: {} }],
    [/\b(top.?product|best.?selling|best.?product|top.?selling)\b/, { tool: "top_products", params: { limit: 5 } }],
    [/\b(slow.?mover|not.?selling|stale.?stock|dead.?stock)\b/, { tool: "slow_movers", params: { days: 30 } }],
    [/\b(summariz|total|payment|receiv\w*)\b/i, { tool: "payment_summary", params: { period: "today" } }],
    [/\b(cash|till|money.?collected|payments.?received)\b/, { tool: "cash_position", params: { period: "today" } }],
    [/\b(expense|spending|spent|where.?did.?money.?go)\b/, { tool: "expense_summary", params: { period: "today" } }],
    [/\b(branch.?stock|stock.?by.?branch|inventory.?by.?location)\b/, { tool: "branch_stock", params: {} }],
    [/\b(sales|revenue|income|sold|how.?much.?sell|how.?much.?sale)\b/, { tool: "sales_summary", params: { period: "today" } }],
  ];

  for (const [regex, decision] of patterns) {
    if (regex.test(q)) return decision;
  }
  return null;
}

/** The platform context the model needs to understand what KaziOS can do. */
const PLATFORM_CONTEXT = [
  "You are the AI assistant inside KaziOS, a shop-management platform for small businesses.",
  "You answer questions about the shop's own sales, stock, customers, invoices, expenses and cash.",
  "Every figure you give is computed from the shop's real database records by a tool — you never do maths yourself.",
  "If you do not know the answer or no tool fits the question, say so honestly instead of guessing.",
].join(" ");

export interface AssistantAnswer {
  question: string;
  /** Which tool answered, so the client can label the response. */
  tool: string;
  /** The model's prose answer, or the deterministic summary when AI is off. */
  answer: string;
  /** The structured figures behind the answer. */
  data: Record<string, unknown>;
  /** True when the wording came from the model rather than the deterministic summary. */
  aiPhrased: boolean;
}

interface RouteDecision {
  tool: string;
  params: ToolParams;
}

/** True when a usable AI key is present, so callers can decide whether to offer the feature. */
export function aiAssistantEnabled(): boolean {
  try {
    return isAiConfigured(loadConfig());
  } catch {
    return false;
  }
}

function routingSystemPrompt(history?: ConversationTurn[]): string {
  const catalog = TOOL_CATALOG.map(
    (t) => `- ${t.name}: ${t.description}. Example: "${t.example}". params: ${t.params}`,
  ).join("\n");
  const historySection = history?.length
    ? [
        "",
        "Recent conversation:",
        ...history.map((h) => `User: ${h.question}\nAssistant: ${h.answer}`),
      ]
    : [];
  return [
    PLATFORM_CONTEXT,
    "",
    "Your job is to read the shop owner's question and pick exactly one tool to answer it.",
    "Available tools:",
    catalog,
    "",
    "There is also a special tool called `general`. Use it when the question is a greeting,",
    "a general \"what can you do\" question, or when no analytics tool fits the question.",
    "general needs no params.",
    "",
    "Respond as JSON only: {\"tool\": string, \"params\": object}.",
    "Rules:",
    "- Choose the single best tool for the question. If nothing fits, use `general`.",
    "- Do not default every question to sales_summary. Read the question carefully.",
    '- Infer a sensible period from the question ("today" -> today, "this month" -> this_month, "yesterday" -> yesterday). Default today.',
    "- limit is a number 1-10 for top_products. days is a number for slow_movers.",
    "- Never invent tools or params. Output nothing but the JSON object.",
    "- The shop owner may write broken English, typos or fragments. Do your best to match intent.",
    ...historySection,
  ].join("\n");
}

/** Uses the model to pick the tool and params. Falls back to a sales summary on any trouble. */
async function routeQuestion(
  question: string,
  history: ConversationTurn[] = []
): Promise<RouteDecision> {
  const fallback: RouteDecision = { tool: "general", params: {} };
  if (!aiAssistantEnabled()) return fallback;

  // Keyword pre-routing: handle obvious patterns without hitting the model,
  // so they always work even when the model struggles with JSON output.
  const keyword = keywordRoute(question);
  if (keyword) return keyword;

  try {
    const normalized = normalizeQuestion(question);
    const decision = await chatJson<RouteDecision>({
      messages: [
        { role: "system", content: routingSystemPrompt(history) },
        { role: "user", content: normalized },
      ],
      temperature: 0,
    });
    const known = TOOL_CATALOG.some((t) => t.name === decision?.tool);
    if (!decision || !known) return fallback;
    return { tool: decision.tool, params: decision.params || {} };
  } catch {
    // A routing failure is not the customer's fault and must not lose them their answer.
    return fallback;
  }
}

function phrasingSystemPrompt(): string {
  return [
    "You are the friendly business assistant inside KaziOS, speaking to a shop owner.",
    "You are given VERIFIED FACTS computed from the shop's own records by a tool.",
    "Write a short, warm, plain-English answer (1-3 sentences) that uses ONLY those facts.",
    "Never introduce, estimate or change any number. If a figure is not in the facts, do not state it.",
    "If the facts say there is no data, say so plainly and offer one practical next step.",
    "Do not give financial advice or predictions.",
    "Vary your wording — do not repeat the same sentence for every question.",
  ].join("\n");
}

/** Turns already-computed facts into prose. Returns the deterministic summary if AI is off. */
async function phraseAnswer(
  question: string,
  facts: string,
  deterministic: string
): Promise<{ answer: string; aiPhrased: boolean }> {
  if (!aiAssistantEnabled()) return { answer: deterministic, aiPhrased: false };
  try {
    const answer = await chatCompletion({
      messages: [
        { role: "system", content: phrasingSystemPrompt() },
        { role: "user", content: `Question: ${question}\n\nVerified facts:\n${facts}` },
      ],
      temperature: 0.3,
      maxTokens: 220,
    });
    const trimmed = (answer || "").trim();
    return trimmed
      ? { answer: trimmed, aiPhrased: true }
      : { answer: deterministic, aiPhrased: false };
  } catch {
    return { answer: deterministic, aiPhrased: false };
  }
}

/**
 * Answers one natural-language business question for one organization.
 *
 * The organizationId is always taken from the authenticated request by the caller and is the
 * only thing that scopes every query here, so a question can never reach another shop's data.
 */
export async function askBusiness(
  organizationId: string,
  currency: string,
  question: string,
  permissions: string[] = [],
  sessionId?: string
): Promise<AssistantAnswer> {
  const normalized = normalizeQuestion(question);
  const trimmed = normalized.trim();
  if (trimmed.length < 2) {
    throw new AppError(
      400,
      "Ask a question about your business, for example: how much did we sell today?"
    );
  }
  if (trimmed.length > 500) {
    throw new AppError(400, "That question is too long. Please keep it under 500 characters.");
  }

  const ctx: ToolContext = { organizationId, currency, permissions };

  // Retrieve recent conversation history so follow-up questions ("what about yesterday?")
  // can be resolved in the context of the shop's own chat.
  const history = sessionId ? await getConversationTurns(sessionId) : [];
  const route = await routeQuestion(trimmed, history);

  // When the model could not match any tool, give an honest general response instead of
  // forcing an irrelevant sales figure.
  if (route.tool === "general") {
    const answer =
      "I can help you with sales, top products, low stock, who owes you money, slow movers, cash position, expenses and branch stock. Try asking something like \"how much did we sell today?\" or \"what am I running low on?\".";
    const assistantAnswer: AssistantAnswer = {
      question: trimmed,
      tool: "general",
      answer,
      data: {},
      aiPhrased: false,
    };
    if (sessionId) {
      await appendConversationTurn(sessionId, {
        question: trimmed,
        answer,
        tool: "general",
        ts: new Date().toISOString(),
      });
    }
    return assistantAnswer;
  }

  const result = await runTool(route.tool, ctx, route.params);
  const { answer, aiPhrased } = await phraseAnswer(trimmed, result.summary, result.summary);

  const assistantAnswer: AssistantAnswer = {
    question: trimmed,
    tool: route.tool,
    answer,
    data: result.data,
    aiPhrased,
  };

  // Persist the turn for future follow-ups, best-effort only.
  if (sessionId) {
    await appendConversationTurn(sessionId, {
      question: trimmed,
      answer,
      tool: route.tool,
      ts: new Date().toISOString(),
    });
  }

  return assistantAnswer;
}
