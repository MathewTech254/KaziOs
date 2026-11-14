import { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "../lib/api";
import { getApiError } from "../lib/api";
import { Plus } from "lucide-react";
import { isValidPhoneNumber } from "libphonenumber-js";
import { useAuth } from "../contexts/AuthContext";
import { AccessDenied, Notice } from "../components/Feedback";

interface Customer {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  customerType: string;
  balanceOwed: number;
  lastPurchaseDate: string | null;
  creditLimit: number | null;
}

// Countries (and dial codes) the site supports. Kept in sync with zCountry in
// @kazios/validation so a number is always judged against the country the
// cashier actually picked.
const PHONE_COUNTRIES = [
  { code: "KE", name: "Kenya", dial: "+254", validateAs: "KE" },
  { code: "UG", name: "Uganda", dial: "+256", validateAs: "UG" },
  { code: "TZ", name: "Tanzania", dial: "+255", validateAs: "TZ" },
  { code: "NG", name: "Nigeria", dial: "+234", validateAs: "NG" },
  { code: "ZA", name: "South Africa", dial: "+27", validateAs: "ZA" },
  { code: "US", name: "United States", dial: "+1", validateAs: "US" },
  { code: "GB", name: "United Kingdom", dial: "+44", validateAs: "GB" },
  { code: "EU", name: "European Union", dial: "+32", validateAs: "BE" },
] as const;

function isValidPhone(countryCode: string, number: string): boolean {
  const trimmed = number.trim();
  if (!trimmed) return true;
  const country = PHONE_COUNTRIES.find(c => c.code === countryCode);
  const full = `${country?.dial ?? ""}${trimmed.replace(/^0+/, "")}`;
  try {
    return isValidPhoneNumber(full, (country?.validateAs ?? "KE") as any);
  } catch {
    const digits = full.replace(/\D/g, "");
    if (digits.length < 5) return false;
    if (/^0+$/.test(digits)) return false;
    return /^[+\d\s\-().]+$/.test(full);
  }
}

function formatMoney(value: number | null | undefined, currency: string): string {
  if (value == null) return "-";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "KES",
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency || "KES"} ${value.toFixed(2)}`;
  }
}

export function CustomersPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("customers.view");
  const canCreate = hasPermission("customers.create");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sortBy, setSortBy] = useState<"balance" | "name">("balance");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showForm, setShowForm] = useState(false);
  const [showPayment, setShowPayment] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phoneCountry: "KE",
    phoneNumber: "",
    customerType: "INDIVIDUAL",
    creditLimit: "",
  });
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    paymentProvider: "CASH",
    paymentMethodType: "cash",
    reference: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    try {
      const res = await api.get("/customers");
      setCustomers(res.data.data);
    } catch (err) {
      setError(getApiError(err));
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedCustomers = useMemo(() => {
    return [...customers].sort((a, b) => {
      if (sortBy === "balance") {
        const diff = a.balanceOwed - b.balanceOwed;
        return sortDir === "desc" ? diff : -diff;
      }
      const nameDiff = a.name.localeCompare(b.name);
      return sortDir === "asc" ? nameDiff : -nameDiff;
    });
  }, [customers, sortBy, sortDir]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidPhone(form.phoneCountry, form.phoneNumber)) {
      setError("Enter a valid phone number for the selected country.");
      return;
    }
    try {
      const country = PHONE_COUNTRIES.find(c => c.code === form.phoneCountry);
      const phone = form.phoneNumber.trim()
        ? `${country?.dial ?? ""} ${form.phoneNumber.trim()}`.trim()
        : undefined;
      const payload: any = {
        name: form.name,
        email: form.email.trim() ? form.email.trim() : undefined,
        phone,
        customerType: form.customerType,
      };
      if (form.creditLimit.trim()) {
        payload.creditLimit = Number(form.creditLimit);
      }
      await api.post("/customers", payload);
      setShowForm(false);
      setForm({
        name: "",
        email: "",
        phoneCountry: "KE",
        phoneNumber: "",
        customerType: "INDIVIDUAL",
        creditLimit: "",
      });
      load();
    } catch (err) {
      setError(getApiError(err));
    }
  };

  const recordPayment = async (customerId: string, e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/payments", {
        amount: Number(paymentForm.amount),
        currency: "KES",
        paymentProvider: paymentForm.paymentProvider,
        paymentMethodType: paymentForm.paymentMethodType,
        customerId,
        reference: paymentForm.reference.trim() || undefined,
        notes: paymentForm.notes.trim() || undefined,
      });
      setShowPayment(null);
      setPaymentForm({
        amount: "",
        paymentProvider: "CASH",
        paymentMethodType: "cash",
        reference: "",
        notes: "",
      });
      load();
    } catch (err) {
      setError(getApiError(err));
    }
  };

  if (!canView) {
    return (
      <AccessDenied
        title="Customers access required"
        permission="customers.view"
        hint="The customer book is limited to roles that may see who owes the business money."
      />
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="kazi-page-title">Customers</h1>
          <p className="kazi-page-subtitle">Manage your customer relationships</p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="kazi-button-primary px-4 text-sm"
          >
            <Plus className="h-4 w-4" />
            {showForm ? "Cancel" : "Add Customer"}
          </button>
        )}
      </div>

      {error && <Notice tone="error" title="Could not load customers" message={error} />}

      {showForm && (
        <form onSubmit={handleSubmit} className="kazi-card mb-6 p-6">
          <h2 className="mb-4 text-lg font-semibold text-foreground">New Customer</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Name</label>
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="kazi-input"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                className="kazi-input"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm text-muted-foreground">Phone</label>
              <div className="flex gap-2">
                <select
                  value={form.phoneCountry}
                  onChange={e => setForm({ ...form, phoneCountry: e.target.value })}
                  className="kazi-input w-48"
                  aria-label="Country code"
                >
                  {PHONE_COUNTRIES.map(c => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.dial})
                    </option>
                  ))}
                </select>
                <input
                  value={form.phoneNumber}
                  onChange={e => setForm({ ...form, phoneNumber: e.target.value })}
                  className="kazi-input flex-1"
                  placeholder="Phone number"
                  inputMode="tel"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Type</label>
              <select
                value={form.customerType}
                onChange={e => setForm({ ...form, customerType: e.target.value })}
                className="kazi-input"
              >
                <option value="INDIVIDUAL">Individual</option>
                <option value="BUSINESS">Business</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Credit limit (KES)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.creditLimit}
                onChange={e => setForm({ ...form, creditLimit: e.target.value })}
                className="kazi-input"
                placeholder="Optional credit limit"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Leave blank for no credit limit.
              </p>
            </div>
          </div>
          <button type="submit" className="kazi-button-primary mt-4 px-4 text-sm">
            Save customer
          </button>
        </form>
      )}

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase cursor-pointer select-none"
                onClick={() => {
                  if (sortBy === "name") setSortDir(sortDir === "asc" ? "desc" : "asc");
                  else setSortBy("name");
                }}
              >
                Name
                {sortBy === "name" && (sortDir === "asc" ? " ↑" : " ↓")}
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Phone
              </th>
              <th
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase cursor-pointer select-none"
                onClick={() => {
                  if (sortBy === "balance") setSortDir(sortDir === "asc" ? "desc" : "asc");
                  else setSortBy("balance");
                }}
              >
                Balance Owed
                {sortBy === "balance" && (sortDir === "asc" ? " ↑" : " ↓")}
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Last Purchase
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Credit Limit
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedCustomers.map(c => (
              <tr key={c.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">{c.name}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{c.phone || "-"}</td>
                <td className="px-6 py-4 text-sm font-medium">
                  {c.balanceOwed > 0 ? (
                    <span className="text-danger">{formatMoney(c.balanceOwed, "KES")}</span>
                  ) : (
                    <span className="text-success">—</span>
                  )}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {c.lastPurchaseDate ? new Date(c.lastPurchaseDate).toLocaleDateString() : "-"}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {c.creditLimit != null ? formatMoney(c.creditLimit, "KES") : "None"}
                </td>
                <td className="px-6 py-4 text-sm">
                  <button
                    type="button"
                    onClick={() => setShowPayment(c.id)}
                    className="kazi-button-primary text-xs px-3 py-1.5"
                  >
                    Record payment
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="kazi-card max-w-md w-full p-6">
            <h2 className="mb-4 text-lg font-semibold text-foreground">Record Payment</h2>
            <form onSubmit={e => recordPayment(showPayment, e)} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">Amount (KES)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={paymentForm.amount}
                  onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                  className="kazi-input"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">Method</label>
                <select
                  value={paymentForm.paymentProvider}
                  onChange={e =>
                    setPaymentForm({
                      ...paymentForm,
                      paymentProvider: e.target.value,
                      paymentMethodType: e.target.value === "CREDIT" ? "credit" : "cash",
                    })
                  }
                  className="kazi-input"
                >
                  <option value="CASH">Cash</option>
                  <option value="MPESA_MANUAL">M-PESA (manual code)</option>
                </select>
              </div>
              {paymentForm.paymentProvider === "MPESA_MANUAL" && (
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">
                    M-PESA transaction code
                  </label>
                  <input
                    value={paymentForm.reference}
                    onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })}
                    placeholder="MPESA123456"
                    className="kazi-input uppercase"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">Notes</label>
                <input
                  value={paymentForm.notes}
                  onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                  placeholder="Optional note"
                  className="kazi-input"
                />
              </div>
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => setShowPayment(null)}
                  className="kazi-button-outline flex-1 px-4"
                >
                  Cancel
                </button>
                <button type="submit" className="kazi-button-primary flex-1 px-4">
                  Record payment
                </button>
              </div>
            </form>
          </div>
          <button
            type="button"
            onClick={() => setShowPayment(null)}
            className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          >
            <span className="sr-only">Close</span>
            <span className="text-xl">✕</span>
          </button>
        </div>
      )}
    </div>
  );
}
