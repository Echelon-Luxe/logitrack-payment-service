-- CreateEnum
CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "Earning" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "EarningStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Earning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
-- One earning per shipment: this is what makes a redelivered pickup event
-- unable to pay a driver twice.
CREATE UNIQUE INDEX "Earning_shipmentId_key" ON "Earning"("shipmentId");

-- CreateIndex
CREATE INDEX "Earning_driverId_status_idx" ON "Earning"("driverId", "status");

-- CreateIndex
CREATE INDEX "Earning_status_createdAt_idx" ON "Earning"("status", "createdAt");
