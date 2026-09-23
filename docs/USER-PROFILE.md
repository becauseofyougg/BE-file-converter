# File Converter — Reading a user profile

**Status:** implemented — see §6 for where the code lives
**Date:** 2026-09-23
**Owning service:** `identity-service`, exposed through `api-gateway`
**Related:** [RBAC.md](RBAC.md) · [AUTHORIZATION.md](AUTHORIZATION.md) · [NON-FUNCTIONAL-REQUIREMENTS.md](NON-FUNCTIONAL-REQUIREMENTS.md)

---

## 1. Scope

`GET /users/{userId}` returns a profile, filtered by who is asking. Self sees their own
account; anyone else needs the `users@read` permission and sees less.

**Out of scope:** updating a profile, and uploading a photo. The `photo_key` column
exists and nothing writes to it yet (§5).

---

## 2. `GET /users/:userId`

Requires a session ([AUTHORIZATION.md](AUTHORIZATION.md)). The id is a UUID; a malformed
one is `400`, not `404` — "that is not a user id" says nothing about anybody, while
"no such user" is a fact about the namespace.

```jsonc
// self
{ "id": "…", "email": "user@example.com", "photo": "https://…", "emailVerified": true,
  "createdAt": "2026-01-01T00:00:00.000Z", "roles": ["USER"] }

// someone else, with users@read
{ "id": "…", "email": "user@example.com", "photo": null, "emailVerified": true,
  "createdAt": "2026-01-01T00:00:00.000Z" }
```

| | |
|---|---|
| `200` | the profile, filtered per §4 |
| `400` | `VALIDATION_FAILED` — the id is not a UUID |
| `401` | `UNAUTHENTICATED` — no session |
| `403` | `FORBIDDEN` — not self, and no `users@read` |
| `404` | `USER_NOT_FOUND` — only reachable by someone allowed to know |
| `429` | `RATE_LIMITED` |

---

## 3. Who may look, and the order it is decided in

The rule is **self OR `users@read`**, and the two halves are different kinds of thing.
Self is an *ownership* fact — it is settled by comparing the viewer to the target, and it
consults RBAC not at all. `users@read` is a *role* fact. This is the same split
[RBAC.md §11](RBAC.md) already drew: "ownership is not RBAC".

That is why the route carries no `@Permissions('users@read')` decorator. A route
decorator sees the caller and the URL but cannot weigh one against the other, and gating
the route on the permission would refuse a user their own profile. The decision is made
in identity, which holds both the target row and the RBAC config.

**The seeded USER grant had to go.** `20260922090000_rbac` gave every `USER` a grant on
`users` with actions `['read', 'update']` — which would have made the "or" meaningless
and let any account read any other. `20260923091000_users_read_is_not_self` deletes that
grant, so `users@read` now means precisely *"may read profiles that are not their own"*.
Nothing is lost, because self-access never needed it. ADMIN keeps it through its
every-permission grant. The grant is deleted rather than narrowed because an empty action
array means "every action", so there is no way to spell "none" except by removing the row.

**Authorisation is settled before the target is looked up.** This is the load-bearing
detail of the whole endpoint. Checking existence first and answering `404` would let
anyone holding no permission at all walk the id space and learn which users are real — an
IDOR by another name, which §1.6 of the requirement names directly. Someone without
`users@read` gets the
same `403` whether or not the id exists, and the row is never read.

---

## 4. Which fields come back

Default-deny, from a policy in
[users.messages.ts](../libs/contracts/src/messages/users.messages.ts):

| Field | self | with `users@read` |
|---|---|---|
| `id` | ✓ | ✓ |
| `email` | ✓ | ✓ |
| `photo` | ✓ | ✓ |
| `emailVerified` | ✓ | ✓ |
| `createdAt` | ✓ | ✓ |
| `roles` | ✓ | — |

`roles` is withheld from everyone but the account itself. Knowing which accounts hold
ADMIN is reconnaissance, and an administrator who legitimately needs that view has
`/admin/rbac/*`, which exposes it deliberately.

**The filter walks the allow-list, not the row.** A column added to `users` later is
invisible here until someone names it in the policy on purpose. That is what makes
default-deny hold by construction rather than by remembering — and it is what the unit
test asserts, rather than any particular field.

The policy is a versioned constant rather than a table. Making it editable at runtime
would mean a schema, admin CRUD, a cache and an invalidation event, which is the shape of
the RBAC feature itself; field visibility changes at the speed of a code review, not of an
incident.

**`photo` is a presigned URL, not a stored one.** Identity holds an object-storage key and
returns it as `photoKey`; the gateway presigns a short-lived GET against the private
`uploads` bucket. The two names differ on purpose: if the swap is ever forgotten, the
response simply has no `photo` field rather than an internal key where a URL belongs. A
presign failure logs and yields `null` — an account page should not go down over an avatar.

---

## 5. Limits and audit

| Layer | Limit | Keyed on |
|---|---|---|
| route throttle | 300/hour | IP |
| profile-read guard | 60/hour | **viewer**, and only for reads of someone else |

The second is what §1.4 asks for. Per viewer rather than per IP, because the account is
what holds the permission: someone with `users@read` who starts walking the user table
does so from wherever they like, and a per-IP limit only counts connections. Self-reads
are exempt — polling your own profile is ordinary, reveals nothing about anyone else, and
counting it would let a busy tab lock its own user out of a support call.

Audit (§1.5) logs `viewerUserId`, `targetUserId`, the audience and the outcome
(`ok` / `forbidden` / `not_found`) — never the profile contents. An audit trail that
copies the data it audits doubles the number of places that data has to be protected.

---

## 6. Where the code lives

| Concern | File |
|---|---|
| The decision and the filter, §3–4 | [profile.service.ts](../apps/identity-service/src/modules/users/profile.service.ts) |
| The field policy, §4 | [users.messages.ts](../libs/contracts/src/messages/users.messages.ts) |
| RPC surface | [identity users.controller.ts](../apps/identity-service/src/modules/users/users.controller.ts) |
| HTTP surface | [gateway users.controller.ts](../apps/api-gateway/src/modules/users/users.controller.ts) |
| Presigning the photo | [gateway users.service.ts](../apps/api-gateway/src/modules/users/users.service.ts) |
| Per-viewer limit, §5 | [profile-read-rate-limit.guard.ts](../apps/api-gateway/src/modules/users/profile-read-rate-limit.guard.ts) |
| Photo column · USER grant | [migrations](../apps/identity-service/prisma/migrations/) `20260923090000_user_photo`, `20260923091000_users_read_is_not_self` |

---

## 7. Still open

1. **Nothing has been run.** Docker is unavailable in the development environment used so
   far, so the route, the grant migration and the presign are covered by unit tests and by
   reading — not by a live Postgres and MinIO.
2. **Nothing sets `photo_key`.** Uploading a photo is a separate feature; until it exists,
   `photo` is always `null`. Photos share the `uploads` bucket under a key prefix rather
   than taking a bucket of their own, which upload should keep to.
3. **There is no role that holds `users@read` yet.** After §3's migration only ADMIN does,
   through its every-permission grant. A `SUPPORT` role is exactly what `/admin/rbac/*`
   exists to create, and creating one needs no deploy.
4. `PATCH /users/:userId` is not built, and `users@update` is now held by nobody but
   ADMIN. Self-update will need the same self-or-permission split this read uses.
5. The per-viewer counter lives in the throttler's in-memory store, so it is per replica.
   Under several gateways the effective limit multiplies; it belongs in Redis alongside
   the rest of the throttler state when that moves.
