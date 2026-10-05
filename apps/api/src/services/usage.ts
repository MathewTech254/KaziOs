import { prisma } from "../lib/prisma";
import { LIMIT_KEYS } from "@kazios/types";

/**
 * Metered usage: the counters behind the limits that cannot be read off a table.
 *
 * Two kinds of limit exist in this system and conflating them is the mistake this
 * module exists to avoid:
 *
 *   COUNTED  users, branches, products. These are rows. Asking "how many branches does
 *            this business have" is a COUNT query that is true by construction, and it
 *            cannot drift from what the business sees.
 *   METERED  transactions, AI requests, API calls, storage. These are events that
 *            happened and leave no row behind, so they have to be counted as they
 *            occur, and the count has to be written atomically.
 *
 * Usage is recorded by the code path that did the work, immediately afterwards, rather
 * than by a nightly sweep that counts rows: a sale that happened is a sale that should
 * be counted, and a sweep that is skipped on a busy day would quietly hand a customer a
 * free month.
 */

/**
 * The single bucket used by a limit that never resets.
 *
 * A fixed instant rather than "now", so every such record for an organization collapses
 * onto one row and the counter is a running total instead of a pile of near-duplicates.
 */
export const FOREVER_PERIOD_START = new Date(Date.UTC(1970, 0, 1));

/**
 * Where a metered limit's allowance starts again.
 *
 * Boundaries are UTC calendar boundaries, not the organization's local midnight. A
 * counter whose reset point depends on a timezone is a counter two support engineers
 * will debug differently, and the difference is at most a few hours against a month.
 * Local dates are still shown in the business's own timezone everywhere it matters.
 */
export function periodStartFor(period: string, now: Date = new Date()): Date {
  if (period === "never") return FOREVER_PERIOD_START;
  if (period === "yearly") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  // Monthly is the default: the first instant of the current UTC month.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Records usage, adding to whatever the counter already holds for this period.
 *
 * The increment is done in the database rather than by reading the current value and
 * writing back the sum. Two tills taking a sale in the same second is ordinary, and a
 * read-then-write would let the second one overwrite the first one's count, quietly
 * under-reporting a customer's usage until it stopped mattering.
 *
 * Callers that do not want a failure here to break the work that was paid for pass
 * `{ bestEffort: true }`. Under counting is worse than no counting, but refusing to
 * ring up a sale because a counter could not be written is worse still.
 */
export async function recordUsage(input: {
  organizationId: string;
  key: string;
  quantity?: number;
  period?: string;
  bestEffort?: boolean;
}): Promise<number> {
  const quantity = input.quantity ?? 1;
  const periodStart = periodStartFor(input.period ?? "monthly");

  try {
    const record = await prisma.usageRecord.upsert({
      where: {
        organizationId_key_periodStart: {
          organizationId: input.organizationId,
          key: input.key,
          periodStart,
        },
      },
      // A negative quantity would let a correction drive a counter below zero, so the
      // floor is applied in the database where concurrent writes cannot skip past it.
      create: { organizationId: input.organizationId, key: input.key, periodStart, quantity },
      update: { quantity: { increment: quantity } },
      select: { quantity: true },
    });
    return Math.max(0, record.quantity);
  } catch (err) {
    if (input.bestEffort) {
      console.warn(`Could not record ${input.key} usage for ${input.organizationId}:`, err);
      return 0;
    }
    throw err;
  }
}

/** Counts one sale. The name is used at every call site so the intent stays readable. */
export function recordTransaction(organizationId: string, bestEffort = true): Promise<number> {
  return recordUsage({
    organizationId,
    key: LIMIT_KEYS.MONTHLY_TRANSACTIONS,
    period: "monthly",
    bestEffort,
  });
}

export function recordAiRequest(organizationId: string, bestEffort = true): Promise<number> {
  return recordUsage({
    organizationId,
    key: LIMIT_KEYS.AI_REQUESTS,
    period: "monthly",
    bestEffort,
  });
}

export function recordApiRequest(organizationId: string, bestEffort = true): Promise<number> {
  return recordUsage({
    organizationId,
    key: LIMIT_KEYS.API_REQUESTS,
    period: "monthly",
    bestEffort,
  });
}

/** The counter for one limit in the period it is currently in. Zero when never used. */
export async function currentUsage(organizationId: string, key: string, period = "monthly") {
  const record = await prisma.usageRecord.findUnique({
    where: {
      organizationId_key_periodStart: { organizationId, key, periodStart: periodStartFor(period) },
    },
    select: { quantity: true },
  });
  return record?.quantity ?? 0;
}
