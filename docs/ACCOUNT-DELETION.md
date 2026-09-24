# File Converter — Erasing an account

**Status:** implemented — see §8 for where the code lives
**Date:** 2026-09-24
**Owning service:** `identity-service`, exposed through `api-gateway`
**Related:** [USER-PROFILE.md](USER-PROFILE.md) · [PROFILE-UPDATE.md](PROFILE-UPDATE.md) · [AUTHORIZATION.md](AUTHORIZATION.md) · [RBAC.md](RBAC.md)

---

## 1. Scope

`DELETE /users/:userId` erases an account. A user may erase their own after proving their
address; the holder of `users@delete` may erase anyone's immediately.

The method is `DELETE`, not `POST …/delete` — §1.3.1 left that open. `DELETE` already means
this, and an idempotent verb suits an operation whose second call is a no-op (§7).

---

## 2. Erasure means anonymisation

The row survives its own deletion, emptied of everything personal.

| column | after |
|---|---|
| `id` | unchanged |
| `email` | `deleted-<id>@invalid` |
| `display_name` · `photo_key` | `NULL` |
| `password_hash` | a sentinel that is not valid argon2 |
| `email_verified_at` · `locked_until` | `NULL` |
| `failed_login_attempts` | `0` |
| `deleted_at` | now |

**Why not `DELETE FROM users`.** `conversion_jobs` lives in a *different database* and carries
`user_id` with no foreign key to enforce anything. Dropping the row would leave every job, and
every audit line ever written about that user, pointing at an id that resolves to nothing. GDPR
asks that the personal data go, not that the primary key go with it — and a key with nothing
attached to it is no longer personal data.

The address becomes a unique unroutable placeholder rather than `NULL`, so the `citext` unique
index still holds and the address the account used is **free for somebody else to register**.
`.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so nothing can be mailed to
it by accident.

Every column is overwritten in **one statement**. A two-step erasure has a window in which the
data is still there and the account already looks gone, and nothing guarantees the second step
ever runs.

---

## 3. Who may do it

| | |
|---|---|
| Self | `targetUserId` equals the caller — **and the address must be proved** (§4) |
| `users@delete` | erases immediately, no challenge |

Self is an ownership fact and consults RBAC not at all, exactly as in
[USER-PROFILE.md §3](USER-PROFILE.md). The permission is `users@delete`, distinct from `@read`
and `@update`, so a support role can be given sight of an account without the power to destroy
it. After [the grant migration](../apps/identity-service/prisma/migrations/20260923091000_users_read_is_not_self/),
only ADMIN holds it.

**Authorisation is settled before the target is looked up**, so a refusal never depends on
whether the id exists — the same ordering every other user route uses, and for the same reason.

---

## 4. Self-erasure needs the mailbox

`DELETE /users/:userId` by the account's owner answers `202` and a challenge:

```jsonc
{ "status": "confirmation_required", "challengeId": "…", "method": "otp", "expiresAt": "…" }
```

completed at `POST /users/:userId/deletion/confirm` with `{ challengeId, code }` or `{ token }`,
which answers `204`.

This is the one irreversible thing the API does, and a session is a weak thing to rest it on: a
fifteen-minute access token found on an unlocked laptop should not be enough to destroy an
account. The mail **is** the second factor — whoever has the laptop does not necessarily have
the mailbox.

It reuses the challenge machinery of registration and login, with
`type = 'account_deletion'`, so the attempt cap, constant-time comparison, single-use
consumption and resend interval are the same code. The magic link lives **10 minutes**, the
shortest of any: a link that can erase an account should not still work tomorrow.

**Confirming requires a session**, unlike the email-change confirmation
([PROFILE-UPDATE.md §4.2](PROFILE-UPDATE.md)). The contrast is deliberate. That link goes to a
mailbox the user has not proved yet, often on a second device with no session, so requiring one
would break the ordinary case. This link goes to their own address, on the device they are
already signed in on, and destroys the account — so requiring both the session and the secret
costs nothing and means an intercepted mail is not enough on its own.

An administrator gets no challenge. Their path exists precisely for the cases where the user
cannot be asked.

---

## 5. What is erased, and what is only announced

Inside the transaction, identity does everything it owns:

1. every live challenge the user holds is spent — a code mailed before the erasure must not
   still work after it;
2. every role assignment is deleted;
3. the row is anonymised (§2).

Then `user.deleted` goes through the outbox — same transaction, so a rollback cannot announce an
erasure that did not happen. **Every other service purges its own data on that event**; identity
can only empty its own tables.

The event carries the address and the photo key *because* both have just been destroyed. A
consumer that went looking for them afterwards would find an emptied row, so they have to travel
with the message. It is the only event in this system that carries personal data in order to get
rid of it.

§1.3.1 step 4 asked for a choice between synchronous and queued. Identity's own work is one
transaction and finishes before the response; the slow parts are all downstream, and the outbox
is already how this codebase moves work across a service boundary. So the answer is `204`, not
`202` with a job id — and §1.3.2's status endpoint does not exist, since it only applies if the
operation is asynchronous.

---

## 6. The sessions really do end

§1.3.1 step 2 asks for active sessions and refresh tokens to be revoked. **Nothing is stored to
revoke** — [AUTHORIZATION.md §1](AUTHORIZATION.md) forbids a server-side record of a refresh
token — so the check in the refresh path *is* the revocation: identity loads the account on every
refresh, and an erased one is refused.

The practical effect is that an erased account's last access token keeps working until it expires
and cannot be replaced. **The session ends within one access-token lifetime, 15 minutes at
worst.** The gateway also clears the cookies of somebody who has just erased their own account,
but that is a courtesy to the browser rather than the boundary.

This is the same mechanism that makes a revoked role take effect
([RBAC.md §4](RBAC.md)), and the clearest illustration of why refreshing goes through identity
rather than being signed at the edge.

Login is refused too. An erased account cannot be reached by its old address anyway — the column
was overwritten — but the check is explicit so the behaviour does not rest on that one detail,
and it is folded into the same `INVALID_CREDENTIALS` refusal, with the same burnt CPU, as an
unknown address. "This account was deleted" is exactly the kind of thing
[AUTHENTICATION.md §3](AUTHENTICATION.md) says not to disclose.

---

## 7. Errors, and the 409 that cannot happen

| | |
|---|---|
| `400` | `VALIDATION_FAILED` — the id is not a UUID, or no code and no token |
| `401` | `UNAUTHENTICATED` |
| `403` | `FORBIDDEN` — not yours, and no `users@delete` |
| `404` | `USER_NOT_FOUND` — including an account already erased |
| `429` | `RATE_LIMITED` |

**§1.4's `409 Conflict` is unreachable, by design.** It describes a user stuck in a `deleting`
state, which only exists if erasure is asynchronous. Here it is one transaction: an account is
live or it is erased, never in between. Inventing an intermediate state purely to be able to
return the status the requirement lists would add a failure mode rather than remove one.

Idempotence (§1.6) comes from the same place. Every read path treats a non-null `deleted_at` as
"no such user", so a repeated `DELETE` finds nothing, changes nothing, publishes no second
`user.deleted`, and answers the `404` every other route gives for a user that does not exist.

Limits: `DELETE` is 5/hour per IP and 10/hour per viewer for someone else's account; the
confirmation is 10/hour.

Audit (§1.5) records `actorUserId`, `targetUserId`, the mode (`self` / `admin`), the outcome and
the caller's stated reason. Never a value being erased — an audit trail that copies the personal
data whose destruction it is recording would be a strange thing to build.

---

## 8. Where the code lives

| Concern | File |
|---|---|
| Both paths, §3–5 | [account-deletion.service.ts](../apps/identity-service/src/modules/users/account-deletion.service.ts) |
| The anonymisation itself, §2 | [users.service.ts](../apps/identity-service/src/modules/users/users.service.ts) |
| Session death, §6 | [refresh.service.ts](../apps/identity-service/src/modules/auth/refresh.service.ts), [login.service.ts](../apps/identity-service/src/modules/auth/login.service.ts) |
| HTTP surface | [gateway users.controller.ts](../apps/api-gateway/src/modules/users/users.controller.ts) |
| Schema | [migration](../apps/identity-service/prisma/migrations/20260924090000_account_deletion/) |

---

## 9. Still open

1. **Nothing has been run.** Docker is unavailable in the development environment used so far,
   so both paths, the migration and the event are covered by unit tests and by reading — not by
   a live Postgres and RabbitMQ.
2. **Nothing consumes `user.deleted`.** `notification-service` sends no farewell and no
   confirmation code, and no service removes the photo from object storage or purges the user's
   conversion jobs. Identity's own erasure is complete; the rest of the system has not been told
   what to do about it yet. Today that leaves nothing behind in practice — no uploader exists, so
   `photo_key` is always null — but it is the gap that matters before this is a real GDPR answer.
3. The erasure is immediate, with no grace period. A user who deletes by mistake has no recourse,
   and the data is genuinely gone. A `deleted_at` in the future plus a nightly sweep would give a
   30-day window; whether that is wanted is a product decision, and the column is already the
   right shape for it.
4. `verification_tokens` rows survive the erasure, spent but present, until the cleanup job
   removes them. What they hold is a `user_id` and a hash, which is not personal data — the one
   exception, `new_email` on an abandoned `email_change` challenge, is cleared as part of the
   erasure, since an address the user typed should not outlive the account it belongs to.
