import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate, generateId } from "../lib";
import { getOrganizationId, getUserId, getScopedValues, isAllowed } from "../lib/scope";
import {
  zExpenseSchema,
  zExpenseQuerySchema,
  zExpenseCategorySchema,
  zExpenseVoidSchema,
} from "@kazios/validation";

export const expenseRouter = Router();

/** Empty optional fields from a form are stored as null rather than blank strings. */
function optionalText(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Money arrives from a browser as a float and is stored as one, so it is rounded to
 * whole cents on the way in. 0.1 + 0.2 has to become 0.30 before it reaches a ledger,
 * otherwise a hundred small expenses drift a cent at a time and the expense report
 * stops agreeing with the bank statement it is supposed to explain.
 */
function toCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100);
}

function toCurrency(cents: number): number {
  return cents / 100;
}

/**
 * Ensures a related record belongs to the caller's organization before it is written.
 *
 * A foreign key is not enough here: the column is a plain string from the request, so
 * without this check a caller could attach another tenant's supplier, branch or category
 * to their own expense and read its details back through the join.
 */
async function assertOwned(
  model: "supplier" | "branch" | "expenseCategory",
  id: string | null | undefined,
  organizationId: string,
  label: string
): Promise<void> {
  if (!id) return;
  const found = await (prisma[model] as any).findFirst({
    where: { id, organizationId },
    select: { id: true },
  });
  if (!found) throw new AppError(400, `${label} is not available in this organization`);
}

/**
 * Posts the expense to the ledger.
 *
 * An expense that exists only as a row in a list cannot be reconciled, so recording one
 * has to move the money somewhere. The credit side depends on how it was paid: cash and
 * M-PESA both leave money the business already holds, while a credit purchase leaves
 * something it owes. Getting this wrong in either direction makes the trial balance
 * disagree with the bank, which is worse than having no entry at all because it looks
 * correct.
 */
async function postToLedger(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    expenseId: string;
    vendorName: string;
    amount: number;
    paymentMethod: string;
    accountCode: string | null | undefined;
    occurredAt: Date;
  }
): Promise<string | null> {
  const { organizationId, amount, paymentMethod, accountCode, vendorName, occurredAt } = args;

  // A category with no mapped account falls back to the general expense account the
  // organization was created with, so an unmapped category still produces a balanced
  // entry rather than being silently dropped from the books.
  const expenseCode = accountCode || "5100";
  const account = await tx.account.upsert({
    where: { organizationId_code: { organizationId, code: expenseCode } },
    update: {},
    create: {
      organizationId,
      code: expenseCode,
      name: expenseCode === "5100" ? "General Expenses" : `Expense ${expenseCode}`,
      type: "EXPENSE",
      isSystem: true,
    },
  });

  const isCredit = paymentMethod === "CREDIT";
  const creditCode = paymentMethod === "BANK" ? "1100" : "1000";
  const creditName = paymentMethod === "BANK" ? "Bank" : "Cash";
  const creditAccount = await tx.account.upsert({
    where: { organizationId_code: { organizationId, code: creditCode } },
    update: {},
    create: { organizationId, code: creditCode, name: creditName, type: "ASSET", isSystem: true },
  });

  // A credit purchase did not move money, it created a liability. Crediting cash for it
  // would understate both the cash on hand and what is owed to the supplier.
  const payableCode = "2000";
  const payableAccount = isCredit
    ? await tx.account.upsert({
        where: { organizationId_code: { organizationId, code: payableCode } },
        update: {},
        create: {
          organizationId,
          code: payableCode,
          name: "Accounts Payable",
          type: "LIABILITY",
          isSystem: true,
        },
      })
    : null;

  const reference = `JE-EXP-${generateId()}`;
  const entry = await tx.journalEntry.create({
    data: {
      reference,
      description: `Expense: ${vendorName}`,
      journalDate: occurredAt,
      status: "POSTED",
      organizationId,
      lines: {
        create: [
          {
            accountId: account.id,
            description: `Expense ${vendorName}`,
            debit: amount,
            credit: 0,
          },
          {
            accountId: payableAccount ? payableAccount.id : creditAccount.id,
            description: isCredit ? `Owed to ${vendorName}` : `Paid for ${vendorName}`,
            debit: 0,
            credit: amount,
          },
        ],
      },
    },
    select: { id: true },
  });

  return entry.id;
}

/**
 * Totals for the dashboard and the expense screen.
 *
 * Aggregated in the database rather than by loading rows and summing in JavaScript: a
 * business with a year of daily expenses would otherwise pull every row to produce four
 * numbers. Voided expenses are excluded from every figure, so a correction does not
 * require editing history to make the books agree.
 */
/**
 * Totals for the dashboard and the expense screen.
 *
 * Aggregated in the database rather than by loading rows and summing in JavaScript: a
 * business with a year of daily expenses would otherwise pull every row to produce four
 * numbers. Voided expenses are excluded from every figure, so a correction does not
 * require editing history to make the books agree.
 */
expenseRouter.get(
  "/summary",
  requireAuth,
  requirePermission("expenses.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = getOrganizationId(req)!;
      const query = zExpenseQuerySchema.parse(req.query);

      const where: Prisma.ExpenseWhereInput = {
        organizationId,
        status: { not: "VOIDED" },
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.startDate || query.endDate
          ? {
              expenseDate: {
                ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
                ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
              },
            }
          : {}),
      };

      const [byCategory, byMethod, total, pending] = await Promise.all([
        prisma.expense.groupBy({
          by: ["categoryId"],
          where,
          _sum: { amount: true },
          _count: { _all: true },
          orderBy: { _sum: { amount: "desc" } },
        }),
        prisma.expense.groupBy({
          by: ["paymentMethod"],
          where,
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.expense.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
        prisma.expense.count({ where: { organizationId, status: "PENDING" } }),
      ]);

      // Category ids are resolved in a second, bounded query rather than by including the
      // relation in the groupBy, which Prisma does not support.
      const categoryIds = byCategory.map(row => row.categoryId).filter((id): id is string => !!id);
      const categories = categoryIds.length
        ? await prisma.expenseCategory.findMany({
            where: { organizationId, id: { in: categoryIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(categories.map(c => [c.id, c.name]));

      res.json({
        data: {
          totalAmount: toCurrency(toCents(total._sum.amount || 0)),
          count: total._count._all,
          pendingCount: pending,
          byCategory: byCategory.map(row => ({
            categoryId: row.categoryId,
            // An expense whose category was deleted still counts towards the total, so it
            // is reported under an explicit label rather than dropped from the sum.
            name: (row.categoryId && nameById.get(row.categoryId)) || "Uncategorised",
            amount: toCurrency(toCents(row._sum.amount || 0)),
            count: row._count._all,
          })),
          byPaymentMethod: byMethod.map(row => ({
            paymentMethod: row.paymentMethod,
            amount: toCurrency(toCents(row._sum.amount || 0)),
            count: row._count._all,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

expenseRouter.get(
  "/",
  requireAuth,
  requirePermission("expenses.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = getOrganizationId(req)!;
      const query = zExpenseQuerySchema.parse(req.query);
      const { skip, take, page, limit } = paginate(query.page, query.limit);
      const scopedBranches = getScopedValues(req, "branchId");

      if (scopedBranches.length && query.branchId && !isAllowed(query.branchId, scopedBranches))
        throw new AppError(403, "This branch is not available for your role");

      const searchFilter: Prisma.ExpenseWhereInput | undefined = query.search
        ? {
            OR: [
              { vendorName: { contains: query.search, mode: "insensitive" } },
              { notes: { contains: query.search, mode: "insensitive" } },
              { receiptNumber: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : undefined;

      const where: Prisma.ExpenseWhereInput = {
        organizationId,
        // A role restricted to certain branches must not read spend from the others.
        // An expense with no branch belongs to the organization as a whole, such as
        // rent or an internet bill, so it stays visible rather than disappearing from a
        // report of what the business spent.
        ...(scopedBranches.length
          ? { OR: [{ branchId: { in: scopedBranches } }, { branchId: null }] }
          : query.branchId
            ? { branchId: query.branchId }
            : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
        ...(query.startDate || query.endDate
          ? {
              expenseDate: {
                ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
                ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
              },
            }
          : {}),
        ...(searchFilter ? { AND: [searchFilter] } : {}),
      };

      const [data, total] = await Promise.all([
        prisma.expense.findMany({
          where,
          include: {
            category: true,
            supplier: true,
            branch: true,
            recordedBy: { select: { id: true, name: true } },
            approvedBy: { select: { id: true, name: true } },
          },
          orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
          skip,
          take,
        }),
        prisma.expense.count({ where }),
      ]);

      res.json({ data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Records an expense and posts it to the ledger as one unit.
 *
 * Both happen in a single transaction on purpose. An expense row without its journal
 * entry is money spent that the accounts do not know about, and a journal entry without
 * its expense row is a ledger line nobody can trace back to a receipt. Neither is
 * recoverable by hand once written, so neither is allowed to exist alone.
 */
expenseRouter.post(
  "/",
  requireAuth,
  requirePermission("expenses.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = getOrganizationId(req)!;
      const userId = getUserId(req);
      if (!userId) throw new AppError(401, "Authentication required");
      const input = zExpenseSchema.parse(req.body);

      const scopedBranches = getScopedValues(req, "branchId");
      if (input.branchId && !isAllowed(input.branchId, scopedBranches))
        throw new AppError(403, "This branch is not available for your role");

      await assertOwned("supplier", input.supplierId, organizationId, "Supplier");
      await assertOwned("branch", input.branchId, organizationId, "Branch");
      await assertOwned("expenseCategory", input.categoryId, organizationId, "Category");

      const category = input.categoryId
        ? await prisma.expenseCategory.findFirst({
            where: { id: input.categoryId, organizationId },
            select: { accountCode: true },
          })
        : null;

      const organization = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true },
      });

      // Rounded to whole cents before it is stored, so a ledger summed from these rows
      // agrees with the figure the user saw on screen.
      const amount = toCurrency(toCents(input.amount));
      const occurredAt = new Date(input.expenseDate);

      const expense = await prisma.$transaction(async tx => {
        const created = await tx.expense.create({
          data: {
            vendorName: input.vendorName.trim(),
            amount,
            currency: organization?.currency || "KES",
            expenseDate: occurredAt,
            paymentMethod: input.paymentMethod,
            categoryId: input.categoryId || null,
            supplierId: input.supplierId || null,
            branchId: input.branchId || null,
            receiptNumber: optionalText(input.receiptNumber),
            notes: optionalText(input.notes),
            status: "RECORDED",
            recordedById: userId,
            organizationId,
          },
        });

        const journalEntryId = await postToLedger(tx, {
          organizationId,
          expenseId: created.id,
          vendorName: created.vendorName,
          amount,
          paymentMethod: input.paymentMethod,
          accountCode: category?.accountCode,
          occurredAt,
        });

        return tx.expense.update({
          where: { id: created.id },
          data: { journalEntryId },
          include: {
            category: true,
            supplier: true,
            branch: true,
            recordedBy: { select: { id: true, name: true } },
          },
        });
      });

      res.status(201).json({ data: expense });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Reverses an expense rather than deleting it.
 *
 * Deleting a financial record that has already been reported, or reconciled against a
 * bank, destroys the evidence that it existed. A void keeps the row and its amount,
 * marks it as no longer counting, and writes a mirror image journal entry so the ledger
 * returns to where it was. This is the same rule the rest of the system already follows
 * for invoices.
 */
expenseRouter.post(
  "/:id/void",
  requireAuth,
  requirePermission("expenses.approve"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = getOrganizationId(req)!;
      const userId = getUserId(req);
      if (!userId) throw new AppError(401, "Authentication required");
      const { reason } = zExpenseVoidSchema.parse(req.body);

      const expense = await prisma.expense.findFirst({
        where: { id: req.params.id, organizationId },
        select: { id: true, status: true, vendorName: true, journalEntryId: true },
      });
      if (!expense) throw new AppError(404, "Expense not found");
      if (expense.status === "VOIDED")
        throw new AppError(409, "This expense has already been voided", "EXPENSE_ALREADY_VOIDED");

      const voided = await prisma.$transaction(async tx => {
        const updated = await tx.expense.update({
          where: { id: expense.id },
          data: {
            status: "VOIDED",
            voidedAt: new Date(),
            voidReason: reason.trim(),
            approvedById: userId,
            approvedAt: new Date(),
          },
          include: { category: true, recordedBy: { select: { id: true, name: true } } },
        });

        // The reversal is written against the same accounts as the original, in the
        // opposite direction, so total debits still equal total credits. Without it the
        // expense would vanish from the report while its ledger line stood, and the
        // trial balance would no longer be derivable from the expense records.
        if (expense.journalEntryId) {
          const original = await tx.journalEntry.findUnique({
            where: { id: expense.journalEntryId },
            include: { lines: true },
          });
          if (original) {
            await tx.journalEntry.create({
              data: {
                reference: `JE-EXP-VOID-${generateId()}`,
                description: `Reversal of expense: ${expense.vendorName} (${reason.trim()})`,
                journalDate: new Date(),
                status: "POSTED",
                organizationId,
                lines: {
                  create: original.lines.map(line => ({
                    accountId: line.accountId,
                    description: `Reversal: ${line.description ?? expense.vendorName}`,
                    // Swapped, not copied. A reversal that repeated the original
                    // direction would double the expense instead of undoing it.
                    debit: line.credit,
                    credit: line.debit,
                  })),
                },
              },
            });
          }
        }

        return updated;
      });

      res.json({ data: voided });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The categories a new business starts with.
 *
 * Seeded on first read rather than during registration, so an organization that already
 * exists picks them up without a migration, and one created tomorrow gets them without
 * this list having to be edited in two places.
 *
 * The account codes follow the conventional numbering an accountant would expect in
 * Kenya: 6xxx is operating expense, so a chart of accounts built up from these sorts
 * itself and the trial balance reads sensibly. M-PESA and airtime are listed as their
 * own categories because for a small trading business the cost of moving money and the
 * cost of talking to customers are recurring, visible costs that would otherwise vanish
 * into an "other" bucket nobody can budget against.
 */
const DEFAULT_EXPENSE_CATEGORIES = [
  { name: "Rent", description: "Shop, office or warehouse rent", accountCode: "6000" },
  {
    name: "Utilities",
    description: "Electricity, water and refuse collection",
    accountCode: "6100",
  },
  {
    name: "Salaries & Wages",
    description: "Staff pay and statutory contributions",
    accountCode: "6200",
  },
  { name: "Transport & Fuel", description: "Delivery, matatu and fuel costs", accountCode: "6300" },
  { name: "Marketing", description: "Advertising, signage and promotions", accountCode: "6400" },
  {
    name: "Office & Stationery",
    description: "Printing, consumables and equipment",
    accountCode: "6500",
  },
  {
    name: "Repairs & Maintenance",
    description: "Building and equipment upkeep",
    accountCode: "6600",
  },
  {
    name: "Internet & Software",
    description: "Data bundles, hosting and subscriptions",
    accountCode: "6700",
  },
  {
    name: "Bank & Mobile Money Fees",
    description: "Bank charges and M-PESA commission",
    accountCode: "6800",
  },
  { name: "Airtime & Data", description: "Airtime and data for staff phones", accountCode: "6900" },
  {
    name: "Security",
    description: "Guards, alarms and insurance on premises",
    accountCode: "7000",
  },
  {
    name: "Licences & Permits",
    description: "Business licence, KRA and county permits",
    accountCode: "7100",
  },
  {
    name: "Cleaning & Sanitation",
    description: "Cleaning supplies and sanitation",
    accountCode: "7200",
  },
  {
    name: "Other",
    description: "Anything that does not fit another category",
    accountCode: "7900",
  },
] as const;

expenseRouter.get(
  "/categories",
  requireAuth,
  requirePermission("expenses.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = getOrganizationId(req)!;
      const load = () =>
        prisma.expenseCategory.findMany({
          where: { organizationId },
          orderBy: { name: "asc" },
          include: { _count: { select: { expenses: true } } },
        });

      // Seeded on first read so a business can record an expense immediately, without
      // an owner first having to invent a category list.
      if ((await prisma.expenseCategory.count({ where: { organizationId } })) === 0) {
        await prisma.expenseCategory.createMany({
          data: DEFAULT_EXPENSE_CATEGORIES.map(category => ({
            id: generateId(),
            organizationId,
            name: category.name,
            description: category.description,
            accountCode: category.accountCode,
          })),
        });
      }

      res.json({ data: await load() });
    } catch (err) {
      next(err);
    }
  }
);

expenseRouter.post(
  "/categories",
  requireAuth,
  requirePermission("expenses.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = getOrganizationId(req)!;
      const input = zExpenseCategorySchema.parse(req.body);
      const name = input.name.trim();

      const clash = await prisma.expenseCategory.findFirst({
        where: { organizationId, name },
        select: { id: true },
      });
      if (clash)
        throw new AppError(409, `A category named "${name}" already exists`, "CATEGORY_EXISTS");

      const category = await prisma.expenseCategory.create({
        data: {
          organizationId,
          name,
          description: optionalText(input.description),
          accountCode: optionalText(input.accountCode),
        },
      });
      res.status(201).json({ data: category });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Categories are only removable while nothing is filed under them. Once an expense
 * points at one, deleting it would silently reclassify real spend and break the report
 * that is meant to explain where the money went.
 */
expenseRouter.delete(
  "/categories/:id",
  requireAuth,
  requirePermission("expenses.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = getOrganizationId(req)!;
      const category = await prisma.expenseCategory.findFirst({
        where: { id: req.params.id, organizationId },
        include: { _count: { select: { expenses: true } } },
      });
      if (!category) throw new AppError(404, "Category not found");
      if (category._count.expenses > 0)
        throw new AppError(
          409,
          "This category has expenses filed under it, so it cannot be deleted",
          "CATEGORY_IN_USE"
        );

      await prisma.expenseCategory.delete({ where: { id: category.id } });
      res.json({ data: { id: category.id, deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);
