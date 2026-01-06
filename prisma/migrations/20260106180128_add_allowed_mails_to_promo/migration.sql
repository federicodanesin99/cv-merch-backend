/*
  Warnings:

  - The `allowedEmails` column on the `PromoCode` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "PromoCode" DROP COLUMN "allowedEmails",
ADD COLUMN     "allowedEmails" JSONB NOT NULL DEFAULT '[]';
