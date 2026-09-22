# File Converter — RBAC

**Status:** implemented — see §9 for where the code lives
**Date:** 2026-09-22
**Owning service:** `identity-service` owns the data; `api-gateway` enforces
**Related:** [ARCHITECTURE.md](ARCHITECTURE.md) · [REGISTRATION.md](REGISTRATION.md) · [NON-FUNCTIONAL-REQUIREMENTS.md](NON-FUNCTIONAL-REQUIREMENTS.md)

---

## 1. Scope

Central access control from roles and permissions, configured in the database and applied **without a
restart**.

**Actors:** an administrator manages roles, permissions and grants; every authenticated user is a
subject of the check, holding one or more roles.

**In scope:** the decision, the admin surface under `/admin/rbac`, cache invalidation, and the seed
that lets the system boot at all.

**Out of scope:** authentication itself beyond verifying an access token (login and refresh rotation
are still to be built), and ownership checks — RBAC answers *may this role do this at all*, not *does
this row belong to this user*. Both are needed; they are different questions.

---

## 2. Model

Three tables, matching §1.3.2–1.3.4 of the requirement:

| Entity | Meaning |
|---|---|
| `roles` | a named role. `is_system` marks the two the application cannot run without |
| `permissions` | a protected resource and the closed set of actions it defines — `users` → `read, update, delete` |
| `grants` | role → permission, optionally narrowed to some of its actions |
| `user_roles` | which roles a user holds — many-to-many, because §1.1 says "one or more" |

A required permission is written **`resource@action`** — `rbac@manage`, `conversions@create`. One
string, because that is what a route declares, and splitting it at the declaration site invites the
two halves drifting apart.

**An empty `grants.actions` means every action the permission defines.** It is stored empty rather
than expanded, so an action added to the permission later is picked up without revisiting every grant
that already meant "all of them". Naming every action explicitly is normalised to empty for the same
reason.

---

## 3. The decision

One pure function, [`decideAccess`](../libs/core/src/rbac/rbac-policy.ts), over a config snapshot:

1. no roles → deny
2. the resource is not in the config → deny
3. the action is not one the resource defines → deny
4. any of the caller's roles grants that resource, with the action named or with an empty list → allow
5. otherwise → deny

It lives in `libs/core` rather than in either service because **both decide**: identity answers
`rbac.check` for callers holding no cache, and the gateway decides locally against its own copy. Two
implementations would eventually disagree, and a disagreement here is a security hole rather than a
bug.

**It fails closed at every branch.** An unknown permission means a route asked for something the
config has never heard of — a deployment mistake — and the safe reading of a mistake is "no". An
empty config therefore denies everything, which is the correct state for a gateway that has not yet
reached identity.

Denials are logged with the reason (`no_grant`, `unknown_role`, `unknown_permission`, …) and the
config version; the client gets `403 FORBIDDEN` and nothing else. The reasons together describe the
shape of the config to anyone probing it.

---

## 4. Where the decision happens

```
client ──HTTP──> api-gateway                         identity-service
                  │ JwtAuthGuard   (verify, locally)   owns roles/permissions/grants
                  │ RbacGuard      (decide, locally)   builds + caches the config
                  │      ▲                                    │
                  │      └── RbacConfigCache <──RPC──── rbac.get-config
                  │                  ▲                        │
                  └──────────────────┴───rbac.updated────── outbox → domain.events
```

The gateway holds the config and decides without I/O. The alternative — asking identity per request —
puts a broker round trip in front of every authorised call and makes the gateway unavailable whenever
identity is.

**Roles travel in the access token.** `{ sub, roles, jti }`. That is what makes the decision free.
The cost, accepted deliberately: **revoking a role takes effect only when the token expires**, up to
`JWT_ACCESS_TTL` (15 minutes). Rule changes — grants, permissions — apply immediately, because those
live in the cached config rather than in the token. Only role *assignment* lags. If that window ever
becomes unacceptable, the fix is refresh-token revocation plus a shorter access TTL, not a per-request
lookup.

---

## 5. Applying a change without a restart

1. An admin call mutates a row inside a transaction.
2. The same transaction writes `rbac.updated` to the **outbox** — so a rolled-back change cannot
   announce itself, and a committed one cannot fail to.
3. The relay publishes it to `domain.events`.
4. Every gateway replica receives it on its **own** queue — non-durable and auto-deleting, because all
   of them must hear it, not one of them, and a message that arrived while a replica was down is
   worthless to it: it reloads the whole config at boot anyway.
5. Each replica re-fetches `rbac.get-config` and swaps its cache.

The event carries the new **version** but not the config. The payload would otherwise grow with the
ruleset, and every replica would be trusting a broker message to decide who may do what. It is a
signal to go and read, not the thing read. The version also lets a replica skip a redelivery of a
change it already has — the relay is at-least-once.

The version is a **digest of the config content**, not a counter, so two replicas that built the same
rules independently report the same string, and "are these gateways agreeing?" is answerable.

A failed reload keeps the previous config. Stale rules are better than none, because none denies
everyone.

---

## 6. Admin API

All under `/admin/rbac`, all requiring `rbac@manage` except the read routes, which require
`rbac@read`. The requirement is declared on the route rather than inferred from a role name, so
handing a new role the same power is a data change, not a deploy.

| Method | Path |
|---|---|
| GET/POST | `/admin/rbac/roles`, `/admin/rbac/permissions`, `/admin/rbac/grants` |
| PUT/DELETE | `.../{id}` for each |
| GET/PUT | `/admin/rbac/users/{userId}/roles` |
| GET | `/admin/rbac/config` — the evaluated config, for debugging a 403 |

The gateway forwards; identity decides and owns the tables. `actorUserId` travels with each call **for
the audit trail only** — identity never authorises on it, because a value the gateway puts into a
message is not a credential.

---

## 7. Refusals

| HTTP | `code` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | no token, or it does not verify |
| 401 | `TOKEN_EXPIRED` | verified but past `exp` — the client should refresh, not re-login |
| 403 | `FORBIDDEN` | the decision was "no", for any reason |
| 404 | `ROLE_NOT_FOUND` / `PERMISSION_NOT_FOUND` / `GRANT_NOT_FOUND` | |
| 409 | `ROLE_ALREADY_EXISTS` / `PERMISSION_ALREADY_EXISTS` / `GRANT_ALREADY_EXISTS` | a duplicate name, or a second grant for the same (role, permission) |
| 409 | `ENTITY_IN_USE` | deleting a role users still hold, or a permission grants still name |
| 409 | `ENTITY_IMMUTABLE` | renaming or deleting a system role |
| 400 | `INVALID_ACTION` | a grant naming an action its permission does not define |

**Deleting refuses rather than cascades.** §1.3.2 left it open. Cascading would silently revoke access
from everyone holding the role, and the one thing an access-control change must never be is silent.
The `user_roles` foreign key is `RESTRICT`, so the database refuses even if the check is bypassed;
grants cascade with their role, because a grant has no meaning without one.

**Narrowing a permission's actions prunes the grants that named them.** A grant left naming only
removed actions would become "all actions" if it were merely emptied — the opposite of what its author
meant — so it is deleted, with a warning logged.

---

## 8. Seed

The config is data, but it cannot start empty: the evaluator fails closed, so an empty config locks
everyone out of everything *including the admin endpoints that would fix it*. The migration seeds:

- roles `USER` and `ADMIN`, both `is_system`
- permissions `users` (read, update, delete), `conversions` (create, read, delete), `rbac` (read, manage)
- `USER` → `users@read,update` and all of `conversions`; `ADMIN` → everything

Every registration is assigned `USER` **in the same transaction as the account**, since a user with no
roles can do nothing at all.

**There is no seeded administrator.** Promoting the first one is a deliberate manual step:

```sql
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE u.email = 'you@example.com' AND r.name = 'ADMIN';
```

Seeding a default admin account would ship a known credential, and seeding none means the first
promotion is recorded as something a human did.

---

## 9. Where the code lives

| Concern | File |
|---|---|
| The rule itself, §3 | [rbac-policy.ts](../libs/core/src/rbac/rbac-policy.ts) |
| Schema, §2 | [schema.prisma](../apps/identity-service/prisma/schema.prisma), [migration](../apps/identity-service/prisma/migrations/20260922090000_rbac/) |
| Config build, cache, invalidation, §5 | [rbac-config.service.ts](../apps/identity-service/src/modules/rbac/rbac-config.service.ts) |
| Admin logic, §6–7 | [roles](../apps/identity-service/src/modules/rbac/roles.service.ts), [permissions](../apps/identity-service/src/modules/rbac/permissions.service.ts), [grants](../apps/identity-service/src/modules/rbac/grants.service.ts) |
| Role assignment, §8 | [user-roles.service.ts](../apps/identity-service/src/modules/rbac/user-roles.service.ts) |
| RPC surface | [rbac.controller.ts](../apps/identity-service/src/modules/rbac/rbac.controller.ts) |
| Authentication, §4 | [jwt-auth.guard.ts](../apps/api-gateway/src/modules/auth/jwt-auth.guard.ts) |
| Enforcement, §3 | [rbac.guard.ts](../apps/api-gateway/src/modules/rbac/rbac.guard.ts) |
| Gateway cache + listener, §5 | [rbac-config.cache.ts](../apps/api-gateway/src/modules/rbac/rbac-config.cache.ts), [rbac-events.controller.ts](../apps/api-gateway/src/modules/rbac/rbac-events.controller.ts) |
| HTTP admin surface, §6 | [rbac-admin.controller.ts](../apps/api-gateway/src/modules/rbac/rbac-admin.controller.ts) |

Guards are registered as `APP_GUARD`, so **every route is authenticated unless it says `@Public()`** —
opt-out, so a new controller is protected by the fact that nobody did anything. `/auth/*` and
`/health` are the public ones. A route additionally declares `@Permissions('resource@action')` when it
needs one; authentication alone is the bar otherwise, since inventing a permission for `/users/me`
buys nothing.

---

## 10. Audit

Per [NFR §6](NON-FUNCTIONAL-REQUIREMENTS.md#6-logging-of-critical-events), with `actorUserId` and the
config version:

| Event | Level |
|---|---|
| `rbac.role.*`, `rbac.permission.*`, `rbac.grant.*` (create/update/delete) | info |
| `rbac.user_roles.replaced`, with the before and after sets | info |
| `rbac.config.invalidated` / `.loaded` / `.reloaded` | info |
| `rbac.config.reload_failed`, with the version kept | error |
| `rbac.access.denied`, with roles, requirement and reason | warn |
| `rbac.permission.malformed` — a route declaring nonsense | error |
| `auth.token.rejected` | warn |

---

## 11. Still open

1. Revoking a role leaves the existing token valid for up to 15 minutes (§4). Acceptable, or does this
   need refresh-token revocation first?
2. Ownership ("this job is mine") is not RBAC and is not built. It belongs with the conversions
   endpoints.
3. `rbac.check` exists for services that hold no cache. Nothing calls it yet — the gateway is the only
   enforcement point today.
4. The per-replica event queue is auto-deleting. If a gateway is partitioned from RabbitMQ for longer
   than a config change takes, it keeps serving stale rules until reconnect, when it reloads.
