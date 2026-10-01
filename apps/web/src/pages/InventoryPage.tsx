import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Package, Plus, Search, Truck } from "lucide-react";
import { api, getApiError } from "../lib/api";
import { EmptyRow, LoadingBlock, Notice } from "../components/Feedback";
import { useAuth } from "../contexts/AuthContext";

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
  branchId: string | null;
  branchName: string | null;
}

interface InventoryTotals {
  warehouseCount: number;
  trackedProducts: number;
  totalUnits: number;
  reservedUnits: number;
  availableUnits: number;
  stockValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  pendingTransfers: number;
  lastMovementAt: string | null;
}

interface InventorySummary {
  totals: InventoryTotals;
  warehouses: WarehouseOption[];
  currency: string;
}

type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

interface LevelRow {
  productId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  costPrice: number;
  sellingPrice: number;
  minStock: number;
  reorderPoint: number;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCount: number;
  quantity: number;
  reserved: number;
  available: number;
  status: StockStatus;
  lastMovementAt: string | null;
}

interface MovementRow {
  id: string;
  type: string;
  quantity: number;
  reason: string | null;
  reference: string | null;
  createdAt: string;
  product: { id: string; name: string; sku: string | null } | null;
  warehouse: { id: string; name: string; code: string } | null;
  branch: { id: string; name: string } | null;
}

interface TransferRow {
  id: string;
  quantity: number;
  reference: string | null;
  status: string;
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
  product: { id: string; name: string; sku: string | null; costPrice: number } | null;
  sourceWarehouse: { id: string; name: string; code: string };
  destinationWarehouse: { id: string; name: string; code: string };
  createdBy: { id: string; name: string } | null;
}

const TABS = [
  { id: "levels", label: "Stock levels", icon: Package },
  { id: "movements", label: "Movements", icon: ArrowRight },
  { id: "transfers", label: "Transfers", icon: Truck },
] as const;

type TabId = (typeof TABS)[number]["id"];

const MOVEMENT_TYPES = [
  "OPENING",
  "PURCHASE",
  "SALE",
  "ADJUSTMENT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "RETURN",
] as const;

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: currency === "UGX" ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: string): string {
  if (status === "OUT_OF_STOCK") return "Out of stock";
  if (status === "LOW_STOCK") return "Low stock";
  return "In stock";
}

function badgeClass(status: string): string {
  switch (status) {
    case "IN_STOCK":
    case "COMPLETED":
      return "bg-success/15 text-success";
    case "LOW_STOCK":
    case "PENDING":
      return "bg-warning/15 text-warning";
    case "OUT_OF_STOCK":
      return "bg-danger/15 text-danger";
    default:
      return "bg-surface-muted text-muted-foreground";
  }
}

function movementLabel(type: string): string {
  const words = type.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kazi-stat-card p-4">
      <p className="kazi-stat-label">{label}</p>
      <p className="kazi-stat-value">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface StockFormProps {
  warehouses: WarehouseOption[];
  onDone: (message: string) => void;
  onCancel: () => void;
}

function StockAdjustmentForm({ warehouses, onDone, onCancel }: StockFormProps) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [productId, setProductId] = useState("");
  const [adjustmentType, setAdjustmentType] = useState<"INCREASE" | "DECREASE">("INCREASE");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [options, setOptions] = useState<LevelRow[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!warehouseId) {
      setOptions([]);
      return;
    }
    let active = true;
    setLoadingOptions(true);
    api
      .get("/inventory", { params: { warehouseId, status: "ALL", limit: 200 } })
      .then(res => {
        if (active) setOptions(res.data.data as LevelRow[]);
      })
      .catch(err => {
        if (active) setError(getApiError(err));
      })
      .finally(() => {
        if (active) setLoadingOptions(false);
      });
    return () => {
      active = false;
    };
  }, [warehouseId]);

  useEffect(() => {
    setProductId("");
  }, [warehouseId]);

  const selected = options.find(row => row.productId === productId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(quantity);
    if (!warehouseId || !productId) {
      setError("Choose a warehouse and a product.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Quantity must be greater than zero.");
      return;
    }
    if (!reason.trim()) {
      setError("Add a short reason so the movement can be audited.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.post("/inventory/adjustments", {
        productId,
        warehouseId,
        quantity: Math.round(qty),
        reason: reason.trim(),
        adjustmentType,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      const data = res.data.data;
      onDone(
        `Stock adjusted for ${data.product?.name ?? "product"} at ${data.warehouse?.name ?? "warehouse"}. Available now: ${formatNumber(
          data.level?.available ?? 0
        )}.`
      );
      setQuantity("");
      setReason("");
      setReference("");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="kazi-card mb-6 p-6">
      <h2 className="mb-1 text-lg font-semibold text-foreground">Adjust stock</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Corrections are written to the stock ledger as an adjustment movement. Decreases check the
        available quantity first.
      </p>

      {error && <Notice tone="error" title="Adjustment not saved" message={error} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="adjust-warehouse">
            Warehouse
          </label>
          <select
            id="adjust-warehouse"
            value={warehouseId}
            onChange={e => setWarehouseId(e.target.value)}
            className="kazi-input"
            required
          >
            <option value="">Select a warehouse</option>
            {warehouses.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="adjust-product">
            Product
          </label>
          <select
            id="adjust-product"
            value={productId}
            onChange={e => setProductId(e.target.value)}
            className="kazi-input"
            disabled={!warehouseId || loadingOptions}
            required
          >
            <option value="">{loadingOptions ? "Loading products..." : "Select a product"}</option>
            {options.map(row => (
              <option key={row.productId} value={row.productId}>
                {row.name}
                {row.sku ? ` (${row.sku})` : ""} - {formatNumber(row.available)} available
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="adjust-type">
            Direction
          </label>
          <select
            id="adjust-type"
            value={adjustmentType}
            onChange={e => setAdjustmentType(e.target.value as "INCREASE" | "DECREASE")}
            className="kazi-input"
          >
            <option value="INCREASE">Increase (add stock)</option>
            <option value="DECREASE">Decrease (remove stock)</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="adjust-quantity">
            Quantity
          </label>
          <input
            id="adjust-quantity"
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            className="kazi-input"
            required
          />
          {selected && (
            <p className="mt-1 text-xs text-muted-foreground">
              On hand {formatNumber(selected.quantity)} - reserved {formatNumber(selected.reserved)}{" "}
              - available {formatNumber(selected.available)}
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="adjust-reason">
            Reason
          </label>
          <input
            id="adjust-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Stock count correction, damage, opening balance..."
            className="kazi-input"
            maxLength={200}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="adjust-reference">
            Reference (optional)
          </label>
          <input
            id="adjust-reference"
            value={reference}
            onChange={e => setReference(e.target.value)}
            placeholder="Leave blank to auto-generate a ledger reference"
            className="kazi-input"
            maxLength={100}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className="kazi-button-primary px-4 text-sm" disabled={saving}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {saving ? "Saving..." : "Save adjustment"}
        </button>
        <button type="button" onClick={onCancel} className="kazi-button-secondary px-4 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

function StockTransferForm({ warehouses, onDone, onCancel }: StockFormProps) {
  const [sourceWarehouseId, setSourceWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [destinationWarehouseId, setDestinationWarehouseId] = useState(warehouses[1]?.id ?? "");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [options, setOptions] = useState<LevelRow[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!sourceWarehouseId) {
      setOptions([]);
      return;
    }
    let active = true;
    setLoadingOptions(true);
    api
      .get("/inventory", { params: { warehouseId: sourceWarehouseId, status: "ALL", limit: 200 } })
      .then(res => {
        if (active) setOptions(res.data.data as LevelRow[]);
      })
      .catch(err => {
        if (active) setError(getApiError(err));
      })
      .finally(() => {
        if (active) setLoadingOptions(false);
      });
    return () => {
      active = false;
    };
  }, [sourceWarehouseId]);

  useEffect(() => {
    setProductId("");
  }, [sourceWarehouseId]);

  const selected = options.find(row => row.productId === productId);
  const sourceName =
    warehouses.find(warehouse => warehouse.id === sourceWarehouseId)?.name ??
    "the source warehouse";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(quantity);
    if (!sourceWarehouseId || !destinationWarehouseId || !productId) {
      setError("Choose a source warehouse, a destination warehouse and a product.");
      return;
    }
    if (sourceWarehouseId === destinationWarehouseId) {
      setError("Source and destination warehouses must be different.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Quantity must be greater than zero.");
      return;
    }
    if (selected && qty > selected.available) {
      setError(`Only ${formatNumber(selected.available)} available at ${sourceName}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.post("/inventory/transfers", {
        sourceWarehouseId,
        destinationWarehouseId,
        productId,
        quantity: Math.round(qty),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      const transfer = res.data.data as TransferRow;
      onDone(
        `Transfer ${transfer.reference ?? ""} raised for ${formatNumber(transfer.quantity)} x ${
          transfer.product?.name ?? "product"
        }. Complete it to move the stock.`
      );
      setQuantity("");
      setReference("");
      setNotes("");
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="kazi-card mb-6 p-6">
      <h2 className="mb-1 text-lg font-semibold text-foreground">New warehouse transfer</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Transfers stay pending until completed. Completing one issues the stock from the source and
        receives it at the destination in a single transaction.
      </p>

      {error && <Notice tone="error" title="Transfer not created" message={error} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="transfer-source">
            From warehouse
          </label>
          <select
            id="transfer-source"
            value={sourceWarehouseId}
            onChange={e => setSourceWarehouseId(e.target.value)}
            className="kazi-input"
            required
          >
            <option value="">Select the source</option>
            {warehouses.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            className="mb-1 block text-sm text-muted-foreground"
            htmlFor="transfer-destination"
          >
            To warehouse
          </label>
          <select
            id="transfer-destination"
            value={destinationWarehouseId}
            onChange={e => setDestinationWarehouseId(e.target.value)}
            className="kazi-input"
            required
          >
            <option value="">Select the destination</option>
            {warehouses.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="transfer-product">
            Product
          </label>
          <select
            id="transfer-product"
            value={productId}
            onChange={e => setProductId(e.target.value)}
            className="kazi-input"
            disabled={!sourceWarehouseId || loadingOptions}
            required
          >
            <option value="">{loadingOptions ? "Loading products..." : "Select a product"}</option>
            {options.map(row => (
              <option key={row.productId} value={row.productId} disabled={row.available <= 0}>
                {row.name}
                {row.sku ? ` (${row.sku})` : ""} - {formatNumber(row.available)} available
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="transfer-quantity">
            Quantity
          </label>
          <input
            id="transfer-quantity"
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            className="kazi-input"
            required
          />
          {selected && (
            <p className="mt-1 text-xs text-muted-foreground">
              Available at {sourceName}: {formatNumber(selected.available)}
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="transfer-reference">
            Reference (optional)
          </label>
          <input
            id="transfer-reference"
            value={reference}
            onChange={e => setReference(e.target.value)}
            placeholder="Leave blank to auto-generate"
            className="kazi-input"
            maxLength={100}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="transfer-notes">
            Notes (optional)
          </label>
          <input
            id="transfer-notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Vehicle, dispatch note, requested by..."
            className="kazi-input"
            maxLength={300}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className="kazi-button-primary px-4 text-sm" disabled={saving}>
          <Truck className="h-4 w-4" aria-hidden="true" />
          {saving ? "Creating..." : "Create transfer"}
        </button>
        <button type="button" onClick={onCancel} className="kazi-button-secondary px-4 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function InventoryPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("inventory.view");
  const canManage = hasPermission("inventory.manage");

  const [tab, setTab] = useState<TabId>("levels");
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [warehouseFilter, setWarehouseFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [levels, setLevels] = useState<LevelRow[]>([]);
  const [levelsLoading, setLevelsLoading] = useState(true);
  const [levelsError, setLevelsError] = useState<string | null>(null);
  const [levelsMeta, setLevelsMeta] = useState<{
    scope: string;
    total: number;
    truncated: boolean;
  } | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [movementsError, setMovementsError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [transfersLoading, setTransfersLoading] = useState(false);
  const [transfersError, setTransfersError] = useState<string | null>(null);
  const [transferStatusFilter, setTransferStatusFilter] = useState("ALL");
  const [pendingTransfers, setPendingTransfers] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyTransferId, setBusyTransferId] = useState<string | null>(null);
  const [showAdjustForm, setShowAdjustForm] = useState(false);
  const [showTransferForm, setShowTransferForm] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get("/inventory/summary");
      setSummary(res.data.data as InventorySummary);
      setSummaryError(null);
    } catch (err) {
      setSummaryError(getApiError(err));
    }
  }, []);

  const loadLevels = useCallback(async () => {
    setLevelsLoading(true);
    try {
      const res = await api.get("/inventory", {
        params: {
          ...(warehouseFilter ? { warehouseId: warehouseFilter } : {}),
          ...(searchTerm.trim() ? { search: searchTerm.trim() } : {}),
          status: statusFilter,
          limit: 200,
        },
      });
      setLevels(res.data.data as LevelRow[]);
      setLevelsMeta({
        scope: res.data.meta?.scope ?? "ORGANIZATION",
        total: res.data.meta?.total ?? 0,
        truncated: Boolean(res.data.meta?.truncated),
      });
      setLevelsError(null);
    } catch (err) {
      setLevelsError(getApiError(err));
    } finally {
      setLevelsLoading(false);
    }
  }, [warehouseFilter, searchTerm, statusFilter]);

  const loadMovements = useCallback(async () => {
    setMovementsLoading(true);
    try {
      const res = await api.get("/inventory/movements", {
        params: {
          ...(warehouseFilter ? { warehouseId: warehouseFilter } : {}),
          ...(typeFilter ? { type: typeFilter } : {}),
          limit: 100,
        },
      });
      setMovements(res.data.data as MovementRow[]);
      setMovementsError(null);
    } catch (err) {
      setMovementsError(getApiError(err));
    } finally {
      setMovementsLoading(false);
    }
  }, [warehouseFilter, typeFilter]);

  const loadTransfers = useCallback(async () => {
    setTransfersLoading(true);
    try {
      const res = await api.get("/inventory/transfers", {
        params: {
          ...(warehouseFilter ? { warehouseId: warehouseFilter } : {}),
          status: transferStatusFilter,
          limit: 100,
        },
      });
      setTransfers(res.data.data as TransferRow[]);
      setPendingTransfers(Number(res.data.meta?.pending ?? 0));
      setTransfersError(null);
    } catch (err) {
      setTransfersError(getApiError(err));
    } finally {
      setTransfersLoading(false);
    }
  }, [warehouseFilter, transferStatusFilter]);

  useEffect(() => {
    if (canView) loadSummary();
  }, [canView, loadSummary]);

  useEffect(() => {
    if (canView && tab === "levels") loadLevels();
  }, [canView, tab, loadLevels]);

  useEffect(() => {
    if (canView && tab === "movements") loadMovements();
  }, [canView, tab, loadMovements]);

  useEffect(() => {
    if (canView && tab === "transfers") loadTransfers();
  }, [canView, tab, loadTransfers]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummary(), loadLevels(), loadMovements(), loadTransfers()]);
  }, [loadSummary, loadLevels, loadMovements, loadTransfers]);

  const handleTransferAction = async (transfer: TransferRow, action: "complete" | "cancel") => {
    setBusyTransferId(transfer.id);
    setActionError(null);
    setNotice(null);
    try {
      await api.post(`/inventory/transfers/${transfer.id}/${action}`);
      setNotice(
        action === "complete"
          ? `Transfer ${transfer.reference ?? ""} completed. ${formatNumber(transfer.quantity)} x ${
              transfer.product?.name ?? "product"
            } moved from ${transfer.sourceWarehouse.name} to ${transfer.destinationWarehouse.name}.`
          : `Transfer ${transfer.reference ?? ""} cancelled. No stock was moved.`
      );
      await refreshAll();
    } catch (err) {
      setActionError(getApiError(err));
    } finally {
      setBusyTransferId(null);
    }
  };

  const handleFormDone = async (message: string) => {
    setShowAdjustForm(false);
    setShowTransferForm(false);
    setActionError(null);
    setNotice(message);
    await refreshAll();
  };

  const warehouses = summary?.warehouses ?? [];
  const currency = summary?.currency ?? "USD";

  const levelCounts = useMemo(() => {
    let inStock = 0;
    let low = 0;
    let out = 0;
    for (const row of levels) {
      if (row.status === "IN_STOCK") inStock += 1;
      else if (row.status === "LOW_STOCK") low += 1;
      else out += 1;
    }
    return { inStock, low, out };
  }, [levels]);

  if (!canView) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="kazi-page-title">Inventory</h1>
          <p className="kazi-page-subtitle">Stock levels, movements and warehouse transfers</p>
        </div>
        <div className="kazi-alert-card p-4 text-sm text-foreground">
          You do not have access to inventory. Ask an owner to grant the{" "}
          <span className="font-medium">inventory.view</span> permission to your role.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="kazi-page-title">Inventory</h1>
          <p className="kazi-page-subtitle">
            Stock levels, movement history and warehouse-to-warehouse transfers
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setShowAdjustForm(open => !open);
                setShowTransferForm(false);
              }}
              className="kazi-button-primary px-4 text-sm"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {showAdjustForm ? "Close adjustment" : "Adjust stock"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowTransferForm(open => !open);
                setShowAdjustForm(false);
              }}
              className="kazi-button-secondary px-4 text-sm"
            >
              <Truck className="h-4 w-4" aria-hidden="true" />
              {showTransferForm ? "Close transfer" : "New transfer"}
            </button>
          </div>
        )}
      </div>

      {!canManage && (
        <div className="kazi-alert-card mb-4 p-4 text-sm text-foreground">
          You have read-only access. An owner can grant the{" "}
          <span className="font-medium">inventory.manage</span> permission to let you adjust stock
          and move it between warehouses.
        </div>
      )}

      {notice && <Notice tone="success" title="Done" message={notice} />}
      {actionError && <Notice tone="error" title="Action failed" message={actionError} />}
      {summaryError && (
        <Notice tone="error" title="Could not load the inventory summary" message={summaryError} />
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Warehouses"
          value={String(summary?.totals.warehouseCount ?? 0)}
          hint={`${summary?.totals.trackedProducts ?? 0} products tracking stock`}
        />
        <StatCard
          label="Available units"
          value={formatNumber(summary?.totals.availableUnits ?? 0)}
          hint={`${formatNumber(summary?.totals.reservedUnits ?? 0)} reserved`}
        />
        <StatCard
          label="Stock value (cost)"
          value={formatMoney(summary?.totals.stockValue ?? 0, currency)}
          hint="On-hand quantity at cost price"
        />
        <StatCard
          label="Needs attention"
          value={`${summary?.totals.lowStockCount ?? 0} low / ${summary?.totals.outOfStockCount ?? 0} out`}
          hint={`${pendingTransfers} pending transfer${pendingTransfers === 1 ? "" : "s"}`}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="inventory-warehouse">
            Warehouse
          </label>
          <select
            id="inventory-warehouse"
            value={warehouseFilter}
            onChange={e => setWarehouseFilter(e.target.value)}
            className="kazi-input"
          >
            <option value="">All warehouses</option>
            {warehouses.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
                {warehouse.branchName ? ` - ${warehouse.branchName}` : ""}
              </option>
            ))}
          </select>
        </div>

        {tab === "levels" && (
          <>
            <div className="w-full sm:w-64">
              <label
                className="mb-1 block text-sm text-muted-foreground"
                htmlFor="inventory-search"
              >
                Search
              </label>
              <input
                id="inventory-search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Product name, SKU or barcode"
                className="kazi-input"
              />
            </div>
            <div className="w-full sm:w-48">
              <label
                className="mb-1 block text-sm text-muted-foreground"
                htmlFor="inventory-status"
              >
                Availability
              </label>
              <select
                id="inventory-status"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="kazi-input"
              >
                <option value="ALL">All levels</option>
                <option value="IN_STOCK">In stock</option>
                <option value="LOW_STOCK">Low stock</option>
                <option value="OUT_OF_STOCK">Out of stock</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground sm:pb-3">
              <Search className="mr-1 inline h-3 w-3" aria-hidden="true" />
              {levelsMeta?.total ?? 0} product{(levelsMeta?.total ?? 0) === 1 ? "" : "s"} -{" "}
              {levelsMeta?.scope === "WAREHOUSE" ? "selected warehouse" : "all warehouses"}
            </p>
          </>
        )}

        {tab === "movements" && (
          <div className="w-full sm:w-56">
            <label
              className="mb-1 block text-sm text-muted-foreground"
              htmlFor="inventory-movement-type"
            >
              Movement type
            </label>
            <select
              id="inventory-movement-type"
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="kazi-input"
            >
              <option value="">All movements</option>
              {MOVEMENT_TYPES.map(type => (
                <option key={type} value={type}>
                  {movementLabel(type)}
                </option>
              ))}
            </select>
          </div>
        )}

        {tab === "transfers" && (
          <div className="w-full sm:w-48">
            <label
              className="mb-1 block text-sm text-muted-foreground"
              htmlFor="inventory-transfer-status"
            >
              Status
            </label>
            <select
              id="inventory-transfer-status"
              value={transferStatusFilter}
              onChange={e => setTransferStatusFilter(e.target.value)}
              className="kazi-input"
            >
              <option value="ALL">All transfers</option>
              <option value="PENDING">Pending</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
        )}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map(item => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              data-active={active}
              aria-current={active ? "page" : undefined}
              className="kazi-sidebar-link flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
              {item.id === "transfers" && pendingTransfers > 0 && (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                  {pendingTransfers}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {showAdjustForm && canManage && (
        <StockAdjustmentForm
          warehouses={warehouses}
          onDone={handleFormDone}
          onCancel={() => setShowAdjustForm(false)}
        />
      )}
      {showTransferForm && canManage && (
        <StockTransferForm
          warehouses={warehouses}
          onDone={handleFormDone}
          onCancel={() => setShowTransferForm(false)}
        />
      )}

      {tab === "levels" && (
        <div>
          {levelsError && (
            <Notice tone="error" title="Could not load stock levels" message={levelsError} />
          )}
          {levelsLoading ? (
            <div className="kazi-card">
              <LoadingBlock label="Loading stock levels..." />
            </div>
          ) : (
            <div className="kazi-table-wrap kazi-card">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Product
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Warehouse
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      On hand
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Reserved
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Available
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Min
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Value (cost)
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Last movement
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {levels.map(row => (
                    <tr
                      key={`${row.productId}-${row.warehouseId ?? "all"}`}
                      className="hover:bg-surface-muted/50"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-foreground">
                        {row.name}
                        {row.sku && (
                          <span className="ml-2 text-xs text-muted-foreground">{row.sku}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {row.warehouseName ??
                          `${row.warehouseCount} warehouse${row.warehouseCount === 1 ? "" : "s"}`}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatNumber(row.quantity)}
                        {row.unit ? ` ${row.unit}` : ""}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatNumber(row.reserved)}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-foreground">
                        {formatNumber(row.available)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{row.minStock}</td>
                      <td className="px-4 py-3 text-sm">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${badgeClass(row.status)}`}
                        >
                          {statusLabel(row.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatMoney(row.available * row.costPrice, currency)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDateTime(row.lastMovementAt)}
                      </td>
                    </tr>
                  ))}
                  {!levels.length && (
                    <EmptyRow
                      colSpan={9}
                      message="No stock records match these filters yet. Try another warehouse, or record a stock adjustment to open a balance."
                    />
                  )}
                </tbody>
              </table>
            </div>
          )}
          {!levelsLoading && levels.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing {levels.length} of {levelsMeta?.total ?? levels.length} -{" "}
              {levelCounts.inStock} in stock - {levelCounts.low} low - {levelCounts.out} out of
              stock
              {levelsMeta?.truncated
                ? " - results truncated, narrow the filters for a complete view"
                : ""}
            </p>
          )}
        </div>
      )}

      {tab === "movements" && (
        <div>
          {movementsError && (
            <Notice tone="error" title="Could not load stock movements" message={movementsError} />
          )}
          {movementsLoading ? (
            <div className="kazi-card">
              <LoadingBlock label="Loading movement history..." />
            </div>
          ) : (
            <div className="kazi-table-wrap kazi-card">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      When
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Product
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Warehouse
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Change
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Reference
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {movements.map(movement => (
                    <tr key={movement.id} className="hover:bg-surface-muted/50">
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDateTime(movement.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${badgeClass(movement.quantity < 0 ? "CANCELLED" : "COMPLETED")}`}
                        >
                          {movementLabel(movement.type)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-foreground">
                        {movement.product?.name ?? "-"}
                        {movement.product?.sku && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {movement.product.sku}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {movement.warehouse?.name ?? "-"}
                        {movement.branch?.name ? (
                          <span className="ml-1 text-xs">({movement.branch.name})</span>
                        ) : null}
                      </td>
                      <td
                        className={`px-4 py-3 text-sm font-medium ${
                          movement.quantity < 0 ? "text-danger" : "text-success"
                        }`}
                      >
                        {movement.quantity > 0 ? "+" : ""}
                        {formatNumber(movement.quantity)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {movement.reference ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {movement.reason ?? "-"}
                      </td>
                    </tr>
                  ))}
                  {!movements.length && (
                    <EmptyRow
                      colSpan={7}
                      message="No stock movements recorded yet. Sales, adjustments and completed transfers appear here."
                    />
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "transfers" && (
        <div>
          {transfersError && (
            <Notice tone="error" title="Could not load transfers" message={transfersError} />
          )}
          {transfersLoading ? (
            <div className="kazi-card">
              <LoadingBlock label="Loading transfers..." />
            </div>
          ) : (
            <div className="kazi-table-wrap kazi-card">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Reference
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Product
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Route
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Quantity
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Raised
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {transfers.map(transfer => (
                    <tr key={transfer.id} className="hover:bg-surface-muted/50">
                      <td className="px-4 py-3 text-sm font-medium text-foreground">
                        {transfer.reference ?? transfer.id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {transfer.product?.name ?? "-"}
                        {transfer.product?.sku && (
                          <span className="ml-2 text-xs">{transfer.product.sku}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {transfer.sourceWarehouse.name} to {transfer.destinationWarehouse.name}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-foreground">
                        {formatNumber(transfer.quantity)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${badgeClass(transfer.status)}`}
                        >
                          {transfer.status.charAt(0) + transfer.status.slice(1).toLowerCase()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDateTime(transfer.createdAt)}
                        <span className="block text-xs">
                          {transfer.createdBy?.name ? `by ${transfer.createdBy.name}` : ""}
                          {transfer.completedAt
                            ? ` - completed ${formatDateTime(transfer.completedAt)}`
                            : ""}
                        </span>
                        {transfer.notes && (
                          <span className="block text-xs italic">{transfer.notes}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {transfer.status === "PENDING" && canManage ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => handleTransferAction(transfer, "complete")}
                              disabled={busyTransferId === transfer.id}
                              className="kazi-button-primary px-3 py-1 text-xs disabled:opacity-50"
                            >
                              {busyTransferId === transfer.id ? "Working..." : "Complete"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleTransferAction(transfer, "cancel")}
                              disabled={busyTransferId === transfer.id}
                              className="kazi-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {transfer.status === "PENDING" ? "Needs inventory.manage" : "No action"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!transfers.length && (
                    <EmptyRow
                      colSpan={7}
                      message="No transfers yet. Use New transfer to move stock between warehouses; nothing moves until you complete it."
                    />
                  )}
                </tbody>
              </table>
            </div>
          )}
          {!transfersLoading && transfers.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing {transfers.length} transfer{transfers.length === 1 ? "" : "s"} -{" "}
              {pendingTransfers} pending
            </p>
          )}
        </div>
      )}
    </div>
  );
}
