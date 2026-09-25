-- Deleting a draft purchase order has to take its lines with it. The original constraint
-- was created without a cascade, so a delete of an order with items raised a foreign key
-- violation. The Prisma relation is declared with onDelete: Cascade - this makes the
-- database agree with it.
ALTER TABLE "PurchaseOrderItem" DROP CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey";

ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
