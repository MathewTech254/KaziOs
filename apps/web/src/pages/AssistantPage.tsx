import { useCallback, useState } from "react";
import { Bot, Send, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { api, getApiError } from "../lib/api";
import { Notice, LoadingBlock } from "../components/Feedback";
import { useEntitlements } from "../lib/entitlements";

/**
 * The AI assistant screen: "Ask your business".
 *
 * The browser's only job is to send the question and render the answer. Every figure in the
 * answer is computed on the server from the shop's own records (see the API's aiTools), so
 * what is shown here can be trusted as the books, not as a guess. The page reads the same
 * entitlements the API enforces, but that is a convenience: the server checks again on every
 * ask, so this cannot be the only gate.
 */

interface AssistantAnswer {
  question: string;
  tool: string;
  answer: string;
  data: Record<string, unknown>;
  aiPhrased: boolean;
}

interface Turn {
  id: string;
  question: string;
  answer: string;
  tool: string;
  aiPhrased: boolean;
}

const SUGGESTIONS = [
  "How much did we sell today?",
  "Which products are selling fastest this month?",
  "What am I running low on?",
  "Who owes the business money?",
  "Which products have not sold recently?",
];

const TOOL_LABELS: Record<string, string> = {
  sales_summary: "Sales",
  top_products: "Top products",
  low_stock: "Low stock",
  who_owes: "Who owes you",
  slow_movers: "Slow movers",
};

export function AssistantPage() {
  const { hasFeature, loading: entLoading } = useEntitlements();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");

  const planAllows = hasFeature("ai_assistant");

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (q.length < 2 || asking) return;
      setAsking(true);
      setError("");
      setQuestion("");
      try {
        const res = await api.post<{ data: AssistantAnswer }>("/ai/ask", { question: q });
        const a = res.data.data;
        setTurns(prev => [
          ...prev,
          {
            id: `${Date.now()}`,
            question: a.question,
            answer: a.answer,
            tool: a.tool,
            aiPhrased: a.aiPhrased,
          },
        ]);
      } catch (err) {
        setError(getApiError(err));
      } finally {
        setAsking(false);
      }
    },
    [asking]
  );

  if (entLoading) return <LoadingBlock label="Loading your assistant..." />;

  if (!planAllows) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Notice
          tone="error"
          title="The AI assistant is not on your plan"
          message="Upgrade to a plan that includes the AI assistant to ask questions about your sales, stock and customers in plain language."
        />
        <Link to="/pricing" className="kazi-button-primary mt-2 inline-flex px-4 py-2 text-sm">
          See plans
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-3xl flex-col p-4 sm:p-6">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h1 className="kazi-page-title text-xl font-semibold">Ask your business</h1>
          <p className="text-sm text-muted-foreground">
            Ask about your sales, stock and customers. Answers come straight from your own records.
          </p>
        </div>
      </div>

      {error && <Notice tone="error" title="Could not answer that" message={error} />}

      <div className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-border bg-surface-muted/40 p-4">
        {turns.length === 0 && !asking && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <Bot className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
            <p className="max-w-sm text-sm text-muted-foreground">
              Try one of these to get started:
            </p>
            <div className="flex max-w-md flex-wrap justify-center gap-2">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map(turn => (
          <div key={turn.id} className="space-y-2">
            <div className="flex justify-end">
              <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-sm text-accent-foreground">
                {turn.question}
              </p>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-background px-4 py-3">
                <p className="text-sm text-foreground">{turn.answer}</p>
                <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {TOOL_LABELS[turn.tool] || turn.tool} · computed from your records
                </p>
              </div>
            </div>
          </div>
        ))}

        {asking && <LoadingBlock label="Working it out from your records..." />}
      </div>

      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={e => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask about your business..."
          className="kazi-input flex-1"
          maxLength={500}
          aria-label="Ask a question about your business"
        />
        <button
          type="submit"
          disabled={asking || question.trim().length < 2}
          className="kazi-button-primary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Ask
        </button>
      </form>
    </div>
  );
}
