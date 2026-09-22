-- Failed-password tracking for the login lockout of docs/AUTHENTICATION.md §1.4.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6);

-- Only locked accounts are ever looked up by this, and they are a tiny
-- minority, so the index stays the size of the problem rather than the table.
CREATE INDEX "idx_users_locked" ON "users" ("locked_until")
WHERE "locked_until" IS NOT NULL;
