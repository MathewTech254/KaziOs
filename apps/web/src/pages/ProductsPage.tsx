import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { Plus } from "lucide-react";

interface Product {
  id: string;
  name: string;
  sku?: string;
  costPrice: number;
  sellingPrice: number;
  minStock: number;
  productType: string;
  isActive: boolean;
}

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", sku: "", costPrice: 0, sellingPrice: 0, minStock: 0, productType: "PHYSICAL" });

  const load = async () => {
    try {
      const res = await api.get("/products");
      setProducts(res.data.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post("/products", form);
    setShowForm(false);
    setForm({ name: "", sku: "", costPrice: 0, sellingPrice: 0, minStock: 0, productType: "PHYSICAL" });
    load();
  };

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="kazi-page-title">Products</h1>
          <p className="kazi-page-subtitle">Manage your product catalog</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="kazi-button-primary px-4 text-sm"
        >
          <Plus className="h-4 w-4" />
          {showForm ? "Cancel" : "Add Product"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="kazi-card mb-6 p-6">
          <h2 className="mb-4 text-lg font-semibold text-foreground">New Product</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="kazi-input"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">SKU</label>
              <input
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                className="kazi-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Cost Price</label>
              <input
                type="number"
                step="0.01"
                value={form.costPrice}
                onChange={(e) => setForm({ ...form, costPrice: parseFloat(e.target.value) })}
                className="kazi-input"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Selling Price</label>
              <input
                type="number"
                step="0.01"
                value={form.sellingPrice}
                onChange={(e) => setForm({ ...form, sellingPrice: parseFloat(e.target.value) })}
                className="kazi-input"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Min Stock</label>
              <input
                type="number"
                value={form.minStock}
                onChange={(e) => setForm({ ...form, minStock: parseInt(e.target.value) })}
                className="kazi-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Type</label>
              <select
                value={form.productType}
                onChange={(e) => setForm({ ...form, productType: e.target.value })}
                className="kazi-input"
              >
                <option value="PHYSICAL">Physical</option>
                <option value="SERVICE">Service</option>
                <option value="DIGITAL">Digital</option>
              </select>
            </div>
          </div>
          <button type="submit" className="kazi-button-primary mt-4 px-4 text-sm">
            Save product
          </button>
        </form>
      )}

      <div className="kazi-table-wrap kazi-card">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">SKU</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Cost</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Sell</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Type</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {products.map((p) => (
              <tr key={p.id} className="hover:bg-surface-muted/50">
                <td className="px-6 py-4 text-sm font-medium text-foreground">{p.name}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{p.sku || "-"}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{p.costPrice}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{p.sellingPrice}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{p.productType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}