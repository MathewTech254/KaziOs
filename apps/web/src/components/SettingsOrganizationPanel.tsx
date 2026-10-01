import { useEffect, useState } from "react";
import { api, getApiError } from "../lib/api";

const CURRENCIES = ["KES", "UGX", "TZS", "NGN", "ZAR", "USD", "EUR", "GBP"];

const COUNTRIES = [
  { code: "KE", label: "Kenya" },
  { code: "UG", label: "Uganda" },
  { code: "TZ", label: "Tanzania" },
  { code: "NG", label: "Nigeria" },
  { code: "ZA", label: "South Africa" },
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "EU", label: "European Union" },
];

const TIMEZONES = [
  "Africa/Nairobi",
  "Africa/Kampala",
  "Africa/Dar_es_Salaam",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Europe/London",
  "America/New_York",
  "UTC",
];

interface Organization {
  id: string;
  name: string;
  slug: string;
  country: string;
  currency: string;
  timezone: string;
  language: string;
  status: string;
  taxNumber?: string | null;
  businessCategory?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export function SettingsOrganizationPanel({ canManage }: { canManage: boolean }) {
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => {
    setError("");
    try {
      const res = await api.get("/org");
      setOrg(res.data.data);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const update = (field: keyof Organization, value: string) => {
    setOrg(current => (current ? { ...current, [field]: value } : current));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await api.patch("/org", {
        name: org.name,
        country: org.country,
        currency: org.currency,
        timezone: org.timezone,
        language: org.language,
        taxNumber: org.taxNumber || null,
        businessCategory: org.businessCategory || null,
        address: org.address || null,
        phone: org.phone || null,
        email: org.email || null,
      });
      setOrg(res.data.data);
      setMessage("Organization profile saved");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="kazi-card p-6 text-sm text-muted-foreground">Loading organization...</div>
    );
  if (!org)
    return (
      <div className="kazi-card p-6 text-sm text-destructive">
        {error || "Organization unavailable"}
      </div>
    );

  return (
    <form onSubmit={handleSubmit} className="kazi-card p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">Organization profile</h2>
        <p className="text-sm text-muted-foreground">
          Identifier: {org.slug} &middot; Status: {org.status}
        </p>
      </div>

      {error && <div className="kazi-alert-card mb-4 p-3 text-sm text-foreground">{error}</div>}
      {message && (
        <div className="mb-4 rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Legal name</label>
          <input
            value={org.name}
            onChange={e => update("name", e.target.value)}
            className="kazi-input"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Business category</label>
          <input
            value={org.businessCategory || ""}
            onChange={e => update("businessCategory", e.target.value)}
            className="kazi-input"
            placeholder="Retail, Pharmacy, Restaurant"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">KRA PIN / Tax number</label>
          <input
            value={org.taxNumber || ""}
            onChange={e => update("taxNumber", e.target.value)}
            className="kazi-input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Phone</label>
          <input
            value={org.phone || ""}
            onChange={e => update("phone", e.target.value)}
            className="kazi-input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Billing email</label>
          <input
            type="email"
            value={org.email || ""}
            onChange={e => update("email", e.target.value)}
            className="kazi-input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Address</label>
          <input
            value={org.address || ""}
            onChange={e => update("address", e.target.value)}
            className="kazi-input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Country</label>
          <select
            value={org.country}
            onChange={e => update("country", e.target.value)}
            className="kazi-input"
          >
            {COUNTRIES.map(country => (
              <option key={country.code} value={country.code}>
                {country.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Base currency</label>
          <select
            value={org.currency}
            onChange={e => update("currency", e.target.value)}
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
          <label className="mb-1 block text-sm text-muted-foreground">Timezone</label>
          <select
            value={org.timezone}
            onChange={e => update("timezone", e.target.value)}
            className="kazi-input"
          >
            {TIMEZONES.map(timezone => (
              <option key={timezone} value={timezone}>
                {timezone}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Language</label>
          <select
            value={org.language}
            onChange={e => update("language", e.target.value)}
            className="kazi-input"
          >
            <option value="en">English</option>
            <option value="sw">Kiswahili</option>
          </select>
        </div>
      </div>

      <button
        type="submit"
        disabled={!canManage || saving}
        className="kazi-button-primary mt-6 px-4 text-sm disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save organization"}
      </button>
    </form>
  );
}
