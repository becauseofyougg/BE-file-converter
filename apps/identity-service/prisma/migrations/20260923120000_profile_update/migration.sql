-- Editable profile data, and the pending address of an email change.
-- docs/PROFILE-UPDATE.md.

-- What the user calls themselves. Nullable and deliberately NOT unique: it is
-- a label, not an identifier. `email` is the identifier, and forcing two people
-- to pick different names would be a rule with nothing behind it.
ALTER TABLE "users" ADD COLUMN "display_name" VARCHAR(64);

-- The address a pending `email_change` challenge is claiming.
--
-- It lives on the challenge row rather than being re-submitted at confirmation
-- time, so the address that was proved is necessarily the address that gets
-- applied. Taking it from the confirming request instead would let a code
-- mailed to one address be quoted back alongside a different one.
--
-- citext to match `users.email`: the uniqueness the application promises has to
-- be the uniqueness the database enforces, on both sides of the comparison.
ALTER TABLE "verification_tokens" ADD COLUMN "new_email" CITEXT;
