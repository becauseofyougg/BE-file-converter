-- AlterTable
-- Options a conversion was asked for (image quality, size, background).
ALTER TABLE "conversion_operations" ADD COLUMN "options" JSONB;
