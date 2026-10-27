import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { getApiError } from "../lib/api";
import { Plus } from "lucide-react";
import { isValidPhoneNumber } from "libphonenumber-js";

interface Customer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  customerType: string;
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

export function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phoneCountry: "KE",
    phoneNumber: "",
    customerType: "INDIVIDUAL",
  });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await api.get("/customers");
    setCustomers(res.data.data);
  };

  useEffect(() => {
    load();
  }, []);

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
      const payload = {
        name: form.name,
        email: form.email.trim() ? form.email.trim() : undefined,
        phone,
        customerType: form.customerType,
      };
      await api.post("/customers", payload);
      setShowForm(false);
      setForm({
        name: "",
        email: "",
        phoneCountry: "KE",
        phoneNumber: "",
        customerType: "INDIVIDUAL",
      });
      load();
    } catch (err) {
      setError(getApiError(err));
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="kazi-page-title">Customers</h1>
          <p className="kazi-page-subtitle">Manage your customer relationships</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="kazi-button-primary px-4 text-sm">
          <Plus className="h-4 w-4" />
          {showForm ? "Cancel" : "Add Customer"}
        </button>
      </div>

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
          </div>
          {error && (
            <p className="mt-3 text-sm text-danger">{error}</p>
          )}
          <button type="submit" className="kazi-button-primary mt-4 px-4 text-sm">
            Save customer
          </button>
        </form>
      )}

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Email
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Phone
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                Type
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {customers.map(c => (
              <tr key={c.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">{c.name}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{c.email || "-"}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{c.phone || "-"}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{c.customerType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
