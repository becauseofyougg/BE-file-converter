-- Erasure by anonymisation — docs/ACCOUNT-DELETION.md.
--
-- The row survives, emptied of everything personal, rather than being dropped.
-- `conversion_jobs` lives in a different database and carries `user_id` with no
-- foreign key to enforce anything, so a hard DELETE here would leave every job
-- and every audit line pointing at an id that resolves to nothing. GDPR asks
-- that the personal data go, not that the primary key go with it.
--
-- Null means a live account. Every path that reads a user treats a non-null
-- value as "no such user", so nothing below this line needs a second table.
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

-- Live accounts only, which is all any lookup outside the deletion path wants.
-- Partial rather than plain: the deleted rows are dead weight in an index whose
-- every reader filters them out, and they accumulate forever.
--
-- Prisma cannot express a partial index, so `prisma migrate dev` will offer to
-- drop this one. Keep it. Same caveat as the partial indexes in
-- `20260921120000_initial_identity_schema`.
CREATE INDEX "idx_users_live" ON "users" ("id") WHERE "deleted_at" IS NULL;
