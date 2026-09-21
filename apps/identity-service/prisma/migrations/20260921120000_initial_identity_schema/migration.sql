-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'USER',
    "email_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "challenge_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" VARCHAR(255),
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "event_name" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_email" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "uq_verification_tokens_challenge_id" ON "verification_tokens"("challenge_id");

-- CreateIndex
CREATE INDEX "idx_verification_tokens_user_type" ON "verification_tokens"("user_id", "type");

-- CreateIndex
CREATE INDEX "idx_verification_tokens_hash" ON "verification_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_refresh_tokens_hash" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_refresh_tokens_family" ON "refresh_tokens"("family_id");

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Partial indexes, which Prisma's schema language cannot express. They are
-- maintained here by hand.
--
-- `prisma migrate dev` diffs the datamodel against the migration history and
-- does not know about these, so it will propose dropping them. Keep them when
-- editing a generated migration — the second one is a correctness guarantee,
-- not a performance tweak.
-- ---------------------------------------------------------------------------

-- Drives the unverified-account cleanup. Partial, because verified rows are
-- the majority and never match.
CREATE INDEX "idx_users_unverified" ON "users" ("created_at")
WHERE "email_verified_at" IS NULL;

-- At most one live challenge per user and type — the invariant the resend
-- logic relies on, enforced by the database rather than hoped for in code.
CREATE UNIQUE INDEX "uq_verification_tokens_live"
ON "verification_tokens" ("user_id", "type")
WHERE "used_at" IS NULL;

-- The relay's claim query. Partial, so the index stays the size of the backlog
-- rather than the size of history.
CREATE INDEX "idx_outbox_unpublished" ON "outbox" ("occurred_at")
WHERE "published_at" IS NULL;
