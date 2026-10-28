-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "maxRetries" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "NotificationTemplate" ADD COLUMN     "html" TEXT;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "adminAlerts" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "logoDesktopHeight" INTEGER,
ADD COLUMN     "logoDesktopWidth" INTEGER,
ADD COLUMN     "logoMobileHeight" INTEGER,
ADD COLUMN     "logoMobileWidth" INTEGER,
ADD COLUMN     "tagline" TEXT;

-- CreateTable
CREATE TABLE "CustomerOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "resendAfter" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerOtp_email_idx" ON "CustomerOtp"("email");

-- CreateIndex
CREATE INDEX "CustomerOtp_expiresAt_idx" ON "CustomerOtp"("expiresAt");
