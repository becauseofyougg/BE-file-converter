-- A profile photo, stored as an object-storage key rather than a URL.
--
-- The `uploads` bucket is private, so the client is served a short-lived
-- presigned link minted per request (docs/USER-PROFILE.md §4). A URL column
-- would mean either making the object public or baking an expiry into a row.
--
-- Nullable, and nothing writes it yet: uploading a photo is not part of the
-- profile-viewing requirement. The column exists so the read path has a real
-- field to serve instead of a hard-coded null.
ALTER TABLE "users" ADD COLUMN "photo_key" VARCHAR(512);
