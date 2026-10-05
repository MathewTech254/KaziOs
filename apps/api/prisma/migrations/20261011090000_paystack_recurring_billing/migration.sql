-- Paystack recurring billing and webhook idempotency.

-- AlterTable
ALTER TABLE "PlanPrice" ADD COLUMN IF NOT EXISTS "paystackPlanCode" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "reference" TEXT,
    "organizationId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentWebhookEvent_providerEventId_key" ON "PaymentWebhookEvent"("providerEventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_event_createdAt_idx" ON "PaymentWebhookEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_status_createdAt_idx" ON "PaymentWebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_reference_idx" ON "PaymentWebhookEvent"("reference");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlanPrice_paystackPlanCode_key" ON "PlanPrice"("paystackPlanCode");
