import { createHash } from "crypto";
import { prisma } from "./prisma";
import { sendMail, passwordResetEmail } from "./email";
import { hashPassword } from "./auth";
import { consumeResetToken, inspectResetToken, issuePasswordReset } from "./passwordReset";

/**
 * A password reset is the one flow in the system that deliberately hands a stranger a
 * credential. These tests pin the properties that make it safe: only a hash is stored, a
 * token dies after one use and a short window, issuing a new link kills the old one, and a
 * completed reset evicts every session that was opened with the old password.
 */
jest.mock("./prisma", () => ({
  prisma: {
    $transaction: jest.fn(),
    passwordResetToken: {
      deleteMany: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: { update: jest.fn() },
    session: { deleteMany: jest.fn() },
  },
}));
jest.mock("./auth", () => ({ hashPassword: jest.fn(async () => "hashed-password") }));
jest.mock("./email", () => ({
  passwordResetEmail: jest.fn((to: string) => ({ to, subject: "s", html: "h", text: "t" })),
  resetWindowMinutes: jest.fn(() => 15),
  sendMail: jest.fn(async () => true),
}));

interface DbMock {
  $transaction: jest.Mock;
  passwordResetToken: {
    deleteMany: jest.Mock;
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  user: { update: jest.Mock };
  session: { deleteMany: jest.Mock };
}

const db = prisma as unknown as DbMock;
const mailer = sendMail as jest.MockedFunction<typeof sendMail>;
const hasher = hashPassword as jest.MockedFunction<typeof hashPassword>;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const activeUser = {
  id: "usr_1",
  email: "amina@highlands.test",
  name: "Amina",
  status: "ACTIVE",
};

const liveRecord = {
  usedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  user: activeUser,
};

beforeEach(() => {
  db.$transaction.mockResolvedValue([]);
  db.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
  db.passwordResetToken.create.mockResolvedValue({});
  db.passwordResetToken.findUnique.mockResolvedValue(liveRecord);
  db.passwordResetToken.update.mockResolvedValue({});
  db.user.update.mockResolvedValue({});
  db.session.deleteMany.mockResolvedValue({ count: 0 });
  hasher.mockResolvedValue("hashed-password");
  mailer.mockResolvedValue(true);
});

describe("issuePasswordReset", () => {
  it("stores only the hash, so a database leak cannot be replayed", async () => {
    const { token } = await issuePasswordReset("usr_1", activeUser.email, activeUser.name);
    const created = db.passwordResetToken.create.mock.calls[0][0];
    expect(created.data.tokenHash).toBe(sha256(token));
    // The plain token must appear nowhere in what gets written.
    expect(JSON.stringify(created)).not.toContain(token);
  });

  it("invalidates any earlier unused link, so only the newest one works", async () => {
    await issuePasswordReset("usr_1", activeUser.email, activeUser.name);
    expect(db.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "usr_1", usedAt: null },
    });
  });

  it("actually hands the message to the mailer", async () => {
    // Building the message and never sending it is the exact bug that made resets
    // silently do nothing, so the hand-off itself is asserted rather than assumed.
    await issuePasswordReset("usr_1", activeUser.email, activeUser.name);
    expect(passwordResetEmail).toHaveBeenCalledWith(
      activeUser.email,
      activeUser.name,
      expect.any(String)
    );
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it("expires the token one short window from now", async () => {
    const before = Date.now();
    const { expiresAt } = await issuePasswordReset("usr_1", activeUser.email, activeUser.name);
    const minutes = (expiresAt.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it("issues a different token every time", async () => {
    const first = await issuePasswordReset("usr_1", activeUser.email, activeUser.name);
    const second = await issuePasswordReset("usr_1", activeUser.email, activeUser.name);
    expect(first.token).not.toBe(second.token);
  });
});

describe("inspectResetToken", () => {
  it("rejects a token it has never seen", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue(null);
    await expect(inspectResetToken("made-up")).resolves.toEqual({ ok: false, reason: "INVALID" });
  });

  it("rejects a token that has already been used", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({ ...liveRecord, usedAt: new Date() });
    await expect(inspectResetToken("t")).resolves.toEqual({ ok: false, reason: "USED" });
  });

  it("rejects a token past its window", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      ...liveRecord,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(inspectResetToken("t")).resolves.toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("refuses a suspended account, so it cannot be used to regain access", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      ...liveRecord,
      user: { ...activeUser, status: "SUSPENDED" },
    });
    await expect(inspectResetToken("t")).resolves.toEqual({ ok: false, reason: "INVALID" });
  });

  it("accepts a live token and names the account it belongs to", async () => {
    await expect(inspectResetToken("t")).resolves.toEqual({
      ok: true,
      userId: activeUser.id,
      email: activeUser.email,
      name: activeUser.name,
    });
  });

  it("checks without consuming, so the form can be shown before committing", async () => {
    await inspectResetToken("t");
    expect(db.passwordResetToken.update).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("consumeResetToken", () => {
  it("refuses a dead token without writing anything", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue(null);
    await expect(consumeResetToken("made-up", "newpassword")).resolves.toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("refuses an expired token without writing anything", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      ...liveRecord,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(consumeResetToken("t", "newpassword")).resolves.toMatchObject({
      ok: false,
      reason: "EXPIRED",
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("sets the new password, burns the token and ends every session together", async () => {
    // All three must land as one unit: a reset that changed the password but left old
    // sessions alive would not actually evict anybody.
    await expect(consumeResetToken("t", "newpassword")).resolves.toEqual({
      ok: true,
      userId: activeUser.id,
    });
    expect(hasher).toHaveBeenCalledWith("newpassword");
    expect(db.passwordResetToken.update).toHaveBeenCalledWith({
      where: { tokenHash: sha256("t") },
      data: { usedAt: expect.any(Date) },
    });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: activeUser.id },
      data: { passwordHash: "hashed-password" },
    });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: activeUser.id } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction.mock.calls[0][0]).toHaveLength(3);
  });

  it("cannot be replayed: a second use of the same token fails", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({ ...liveRecord, usedAt: new Date() });
    await expect(consumeResetToken("t", "newpassword")).resolves.toEqual({
      ok: false,
      reason: "USED",
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
