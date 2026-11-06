-- AlterTable
-- The converter family that ran each operation: the history's `type`.
ALTER TABLE "conversion_operations" ADD COLUMN "family" VARCHAR(16) NOT NULL DEFAULT 'data';

-- Backfill: what was converted before this column existed is an image if
-- either side of it is an image format, and data otherwise.
UPDATE "conversion_operations"
SET "family" = 'image'
WHERE "source_format" IN ('png', 'jpeg', 'svg')
   OR "target_format" IN ('png', 'jpeg', 'svg');

-- CreateIndex
CREATE INDEX "ix_conversion_operations_user_status_history" ON "conversion_operations"("user_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ix_conversion_operations_user_family_history" ON "conversion_operations"("user_id", "family", "created_at" DESC, "id" DESC);