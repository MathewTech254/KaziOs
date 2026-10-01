import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Filter,
  LoaderCircle,
  Plus,
  Receipt,
  Search,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { getApiError } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

interface CustomerOption {
  id: string;
  name: string;
}

interface InvoiceOption {
  id: string;
  invoiceNumber: string;
  total: number;
  currency: string;
  status: string;
}

interface Payment {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  provider: string;
  methodType: string;
  status: string;
  providerRef?: string | null;
  notes?: string | null;
  paidAt?: string | null;
  createdAt: string;
  customer?: { id: string; name: string } | null;
  invoice?: { id: string; invoiceNumber: string; total: number; status: string } | null;
  branch?: { id: string; name: string } | null;
}

interface PaymentsResponse {
  data: Payment[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface PaymentForm {
  invoiceId: string;
  customerId: string;
  amount: string;
  currency: string;
  paymentProvider: "PAYSTACK" | "MPESA" | "BANK" | "MANUAL" | "CASH" | "CHECK";
  paymentMethodType: "card" | "bank_transfer" | "mobile_money" | "cash" | "check" | "manual";
  reference: string;
  notes: string;
}

const PAYMENT_PAGE_SIZE = 20;
const CURRENCIES = ["KES", "UGX", "TZS", "NGN", "ZAR", "USD", "EUR", "GBP"];
const PROVIDERS = [
  { value: "CASH", label: "Cash", methodType: "cash" as const },
  { value: "BANK", label: "Bank transfer", methodType: "bank_transfer" as const },
  { value: "MANUAL", label: "Manual", methodType: "manual" as const },
  { value: "CHECK", label: "Check", methodType: "check" as const },
  { value: "PAYSTACK", label: "Paystack", methodType: "card" as const },
  { value: "MPESA", label: "M-Pesa", methodType: "mobile_money" as const },
];

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: currency === "UGX" ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function formatDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function statusClass(status: string): string {
  switch (status) {
    case "SUCCESS":
    case "PAID":
      return "bg-success/10 text-success";
    case "PENDING":
    case "PROCESSING":
      return "bg-warning/10 text-warning";
    case "FAILED":
    case "REFUNDED":
      return "bg-danger/10 text-danger";
    default:
      return "bg-surface-muted text-muted-foreground";
  }
}

function providerLabel(provider: string): string {
  return PROVIDERS.find(item => item.value === provider)?.label || provider;
}

function methodLabel(methodType: string): string {
  return methodType.replaceAll("_", " ");
}

export function PaymentsPage() {
  const { hasPermission } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [providerFilter, setProviderFilter] = useState("ALL");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<PaymentForm>({
    invoiceId: "",
    customerId: "",
    amount: "",
    currency: "KES",
    paymentProvider: "CASH",
    paymentMethodType: "cash",
    reference: "",
    notes: "",
  });

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: String(page), limit: String(PAYMENT_PAGE_SIZE) });
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (providerFilter !== "ALL") params.set("provider", providerFilter);
    if (search.trim()) params.set("search", search.trim());

    try {
      const res = await api.get<PaymentsResponse>(`/payments?${params.toString()}`);
      setPayments(res.data.data);
      setTotal(res.data.total);
      setTotalPages(Math.max(1, res.data.totalPages));
      setPage(current => Math.min(current, Math.max(1, res.data.totalPages)));
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, providerFilter, search]);

  useEffect(() => {
    if (!hasPermission("payments.view")) {
      setLoading(false);
      return;
    }
    void loadPayments();
  }, [hasPermission, loadPayments]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    if (!hasPermission("payments.view")) {
      setLoadingOptions(false);
      return;
    }

    void Promise.allSettled([
      api.get<{ data: InvoiceOption[] }>("/invoices?limit=100"),
      api.get<{ data: CustomerOption[] }>("/customers?limit=100"),
    ])
      .then(([invoiceResult, customerResult]) => {
        if (invoiceResult.status === "fulfilled") setInvoices(invoiceResult.value.data.data || []);
        if (customerResult.status === "fulfilled")
          setCustomers(customerResult.value.data.data || []);
      })
      .finally(() => setLoadingOptions(false));
  }, [hasPermission]);

  const visibleTotal = useMemo(
    () => payments.reduce((sum, payment) => sum + payment.amount, 0),
    [payments]
  );
  const successfulCount = useMemo(
    () => payments.filter(payment => payment.status === "SUCCESS").length,
    [payments]
  );
  const pendingCount = useMemo(
    () => payments.filter(payment => ["PENDING", "PROCESSING"].includes(payment.status)).length,
    [payments]
  );
  const selectedProvider =
    PROVIDERS.find(provider => provider.value === form.paymentProvider) || PROVIDERS[0];

  const updateProvider = (providerValue: PaymentForm["paymentProvider"]) => {
    const provider = PROVIDERS.find(item => item.value === providerValue) || PROVIDERS[0];
    setForm(current => ({
      ...current,
      paymentProvider: providerValue,
      paymentMethodType: provider.methodType,
    }));
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!amount || amount <= 0) {
      setError("Enter a payment amount greater than zero");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await api.post("/payments", {
        invoiceId: form.invoiceId || undefined,
        customerId: form.customerId || undefined,
        amount,
        currency: form.currency,
        paymentProvider: form.paymentProvider,
        paymentMethodType: form.paymentMethodType,
        reference: form.reference.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      setShowForm(false);
      setForm({
        invoiceId: "",
        customerId: "",
        amount: "",
        currency: "KES",
        paymentProvider: "CASH",
        paymentMethodType: "cash",
        reference: "",
        notes: "",
      });
      await loadPayments();
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!hasPermission("payments.view")) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="kazi-card max-w-md p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-10 w-10 text-danger" />
          <h1 className="kazi-page-title">Payments access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your role does not include the payments.view permission.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="kazi-page-title">Payments</h1>
          <p className="kazi-page-subtitle">
            Track customer receipts, payment status, and settlement activity.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="kazi-button-primary px-4 text-sm"
        >
          <Plus className="h-4 w-4" /> Record payment
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="kazi-stat-card">
          <div className="flex items-center justify-between">
            <span className="kazi-stat-label">Page volume</span>
            <Receipt className="h-5 w-5 text-accent" />
          </div>
          <p className="kazi-stat-value mt-1">
            {formatMoney(visibleTotal, payments[0]?.currency || "KES")}
          </p>
        </div>
        <div className="kazi-stat-card">
          <div className="flex items-center justify-between">
            <span className="kazi-stat-label">Successful</span>
            <CheckCircle className="h-5 w-5 text-success" />
          </div>
          <p className="kazi-stat-value mt-1">{successfulCount}</p>
        </div>
        <div className="kazi-stat-card">
          <div className="flex items-center justify-between">
            <span className="kazi-stat-label">Pending</span>
            <LoaderCircle className="h-5 w-5 text-warning" />
          </div>
          <p className="kazi-stat-value mt-1">{pendingCount}</p>
        </div>
        <div className="kazi-stat-card">
          <div className="flex items-center justify-between">
            <span className="kazi-stat-label">All payments</span>
            <CreditCard className="h-5 w-5 text-info" />
          </div>
          <p className="kazi-stat-value mt-1">{total}</p>
        </div>
      </div>

      <div className="kazi-card mb-5 mt-5 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-72">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Search</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <input
                value={searchDraft}
                onChange={event => setSearchDraft(event.target.value)}
                placeholder="Reference, invoice, or customer"
                className="kazi-input pl-9"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
            <select
              value={statusFilter}
              onChange={event => setStatusFilter(event.target.value)}
              className="kazi-input"
            >
              <option value="ALL">All statuses</option>
              <option value="SUCCESS">Success</option>
              <option value="PENDING">Pending</option>
              <option value="PROCESSING">Processing</option>
              <option value="FAILED">Failed</option>
              <option value="REFUNDED">Refunded</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Provider</label>
            <select
              value={providerFilter}
              onChange={event => setProviderFilter(event.target.value)}
              className="kazi-input"
            >
              <option value="ALL">All providers</option>
              {PROVIDERS.map(provider => (
                <option key={provider.value} value={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Filter className="h-4 w-4" />
            <span>{total} records</span>
          </div>
        </div>
      </div>

      <div className="kazi-table-wrap kazi-card">
        {loading ? (
          <div className="flex min-h-[24rem] items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Loading payments...
          </div>
        ) : payments.length ? (
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-muted">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase sm:px-6">
                  Reference
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase sm:px-6">
                  Customer
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase sm:px-6">
                  Invoice
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase sm:px-6">
                  Amount
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase sm:px-6">
                  Method
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase sm:px-6">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase sm:px-6">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payments.map(payment => (
                <tr key={payment.id} className="hover:bg-surface-muted/40">
                  <td className="px-4 py-4 text-sm sm:px-6">
                    <div className="flex items-center gap-2">
                      <Receipt className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="font-medium text-foreground">{payment.reference}</p>
                        <p className="text-xs text-muted-foreground">
                          {payment.providerRef || "No provider reference"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm text-muted-foreground sm:px-6">
                    {payment.customer?.name || "-"}
                  </td>
                  <td className="px-4 py-4 text-sm text-muted-foreground sm:px-6">
                    {payment.invoice?.invoiceNumber || "-"}
                  </td>
                  <td className="px-4 py-4 text-sm font-semibold text-foreground sm:px-6">
                    {formatMoney(payment.amount, payment.currency)}
                  </td>
                  <td className="px-4 py-4 text-sm text-muted-foreground sm:px-6">
                    <div>
                      <p className="text-foreground">{providerLabel(payment.provider)}</p>
                      <p className="text-xs">{methodLabel(payment.methodType)}</p>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm sm:px-6">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(payment.status)}`}
                    >
                      {payment.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-sm text-muted-foreground sm:px-6 whitespace-nowrap">
                    {formatDate(payment.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex min-h-[24rem] flex-col items-center justify-center text-center">
            <CreditCard className="mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="font-semibold text-foreground">No payments found</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Adjust the filters or record a new payment.
            </p>
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setPage(current => Math.max(1, current - 1))}
          disabled={page <= 1 || loading}
          className="kazi-button-secondary px-4 text-sm disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" /> Previous
        </button>
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => setPage(current => Math.min(totalPages, current + 1))}
          disabled={page >= totalPages || loading}
          className="kazi-button-secondary px-4 text-sm disabled:opacity-40"
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-form-title"
        >
          <div className="kazi-card w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                  New transaction
                </p>
                <h2 id="payment-form-title" className="kazi-page-title mt-1">
                  Record payment
                </h2>
                <p className="kazi-page-subtitle">
                  Create a payment against an invoice or customer account.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                aria-label="Close payment form"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">
                    Invoice <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <select
                    value={form.invoiceId}
                    onChange={event => setForm({ ...form, invoiceId: event.target.value })}
                    className="kazi-input"
                  >
                    <option value="">No invoice</option>
                    {invoices.map(invoice => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.invoiceNumber} · {formatMoney(invoice.total, invoice.currency)} ·{" "}
                        {invoice.status}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">
                    Customer <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <select
                    value={form.customerId}
                    onChange={event => setForm({ ...form, customerId: event.target.value })}
                    className="kazi-input"
                  >
                    <option value="">No customer</option>
                    {customers.map(customer => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">Amount</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.amount}
                    onChange={event => setForm({ ...form, amount: event.target.value })}
                    className="kazi-input"
                    placeholder="0.00"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">Currency</label>
                  <select
                    value={form.currency}
                    onChange={event => setForm({ ...form, currency: event.target.value })}
                    className="kazi-input"
                  >
                    {CURRENCIES.map(currency => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">Provider</label>
                  <select
                    value={form.paymentProvider}
                    onChange={event =>
                      updateProvider(event.target.value as PaymentForm["paymentProvider"])
                    }
                    className="kazi-input"
                  >
                    {PROVIDERS.map(provider => (
                      <option key={provider.value} value={provider.value}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">Method type</label>
                  <input
                    value={selectedProvider.methodType.replaceAll("_", " ")}
                    disabled
                    className="kazi-input bg-surface-muted text-muted-foreground"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">
                    Reference <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    value={form.reference}
                    onChange={event => setForm({ ...form, reference: event.target.value })}
                    className="kazi-input"
                    placeholder="Transaction reference"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">
                    Notes <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    value={form.notes}
                    onChange={event => setForm({ ...form, notes: event.target.value })}
                    className="kazi-input"
                    placeholder="Payment notes"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="kazi-button-secondary px-4 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || loadingOptions}
                  className="kazi-button-primary px-4 text-sm"
                >
                  {submitting ? "Recording..." : "Record payment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
