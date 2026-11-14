import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle, ChevronRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, getApiError } from "../lib/api";

interface ProductForm {
  name: string;
  sku: string;
  barcode: string;
  size: string;
  category: string;
  costPrice: string;
  sellingPrice: string;
  minStock: string;
  reorderPoint: string;
}

interface AttendantForm {
  name: string;
  email: string;
  phone: string;
  password: string;
}

type Step = "products" | "stock" | "attendants" | "done";

const STEP_LABELS: Record<Step, string> = {
  products: "1. Add products",
  stock: "2. Set opening stock",
  attendants: "3. Add attendants",
  done: "4. Done",
};

export function OnboardingWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("products");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Products step state
  const [products, setProducts] = useState<
    Array<{
      id: string;
      name: string;
      sku: string | null;
      costPrice: number;
      sellingPrice: number;
      minStock: number;
      reorderPoint: number;
      category: string | null;
    }>
  >([]);
  const [productForm, setProductForm] = useState<ProductForm>({
    name: "",
    sku: "",
    barcode: "",
    size: "",
    category: "",
    costPrice: "",
    sellingPrice: "",
    minStock: "0",
    reorderPoint: "0",
  });
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvImportResult, setCsvImportResult] = useState<{
    imported: number;
    total: number;
    errors: Array<{ row: number; error: string }>;
  } | null>(null);

  // Stock step state
  const [stockForms, setStockForms] = useState<Map<string, string>>(new Map());
  const [stockSaving, setStockSaving] = useState(false);

  // Attendants step state
  const [attendants, setAttendants] = useState<Array<{ id: string; name: string; email: string }>>(
    []
  );
  const [attendantForm, setAttendantForm] = useState<AttendantForm>({
    name: "",
    email: "",
    phone: "",
    password: "",
  });
  const [attendantSaving, setAttendantSaving] = useState(false);

  const progress =
    step === "products" ? 33 : step === "stock" ? 66 : step === "attendants" ? 90 : 100;

  useEffect(() => {
    // Check if onboarding already complete - redirect to dashboard
    // This is handled server-side via middleware, but also guard here
    const loadProducts = async () => {
      try {
        const res = await api.get("/products/", { params: { limit: 50 } });
        setProducts(res.data.data || []);
        // Initialize stock forms for each product
        const forms = new Map<string, string>();
        (res.data.data || []).forEach((p: any) => {
          forms.set(p.id, "");
        });
        setStockForms(forms);
      } catch {
        // Non-fatal on load
      }
    };
    loadProducts();
  }, []);

  const addProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.post("/products/", {
        name: productForm.name,
        sku: productForm.sku || undefined,
        barcode: productForm.barcode || undefined,
        size: productForm.size || undefined,
        category: productForm.category || undefined,
        costPrice: parseFloat(productForm.costPrice) || 0,
        sellingPrice: parseFloat(productForm.sellingPrice),
        minStock: parseInt(productForm.minStock) || 0,
        reorderPoint: parseInt(productForm.reorderPoint) || 0,
        isActive: true,
        productType: "PHYSICAL",
      });
      setProducts(prev => [...prev, res.data.data]);
      // Initialize stock form for new product
      setStockForms(prev => new Map(prev).set(res.data.data.id, ""));
      setProductForm({
        name: "",
        sku: "",
        barcode: "",
        size: "",
        category: "",
        costPrice: "",
        sellingPrice: "",
        minStock: "0",
        reorderPoint: "0",
      });
    } catch (err: any) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const importCsvFile = async (file: File) => {
    setError("");
    setCsvImporting(true);
    setCsvImportResult(null);
    try {
      const text = await file.text();
      const res = await api.post("/products/import", text, {
        headers: { "Content-Type": "text/csv" },
      });
      setCsvImportResult(res.data);
      // Reload products
      const res2 = await api.get("/products/", { params: { limit: 50 } });
      setProducts(res2.data.data || []);
      const forms = new Map<string, string>();
      (res2.data.data || []).forEach((p: any) => {
        forms.set(p.id, "");
      });
      setStockForms(forms);
    } catch (err: any) {
      setError(getApiError(err));
    } finally {
      setCsvImporting(false);
    }
  };

  const importCsv = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const file = formData.get("csv") as File;
    if (!file) {
      setError("Please select a CSV file");
      return;
    }
    await importCsvFile(file);
  };

  const saveStock = async () => {
    setError("");
    setStockSaving(true);
    try {
      const warehouseRes = await api.get("/inventory/", { params: { limit: 5 } });
      const warehouses = warehouseRes.data.data.warehouses || [];
      if (warehouses.length === 0) {
        setError("No warehouse found. Please contact support.");
        return;
      }
      const warehouseId = warehouses[0].id;

      for (const [productId, quantityStr] of stockForms.entries()) {
        const qty = parseFloat(quantityStr);
        if (!qty || qty <= 0) continue;
        await api.post("/inventory/adjustments", {
          productId,
          warehouseId,
          quantity: Math.floor(qty),
          adjustmentType: "INCREASE",
          reason: "Opening stock",
        });
      }

      setStep("attendants");
    } catch (err: any) {
      setError(getApiError(err));
    } finally {
      setStockSaving(false);
    }
  };

  const addAttendant = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setAttendantSaving(true);
    try {
      // Find the attendant role
      const rolesRes = await api.get("/roles/", { params: { limit: 50 } });
      const roles = rolesRes.data.data || [];
      const attendantRole = roles.find((r: any) => r.type === "ATTENDANT");
      if (!attendantRole) {
        setError("Attendant role not found. Please contact support.");
        return;
      }

      await api.post("/users/", {
        name: attendantForm.name,
        email: attendantForm.email,
        phone: attendantForm.phone || undefined,
        password: attendantForm.password,
        roleId: attendantRole.id,
      });
      setAttendants(prev => [
        ...prev,
        { id: `att-${Date.now()}`, name: attendantForm.name, email: attendantForm.email },
      ]);
      setAttendantForm({ name: "", email: "", phone: "", password: "" });
    } catch (err: any) {
      setError(getApiError(err));
    } finally {
      setAttendantSaving(false);
    }
  };

  const completeOnboarding = async () => {
    setLoading(true);
    try {
      await api.put("/settings/onboarding", { completed: true });
      navigate("/dashboard");
    } catch (err: any) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--kazi-bg)] text-[var(--kazi-text)]">
      <header className="border-b border-[var(--kazi-border)] bg-[var(--kazi-surface)] px-6 py-4">
        <div className="max-w-[1328px] mx-auto flex items-center justify-between sm:px-8 lg:px-14">
          <Link to="/" className="flex items-center gap-3">
            <span className="text-lg font-semibold text-[var(--kazi-accent)]">K</span>
            <span className="text-sm font-medium tracking-[.05em]">KaziOS</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm sm:gap-8 hidden md:flex">
            <Link
              to="/"
              className="text-[var(--kazi-muted-text)] hover:text-[var(--kazi-accent)] transition-colors"
            >
              Back home
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-[1328px] mx-auto px-6 py-8 sm:px-8 lg:px-14">
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[10px] font-semibold uppercase tracking-[.2em] text-[var(--kazi-muted-text)]">
              Setting up your shop
            </span>
            <div className="flex-1 h-[4px] bg-[var(--kazi-border)] rounded-full overflow-hidden">
              <div
                className={`h-full bg-[var(--kazi-accent)] rounded-full transition-all duration-300`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[10px] font-semibold text-[var(--kazi-accent)]">{progress}%</span>
          </div>
          <div className="flex gap-2">
            {["products", "stock", "attendants", "done"].map((s, i) => (
              <div
                key={s}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  step === s
                    ? "bg-[var(--kazi-accent)] text-white"
                    : step === "done" && i < 3
                      ? "bg-[var(--kazi-success)/10] text-[var(--kazi-success)]"
                      : "bg-[var(--kazi-surface)] text-[var(--kazi-muted-text)]"
                }`}
              >
                {step === s || (step === "done" && i < 3) ? (
                  <CheckCircle className="h-3 w-3" />
                ) : (
                  <div className="h-3 w-3 rounded-full border border-[var(--kazi-border)]" />
                )}
                <span>{STEP_LABELS[s as Step]}</span>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-amber-500/50 bg-amber-900/30 p-4 text-sm text-amber-200"
          >
            {error}
          </div>
        )}

        {step === "products" && (
          <section className="mb-8">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-[var(--kazi-display-text)]">
                Add your first products
              </h2>
              <p className="mt-1 text-sm text-[var(--kazi-muted-text)]">
                Add the drinks you sell. You can add them one at a time or import many from a CSV
                file.
              </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              {/* Manual add form */}
              <div className="kazi-card p-6">
                <h3 className="mb-4 text-sm font-semibold text-[var(--kazi-display-text)] uppercase tracking-[.1em]">
                  Add product
                </h3>
                <form onSubmit={addProduct} className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                        Product name
                      </label>
                      <input
                        value={productForm.name}
                        onChange={e => setProductForm({ ...productForm, name: e.target.value })}
                        className="kazi-input"
                        placeholder="e.g. Tusker Lager 500ml"
                        required
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                        SKU
                      </label>
                      <input
                        value={productForm.sku}
                        onChange={e => setProductForm({ ...productForm, sku: e.target.value })}
                        className="kazi-input"
                        placeholder="e.g. TUSK-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                        Category
                      </label>
                      <select
                        value={productForm.category}
                        onChange={e => setProductForm({ ...productForm, category: e.target.value })}
                        className="kazi-input"
                      >
                        <option value="">Select category</option>
                        <option value="beer">Beer</option>
                        <option value="spirits">Spirits</option>
                        <option value="wine">Wine</option>
                        <option value="soft drinks">Soft drinks</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                        Selling price (KES)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={productForm.sellingPrice}
                        onChange={e =>
                          setProductForm({ ...productForm, sellingPrice: e.target.value })
                        }
                        className="kazi-input"
                        required
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                        Cost price (KES)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={productForm.costPrice}
                        onChange={e =>
                          setProductForm({ ...productForm, costPrice: e.target.value })
                        }
                        className="kazi-input"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="kazi-button-primary w-full py-2.5"
                  >
                    {loading ? "Adding..." : "Add product"}
                  </button>
                </form>
              </div>

              {/* CSV import */}
              <div className="kazi-card p-6">
                <h3 className="mb-4 text-sm font-semibold text-[var(--kazi-display-text)] uppercase tracking-[.1em]">
                  Import from CSV
                </h3>
                <p className="mb-3 text-xs text-[var(--kazi-muted-text)]">
                  CSV columns: name, sku, barcode, size, category, costPrice, sellingPrice,
                  minStock, reorderPoint
                </p>
                <form onSubmit={importCsv} className="space-y-3">
                  <label className="block text-xs font-medium text-[var(--kazi-muted-text)]">
                    CSV file
                  </label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) {
                        importCsvFile(file);
                      }
                    }}
                    className="kazi-input"
                  />
                  {csvImportResult && (
                    <div className="kazi-card p-3 bg-[var(--kazi-surface)]">
                      <p className="text-sm text-[var(--kazi-text)]">
                        Imported {csvImportResult.imported} of {csvImportResult.total} products
                      </p>
                      {csvImportResult.errors.length > 0 && (
                        <ul className="mt-2 text-xs text-[var(--kazi-text-error)] space-y-1">
                          {csvImportResult.errors.map(err => (
                            <li key={`${err.row}-${err.error}`}>
                              Row {err.row}: {err.error}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={csvImporting}
                    className="kazi-button-primary w-full py-2.5"
                  >
                    {csvImporting ? "Importing..." : "Import CSV"}
                  </button>
                </form>
              </div>
            </div>

            {products.length > 0 && (
              <div className="mt-6 kazi-card p-4">
                <h3 className="mb-3 text-sm font-semibold text-[var(--kazi-display-text)] uppercase tracking-[.1em]">
                  Products added
                </h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-[var(--kazi-border)]">
                    <thead>
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-[var(--kazi-muted-text)]">
                          Name
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-[var(--kazi-muted-text)]">
                          Price
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-[var(--kazi-muted-text)]">
                          Category
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map(p => (
                        <tr key={p.id} className="hover:bg-[var(--kazi-surface)]/50">
                          <td className="px-3 py-2 text-sm text-[var(--kazi-text)]">{p.name}</td>
                          <td className="px-3 py-2 text-right text-sm text-[var(--kazi-text)]">
                            KES {p.sellingPrice}
                          </td>
                          <td className="px-3 py-2 text-right text-sm text-[var(--kazi-muted-text)]">
                            {p.category || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setStep("stock")}
                disabled={products.length === 0}
                className="kazi-button-primary px-6 py-2.5"
              >
                Next: Set opening stock <ChevronRight className="h-4 w-4 ml-2" />
              </button>
            </div>
          </section>
        )}

        {step === "stock" && (
          <section className="mb-8">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-[var(--kazi-display-text)]">
                Set opening stock
              </h2>
              <p className="mt-1 text-sm text-[var(--kazi-muted-text)]">
                Enter how many units of each product you currently have in stock. This creates the
                opening stock ledger entry so your stock is accurate from day one.
              </p>
            </div>

            <div className="kazi-card p-6">
              {products.length === 0 ? (
                <div className="text-center py-8 text-[var(--kazi-muted-text)]">
                  <p>No products added yet. Go back to add products first.</p>
                  <button
                    onClick={() => setStep("products")}
                    className="mt-4 kazi-button-outline px-4 py-2"
                  >
                    Back to products
                  </button>
                </div>
              ) : (
                <form onSubmit={saveStock} className="space-y-4">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-[var(--kazi-border)]">
                      <thead>
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-[var(--kazi-muted-text)]">
                            Product
                          </th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-[var(--kazi-muted-text)]">
                            Opening stock (units)
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {products.map(p => (
                          <tr key={p.id} className="hover:bg-[var(--kazi-surface)]/50">
                            <td className="px-3 py-2 text-sm text-[var(--kazi-text)]">{p.name}</td>
                            <td className="px-3 py-2 text-right">
                              <input
                                type="number"
                                min="0"
                                value={stockForms.get(p.id) || ""}
                                onChange={e => {
                                  const val = e.target.value;
                                  setStockForms(prev => new Map(prev).set(p.id, val));
                                }}
                                className="kazi-input w-24 text-right"
                                placeholder="0"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-6 flex justify-end">
                    <button
                      type="button"
                      disabled={stockSaving}
                      onClick={saveStock}
                      className="kazi-button-primary px-6 py-2.5"
                    >
                      {stockSaving ? "Saving..." : "Next: Add attendants"}
                      <ChevronRight className="h-4 w-4 ml-2" />
                    </button>
                  </div>
                </form>
              )}
            </div>
          </section>
        )}

        {step === "attendants" && (
          <section className="mb-8">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-[var(--kazi-display-text)]">
                Add attendants
              </h2>
              <p className="mt-1 text-sm text-[var(--kazi-muted-text)]">
                Add the people who will work the till. Attendants can sell and view stock, but
                cannot see cost prices, adjust stock, or void sales.
              </p>
            </div>

            <div className="kazi-card p-6">
              <div className="grid gap-4 md:grid-cols-2">
                <form onSubmit={addAttendant} className="space-y-4">
                  <h3 className="mb-4 text-sm font-semibold text-[var(--kazi-display-text)] uppercase tracking-[.1em]">
                    Add attendant
                  </h3>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                      Full name
                    </label>
                    <input
                      value={attendantForm.name}
                      onChange={e => setAttendantForm({ ...attendantForm, name: e.target.value })}
                      className="kazi-input"
                      placeholder="e.g. Grace Wanjiku"
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                      Email
                    </label>
                    <input
                      type="email"
                      value={attendantForm.email}
                      onChange={e => setAttendantForm({ ...attendantForm, email: e.target.value })}
                      className="kazi-input"
                      placeholder="e.g. grace@shop.com"
                      required
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                      Phone
                    </label>
                    <input
                      value={attendantForm.phone}
                      onChange={e => setAttendantForm({ ...attendantForm, phone: e.target.value })}
                      className="kazi-input"
                      placeholder="e.g. +254700000000"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-xs font-medium text-[var(--kazi-muted-text)]">
                      Password
                    </label>
                    <input
                      type="password"
                      value={attendantForm.password}
                      onChange={e =>
                        setAttendantForm({ ...attendantForm, password: e.target.value })
                      }
                      className="kazi-input"
                      placeholder="••••••••"
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={attendantSaving}
                    className="kazi-button-primary w-full py-2.5"
                  >
                    {attendantSaving ? "Adding..." : "Add attendant"}
                  </button>
                </form>

                {attendants.length > 0 && (
                  <div className="col-span-2">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--kazi-display-text)] uppercase tracking-[.1em]">
                      Attendants added
                    </h3>
                    <div className="space-y-2">
                      {attendants.map(a => (
                        <div
                          key={a.email}
                          className="flex items-center justify-between px-3 py-2 rounded-lg border border-[var(--kazi-border)] bg-[var(--kazi-surface)]"
                        >
                          <span className="text-sm text-[var(--kazi-text)]">{a.name}</span>
                          <span className="text-xs text-[var(--kazi-muted-text)]">{a.email}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-6 flex justify-end">
                <button
                  onClick={completeOnboarding}
                  disabled={loading}
                  className="kazi-button-primary px-6 py-2.5"
                >
                  {loading ? "Finishing..." : "Finish setup & open shop"}
                  <ArrowRight className="h-4 w-4 ml-2" />
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "done" && (
          <div className="kazi-card p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--kazi-success)/10] text-[var(--kazi-success)] mx-auto mb-4">
              <CheckCircle className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-semibold text-[var(--kazi-display-text)]">
              You're ready to sell!
            </h2>
            <p className="mt-2 text-sm text-[var(--kazi-muted-text)]">
              Your shop is set up with products, opening stock, and attendants. Head to the POS to
              start selling.
            </p>
            <div className="mt-6 flex justify-center">
              <button onClick={() => navigate("/pos")} className="kazi-button-primary px-8 py-2.5">
                Go to POS
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
