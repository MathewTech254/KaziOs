import { billingNoticeEmail, sendMail } from "../lib/email";
import { notify, resolvePermissionHolders } from "./notifications";

/**
 * The customer-facing side of billing: when a subscription starts, renews, fails,
 * expires or runs towards a limit, the people who manage billing are told — in the app
 * they are already watching, and for the events that cost money, by email as well.
 *
 * Three rules hold across every call site:
 *
 *  1. Never throws. A notification is a courtesy on top of a state change that has
 *     already happened; an address that cannot be resolved must not roll back a
 *     payment that settled or a cancellation that was recorded.
 *  2. Deduped by a stable key, so a sweep that runs every hour announces one condition
 *     once rather than once per sweep.
 *  3. Addressed to whoever holds `settings.manage` — the same permission the billing
 *     tab itself requires — and never to the whole staff list.
 */
export async function announceBilling(input: {
  organizationId: string;
  title: string;
  body: string;
  type?: "info" | "success" | "warning" | "error";
  /** App path the alert should open, e.g. "/settings?tab=billing". */
  link?: string;
  /** Stable identity for the condition, so repeats while unread are suppressed. */
  dedupeKey?: string;
  /**
   * Present only for events worth an email (a failed payment, an activation, an
   * expiry). Absent means in-app only — most billing events do not deserve an inbox.
   */
  email?: { subject: string; paragraph: string };
  /** Who caused this, when a person did. */
  excludeUserIds?: string[];
}): Promise<void> {
  try {
    const holders = await resolvePermissionHolders({
      organizationId: input.organizationId,
      permission: "settings.manage",
      excludeUserIds: input.excludeUserIds,
    });
    if (!holders.length) return;

    await notify({
      organizationId: input.organizationId,
      userIds: holders.map(holder => holder.id),
      title: input.title,
      body: input.body,
      type: input.type,
      link: input.link ?? "/settings?tab=billing",
      dedupeKey: input.dedupeKey,
    });

    if (input.email) {
      for (const holder of holders) {
        await sendMail(
          billingNoticeEmail({
            to: holder.email,
            name: holder.name.split(" ")[0] || holder.name,
            subject: input.email.subject,
            paragraph: input.email.paragraph,
            link: input.link,
          })
        );
      }
    }
  } catch (err) {
    console.error("Could not announce billing event:", (err as Error).message);
  }
}

/**
 * Usage warnings raised by the sweep: one alert per allowance per period, the moment it
 * crosses 80%. The billing page shows the same numbers, but a customer should not have
 * to open settings to discover the till is about to stop taking sales.
 */
export async function announceUsageWarning(input: {
  organizationId: string;
  label: string;
  used: number;
  limit: number;
  /** The period the counter resets on, folded into the key so next month can speak. */
  periodKey: string;
}): Promise<void> {
  const percent = Math.round((input.used / input.limit) * 100);
  await announceBilling({
    organizationId: input.organizationId,
    title: `Approaching your ${input.label} limit`,
    body: `You have used ${input.used.toLocaleString()} of your ${input.limit.toLocaleString()} ${input.label} (${percent}%). Upgrading raises the limit; nothing you already have is removed.`,
    type: "warning",
    link: "/settings?tab=billing",
    dedupeKey: `usage:${input.label}:${input.periodKey}`,
  });
}
