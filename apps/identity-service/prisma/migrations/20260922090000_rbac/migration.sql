-- ---------------------------------------------------------------------------
-- RBAC: roles, permissions, grants, and users holding many roles.
--
-- Hand-ordered. `prisma migrate diff` puts `ALTER TABLE "users" DROP COLUMN
-- "role"` first, which would throw away every existing user's role before
-- there is anywhere to put it. The drop is moved to the end, after the seed
-- and the data migration have copied those values into `user_roles`.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "actions" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grants" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "actions" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_user_roles_role" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_roles_name" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_permissions_name" ON "permissions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_grants_role_permission" ON "grants"("role_id", "permission_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Seed
--
-- The config is data, but it cannot start empty: the evaluator fails closed,
-- so an empty config locks everyone out of everything including the admin
-- endpoints that would fix it. These two roles are marked `is_system` and the
-- service refuses to rename or delete them for the same reason.
-- ---------------------------------------------------------------------------

INSERT INTO "roles" ("id", "name", "description", "is_system", "updated_at") VALUES
  (gen_random_uuid(), 'USER',  'Ordinary account: owns its own conversions', true, now()),
  (gen_random_uuid(), 'ADMIN', 'Full access, including RBAC administration',  true, now());

INSERT INTO "permissions" ("id", "name", "actions", "updated_at") VALUES
  (gen_random_uuid(), 'users',       ARRAY['read', 'update', 'delete'],        now()),
  (gen_random_uuid(), 'conversions', ARRAY['create', 'read', 'delete'],        now()),
  (gen_random_uuid(), 'rbac',        ARRAY['read', 'manage'],                  now());

-- A plain user may act on its own profile and its own conversions. Ownership
-- is a separate check: RBAC answers "may this role do this at all", not "does
-- this row belong to them".
INSERT INTO "grants" ("id", "role_id", "permission_id", "actions", "updated_at")
SELECT gen_random_uuid(), r."id", p."id", ARRAY['read', 'update'], now()
FROM "roles" r, "permissions" p
WHERE r."name" = 'USER' AND p."name" = 'users';

INSERT INTO "grants" ("id", "role_id", "permission_id", "actions", "updated_at")
SELECT gen_random_uuid(), r."id", p."id", ARRAY['create', 'read', 'delete'], now()
FROM "roles" r, "permissions" p
WHERE r."name" = 'USER' AND p."name" = 'conversions';

-- Empty actions: every action of every permission, including ones added later.
INSERT INTO "grants" ("id", "role_id", "permission_id", "actions", "updated_at")
SELECT gen_random_uuid(), r."id", p."id", ARRAY[]::TEXT[], now()
FROM "roles" r, "permissions" p
WHERE r."name" = 'ADMIN';

-- ---------------------------------------------------------------------------
-- Data migration: the old single `users.role` becomes a row in `user_roles`.
-- ---------------------------------------------------------------------------

INSERT INTO "user_roles" ("user_id", "role_id")
SELECT u."id", r."id"
FROM "users" u
JOIN "roles" r ON r."name" = u."role";

-- Anything whose role name no longer exists would be left with no role at all,
-- and a user with no roles can do nothing. Fall back to USER rather than
-- stranding the account.
INSERT INTO "user_roles" ("user_id", "role_id")
SELECT u."id", r."id"
FROM "users" u
CROSS JOIN "roles" r
WHERE r."name" = 'USER'
  AND NOT EXISTS (SELECT 1 FROM "user_roles" ur WHERE ur."user_id" = u."id");

-- AlterTable — last, now that the values are safely in `user_roles`.
ALTER TABLE "users" DROP COLUMN "role";
