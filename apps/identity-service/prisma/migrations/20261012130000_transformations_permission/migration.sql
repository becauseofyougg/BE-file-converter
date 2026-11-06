-- `transformations@read`: reading *another* user's transformation history —
-- docs/TRANSFORMATION-HISTORY.md §3. A user's own history needs no permission.
--
-- A new permission rather than an action on `conversions`: every USER holds
-- `conversions@read` for their own work, and this is a different power.
INSERT INTO "permissions" ("id", "name", "actions", "updated_at")
SELECT gen_random_uuid(), 'transformations', ARRAY['read'], now()
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "name" = 'transformations');

-- ADMIN's grants were made per permission when the RBAC migration ran, so a
-- permission created since has none. Empty actions = every action, as for the
-- others.
INSERT INTO "grants" ("id", "role_id", "permission_id", "actions", "updated_at")
SELECT gen_random_uuid(), r."id", p."id", ARRAY[]::TEXT[], now()
FROM "roles" r, "permissions" p
WHERE r."name" = 'ADMIN' AND p."name" = 'transformations'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
