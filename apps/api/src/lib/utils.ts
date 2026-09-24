import { randomUUID } from "crypto";

export function generateId(): string {
  return randomUUID();
}

export function generateInvoiceNumber(prefix = "INV"): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const rnd = randomUUID().slice(-4).toUpperCase();
  return `${prefix}-${y}${m}${d}-${rnd}`;
}

export function generatePoNumber(prefix = "PO"): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const rnd = randomUUID().slice(-4).toUpperCase();
  return `${prefix}-${y}${m}-${rnd}`;
}

export function generateQuoteNumber(prefix = "QT"): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const rnd = randomUUID().slice(-4).toUpperCase();
  return `${prefix}-${y}${m}-${rnd}`;
}

export function generateOrderNumber(prefix = "SO"): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const rnd = randomUUID().slice(-4).toUpperCase();
  return `${prefix}-${y}${m}-${rnd}`;
}

/** Reference used for stock adjustments ("ADJ") and transfers ("TRF"). */
export function generateStockReference(prefix = "ADJ"): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const rnd = randomUUID().slice(-4).toUpperCase();
  return `${prefix}-${y}${m}-${rnd}`;
}

export function paginate(page = 1, limit = 50) {
  const p = Math.max(1, page);
  const l = Math.min(100, Math.max(1, limit));
  return { skip: (p - 1) * l, take: l, page: p, limit: l };
}

export function toFloat(value: any, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}