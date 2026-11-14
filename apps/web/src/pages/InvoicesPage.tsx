import { useState, useEffect, useCallback } from "react";
import { api, getApiError } from "../lib/api";

interface EtimsState {
  status: string;
  kraInvoiceNumber: string | null;
  qrCode: string | null;
  lastError: string | null;
  attempts: number;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string;
  total: number;
  currency: string;
  customer: { name: string } | null;
  etims?: EtimsState | null;
}

export function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [kraNumber, setKraNumber] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    return api
      .get("/invoices")
      .then(res => {
        setInvoices(res.data.data);
      })
      .catch(err => {
        setError(getApiError(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openKra = (invoice: Invoice) => {
    setSelected(invoice);
    setKraNumber(invoice.etims?.kraInvoiceNumber || "");
    setQrCode(invoice.etims?.qrCode || "");
    setError("");
  };

  const closeKra = () => {
    setSelected(null);
    setKraNumber("");
    setQrCode("");
    setError("");
  };

  const saveManual = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/invoices/${selected.id}/etims/manual`, {
        kraInvoiceNumber: kraNumber,
        qrCode: qrCode.trim() || null,
      });
      await load();
      closeKra();
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const fileNow = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ data: EtimsState }>(`/invoices/${selected.id}/etims/submit`, {});
      const submission = res.data.data;
      // Keep the dialog open so the cashier sees KRA's answer — a silent success is
      // indistinguishable from a silent failure, and the number matters either way.
      setKraNumber(submission.kraInvoiceNumber || "");
      await load();
      const refreshed = invoices.find(inv => inv.id === selected.id);
      if (refreshed) setSelected(refreshed);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "PAID":
        return "bg-success/15 text-success";
      case "DRAFT":
        return "bg-surface-muted text-muted-foreground";
      case "SENT":
        return "bg-info/15 text-info";
      case "PARTIALLY_PAID":
        return "bg-warning/15 text-warning";
      case "OVERDUE":
        return "bg-danger/15 text-danger";
      case "VOID":
        return "bg-surface-muted text-muted-foreground";
      default:
        return "bg-surface-muted text-muted-foreground";
    }
  };

  const kraColor = (status: string) => {
    switch (status) {
      case "ACCEPTED":
        return "bg-success/15 text-success";
      case "REJECTED":
        return "bg-danger/15 text-danger";
      case "SUBMITTED":
        return "bg-warning/15 text-warning";
      case "MANUAL":
        return "bg-info/15 text-info";
      default:
        return "bg-surface-muted text-muted-foreground";
    }
  };

  const kraLabel = (status: string) => {
    switch (status) {
      case "ACCEPTED":
        return "Filed";
      case "REJECTED":
        return "Rejected";
      case "SUBMITTED":
        return "Sending";
      case "MANUAL":
        return "Recorded";
      default:
        return "Not filed";
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="kazi-page-title">Invoices</h1>
        <p className="kazi-page-subtitle">
          Create and manage sales invoices. The KRA column shows whether each invoice has been filed
          with the tax authority.
        </p>
      </div>

      {error && !selected && <p className="mb-4 text-sm text-danger">{error}</p>}

      {loading ? (
        <div className="p-6 text-muted-foreground">Loading...</div>
      ) : (
        <div className="kazi-table-wrap kazi-card">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-muted">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Invoice #
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Customer
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Due
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Total
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  KRA
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invoices.map(inv => (
                <tr key={inv.id} className="hover:bg-surface-muted/50">
                  <td className="px-6 py-4 text-sm font-medium text-foreground">
                    {inv.invoiceNumber}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">{inv.customer?.name}</td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {new Date(inv.issueDate).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {new Date(inv.dueDate).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {inv.currency} {inv.total.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${statusColor(inv.status)}`}
                    >
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <button
                      type="button"
                      onClick={() => openKra(inv)}
                      className={`rounded-full px-2 py-1 text-xs font-medium ${kraColor(inv.etims?.status || "PENDING")}`}
                      title={
                        inv.etims?.lastError ||
                        inv.etims?.kraInvoiceNumber ||
                        "Open the KRA filing for this invoice"
                      }
                    >
                      {kraLabel(inv.etims?.status || "PENDING")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="kazi-card w-full max-w-lg p-6">
            <div className="mb-4">
              <h2 className="kazi-page-title">KRA filing</h2>
              <p className="kazi-page-subtitle">
                {selected.invoiceNumber} · {selected.currency} {selected.total.toLocaleString()}
              </p>
            </div>

            <div className="mb-4 rounded-lg bg-surface-muted p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${kraColor(selected.etims?.status || "PENDING")}`}
                >
                  {kraLabel(selected.etims?.status || "PENDING")}
                </span>
              </div>
              {selected.etims?.kraInvoiceNumber && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-muted-foreground">KRA invoice no.</span>
                  <span className="font-medium text-foreground">
                    {selected.etims.kraInvoiceNumber}
                  </span>
                </div>
              )}
              {selected.etims?.lastError && (
                <p className="mt-2 text-xs text-danger">{selected.etims.lastError}</p>
              )}
            </div>

            {error && <p className="mb-3 text-sm text-danger">{error}</p>}

            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              KRA invoice number
            </label>
            <input
              value={kraNumber}
              onChange={e => setKraNumber(e.target.value)}
              placeholder="From the KRA portal"
              className="kazi-input mb-3 w-full"
            />

            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Verification code (optional)
            </label>
            <input
              value={qrCode}
              onChange={e => setQrCode(e.target.value)}
              placeholder="Printed under the QR code"
              className="kazi-input mb-5 w-full"
            />

            <p className="mb-4 text-xs text-muted-foreground">
              Use this when the eTIMS API is not connected: the number still comes from KRA, so the
              invoice counts as filed. Saving it records the filing; it does not submit anything on
              your behalf.
            </p>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void fileNow()}
                disabled={busy}
                className="kazi-button-primary w-full px-4 disabled:opacity-60"
              >
                {busy ? "Working..." : "File with KRA now"}
              </button>
              <button
                type="button"
                onClick={() => void saveManual()}
                disabled={busy || !kraNumber.trim()}
                className="kazi-button-secondary w-full px-4 disabled:opacity-60"
              >
                Save this number
              </button>
              <button
                type="button"
                onClick={closeKra}
                className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
