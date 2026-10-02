import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Plus, Receipt, RotateCcw, Search, Trash2, Wallet } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { useCurrency, formatMoney } from "../lib/currency";
import { useAuth } from "../contexts/AuthContext";
import { Notice, LoadingBlock, EmptyRow } from "../components/Feedback";

interface ExpenseCategory {
  id: string;
  name: string;
  description?: string | null;
  accountCode?: string | null;
  _count?: { expenses: number };
}

interface Expense {
  id: string;
  vendorName: string;
  amount: number;
  currency: string;
  expenseDate: string;
  paymentMethod: string;
  receiptNumber?: string | null;
  notes?: string | null;
  status: string;
  voidReason?: string | null;
  category?: ExpenseCategory | null;
  supplier?: { id: string; name: string } | null;
  branch?: { id: string; name: string } | null;
  recordedBy?: { id: string; name: string } | null;
  approvedBy?: { id: string; name: string } | null;
}

interface Summary {
  totalAmount: number;
  count: number;
  pendingCount: number;
  byCategory: { categoryId: string | null; name: string; amount: number; count: number }[];
  byPaymentMethod: { paymentMethod: string; amount: number; count: number }[];
}

/**
 * M-PESA sits alongside cash and bank rather than being hidden in an "other" list,
 * because for most small Kenyan businesses it is the rail they actually settle on, and
 * a report that cannot separate it makes the cost of moving money impossible to see.
 */
const PAYMENT_METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "MPESA", label: "M-PESA" },
  { value: "BANK", label: "Bank transfer" },
  { value: "PAYSTACK", label: "Paystack" },
  { value: "CARD", label: "Card" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CREDIT", label: "Credit (not yet paid)" },
  { value: "OTHER", label: "Other" },
];

const todayIso = () => new Date().toISOString().slice(0, 10);

const emptyForm = {
  vendorName: "",
  amount: "",
  expenseDate: todayIso(),
  paymentMethod: "CASH",
  categoryId: "",
  receiptNumber: "",
  notes: "",
};

export function ExpensesPage() {
  const { hasPermission } = useAuth();
  const currency = useCurrency();

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [voidTarget, setVoidTarget] = useState<Expense | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const canView = hasPermission("expenses.view");
  const canCreate = hasPermission("expenses.create");
  const canApprove = hasPermission("expenses.approve");

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter) params.set("status", statusFilter);
      // An explicit null means "everything that is not voided", which is what a user
      // looking at current spend actually wants. Voided rows stay reachable behind the
      // filter, because they are part of the record rather than something to hide.
      if (statusFilter === "ACTIVE") params.delete("status");

      const [list, cats, totals] = await Promise.all([
        api.get(`/expenses?${params.toString()}`),
        api.get("/expenses/categories"),
        api.get("/expenses/summary"),
      ]);
      setExpenses(list.data.data || []);
      setCategories(cats.data.data || []);
      setSummary(totals.data.data || null);
      setError("");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, [canView, search, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visible = useMemo(
    () => (statusFilter === "ACTIVE" ? expenses.filter(e => e.status !== "VOIDED") : expenses),
    [expenses, statusFilter]
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      // Sent as an ISO instant because the API validates a full timestamp, while the
      // date input gives a plain calendar day.
      await api.post("/expenses", {
        vendorName: form.vendorName.trim(),
        amount,
        expenseDate: new Date(`${form.expenseDate}T12:00:00`).toISOString(),
        paymentMethod: form.paymentMethod,
        categoryId: form.categoryId || null,
        receiptNumber: form.receiptNumber.trim() || null,
        notes: form.notes.trim() || null,
      });
      setNotice(`${form.vendorName.trim()} was recorded and posted to your accounts.`);
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmVoid = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!voidTarget) return;
    setSaving(true);
    setError("");
    try {
      await api.post(`/expenses/${voidTarget.id}/void`, { reason: voidReason.trim() });
      setNotice(
        `${voidTarget.vendorName} was voided. A reversing entry was posted to your accounts.`
      );
      setVoidTarget(null);
      setVoidReason("");
      await load();
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (!canView) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="kazi-card max-w-md p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-10 w-10 text-danger" />
          <h1 className="kazi-page-title mb-2">Not available</h1>
          <p className="text-sm text-muted-foreground">
            Your role does not include permission to view expenses. Ask an owner or administrator to
            grant it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="kazi-page-title">Expenses</h1>
          <p className="kazi-page-subtitle">
            Every expense is posted to your accounts, so your profit figure is real.
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={() => setShowForm(value => !value)}
            className="kazi-button-primary px-4 text-sm"
          >
            <Plus className="h-4 w-4" />
            {showForm ? "Cancel" : "Record expense"}
          </button>
        )}
      </div>

      {error && <Notice tone="error" title="That did not work" message={error} />}
      {notice && <Notice tone="success" title="Done" message={notice} />}

      {summary && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Total recorded</p>
            <p className="kazi-stat-value mt-1">{formatMoney(summary.totalAmount, currency)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.count} {summary.count === 1 ? "expense" : "expenses"}, excluding voided
            </p>
          </div>
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Largest category</p>
            <p className="kazi-stat-value mt-1">{summary.byCategory[0]?.name ?? "None yet"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.byCategory[0]
                ? formatMoney(summary.byCategory[0].amount, currency)
                : "Record an expense to see this"}
            </p>
          </div>
          <div className="kazi-stat-card">
            <p className="kazi-stat-label">Most used rail</p>
            <p className="kazi-stat-value mt-1">
              {summary.byPaymentMethod[0]
                ? (PAYMENT_METHODS.find(m => m.value === summary.byPaymentMethod[0].paymentMethod)
                    ?.label ?? summary.byPaymentMethod[0].paymentMethod)
                : "None yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across {summary.byPaymentMethod.length} payment methods
            </p>
          </div>
        </div>
      )}

      {showForm && canCreate && (
        <form onSubmit={submit} className="kazi-card mb-6 p-6">
          <h2 className="mb-4 text-lg font-semibold text-foreground">New expense</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="exp-vendor">
                Paid to
              </label>
              <input
                id="exp-vendor"
                value={form.vendorName}
                onChange={e => setForm({ ...form, vendorName: e.target.value })}
                className="kazi-input"
                placeholder="Landlord, Kenya Power, fuel station…"
                required
                minLength={2}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="exp-amount">
                Amount ({currency})
              </label>
              <input
                id="exp-amount"
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                className="kazi-input"
                placeholder="0.00"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="exp-date">
                Date
              </label>
              <input
                id="exp-date"
                type="date"
                value={form.expenseDate}
                onChange={e => setForm({ ...form, expenseDate: e.target.value })}
                className="kazi-input"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="exp-method">
                Paid by
              </label>
              <select
                id="exp-method"
                value={form.paymentMethod}
                onChange={e => setForm({ ...form, paymentMethod: e.target.value })}
                className="kazi-input"
              >
                {PAYMENT_METHODS.map(method => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="exp-category">
                Category
              </label>
              <select
                id="exp-category"
                value={form.categoryId}
                onChange={e => setForm({ ...form, categoryId: e.target.value })}
                className="kazi-input"
              >
                <option value="">Uncategorised</option>
                {categories.map(category => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="exp-receipt">
                Receipt number
              </label>
              <input
                id="exp-receipt"
                value={form.receiptNumber}
                onChange={e => setForm({ ...form, receiptNumber: e.target.value })}
                className="kazi-input"
                placeholder="Optional"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm text-muted-foreground" htmlFor="exp-notes">
                Notes
              </label>
              <textarea
                id="exp-notes"
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className="kazi-input resize-none"
                placeholder="What this was for"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="kazi-button-primary px-4 py-2 text-sm"
            >
              <Wallet className="h-4 w-4" />
              {saving ? "Recording…" : "Record and post to accounts"}
            </button>
            <p className="text-xs text-muted-foreground">
              Posts a balanced entry to your ledger straight away.
            </p>
          </div>
        </form>
      )}

      <div className="kazi-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="kazi-input pl-9"
              placeholder="Search by name, note or receipt"
              aria-label="Search expenses"
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="kazi-input w-auto"
            aria-label="Filter by status"
          >
            <option value="">All records</option>
            <option value="ACTIVE">Not voided</option>
            <option value="RECORDED">Recorded</option>
            <option value="VOIDED">Voided</option>
          </select>
        </div>

        {loading ? (
          <LoadingBlock label="Loading expenses…" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Paid to</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Method</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  {canApprove && <th className="px-4 py-3 font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {!visible.length ? (
                  <EmptyRow
                    colSpan={canApprove ? 6 : 5}
                    message="No expenses recorded yet. Use Record expense to enter your first one."
                  />
                ) : (
                  visible.map(expense => {
                    const voided = expense.status === "VOIDED";
                    return (
                      <tr
                        key={expense.id}
                        className={`border-b border-border ${voided ? "opacity-60" : ""}`}
                      >
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {new Date(expense.expenseDate).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{expense.vendorName}</p>
                          {expense.notes && (
                            <p className="text-xs text-muted-foreground">{expense.notes}</p>
                          )}
                          {voided && expense.voidReason && (
                            <p className="text-xs text-danger">Voided: {expense.voidReason}</p>
                          )}
                          {expense.receiptNumber && (
                            <p className="text-xs text-muted-foreground">
                              Receipt {expense.receiptNumber}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {expense.category?.name ?? "Uncategorised"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {PAYMENT_METHODS.find(m => m.value === expense.paymentMethod)?.label ??
                            expense.paymentMethod}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-foreground">
                          {formatMoney(expense.amount, expense.currency || currency)}
                          {voided && (
                            <span className="ml-2 text-xs font-normal text-danger">voided</span>
                          )}
                        </td>
                        {canApprove && (
                          <td className="px-4 py-3 text-right">
                            {!voided && (
                              <button
                                type="button"
                                onClick={() => {
                                  setVoidTarget(expense);
                                  setVoidReason("");
                                }}
                                className="inline-flex items-center gap-1 text-xs text-danger hover:text-danger/80"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Void
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {voidTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form onSubmit={confirmVoid} className="kazi-card w-full max-w-md p-6">
            <h2 className="mb-2 text-lg font-semibold text-foreground">
              Void {voidTarget.vendorName}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              This keeps the record and its amount, but stops it counting towards your totals and
              posts a reversing entry so your accounts still balance. It is not a deletion.
            </p>
            <label className="mb-1 block text-sm text-muted-foreground" htmlFor="void-reason">
              Why is this being voided?
            </label>
            <textarea
              id="void-reason"
              value={voidReason}
              onChange={e => setVoidReason(e.target.value)}
              rows={3}
              className="kazi-input resize-none"
              placeholder="Recorded against the wrong supplier"
              required
              minLength={3}
            />
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setVoidTarget(null)}
                className="kazi-button-secondary px-4 py-2 text-sm"
              >
                <RotateCcw className="h-4 w-4" />
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="kazi-button-primary px-4 py-2 text-sm"
              >
                <Receipt className="h-4 w-4" />
                {saving ? "Voiding…" : "Void expense"}
              </button>
            </div>
          </form>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Looking for the money coming in?{" "}
        <Link to="/dashboard/reports" className="text-accent hover:underline">
          Sales reports
        </Link>{" "}
        covers revenue; this page covers what the business spent.
      </p>
    </div>
  );
}
