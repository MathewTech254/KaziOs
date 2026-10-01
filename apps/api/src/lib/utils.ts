import { randomUUID } from "crypto";

export function generateId(): string {
  return randomUUID();
}

/**
 * The random tail of a document number.
 *
 * This is eight hex characters, so 32 bits. It was four, which is only 16 bits, and every
 * one of these numbers is stored in a @unique column. At 16 bits a couple of hundred
 * documents is already a coin flip on a repeat, so a busy branch would intermittently fail
 * to save an invoice with a unique constraint error. Widening the tail costs four
 * characters of display width and removes the collision.
 */
function randomSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function yearMonthDay(now: Date): string {
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function yearMonth(now: Date): string {
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

export function generateInvoiceNumber(prefix = "INV"): string {
  return `${prefix}-${yearMonthDay(new Date())}-${randomSuffix()}`;
}

export function generatePoNumber(prefix = "PO"): string {
  return `${prefix}-${yearMonth(new Date())}-${randomSuffix()}`;
}

export function generateQuoteNumber(prefix = "QT"): string {
  return `${prefix}-${yearMonth(new Date())}-${randomSuffix()}`;
}

export function generateOrderNumber(prefix = "SO"): string {
  return `${prefix}-${yearMonth(new Date())}-${randomSuffix()}`;
}

/** Reference used for stock adjustments ("ADJ") and transfers ("TRF"). */
export function generateStockReference(prefix = "ADJ"): string {
  return `${prefix}-${yearMonth(new Date())}-${randomSuffix()}`;
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
