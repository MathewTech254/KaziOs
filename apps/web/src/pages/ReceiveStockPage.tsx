import { useState, useEffect, useCallback } from "react";
import { Search } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { formatMoney } from "../lib/currency";
import { useAuth } from "../contexts/AuthContext";
import { AccessDenied } from "../components/Feedback";

interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  sellingPrice: number;
  costPrice: number;
  minStock: number;
  trackStock: boolean;
  productUnits: {
    id: string;
    name: string;
    factorToBase: number;
    isDefaultPurchaseUnit: boolean;
  }[];
}

interface ReceiveForm {
  productId: string;
  warehouseId: string;
  quantity: string;
  unit: string;
  factorToBase: string;
  costPrice: string;
  supplierName: string;
  notes: string;
}

export function ReceiveStockPage() {
  const { hasPermission } = useAuth();
  // Receiving writes stock in and costs the business money. POST /inventory/receive is
  // guarded by inventory.manage, not inventory.view, so that is what gates the page.
  const canReceive = hasPermission("inventory.manage");

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<ProductOption | null>(null);
  const [form, setForm] = useState<ReceiveForm>({
    productId: "",
    warehouseId: "",
    quantity: "1",
    unit: "bottle",
    factorToBase: "1",
    costPrice: "",
    supplierName: "",
    notes: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadProducts = useCallback(
    async (search: string) => {
      if (!canReceive) return;
      try {
        const res = await api.get("/products/", {
          params: { search, limit: 50 },
        });
        setProducts(res.data.data || []);
      } catch {
        // Non-fatal: the picker simply stays empty.
      }
    },
    [canReceive]
  );

  useEffect(() => {
    void loadProducts("");
  }, [loadProducts]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canReceive) return;
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      await api.post("/inventory/receive", {
        productId: form.productId,
        warehouseId: form.warehouseId,
        quantity: parseInt(form.quantity, 10),
        unit: form.unit,
        factorToBase: parseInt(form.factorToBase, 10),
        costPrice: parseFloat(form.costPrice),
        supplierName: form.supplierName,
        notes: form.notes || undefined,
      });
      setSuccess("Stock received successfully");
      setForm({
        ...form,
        quantity: "1",
        costPrice: "",
        supplierName: "",
        notes: "",
      });
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  if (!canReceive) {
    return (
      <AccessDenied
        title="Receive stock access required"
        permission="inventory.manage"
        hint="Receiving stock raises a purchase and a cost against the business. That is limited to roles with receiving rights."
      />
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="kazi-page-title">Receive Stock</h1>
          <p className="kazi-page-subtitle">
            Receive stock from a supplier. Every receipt writes a PURCHASE movement to the stock
            ledger.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSelectedProduct(null)}
          className="kazi-button-outline px-4 text-sm"
        >
          New receipt
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-success/30 bg-success/10 p-4 text-sm text-success"
        >
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="kazi-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-foreground">Receive stock</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <div className="col-span-1 sm:col-span-2 lg:col-span-2">
            <label className="mb-1 block text-sm font-medium text-muted-foreground">Supplier</label>
            <input
              type="text"
              value={form.supplierName}
              onChange={e => setForm({ ...form, supplierName: e.target.value })}
              placeholder="e.g. East African Breweries, Keroche, etc."
              className="kazi-input"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-muted-foreground">
              Warehouse
            </label>
            <select
              value={form.warehouseId}
              onChange={e => setForm({ ...form, warehouseId: e.target.value })}
              className="kazi-input"
              required
            >
              <option value="">Select warehouse</option>
            </select>
          </div>

          <div className="sm:col-span-2 lg:col-span-2">
            <label className="mb-1 block text-sm font-medium text-muted-foreground">Product</label>
            <div className="relative">
              <input
                type="text"
                value={selectedProduct?.name || ""}
                onChange={() => {
                  setForm({ ...form, productId: "" });
                  setSelectedProduct(null);
                  void loadProducts("");
                }}
                placeholder="Search by name, SKU or barcode"
                className="kazi-input pl-10"
                required
              />
              <Search className="absolute left-3 top-1/2 h-4 w-4 text-muted-foreground -translate-y-1/2" />
              {selectedProduct && (
                <div className="mt-2 p-3 rounded-lg border border-border bg-surface-muted">
                  <p className="text-sm font-medium text-foreground">{selectedProduct.name}</p>
                  <p className="text-xs text-muted-foreground">
                    SKU: {selectedProduct.sku || "—"} &nbsp;|&nbsp; Base price:{" "}
                    {formatMoney(selectedProduct.costPrice, "KES")}
                  </p>
                </div>
              )}
              {products.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-white shadow-lg max-h-48 overflow-y-auto">
                  {products.map(p => (
                    <div
                      key={p.id}
                      onClick={() => {
                        const defaultPurchase = p.productUnits.find(u => u.isDefaultPurchaseUnit);
                        const unit = defaultPurchase || p.productUnits[0];
                        setForm({
                          ...form,
                          productId: p.id,
                          unit: unit.name,
                          factorToBase: String(unit.factorToBase),
                          costPrice: String(p.costPrice),
                        });
                        setSelectedProduct(p);
                      }}
                      className="px-3 py-2 text-sm cursor-pointer hover:bg-accent/50"
                    >
                      {p.name} {p.sku ? `(${p.sku})` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-muted-foreground">Unit</label>
            <input
              type="text"
              value={form.unit}
              onChange={e => setForm({ ...form, unit: e.target.value })}
              className="kazi-input"
              placeholder="e.g. crate"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-muted-foreground">
              Factor to base
            </label>
            <input
              type="number"
              min="1"
              value={form.factorToBase}
              onChange={e => setForm({ ...form, factorToBase: e.target.value })}
              className="kazi-input"
              placeholder="e.g. 24"
              required
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Units of this type per base unit (bottle)
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-muted-foreground">
              Quantity (units)
            </label>
            <input
              type="number"
              min="1"
              value={form.quantity}
              onChange={e => setForm({ ...form, quantity: e.target.value })}
              className="kazi-input"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-muted-foreground">
              Cost price per base unit (KES)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.costPrice}
              onChange={e => setForm({ ...form, costPrice: e.target.value })}
              className="kazi-input"
              required
            />
          </div>

          <div className="col-span-1 sm:col-span-2 lg:col-span-2">
            <label className="mb-1 block text-sm font-medium text-muted-foreground">Notes</label>
            <input
              type="text"
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              className="kazi-input"
              placeholder="e.g. Invoice INV-2024-001"
            />
          </div>

          <div className="col-span-1 sm:col-span-2 lg:col-span-2 flex items-end">
            <button
              type="submit"
              disabled={loading || !form.warehouseId || !form.productId || !form.costPrice}
              className="kazi-button-primary w-full px-4 py-2 text-sm"
            >
              {loading ? "Receiving..." : "Receive stock"}
            </button>
          </div>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Stock is received in the unit you select and converted to base units (bottles) in the
          ledger. Example: 2 crates of 24 = 48 base units.
        </p>
      </form>
    </div>
  );
}
