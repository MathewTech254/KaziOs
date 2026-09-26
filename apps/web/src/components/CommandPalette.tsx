import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Package, Receipt, Search, Truck, User, Users, X } from "lucide-react";
import { api, getApiError } from "../lib/api";

interface Hit {
  id: string;
  label: string;
  detail: string;
  to: string;
}

interface SearchResults {
  products?: Array<{ id: string; name: string; sku: string | null }>;
  suppliers?: Array<{ id: string; name: string; email: string | null }>;
  customers?: Array<{ id: string; name: string; email: string | null }>;
  purchaseOrders?: Array<{ id: string; poNumber: string; status: string; supplier: { name: string } }>;
  invoices?: Array<{ id: string; invoiceNumber: string; status: string; customer: { name: string } }>;
}

const PAGES = [
  { label: "Go to Dashboard", to: "/" },
  { label: "Go to Products", to: "/products" },
  { label: "Go to Customers", to: "/customers" },
  { label: "Go to Suppliers and purchase orders", to: "/purchases" },
  { label: "Go to Inventory", to: "/inventory" },
  { label: "Go to Invoices", to: "/invoices" },
  { label: "Go to Payments", to: "/payments" },
  { label: "Go to Reports", to: "/reports" },
  { label: "Go to Point of sale", to: "/pos" },
];

/** Converts the grouped API response into one flat, keyboard-navigable list. */
function toHits(results: SearchResults): Hit[] {
  const hits: Hit[] = [];
  (results.products ?? []).forEach((row) =>
    hits.push({
      id: `product-${row.id}`,
      label: row.name,
      detail: row.sku ? `Product Â· ${row.sku}` : "Product",
      to: "/products",
    })
  );
  (results.suppliers ?? []).forEach((row) =>
    hits.push({
      id: `supplier-${row.id}`,
      label: row.name,
      detail: row.email ? `Supplier Â· ${row.email}` : "Supplier",
      to: "/purchases",
    })
  );
  (results.customers ?? []).forEach((row) =>
    hits.push({
      id: `customer-${row.id}`,
      label: row.name,
      detail: row.email ? `Customer Â· ${row.email}` : "Customer",
      to: "/customers",
    })
  );
  (results.purchaseOrders ?? []).forEach((row) =>
    hits.push({
      id: `po-${row.id}`,
      label: row.poNumber,
      detail: `Purchase order Â· ${row.supplier.name} Â· ${row.status.toLowerCase()}`,
      to: "/purchases",
    })
  );
  (results.invoices ?? []).forEach((row) =>
    hits.push({
      id: `invoice-${row.id}`,
      label: row.invoiceNumber,
      detail: `Invoice Â· ${row.customer.name} Â· ${row.status.toLowerCase()}`,
      to: "/invoices",
    })
  );
  return hits;
}

function iconFor(hit: Hit) {
  if (hit.id.startsWith("product")) return Package;
  if (hit.id.startsWith("supplier")) return Truck;
  if (hit.id.startsWith("customer")) return User;
  if (hit.id.startsWith("invoice")) return Receipt;
  if (hit.id.startsWith("po")) return FileText;
  return Users;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const term = query.trim();

  // Page jumps are local, so they work before any request completes.
  const pageHits = useMemo(
    () =>
      term
        ? PAGES.filter((page) => page.label.toLowerCase().includes(term.toLowerCase())).map((page) => ({
            id: `page-${page.to}`,
            label: page.label,
            detail: "Page",
            to: page.to,
          }))
        : [],
    [term]
  );

  const hits = useMemo(() => [...pageHits, ...remote], [pageHits, remote]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRemote([]);
    setError(null);
    setCursor(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setCursor(0);
    if (term.length < 2) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.get("/reports/search", { params: { q: term } });
        if (!cancelled) {
          setRemote(toHits((res.data.data?.results ?? {}) as SearchResults));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(getApiError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const go = (hit: Hit) => {
    onClose();
    navigate(hit.to);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((c) => (hits.length ? (c + 1) % hits.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((c) => (hits.length ? (c - 1 + hits.length) % hits.length : 0));
      } else if (event.key === "Enter" && hits[cursor]) {
        event.preventDefault();
        go(hits[cursor]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hits, cursor, onClose]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="kazi-card w-full max-w-xl overflow-hidden p-0"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search products, suppliers, customers, orders and invoices"
            className="w-full bg-transparent py-4 text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search the workspace"
          />
          <button type="button" onClick={onClose} className="kazi-button-secondary px-2 py-1 text-xs">
            <X className="h-3 w-3" aria-hidden="true" />
            Esc
          </button>
        </div>

        {error && <p className="border-b border-border px-4 py-2 text-sm text-danger">{error}</p>}


        <ul ref={listRef} className="max-h-80 overflow-y-auto">
          {hits.map((hit, index) => {
            const Icon = iconFor(hit);
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  onClick={() => go(hit)}
                  onMouseEnter={() => setCursor(index)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${
                    index === cursor ? "bg-accent/10" : ""
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{hit.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{hit.detail}</span>
                  </span>
                </button>
              </li>
            );
          })}

          {!hits.length && (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">
              {loading
                ? "Searching..."
                : term.length >= 2
                ? `Nothing matches "${term}".`
                : "Type at least two characters."}
            </li>
          )}
        </ul>


        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>Up/Down to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}


