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

/**
 * The assistant orchestrator: User -> AI -> Intent -> Authorized Tool -> Business Data.
 *
 * The contract that makes this safe to put in front of a shop's money:
 *
 *   1. The model reads the question and chooses a tool and its parameters. It does no maths.
 *   2. The chosen tool computes the real figures from the database (see `aiTools.ts`).
 *   3. The model is asked only to turn those already-computed figures into a friendly
 *      sentence. Its system prompt forbids introducing any number that is not in the facts,
 *      so a confident-sounding hallucination is designed out rather than merely discouraged.
 *
 * When AI is not configured, step 3 is skipped and the deterministic summary from step 2 is
 * returned verbatim. The business still gets a correct, useful answer; only the polish is
 * missing. A missing key degrades the wording, never the truth.
 */

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
  const catalog = TOOL_CATALOG.map(t => `- ${t.name}: ${t.description}. params: ${t.params}`).join(
    "\n"
  );
  const historySection = history?.length
    ? [
        "",
        "Recent conversation:",
        ...history.map(h => `User: ${h.question}\nAssistant: ${h.answer}`),
      ]
    : [];
  return [
    "You route a shop owner's question to exactly one tool. Some tools are read-only analytics;",
    "others are actions that change records (send_invoice, void_invoice, record_payment).",
    "Available tools:",
    catalog,
    "",
    'Respond as JSON only: {"tool": string, "params": object}.',
    "Rules:",
    "- Choose the single best tool. If nothing fits, use sales_summary.",
    "- For action tools, never set confirm: true. Route with confirm: false first, present the",
    "  preview to the shop owner, and ask them to confirm explicitly before you set confirm: true.",
    "- period is one of: today, yesterday, this_week, this_month, last_month, all_time.",
    '- Infer a sensible period from the question ("today"->today, "this month"->this_month). Default today.',
    "- limit is a number 1-10 for top_products. days is a number for slow_movers.",
    "- Never invent tools or params. Output nothing but the JSON object.",
    ...historySection,
  ].join("\n");
}

/** Uses the model to pick the tool and params. Falls back to a sales summary on any trouble. */
async function routeQuestion(
  question: string,
  history: ConversationTurn[] = []
): Promise<RouteDecision> {
  const fallback: RouteDecision = { tool: "sales_summary", params: { period: "today" } };
  if (!aiAssistantEnabled()) return fallback;
  try {
    const decision = await chatJson<RouteDecision>({
      messages: [
        { role: "system", content: routingSystemPrompt(history) },
        { role: "user", content: question },
      ],
      temperature: 0,
    });
    const known = TOOL_CATALOG.some(t => t.name === decision?.tool);
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
    "You are given VERIFIED FACTS computed from the shop's own records.",
    "Write a short, warm, plain-English answer (1-3 sentences) that uses ONLY those facts.",
    "Never introduce, estimate or change any number. If a figure is not in the facts, do not state it.",
    "Do not give financial advice or predictions. You may end with one practical next step that follows from the facts.",
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
  const trimmed = question.trim();
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
