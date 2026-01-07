-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "isComingSoon" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProductInterest" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "preferredColor" TEXT,
    "preferredSize" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductInterest_productId_idx" ON "ProductInterest"("productId");

-- CreateIndex
CREATE INDEX "ProductInterest_userEmail_idx" ON "ProductInterest"("userEmail");

-- CreateIndex
CREATE UNIQUE INDEX "ProductInterest_productId_userEmail_key" ON "ProductInterest"("productId", "userEmail");

-- AddForeignKey
ALTER TABLE "ProductInterest" ADD CONSTRAINT "ProductInterest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
