-- The admin user list — docs/USER-LIST.md.

-- Sortable in the list, and the thing that makes "who has not signed in for a
-- year" answerable. Written when a session is actually issued, not when the
-- password is merely accepted: a login waiting on a confirmation has not
-- happened yet.
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMPTZ(6);

-- Sort keys, each carrying `id` as the tie-break.
--
-- The tie-break is not decoration. Cursor pagination walks the index in order,
-- and if two rows share a `created_at` their relative order is otherwise
-- undefined — between two pages the database may return them the other way
-- round, and the cursor then skips one row and repeats another. Ordering by
-- (sort key, id) makes the sequence total, and indexing the same pair is what
-- keeps the walk an index scan rather than a sort of the whole table.
CREATE INDEX "idx_users_created_at_id" ON "users" ("created_at", "id");
CREATE INDEX "idx_users_last_login_id" ON "users" ("last_login_at", "id");

-- Substring search on the display name.
--
-- `ILIKE '%x%'` cannot use a btree index — the leading wildcard has nothing to
-- anchor on — so without this a search is a sequential scan of every user.
-- A GIN trigram index is what makes an unanchored match indexable.
--
-- `pg_trgm` is a standard contrib extension, available wherever `citext`
-- already is (see 20260921120000_initial_identity_schema).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "idx_users_display_name_trgm" ON "users" USING gin ("display_name" gin_trgm_ops);

-- `users@list` — the right to enumerate accounts, which is deliberately not the
-- same right as reading one.
--
-- `users@read` means "may read a profile that is not their own", and a support
-- agent given that can look up the account named in a ticket. Being able to
-- page through every account in the system is a larger thing: it turns the API
-- into a directory of everyone who has ever signed up. Splitting the two lets a
-- role hold the first without the second.
--
-- ADMIN needs no new grant. Its row has an empty `actions` array, which the
-- evaluator reads as every action of the permission — including ones added
-- later, which is exactly this case (see 20260922090000_rbac).
UPDATE "permissions"
SET "actions" = array_append("actions", 'list'), "updated_at" = now()
WHERE "name" = 'users'
  AND NOT ('list' = ANY("actions"));
