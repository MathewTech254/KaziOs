import { z } from "zod";

export const zString = (min = 1, max = 255) =>
  z.string().min(min, `Must be at least ${min} characters`).max(max, `Must be at most ${max} characters`);

export const zEmail = z.string().email("Invalid email address");

export const zPhone = z.string().min(5, "Invalid phone number");

export const zCurrency = z.enum(["KES", "UGX", "TZS", "NGN", "ZAR", "USD", "EUR", "GBP"]);

export const zCountry = z.enum(["KE", "UG", "TZ", "NG", "ZA", "US", "GB", "EU"]);

export const zUuid = z.string().uuid("Invalid UUID");

export const zDecimal = z.union([
  z.string().regex(/^-?\d+(\.\d+)?$/, "Must be a valid decimal"),
  z.number(),
  z.object({
    value: z.string().regex(/^-?\d+(\.\d+)?$/),
    currency: zCurrency,
  }),
]);

export const zPositiveDecimal = zDecimal.refine(
  (val) => {
    if (typeof val === "string") return parseFloat(val) >= 0;
    if (typeof val === "number") return val >= 0;
    return parseFloat(val.value) >= 0;
  },
  { message: "Must be a positive value" }
);

export const zPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const zDateRangeSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const zOrganizationSchema = z.object({
  name: zString(2, 100),
  slug: zString(2, 50).regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens"),
  country: zCountry,
  currency: zCurrency,
  timezone: zString(3, 50),
  language: z.string().length(2).default("en"),
  taxNumber: zString(1, 50).optional(),
  businessCategory: zString(1, 100).optional(),
  address: zString(1, 200).optional(),
  phone: zPhone.optional(),
  email: zEmail.optional(),
});

export const zRegisterSchema = z.object({
  name: zString(2, 100),
  email: zEmail,
  password: z.string().min(8, "Password must be at least 8 characters"),
  organizationName: zString(2, 100),
  country: zCountry.default("KE"),
  currency: zCurrency.default("KES"),
  timezone: zString(3, 50).default("Africa/Nairobi"),
});

export const zLoginSchema = z.object({
  email: zEmail,
  password: z.string().min(1, "Password is required"),
  rememberMe: z.boolean().optional(),
});

export const zForgotPasswordSchema = z.object({
  email: zEmail,
});

export const zResetPasswordSchema = z.object({
  token: zString(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(8, "Password must be at least 8 characters"),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export const zChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(8, "Password must be at least 8 characters"),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export const zCustomerSchema = z.object({
  name: zString(2, 100),
  email: zEmail.optional().nullable(),
  phone: zPhone.optional().nullable(),
  address: zString(1, 200).optional().nullable(),
  taxNumber: zString(1, 50).optional().nullable(),
  customerType: z.enum(["INDIVIDUAL", "BUSINESS"]).default("INDIVIDUAL"),
});

export const zSupplierSchema = z.object({
  name: zString(2, 100),
  email: zEmail.optional().nullable(),
  phone: zPhone.optional().nullable(),
  address: zString(1, 200).optional().nullable(),
  taxNumber: zString(1, 50).optional().nullable(),
});

export const zProductSchema = z.object({
  name: zString(2, 200),
  sku: zString(1, 50).optional().nullable(),
  barcode: zString(1, 50).optional().nullable(),
  description: zString(0, 1000).optional().nullable(),
  costPrice: z.number().positive("Cost price must be positive"),
  sellingPrice: z.number().positive("Selling price must be positive"),
  minStock: z.number().int().nonnegative().default(0),
  reorderPoint: z.number().int().nonnegative().default(0),
  taxCategoryId: zUuid.optional().nullable(),
  brandId: zUuid.optional().nullable(),
  categoryId: zUuid.optional().nullable(),
  unitId: zUuid.optional().nullable(),
  isActive: z.boolean().default(true),
  productType: z.enum(["PHYSICAL", "SERVICE", "DIGITAL"]).default("PHYSICAL"),
});

export const zBranchSchema = z.object({
  name: zString(2, 100),
  code: zString(1, 20),
  address: zString(1, 200).optional().nullable(),
  phone: zPhone.optional().nullable(),
});

export const zWarehouseSchema = z.object({
  name: zString(2, 100),
  code: zString(1, 20),
  address: zString(1, 200).optional().nullable(),
  branchId: zUuid.optional().nullable(),
});

export const zInvoiceItemSchema = z.object({
  productId: zUuid.optional().nullable(),
  description: zString(1, 200),
  quantity: z.number().positive("Quantity must be positive"),
  unitPrice: z.number().nonnegative("Unit price must be non-negative"),
  discountAmount: z.number().nonnegative().default(0),
  taxRateId: zUuid.optional().nullable(),
  taxAmount: z.number().nonnegative().default(0),
  lineTotal: z.number().nonnegative(),
});

export const zInvoiceSchema = z.object({
  customerId: zUuid,
  branchId: zUuid.optional().nullable(),
  issueDate: z.string().datetime(),
  dueDate: z.string().datetime(),
  items: z.array(zInvoiceItemSchema).min(1, "At least one item is required"),
  subtotal: z.number().nonnegative(),
  taxTotal: z.number().nonnegative(),
  discountTotal: z.number().nonnegative(),
  total: z.number().nonnegative(),
  notes: zString(0, 500).optional().nullable(),
  terms: zString(0, 500).optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  currency: zCurrency.default("KES"),
});

export const zPaymentSchema = z.object({
  invoiceId: zUuid.optional().nullable(),
  amount: z.number().positive("Amount must be positive"),
  currency: zCurrency,
  paymentProvider: z.enum(["PAYSTACK", "MPESA", "BANK", "MANUAL", "CASH", "CHECK"]),
  paymentMethodType: z.enum(["card", "bank_transfer", "mobile_money", "cash", "check", "manual"]),
  reference: zString(1, 100),
  notes: zString(0, 500).optional().nullable(),
  customerId: zUuid.optional().nullable(),
});

export const zPosSaleItemSchema = z.object({
  productId: zUuid,
  quantity: z.number().int().positive("Quantity must be positive").max(10000),
  discountAmount: z.number().nonnegative("Discount cannot be negative").default(0),
});

export const zPosPaymentSchema = z.object({
  provider: z.enum(["PAYSTACK", "MPESA", "BANK", "MANUAL", "CASH", "CHECK"]),
  methodType: z.enum(["card", "bank_transfer", "mobile_money", "cash", "check", "manual"]),
  amount: z.number().positive("Amount must be positive"),
  tenderedAmount: z.number().nonnegative("Tendered amount cannot be negative").optional(),
  reference: zString(1, 100).optional(),
});

export const zPosSaleSchema = z.object({
  branchId: zUuid.optional().nullable(),
  warehouseId: zUuid.optional().nullable(),
  customerId: zUuid.optional().nullable(),
  items: z.array(zPosSaleItemSchema).min(1, "Add at least one product").max(100),
  discountAmount: z.number().nonnegative("Discount cannot be negative").default(0),
  payments: z.array(zPosPaymentSchema).min(1, "Select a payment method").max(10),
  notes: zString(0, 500).optional().nullable(),
  idempotencyKey: z.string().max(100).optional(),
});

export const zJournalEntrySchema = z.object({
  organizationId: zUuid,
  description: zString(1, 500),
  reference: zString(1, 100),
  journalDate: z.string().datetime(),
  lines: z.array(
    z.object({
      accountId: zUuid,
      description: zString(0, 500).optional(),
      debit: z.number().nonnegative(),
      credit: z.number().nonnegative(),
    })
  ).min(2, "At least two journal lines are required"),
}).refine(
  (data) => {
    const totalDebit = data.lines.reduce((sum, line) => sum + line.debit, 0);
    const totalCredit = data.lines.reduce((sum, line) => sum + line.credit, 0);
    return Math.abs(totalDebit - totalCredit) < 0.01;
  },
  { message: "Journal entries must balance (debits = credits)" }
);

export const zUserRoleSchema = z.object({
  userId: zUuid,
  roleId: zUuid,
  branchId: zUuid.optional().nullable(),
  warehouseId: zUuid.optional().nullable(),
});

export const zInventoryAdjustmentSchema = z.object({
  productId: zUuid,
  warehouseId: zUuid,
  quantity: z.number().int(),
  reason: zString(1, 200),
  reference: zString(1, 100).optional(),
  adjustmentType: z.enum(["INCREASE", "DECREASE"]),
});

export const zStockTransferSchema = z.object({
  sourceWarehouseId: zUuid,
  destinationWarehouseId: zUuid,
  productId: zUuid,
  quantity: z.number().int().positive("Quantity must be positive"),
  reference: zString(0, 100).optional(),
});

export const zQuotationSchema = z.object({
  customerId: zUuid,
  branchId: zUuid.optional().nullable(),
  validUntil: z.string().datetime(),
  items: z.array(zInvoiceItemSchema).min(1, "At least one item is required"),
  notes: zString(0, 500).optional().nullable(),
});

export const zSalesOrderSchema = z.object({
  customerId: zUuid,
  branchId: zUuid.optional().nullable(),
  items: z.array(zInvoiceItemSchema).min(1, "At least one item is required"),
  notes: zString(0, 500).optional().nullable(),
});

export const zPurchaseOrderSchema = z.object({
  supplierId: zUuid,
  branchId: zUuid.optional().nullable(),
  items: z.array(
    z.object({
      productId: zUuid,
      quantity: z.number().positive(),
      unitPrice: z.number().nonnegative(),
      description: zString(1, 200).optional(),
    })
  ).min(1, "At least one item is required"),
  notes: zString(0, 500).optional().nullable(),
});

export const zApiKeySchema = z.object({
  name: zString(2, 100),
  scopes: z.array(zString(1, 100)).optional().default([]),
  expiresAt: z.string().datetime().optional().nullable(),
});

export const zWebhookEndpointSchema = z.object({
  name: zString(2, 100),
  url: z.string().url("Invalid URL"),
  events: z.array(zString(1, 100)).min(1, "At least one event is required"),
  isActive: z.boolean().default(true),
});

export const zAutomationRuleSchema = z.object({
  name: zString(2, 100),
  trigger: z.enum([
    "RECORD_CREATED",
    "RECORD_UPDATED",
    "PAYMENT_RECEIVED",
    "INVOICE_OVERDUE",
    "STOCK_BELOW_THRESHOLD",
    "CUSTOMER_CREATED",
    "PURCHASE_RECEIVED",
    "SCHEDULED",
  ]),
  triggerConfig: z.string().optional(),
  conditions: z.any().optional(),
  actions: z.any().refine((val: any) => Array.isArray(val) && val.length >= 1, {
    message: "At least one action is required",
  }),
  isActive: z.boolean().default(true),
});

export const zTaskSchema = z.object({
  title: zString(1, 200),
  description: zString(0, 2000).optional().nullable(),
  projectId: zUuid.optional().nullable(),
  assigneeId: zUuid.optional().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  dueDate: z.string().datetime().optional().nullable(),
});

export const zProjectSchema = z.object({
  name: zString(2, 100),
  description: zString(0, 1000).optional().nullable(),
  status: z.enum(["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"]).default("ACTIVE"),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  budget: z.number().nonnegative().optional().nullable(),
});

export const zExpenseSchema = z.object({
  categoryId: zUuid,
  vendorName: zString(1, 100),
  amount: z.number().positive("Amount must be positive"),
  currency: zCurrency,
  expenseDate: z.string().datetime(),
  paymentMethod: z.enum(["CASH", "CARD", "BANK_TRANSFER", "CHECK", "MOBILE_MONEY"]),
  branchId: zUuid.optional().nullable(),
  projectId: zUuid.optional().nullable(),
  receiptNumber: zString(1, 50).optional().nullable(),
  notes: zString(0, 500).optional().nullable(),
});

export const zAiMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: zString(1, 10000),
});

export const zEmployeeSchema = z.object({
  firstName: zString(2, 50),
  lastName: zString(2, 50),
  email: zEmail,
  phone: zPhone.optional().nullable(),
  departmentId: zUuid.optional().nullable(),
  positionId: zUuid.optional().nullable(),
  hireDate: z.string().datetime(),
  salary: z.number().nonnegative().optional().nullable(),
  isActive: z.boolean().default(true),
});

export const zLeaveRequestSchema = z.object({
  employeeId: zUuid,
  typeId: zUuid,
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  reason: zString(1, 500),
});

export const zSupportTicketSchema = z.object({
  subject: zString(1, 200),
  description: zString(1, 2000),
  category: z.enum(["BILLING", "TECHNICAL", "ACCOUNT", "FEATURE", "OTHER"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
});

export const zApiKeyScopeSchema = z.enum([
  "read",
  "write",
  "admin",
  "finance",
  "inventory",
  "sales",
  "crm",
  "hr",
  "projects",
  "ai",
  "integrations",
]);

export const zSubscriptionSchema = z.object({
  planId: zUuid,
  billingCycle: z.enum(["monthly", "annual"]).default("monthly"),
  paymentMethodId: zUuid.optional().nullable(),
});
