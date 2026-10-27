-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "conversion_operation_status" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "conversion_operations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "conversion_operation_status" NOT NULL DEFAULT 'PROCESSING',
    "source_name" VARCHAR(255) NOT NULL,
    "source_format" VARCHAR(16),
    "source_size" BIGINT NOT NULL,
    "source_checksum" CHAR(64),
    "target_format" VARCHAR(16) NOT NULL,
    "result_size" BIGINT,
    "result_checksum" CHAR(64),
    "result_key" VARCHAR(512),
    "storage_driver" VARCHAR(16) NOT NULL,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "result_expires_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(1024),
    "duration_ms" INTEGER,
    "correlation_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "conversion_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_conversion_operations_user_history" ON "conversion_operations"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ix_conversion_operations_result_expires_at" ON "conversion_operations"("result_expires_at");

-- CreateIndex
CREATE INDEX "ix_conversion_operations_status_created_at" ON "conversion_operations"("status", "created_at");

