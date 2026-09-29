-- Rows published before the relay started emptying them still carry their
-- events: one-time codes, link tokens, and the address of every erased
-- account. The relay now clears the payload as it marks a row published; this
-- does the same for the rows it marked before it did.
--
-- Data only; the schema is unchanged, so `prisma migrate dev` has nothing to
-- say about it.
UPDATE "outbox"
SET "payload" = '{}'::jsonb
WHERE "published_at" IS NOT NULL
  AND "payload" <> '{}'::jsonb;
