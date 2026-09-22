import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { prisma } from "./prisma";

const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret-change-in-production-min-32chars";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: { userId: string; sessionId: string; organizationId: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): {
  userId: string;
  sessionId: string;
  organizationId: string;
} | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    return {
      userId: decoded.userId,
      sessionId: decoded.sessionId,
      organizationId: decoded.organizationId,
    };
  } catch {
    return null;
  }
}

export function generateSessionToken(): string {
  return randomUUID();
}

export async function createSession(userId: string, ip?: string, userAgent?: string) {
  const token = generateSessionToken();
  const refreshToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: { userId, token, refreshToken, expiresAt, ip, userAgent },
  });
  return session;
}

export async function validateSession(token: string) {
  const payload = verifyToken(token);
  if (!payload) return null;

  const session = await prisma.session.findUnique({
    where: { id: payload.sessionId },
  });
  if (!session || session.expiresAt < new Date() || session.userId !== payload.userId) return null;
  return session;
}

export async function rotateSession(sessionId: string) {
  const refreshToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return prisma.session.update({
    where: { id: sessionId },
    data: { token: generateSessionToken(), refreshToken, expiresAt },
  });
}

export async function destroySession(token: string) {
  await prisma.session.delete({ where: { token } }).catch(() => {});
}

export async function getUserOrganization(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true, branch: true, warehouse: true } } },
  });
  if (!user) return null;
  return {
    user,
    organizationId: user.organizationId,
    roles: user.roles.map((r: any) => ({
      role: r.role,
      branchId: r.branchId,
      warehouseId: r.warehouseId,
    })),
  };
}