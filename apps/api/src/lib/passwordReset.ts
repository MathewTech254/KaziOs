import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";
import { passwordResetEmail, resetWindowMinutes, sendMail } from "./email";
import { hashPassword } from "./auth";

/** Only the hash is ever stored, so a database leak cannot be replayed as a reset link. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedReset {
  /** The plain token, returned to the caller so a test can complete the flow. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues a single use reset token and emails the link. Any earlier unused token for
 * the same user is removed first, so only the newest link in a inbox can work.
 */
export async function issuePasswordReset(userId: string, email: string, name: string): Promise<IssuedReset> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + resetWindowMinutes() * 60 * 1000);

  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId, usedAt: null } }),
    prisma.passwordResetToken.create({ data: { tokenHash: hashToken(token), userId, expiresAt } }),
  ]);

  // Build the message and hand it to the mailer. Constructing the object alone sends
  // nothing, which is exactly the bug this line once had.
  await sendMail(passwordResetEmail(email, name, token));
  return { token, expiresAt };
}

export type ResetFailure = "INVALID" | "EXPIRED" | "USED";

export interface ResetOutcome {
  ok: boolean;
  reason?: ResetFailure;
  userId?: string;
  email?: string;
  name?: string;
}

/** Checks a token without consuming it, so the form can refuse a dead link up front. */
export async function inspectResetToken(token: string): Promise<ResetOutcome> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, name: true, status: true } } },
  });

  if (!record) return { ok: false, reason: "INVALID" };
  if (record.usedAt) return { ok: false, reason: "USED" };
  if (record.expiresAt < new Date()) return { ok: false, reason: "EXPIRED" };
  if (record.user.status !== "ACTIVE") return { ok: false, reason: "INVALID" };

  return { ok: true, userId: record.user.id, email: record.user.email, name: record.user.name };
}

/**
 * Consumes the token, sets the new password and signs out every existing session, so a
 * password reset also evicts anyone who was already signed in with the old one.
 */
export async function consumeResetToken(
  token: string,
  newPassword: string
): Promise<{ ok: boolean; reason?: ResetFailure; userId?: string }> {
  const outcome = await inspectResetToken(token);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { tokenHash: hashToken(token) },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({ where: { id: outcome.userId! }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { userId: outcome.userId } }),
  ]);

  return { ok: true, userId: outcome.userId };
}
