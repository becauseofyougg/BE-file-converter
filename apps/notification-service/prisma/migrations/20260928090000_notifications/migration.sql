-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'RETRYING', 'SENT', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "ref_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(512),
    "correlation_id" VARCHAR(128) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_notifications_user_created" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_notifications_ref_channel" ON "notifications"("ref_id", "channel");

