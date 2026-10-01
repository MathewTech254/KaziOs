-- Notifications need to be raised exactly once per real world event, not once per
-- sweep, and they need somewhere to send the user when the alert is opened.
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN "link" TEXT;
ALTER TABLE "Notification" ADD COLUMN "actorName" TEXT;

-- The bell reads one user's newest alerts.
CREATE INDEX "Notification_organizationId_userId_createdAt_idx" ON "Notification"("organizationId", "userId", "createdAt");

-- The unread badge counts one user's unread rows.
CREATE INDEX "Notification_organizationId_userId_readAt_idx" ON "Notification"("organizationId", "userId", "readAt");

-- Guards against repeating an alert for the same underlying condition.
CREATE INDEX "Notification_dedupeKey_createdAt_idx" ON "Notification"("dedupeKey", "createdAt");