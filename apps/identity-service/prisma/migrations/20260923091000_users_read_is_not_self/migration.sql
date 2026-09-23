-- Take `users@read` / `users@update` away from the USER role.
--
-- The profile requirement reads: access is granted to **Self OR** the holder of
-- `users.read`. The seed in `20260922090000_rbac` gave every USER a grant on
-- `users` with actions ['read', 'update'], which makes that "or" meaningless —
-- every ordinary account would have been able to read every other account's
-- profile, which is exactly the IDOR §1.6 forbids.
--
-- The fix is not to narrow the actions but to remove the grant. An empty action
-- array means "every action", so there is no way to spell "none" except by
-- deleting the row.
--
-- Nothing is lost. Reading and updating *your own* profile is an ownership
-- question, not a role question, and is decided by comparing the viewer to the
-- target — see docs/USER-PROFILE.md §3, and docs/RBAC.md §11 for the
-- longer-standing position that ownership is not RBAC. After this, `users@read`
-- means precisely "may read profiles that are not their own", which is what a
-- support or admin role is for. ADMIN keeps it through its
-- every-permission grant, which this does not touch.
DELETE FROM "grants" g
USING "roles" r, "permissions" p
WHERE g."role_id" = r."id"
  AND g."permission_id" = p."id"
  AND r."name" = 'USER'
  AND p."name" = 'users';
