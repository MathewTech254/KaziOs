import { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { api, getApiError } from "../lib/api";

type Values = Record<string, Record<string, unknown>>;

interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "number" | "toggle" | "select";
  options?: { value: string; label: string }[];
}

interface SectionSpec {
  key: string;
  title: string;
  description: string;
  fields: FieldSpec[];
}

const SECTIONS: SectionSpec[] = [
  {
    key: "invoicing",
    title: "Invoicing",
    description: "Numbering, payment terms and tax defaults applied to new invoices.",
    fields: [
      { key: "invoicePrefix", label: "Invoice prefix", type: "text" },
      { key: "defaultPaymentTermsDays", label: "Payment terms (days)", type: "number" },
      {
        key: "defaultTaxMode",
        label: "Default tax mode",
        type: "select",
        options: [
          { value: "EXCLUSIVE", label: "Exclusive (tax added)" },
          { value: "INCLUSIVE", label: "Inclusive (tax included)" },
        ],
      },
      { key: "invoiceFooterNote", label: "Invoice footer note", type: "text" },
    ],
  },
  {
    key: "pos",
    title: "Point of sale",
    description: "Receipt output and stock behaviour at the till.",
    fields: [
      { key: "receiptFooterNote", label: "Receipt footer note", type: "text" },
      { key: "autoPrintReceipt", label: "Auto-print receipt after sale", type: "toggle" },
      { key: "allowNegativeStock", label: "Allow selling out-of-stock items", type: "toggle" },
      { key: "cashRoundingEnabled", label: "Round cash totals to nearest unit", type: "toggle" },
    ],
  },
  {
    key: "notifications",
    title: "Notifications",
    description: "Automated alerts sent to your team.",
    fields: [
      { key: "lowStockAlerts", label: "Low stock alerts", type: "toggle" },
      { key: "overdueInvoiceReminders", label: "Overdue invoice reminders", type: "toggle" },
      { key: "dailySalesSummary", label: "Daily sales summary", type: "toggle" },
    ],
  },
  {
    key: "accounting",
    title: "Accounting",
    description: "Financial year and default ledger accounts.",
    fields: [
      { key: "fiscalYearStartMonth", label: "Fiscal year start month (1-12)", type: "number" },
      { key: "defaultCashAccountCode", label: "Default cash account code", type: "text" },
    ],
  },
];

export function SettingsPreferencesPanel({ canManage }: { canManage: boolean }) {
  const [values, setValues] = useState<Values>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => {
    try {
      const res = await api.get("/settings");
      setValues(res.data.data);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setField = (sectionKey: string, fieldKey: string, value: unknown) =>
    setValues(current => ({
      ...current,
      [sectionKey]: { ...(current[sectionKey] || {}), [fieldKey]: value },
    }));

  const saveSection = async (sectionKey: string) => {
    setSavingKey(sectionKey);
    setError("");
    setMessage("");
    try {
      const res = await api.put(`/settings/${sectionKey}`, values[sectionKey] || {});
      setValues(current => ({ ...current, [sectionKey]: res.data.data.value }));
      setMessage(`${sectionKey} settings saved`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSavingKey(null);
    }
  };

  const resetSection = async (sectionKey: string) => {
    setSavingKey(sectionKey);
    setError("");
    setMessage("");
    try {
      const res = await api.delete(`/settings/${sectionKey}`);
      setValues(current => ({ ...current, [sectionKey]: res.data.data.value }));
      setMessage(`${sectionKey} settings restored to defaults`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSavingKey(null);
    }
  };

  if (loading)
    return (
      <div className="kazi-card p-6 text-sm text-muted-foreground">Loading preferences...</div>
    );

  return (
    <div className="space-y-6">
      {error && <div className="kazi-alert-card p-3 text-sm text-foreground">{error}</div>}
      {message && (
        <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground">
          {message}
        </div>
      )}

      {SECTIONS.map(section => {
        const busy = savingKey === section.key;
        return (
          <div key={section.key} className="kazi-card p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-foreground">{section.title}</h2>
              <p className="text-sm text-muted-foreground">{section.description}</p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {section.fields.map(field => {
                const value = values[section.key]?.[field.key];
                return (
                  <div key={field.key}>
                    <label className="mb-1 block text-sm text-muted-foreground">
                      {field.label}
                    </label>
                    {field.type === "toggle" && (
                      <label className="flex items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={Boolean(value)}
                          onChange={e => setField(section.key, field.key, e.target.checked)}
                          disabled={!canManage || busy}
                        />
                        <span>{value ? "Enabled" : "Disabled"}</span>
                      </label>
                    )}
                    {field.type === "select" && (
                      <select
                        value={value === undefined || value === null ? "" : String(value)}
                        onChange={e => setField(section.key, field.key, e.target.value)}
                        className="kazi-input"
                        disabled={!canManage || busy}
                      >
                        {field.options?.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {(field.type === "text" || field.type === "number") && (
                      <input
                        type={field.type === "number" ? "number" : "text"}
                        value={value === undefined || value === null ? "" : String(value)}
                        onChange={e =>
                          setField(
                            section.key,
                            field.key,
                            field.type === "number" ? Number(e.target.value) : e.target.value
                          )
                        }
                        className="kazi-input"
                        disabled={!canManage || busy}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => saveSection(section.key)}
                disabled={!canManage || busy}
                className="kazi-button-primary px-4 text-sm disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {busy ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={() => resetSection(section.key)}
                disabled={!canManage || busy}
                className="kazi-button-secondary px-4 text-sm disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                Reset to defaults
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
