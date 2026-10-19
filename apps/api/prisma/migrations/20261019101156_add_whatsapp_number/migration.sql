-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "whatsappNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_whatsappNumber_key" ON "Organization"("whatsappNumber");
