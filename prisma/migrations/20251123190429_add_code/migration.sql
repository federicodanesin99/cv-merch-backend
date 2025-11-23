/*
  Warnings:

  - A unique constraint covering the columns `[uniqueCode]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "uniqueCode" TEXT NOT NULL DEFAULT 'MIDA-0001-A3F7';

-- CreateIndex
CREATE UNIQUE INDEX "Order_uniqueCode_key" ON "Order"("uniqueCode");
