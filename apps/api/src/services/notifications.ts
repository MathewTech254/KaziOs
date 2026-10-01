import { prisma } from "../lib/prisma";
import { publishRealtime } from "../lib/realtime";

/**
 * The one place a notification is created.
 *
 * Writing the row and telling the browsers are the same operation, so an alert can
 * never be stored but not delivered, or delivered but not stored. Anything that wants
 * to raise an alert goes through here rather than touching the table directly.
 */

export type NotificationType = "info" | "success" | "warning" | "error";

export interface NotifyInput {
  organizationId: string;
  /** Who should see it. Every recipient is notified individually, so a personal
   *  list is never shared or leaked between people in the same company. */
  userIds: string[];
  type?: NotificationType;
  channel?: string;
  title: string;
  body: string;
  link?: string;
  actorName?: string;
  /**
   * A stable identity for the underlying condition. While a notification carrying the
   * same key is still unread, further ones are suppressed: a stock sweep that runs
   * every few minutes must not produce a new identical alert every time.
   */
  dedupeKey?: string;
}

/**
 * Notifies a set of users. Returns how many were actually delivered, which is zero
 * when every recipient was suppressed by deduplication.
 *
 * Never throws. An alert is a courtesy on top of a business operation that has
 * already succeeded, so a failure here must not roll back a completed sale.
 */
export async function notify(input: NotifyInput): Promise<number> {
  const recipients = Array.from(new Set(input.userIds.filter(Boolean)));
  if (!recipients.length) return 0;

  try {
    const type = input.type ?? "info";
    const channel = input.channel ?? "in_app";
    const dedupeKey = input.dedupeKey ?? null;

    let targets = recipients;
    if (dedupeKey) {
      // An existing unread alert for the same condition means the user already knows.
      const existing = await prisma.notification.findMany({
        where: { dedupeKey, userId: { in: recipients }, readAt: null },
        select: { userId: true },
      });
      const alreadyInformed = new Set(existing.map(row => row.userId));
      targets = recipients.filter(userId => !alreadyInformed.has(userId));
    }
    if (!targets.length) return 0;

    const created = await prisma.notification.createManyAndReturn({
      data: targets.map(userId => ({
        organizationId: input.organizationId,
        userId,
        channel,
        type,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        actorName: input.actorName ?? null,
        dedupeKey,
        status: "SENT",
      })),
    });

    for (const notification of created) {
      publishRealtime({
        organizationId: input.organizationId,
        userId: notification.userId,
        type: "notification",
        payload: notification,
      });
    }

    return created.length;
  } catch (err) {
    console.error("Failed to deliver notification:", (err as Error).message);
    return 0;
  }
}

/**
 * Notifies everyone in the organization holding a permission, optionally leaving one
 * person out. Used for shop wide events: a sale nobody else should have to be told
 * about, or an invoice going overdue that the person who raised it already knows.
 */
export async function notifyPermissionHolders(options: {
  organizationId: string;
  permission: string;
  title: string;
  body: string;
  type?: NotificationType;
  link?: string;
  actorName?: string;
  dedupeKey?: string;
  excludeUserIds?: string[];
}): Promise<number> {
  try {
    const excluded = new Set(options.excludeUserIds ?? []);
    const assignments = await prisma.userRole.findMany({
      where: {
        user: {
          organizationId: options.organizationId,
          status: "ACTIVE",
          ...(excluded.size ? { id: { notIn: [...excluded] } } : {}),
        },
        role: { permissions: { has: options.permission } },
      },
      select: { userId: true },
    });

    // A wildcard owner holds every permission without listing it, so an organization
    // whose owner has permissions ["*"] would otherwise never hear anything.
    const owners = await prisma.userRole.findMany({
      where: {
        user: {
          organizationId: options.organizationId,
          status: "ACTIVE",
          ...(excluded.size ? { id: { notIn: [...excluded] } } : {}),
        },
        role: { permissions: { has: "*" } },
      },
      select: { userId: true },
    });

    const userIds = Array.from(new Set([...assignments, ...owners].map(row => row.userId)));
    if (!userIds.length) return 0;

    return await notify({
      organizationId: options.organizationId,
      userIds,
      title: options.title,
      body: options.body,
      type: options.type,
      link: options.link,
      actorName: options.actorName,
      dedupeKey: options.dedupeKey,
    });
  } catch (err) {
    console.error("Failed to resolve notification recipients:", (err as Error).message);
    return 0;
  }
}

/**
 * How many alerts a person has not read yet. Cheap enough to poll, and the SSE stream
 * sends it on connect so the badge is correct before any alert arrives.
 */
export async function unreadCount(organizationId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { organizationId, userId, readAt: null } });
}
