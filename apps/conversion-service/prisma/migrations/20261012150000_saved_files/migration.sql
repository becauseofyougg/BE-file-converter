-- AlterTable
-- An identifier for each saved result file — docs/SAVED-RESULTS.md.
ALTER TABLE "conversion_operations" ADD COLUMN "file_id" UUID;

-- Saved results kept so far had no identifier: give each one that is still
-- there its own.
UPDATE "conversion_operations"
SET "file_id" = gen_random_uuid()
WHERE "saved" = true AND "result_key" IS NOT NULL;