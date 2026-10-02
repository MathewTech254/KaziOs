import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Banknote,
  CheckCircle,
  Minus,
  Package,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  ShoppingBag,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import { getApiError } from "../lib/api";
import { useCardPayment } from "../lib/useCardPayment";
import { useAuth } from "../contexts/AuthContext";
// The till prices a cart with the same maths the server prices it with. If the two
// disagree, the total on screen is not the total that gets charged.
import { computeCartTotals, summarizeTender, toCurrency } from "../lib/posTotals";

interface Branch {
  id: string;
  name: string;
  code: string;
  isMain: boolean;
}

interface Warehouse {
  id: string;
  name: string;
  code: string;
  branchId?: string | null;
}

interface Category {
  id: string;
  name: string;
  _count: { products: number };
}

interface PaymentMethod {
  id: string;
  label: string;
  provider: "PAYSTACK" | "MPESA" | "BANK" | "MANUAL" | "CASH" | "CHECK";
  methodType: "card" | "bank_transfer" | "mobile_money" | "cash" | "check" | "manual";
  configured: boolean;
}

interface PosContext {
  organization: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
  };
  branches: Branch[];
  warehouses: Warehouse[];
  categories: Category[];
  paymentMethods: PaymentMethod[];
  // Present only when the server is ready to take cards. Its absence simply hides card
  // payments, so a branch without keys is never shown a card option it cannot use.
  cardPublicKey?: string | null;
}

interface Product {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  sellingPrice: number;
  costPrice: number;
  minStock: number;
  productType: string;
  trackStock: boolean;
  stockQuantity: number;
  stockStatus: "OUT_OF_STOCK" | "LOW_STOCK" | "IN_STOCK";
  taxRate: number;
  taxMode: "EXCLUSIVE" | "INCLUSIVE";
  taxCategory?: { id: string; name: string; rate: number; mode: string } | null;
  inventories?: { warehouseId: string; quantity: number; reserved: number }[];
}

interface CartLine extends Product {
  quantity: number;
  discountAmount: number;
}

interface ReceiptData {
  invoice: {
    id: string;
    invoiceNumber: string;
    total: number;
    currency: string;
    createdAt: string;
    status: string;
    paidAmount: number;
    // Present on a sale that was attributed to someone, null on a walk-in.
    customer?: { id: string; name: string; phone?: string | null } | null;
    items: {
      id: string;
      description: string;
      quantity: number;
      unitPrice: number;
      discountAmount: number;
      taxAmount: number;
      lineTotal: number;
      product?: Product | null;
    }[];
    payments: { id: string; amount: number; provider: string; methodType: string }[];
  };
  receiptNumber: string;
  changeAmount: number;
  currency: string;
  idempotent?: boolean;
}

interface ProductsResponse {
  data: Product[];
  meta: { page: number; limit: number; total: number };
}

interface PosCustomer {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
}

// Card is listed because the server verifies it properly: the till records the sale, then
// Paystack confirms the money before the invoice is ever marked paid.
const immediatePaymentProviders = new Set(["CASH", "BANK", "MANUAL", "CHECK", "PAYSTACK"]);

function formatMoney(value: number, currency: string): string {
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

function stockLabel(status: string): string {
  if (status === "OUT_OF_STOCK") return "Out of stock";
  if (status === "LOW_STOCK") return "Low stock";
  return "In stock";
}

export function PosPage() {
  const { hasPermission } = useAuth();
  const [context, setContext] = useState<PosContext | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [search, setSearch] = useState("");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [tenderedAmount, setTenderedAmount] = useState("");
  // Once the cashier types a figure, the total no longer overwrites it. Until then the
  // field is derived from the cart and stays correct as items are added or removed.
  const [tenderedTouched, setTenderedTouched] = useState(false);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  // Paystack sends the customer a receipt, so card payments need an email up front.
  const [customerEmail, setCustomerEmail] = useState("");
  // Null is a walk-in sale, which is the default for ordinary retail. It is stored as a
  // null customer rather than a placeholder "Walk-in Customer" row, because creating one
  // row per anonymous sale would flood the customer table and corrupt every report that
  // counts customers. Attaching a real customer is what makes history and loyalty work.
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<PosCustomer[]>([]);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  // A cashier may attach a customer they can see but must not be able to invent one, so
  // quick create is offered only to a role that already holds customers.create.
  const canCreateCustomers = hasPermission("customers.create");
  const cardPayment = useCardPayment();

  const availablePaymentMethods = useMemo(
    () =>
      (context?.paymentMethods || []).filter(
        method => method.configured && immediatePaymentProviders.has(method.provider)
      ),
    [context]
  );

  const selectedPaymentMethod =
    availablePaymentMethods.find(method => method.id === paymentMethodId) ||
    availablePaymentMethods[0];

  // A receipt must never claim money was taken when it was not. Card sales are created
  // unpaid and only turn paid once the server confirms the money with Paystack.
  const isReceiptPaid = receipt
    ? receipt.invoice.status === "PAID" ||
      receipt.invoice.paidAmount + 0.001 >= receipt.invoice.total
    : false;

  const totals = useMemo(() => {
    const result = computeCartTotals(cart);
    return {
      ...result,
      subtotal: toCurrency(result.subtotalCents),
      tax: toCurrency(result.taxCents),
      discount: toCurrency(result.discountCents),
      total: toCurrency(result.totalCents),
    };
  }, [cart]);

  // How the cash in hand stands against the total, so the cashier is told what is
  // missing or what change to hand back rather than being met with a rejection.
  const tender = useMemo(
    () => summarizeTender(tenderedAmount, totals.totalCents),
    [tenderedAmount, totals.totalCents]
  );

  const loadContext = async () => {
    setError("");
    try {
      const res = await api.get("/pos/context");
      const nextContext: PosContext = res.data.data;
      setContext(nextContext);
      const mainBranch =
        nextContext.branches.find(branch => branch.isMain) || nextContext.branches[0];
      const mainWarehouse =
        nextContext.warehouses.find(warehouse => warehouse.branchId === mainBranch?.id) ||
        nextContext.warehouses[0];
      setBranchId(mainBranch?.id || "");
      setWarehouseId(mainWarehouse?.id || "");
      setPaymentMethodId(
        nextContext.paymentMethods.find(method => method.provider === "CASH")?.id ||
          nextContext.paymentMethods[0]?.id ||
          ""
      );
      setTenderedAmount("");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const loadProducts = async (nextPage = 1) => {
    setLoadingProducts(true);
    setError("");
    const params = new URLSearchParams({ page: String(nextPage), limit: "60" });
    if (search.trim()) params.set("search", search.trim());
    if (branchId) params.set("branchId", branchId);
    if (warehouseId) params.set("warehouseId", warehouseId);
    if (categoryId) params.set("categoryId", categoryId);
    try {
      const res = await api.get<ProductsResponse>(`/pos/products?${params.toString()}`);
      setProducts(nextPage === 1 ? res.data.data : [...products, ...res.data.data]);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoadingProducts(false);
    }
  };

  useEffect(() => {
    if (!hasPermission("pos.sale")) {
      setLoading(false);
      return;
    }
    void loadContext();
  }, [hasPermission]);

  useEffect(() => {
    if (!context || !hasPermission("pos.sale")) return;
    const timer = window.setTimeout(() => void loadProducts(1), 250);
    return () => window.clearTimeout(timer);
  }, [context, branchId, warehouseId, categoryId, search, hasPermission]);

  // The cash tendered field follows the total until the cashier overrides it by typing.
  //
  // It used to be seeded only while the field was empty, so once it held the total for
  // the first product it was never refreshed: adding a second product left the old
  // figure in the box, and submitting a sale whose total had grown was rejected with
  // "Tendered amount must be at least the sale total" against a number the cashier had
  // never entered. A field the cashier has typed into is left alone, because a note
  // rounded up to the next 500 is a deliberate choice, not a stale value.
  useEffect(() => {
    if (!selectedPaymentMethod) return;
    if (selectedPaymentMethod.provider !== "CASH" || tenderedTouched) return;
    setTenderedAmount(totals.total.toFixed(2));
  }, [selectedPaymentMethod, totals.total, tenderedTouched]);

  /**
   * Looks a customer up as the cashier types, by name, phone or email.
   *
   * Debounced and cancelled on every change, so a fast typist does not have one search's
   * results overwrite another's and leave the wrong customer on the list. A two character
   * floor matches the rest of the system: a one character term would return a large slice
   * of the customer table and tell the cashier nothing.
   */
  useEffect(() => {
    const term = customerQuery.trim();
    if (term.length < 2) {
      setCustomerResults([]);
      setSearchingCustomers(false);
      return;
    }
    let active = true;
    setSearchingCustomers(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.get(`/customers?search=${encodeURIComponent(term)}&limit=8`);
        // A response for a term the cashier has already replaced is discarded, so the
        // list always matches what is in the box.
        if (active) setCustomerResults(res.data.data || []);
      } catch {
        if (active) setCustomerResults([]);
      } finally {
        if (active) setSearchingCustomers(false);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [customerQuery]);

  const selectCustomer = (next: PosCustomer | null) => {
    setCustomer(next);
    setCustomerQuery("");
    setCustomerResults([]);
  };

  /**
   * Creates a customer and attaches them in one action, so a manager selling to someone
   * new does not have to leave the till, save the sale, and go and register them
   * afterwards. The sale is not blocked if this fails: the customer simply stays
   * unattached and the sale still completes.
   */
  const quickCreateCustomer = async (name: string, phone: string) => {
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError("Enter the customer's name to add them.");
      return null;
    }
    try {
      const res = await api.post("/customers", {
        name: trimmedName,
        // Phone is the one field worth asking for at a till: it is how the person will be
        // recognised next time, and how a receipt or reminder would reach them.
        phone: phone.trim() || null,
      });
      const created: PosCustomer = res.data.data;
      selectCustomer(created);
      // A card receipt goes to an email, and typing one the customer has already given
      // beats asking for it a second time.
      if (created.email) setCustomerEmail(created.email);
      return created;
    } catch (err) {
      setError(getApiError(err));
      return null;
    }
  };

  const addToCart = (product: Product) => {
    if (product.stockQuantity <= 0) return;
    setError("");
    setCart(current => {
      const existing = current.find(line => line.id === product.id);
      if (existing) {
        return current.map(line =>
          line.id === product.id ? { ...line, quantity: line.quantity + 1 } : line
        );
      }
      return [...current, { ...product, quantity: 1, discountAmount: 0 }];
    });
  };

  const updateQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      setCart(current => current.filter(line => line.id !== productId));
      return;
    }
    setCart(current => current.map(line => (line.id === productId ? { ...line, quantity } : line)));
  };

  const removeFromCart = (productId: string) => {
    setCart(current => current.filter(line => line.id !== productId));
  };

  const handleBranchChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextBranchId = event.target.value;
    setBranchId(nextBranchId);
    const nextWarehouse =
      context?.warehouses.find(warehouse => warehouse.branchId === nextBranchId) ||
      context?.warehouses[0];
    setWarehouseId(nextWarehouse?.id || "");
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!cart.length || !selectedPaymentMethod) return;
    setSubmitting(true);
    setError("");
    const total = totals.total;
    const isCard = selectedPaymentMethod.provider === "PAYSTACK";
    const isCash = selectedPaymentMethod.provider === "CASH";
    if (isCash && !tender.coversTotal) {
      // The amount is named because "not enough" leaves the cashier to guess by how
      // much, and a till that only says no is a till that stalls the queue.
      setError(
        `Tendered amount must be at least the sale total. Short by ${formatMoney(
          toCurrency(tender.shortfallCents),
          context?.organization.currency || "KES"
        )}`
      );
      setSubmitting(false);
      return;
    }
    if (isCard) {
      // Paystack needs an addressable customer to send the receipt to.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())) {
        setError("Enter the customer's email so they can receive the card receipt");
        setSubmitting(false);
        return;
      }
      if (!context?.cardPublicKey) {
        setError("Card payments are not available on this terminal");
        setSubmitting(false);
        return;
      }
    }

    try {
      const res = await api.post<{
        data: ReceiptData & { requiresCardPayment?: boolean; invoiceId?: string };
      }>("/pos/sale", {
        branchId: branchId || null,
        warehouseId: warehouseId || null,
        // Null for a walk-in, which is the ordinary case and needs no registration.
        customerId: customer?.id || null,
        items: cart.map(line => ({
          productId: line.id,
          quantity: line.quantity,
          discountAmount: line.discountAmount,
        })),
        discountAmount: 0,
        payments: [
          {
            provider: selectedPaymentMethod.provider,
            methodType: selectedPaymentMethod.methodType,
            amount: total,
            ...(isCash ? { tenderedAmount: toCurrency(tender.tenderedCents) } : {}),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
          },
        ],
        notes: notes.trim() || null,
        idempotencyKey: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });

      const sale = res.data.data;

      if (isCard && sale.invoiceId) {
        // The sale is recorded but not yet paid. Take the card payment now; the invoice is
        // only marked paid once the server confirms the money with Paystack.
        const paid = await cardPayment.startCardPayment(sale.invoiceId, customerEmail.trim());

        // Refresh the receipt so a successful card sale shows as paid.
        if (paid) {
          try {
            const receiptRes = await api.get<{ data: ReceiptData }>(
              `/pos/receipt/${sale.invoiceId}`
            );
            setReceipt(receiptRes.data.data);
          } catch {
            setReceipt(sale);
          }
        } else {
          // The sale exists and stock has moved, so the cashier is told exactly that rather
          // than being left to guess whether the customer still owes money.
          setReceipt(sale);
          setError(
            cardPayment.error ||
              "The card payment was not completed. The sale is saved and unpaid; take payment another way."
          );
        }
      } else {
        setReceipt(sale);
      }

      setCart([]);
      setTenderedAmount("");
      // The next sale starts as a fresh walk-in. Carrying the previous customer over
      // would silently attribute an unrelated sale to them, which is worse than losing
      // the attribution on a genuine walk-in.
      selectCustomer(null);
      // The next sale starts from a derived tendered field again, so it follows its
      // first product rather than inheriting a figure typed for the last one.
      setTenderedTouched(false);
      setReference("");
      setNotes("");
      if (isCard) setCustomerEmail("");
      await loadProducts(1);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const startNewSale = () => {
    setReceipt(null);
    setCart([]);
    setTenderedAmount("");
    setTenderedTouched(false);
    selectCustomer(null);
    setReference("");
    setNotes("");
    setError("");
    // Clears the card banner so the next sale starts from a clean till.
    cardPayment.reset();
  };

  if (!hasPermission("pos.sale")) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="kazi-card max-w-md p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-10 w-10 text-danger" />
          <h1 className="kazi-page-title">POS access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your role does not include the pos.sale permission.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-muted-foreground">
        Loading POS...
      </div>
    );
  }

  if (!context) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="kazi-card max-w-md p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-10 w-10 text-danger" />
          <h1 className="kazi-page-title">POS unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {error || "The POS context could not be loaded."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col gap-5 lg:flex-row">
      <div className="min-w-0 flex-1">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="kazi-page-title">Point of Sale</h1>
            <p className="kazi-page-subtitle">
              {context.organization.name} · {context.organization.currency}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1.5 text-success">
              <CheckCircle className="h-3.5 w-3.5" /> Terminal ready
            </span>
          </div>
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

        <div className="kazi-card mb-5 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Branch</label>
              <select value={branchId} onChange={handleBranchChange} className="kazi-input">
                {context.branches.map(branch => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} {branch.isMain ? "(Main)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Warehouse
              </label>
              <select
                value={warehouseId}
                onChange={event => setWarehouseId(event.target.value)}
                className="kazi-input"
              >
                {context.warehouses
                  .filter(warehouse => !branchId || warehouse.branchId === branchId)
                  .map(warehouse => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name} {warehouse.branchId === branchId ? "" : "(Default)"}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Category
              </label>
              <select
                value={categoryId}
                onChange={event => setCategoryId(event.target.value)}
                className="kazi-input"
              >
                <option value="">All categories</option>
                {context.categories.map(category => (
                  <option key={category.id} value={category.id}>
                    {category.name} ({category._count.products})
                  </option>
                ))}
              </select>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search products or barcode"
                className="kazi-input pl-9"
              />
            </div>
          </div>
        </div>

        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Products</h2>
            <p className="text-xs text-muted-foreground">
              {products.length ? `${products.length} available products` : "No products found"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadProducts(1)}
            className="inline-flex items-center gap-2 text-xs font-medium text-accent hover:text-accent-hover"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        {loadingProducts && !products.length ? (
          <div className="kazi-card flex min-h-[16rem] items-center justify-center text-sm text-muted-foreground">
            Loading products...
          </div>
        ) : products.length ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {products.map(product => (
              <button
                type="button"
                key={product.id}
                onClick={() => addToCart(product)}
                disabled={product.stockQuantity <= 0}
                className="kazi-card group flex min-h-[10.5rem] flex-col gap-3 p-4 text-left transition hover:border-accent/50 hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Package className="h-5 w-5" />
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${product.stockStatus === "OUT_OF_STOCK" ? "bg-danger/10 text-danger" : product.stockStatus === "LOW_STOCK" ? "bg-warning/10 text-warning" : "bg-success/10 text-success"}`}
                  >
                    {stockLabel(product.stockStatus)}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold text-foreground">{product.name}</h3>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {product.sku
                      ? `SKU ${product.sku}`
                      : product.barcode
                        ? `Barcode ${product.barcode}`
                        : product.productType}
                  </p>
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {product.stockQuantity} in stock
                    </p>
                    <p className="kazi-display text-lg font-semibold text-accent">
                      {formatMoney(product.sellingPrice, context.organization.currency)}
                    </p>
                  </div>
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-accent transition group-hover:bg-accent group-hover:text-accent-foreground">
                    <Plus className="h-4 w-4" />
                  </span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="kazi-card flex min-h-[16rem] flex-col items-center justify-center text-center">
            <Package className="mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="font-semibold text-foreground">No products found</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Try a different search or add products to your catalog.
            </p>
          </div>
        )}
      </div>

      <aside className="kazi-card flex w-full flex-col gap-4 p-4 lg:w-[26rem] lg:shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Current Sale</h2>
            <p className="text-xs text-muted-foreground">
              {cart.length} {cart.length === 1 ? "item" : "items"}
            </p>
          </div>
          {cart.length > 0 && (
            <button
              type="button"
              onClick={() => setCart([])}
              className="inline-flex items-center gap-1.5 text-xs text-danger hover:text-danger/80"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          )}
        </div>

        {/* Customer, sitting above the cart because who is buying is a decision made
            before what they are buying, and because attaching one afterwards is exactly
            the step a busy till forgets. */}
        <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
          {customer ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{customer.name}</p>
                {customer.phone && (
                  <p className="truncate text-xs text-muted-foreground">{customer.phone}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => selectCustomer(null)}
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            </div>
          ) : (
            <>
              <label
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
                htmlFor="pos-customer"
              >
                Customer
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  id="pos-customer"
                  value={customerQuery}
                  onChange={event => setCustomerQuery(event.target.value)}
                  className="kazi-input pl-9"
                  placeholder="Walk-in, or search by name or phone"
                  autoComplete="off"
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Walk-in is fine for most sales. Attach a customer to keep their history.
              </p>

              {(searchingCustomers || customerResults.length > 0) && (
                <div className="mt-2 rounded-md border border-border bg-surface">
                  {searchingCustomers && !customerResults.length && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
                  )}
                  {customerResults.map(result => (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => selectCustomer(result)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-muted"
                    >
                      <span className="block truncate font-medium text-foreground">
                        {result.name}
                      </span>
                      {result.phone && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {result.phone}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {canCreateCustomers &&
                customerQuery.trim().length >= 2 &&
                !customerResults.length && (
                  <button
                    type="button"
                    onClick={() => void quickCreateCustomer(customerQuery, "")}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add “{customerQuery.trim()}” as a new customer
                  </button>
                )}
            </>
          )}
        </div>

        <div className="flex min-h-[14rem] max-h-[32rem] flex-col gap-2 overflow-y-auto pr-1">
          {cart.length ? (
            cart.map(line => (
              <div
                key={line.id}
                className="rounded-lg border border-border bg-surface-muted/60 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{line.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatMoney(line.sellingPrice, context.organization.currency)} each
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFromCart(line.id)}
                    aria-label={`Remove ${line.name}`}
                    className="text-muted-foreground hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="inline-flex items-center rounded-md border border-border">
                    <button
                      type="button"
                      onClick={() => updateQuantity(line.id, line.quantity - 1)}
                      aria-label="Decrease quantity"
                      className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-8 text-center text-sm tabular-nums">{line.quantity}</span>
                    <button
                      type="button"
                      onClick={() => updateQuantity(line.id, line.quantity + 1)}
                      aria-label="Increase quantity"
                      className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.discountAmount}
                    onChange={event =>
                      setCart(current =>
                        current.map(item =>
                          item.id === line.id
                            ? { ...item, discountAmount: Math.max(0, Number(event.target.value)) }
                            : item
                        )
                      )
                    }
                    aria-label="Line discount"
                    className="kazi-input h-8 min-h-0 px-2 text-xs"
                  />
                </div>
              </div>
            ))
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center">
              <ShoppingBag className="mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">Your cart is empty</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Select a product to start a sale.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span>{formatMoney(totals.subtotal, context.organization.currency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Tax</span>
            <span>{formatMoney(totals.tax, context.organization.currency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Discount</span>
            <span>- {formatMoney(totals.discount, context.organization.currency)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-3 text-base font-semibold text-foreground">
            <span>Total</span>
            <span className="kazi-display text-xl text-accent">
              {formatMoney(totals.total, context.organization.currency)}
            </span>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Payment method
          </label>
          <select
            value={selectedPaymentMethod?.id || ""}
            onChange={event => setPaymentMethodId(event.target.value)}
            className="kazi-input"
          >
            {availablePaymentMethods.map(method => (
              <option key={method.id} value={method.id}>
                {method.label}
              </option>
            ))}
          </select>
          {selectedPaymentMethod?.provider === "CASH" && (
            <div className="mt-3">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Cash tendered
              </label>
              <div className="relative">
                <Banknote className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={tenderedAmount}
                  onChange={event => {
                    setTenderedTouched(true);
                    setTenderedAmount(event.target.value);
                  }}
                  className="kazi-input pl-9"
                />
              </div>
              {/* The cashier needs the change while the customer is still at the
                  counter. Without it the only feedback is a rejection on submit, which
                  arrives after the money has already been counted out. */}
              {cart.length > 0 && tender.changeCents > 0 && (
                <p className="mt-1.5 text-xs text-success">
                  Change due:{" "}
                  {formatMoney(toCurrency(tender.changeCents), context.organization.currency)}
                </p>
              )}
              {cart.length > 0 && tender.shortfallCents > 0 && (
                <p className="mt-1.5 text-xs text-danger">
                  Short by{" "}
                  {formatMoney(toCurrency(tender.shortfallCents), context.organization.currency)}
                </p>
              )}
            </div>
          )}
          {selectedPaymentMethod &&
            ["BANK", "MANUAL", "CHECK"].includes(selectedPaymentMethod.provider) && (
              <div className="mt-3">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Reference
                </label>
                <input
                  value={reference}
                  onChange={event => setReference(event.target.value)}
                  placeholder="Optional reference"
                  className="kazi-input"
                />
              </div>
            )}
          {selectedPaymentMethod?.provider === "PAYSTACK" && (
            <div className="mt-3">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Customer email
              </label>
              <input
                type="email"
                value={customerEmail}
                onChange={event => setCustomerEmail(event.target.value)}
                placeholder="customer@example.com"
                autoComplete="email"
                className="kazi-input"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                The customer pays by card on the next screen. They will receive a receipt at this
                address.
              </p>
            </div>
          )}
        </div>

        {/* Clear, honest feedback while the customer is in the payment window. */}
        {cardPayment.stage !== "IDLE" && (
          <div
            className={`rounded-lg border p-3 text-sm ${
              cardPayment.stage === "SUCCESS"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : cardPayment.stage === "FAILED"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-blue-200 bg-blue-50 text-blue-800"
            }`}
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 font-medium">
              {cardPayment.stage === "SUCCESS" ? (
                <CheckCircle className="h-4 w-4" />
              ) : cardPayment.stage === "FAILED" ? (
                <AlertCircle className="h-4 w-4" />
              ) : (
                <RotateCcw className="h-4 w-4 animate-spin" />
              )}
              <span>
                {cardPayment.stage === "STARTING" && "Opening secure payment..."}
                {cardPayment.stage === "AWAITING_CUSTOMER" &&
                  "Waiting for the customer to complete payment..."}
                {cardPayment.stage === "VERIFYING" && "Confirming payment with Paystack..."}
                {cardPayment.stage === "SUCCESS" && "Payment received"}
                {cardPayment.stage === "FAILED" && "Payment not completed"}
              </span>
            </div>
            {cardPayment.error && <p className="mt-1.5 text-xs">{cardPayment.error}</p>}
            {cardPayment.reference && (
              <p className="mt-1.5 font-mono text-xs">Reference: {cardPayment.reference}</p>
            )}
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Notes</label>
          <textarea
            value={notes}
            onChange={event => setNotes(event.target.value)}
            rows={2}
            placeholder="Add a note for this sale"
            className="kazi-input resize-none"
          />
        </div>

        <button
          type="submit"
          form="pos-sale-form"
          disabled={!cart.length || submitting}
          className="kazi-button-primary w-full px-4"
        >
          {submitting
            ? selectedPaymentMethod?.provider === "PAYSTACK"
              ? cardPayment.stage === "VERIFYING"
                ? "Confirming payment..."
                : "Opening payment..."
              : "Processing..."
            : `Charge ${formatMoney(totals.total, context.organization.currency)}`}
          {!submitting && <ArrowRight className="h-4 w-4" />}
        </button>
      </aside>

      <form id="pos-sale-form" onSubmit={handleSubmit} className="hidden" />

      {receipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="kazi-card max-w-lg w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-full ${isReceiptPaid ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}
                >
                  {isReceiptPaid ? (
                    <CheckCircle className="h-5 w-5" />
                  ) : (
                    <AlertCircle className="h-5 w-5" />
                  )}
                </div>
                <div>
                  <h2 className="kazi-page-title">
                    {isReceiptPaid ? "Sale completed" : "Sale saved, payment due"}
                  </h2>
                  <p className="kazi-page-subtitle">
                    Receipt {receipt.receiptNumber}
                    {/* The cashier needs to see the attribution on the receipt they hand
                        over: a sale attached to the wrong person is a credit and loyalty
                        problem that is far harder to unpick later. */}
                    {receipt.invoice.customer && ` · ${receipt.invoice.customer.name}`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={startNewSale}
                aria-label="Close receipt"
                className="text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
            <div
              className={`rounded-lg p-4 text-center ${isReceiptPaid ? "bg-surface-muted" : "bg-warning/10"}`}
            >
              <p className="text-sm text-muted-foreground">
                {isReceiptPaid ? "Amount paid" : "Amount owed"}
              </p>
              <p className="kazi-display mt-1 text-3xl font-semibold text-accent">
                {formatMoney(receipt.invoice.total, receipt.currency)}
              </p>
              {receipt.changeAmount > 0 && (
                <p className="mt-1 text-xs text-success">
                  Change: {formatMoney(receipt.changeAmount, receipt.currency)}
                </p>
              )}
              {!isReceiptPaid && (
                <p className="mt-2 text-xs text-muted-foreground">
                  The stock for this sale has been recorded. The card payment did not complete, so
                  the customer still owes this amount.
                </p>
              )}
            </div>
            <div className="mt-5 space-y-2">
              {receipt.invoice.items.map(item => (
                <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-foreground">
                    {item.description} × {item.quantity}
                  </span>
                  <span className="text-muted-foreground">
                    {formatMoney(item.lineTotal, receipt.currency)}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between border-t border-border pt-4 text-sm text-muted-foreground">
              <span>Payment</span>
              <span>
                {receipt.invoice.payments.length
                  ? receipt.invoice.payments.map(payment => payment.provider).join(", ")
                  : "Card payment not completed"}
              </span>
            </div>
            <button
              type="button"
              onClick={startNewSale}
              className="kazi-button-primary mt-6 w-full px-4"
            >
              <Receipt className="h-4 w-4" /> Start new sale
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
