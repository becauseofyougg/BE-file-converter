# File Converter — Changing a user profile

**Status:** implemented — see §7 for where the code lives
**Date:** 2026-09-23
**Owning service:** `identity-service`, exposed through `api-gateway`
**Related:** [USER-PROFILE.md](USER-PROFILE.md) · [RBAC.md](RBAC.md) · [REGISTRATION.md](REGISTRATION.md) · [AUTHORIZATION.md](AUTHORIZATION.md)

---

## 1. Scope

Three endpoints. `PATCH /users/:userId` writes ordinary fields; `POST /users/:userId/email-change`
and `.../confirm` move an account to a new address, which a user has to prove and an administrator
does not.

**Out of scope:** uploading a photo (§8).

---

## 2. Two paths to a new address, and why

| | Self | holder of `users@update` |
|---|---|---|
| `displayName` | `PATCH` | `PATCH` |
| `email` | **challenge flow only** | `PATCH`, directly |

This is the requirement's central rule. A user claiming an address has to demonstrate they can read
mail sent to it — otherwise `PATCH {"email": "ceo@company.com"}` is an account-takeover primitive that
needs no more than a form field. An administrator is exempt precisely because the administrative path
exists to rescue somebody who has *lost* the mailbox they would otherwise have to prove.

§1.3.4 asked us to pick one of two ways for the administrator to do it. It is the general `PATCH`, not
a dedicated `/email` route: an administrator changing a name and an address in one go should be one
request and one transaction, and a second route would make it two of each.

---

## 3. `PATCH /users/:userId`

```jsonc
{ "displayName": "Ada Lovelace" }   // or null to clear it
```

Returns `200` and the updated profile, filtered by the reader's audience exactly as
[USER-PROFILE.md §4](USER-PROFILE.md) describes — the same projection, so a write and a read of the
same account never disagree about what that account may see.

**Authorisation mirrors the read**, with its own permission: self, or `users@update`. A role can
therefore be given sight of a profile without the power to change it. The decision is made in identity,
not by a route decorator, because it depends on who the target turns out to be — and it is settled
**before the target is looked up**, so a refusal never depends on whether the id exists
([USER-PROFILE.md §3](USER-PROFILE.md) has the reasoning in full).

**A field this caller may not write is refused, not dropped.** Silently ignoring it is the worst of the
three possible behaviours: the client believes a change it can see in its own form actually happened,
and nothing anywhere reveals otherwise. The response names the offending fields, and a Self who sends
`email` gets a message pointing at the flow that can do it.

Nothing is applied when any field is refused. A patch is one change, not a best effort.

**`photo` is writable by nobody**, in either role. It holds an object-storage key, and a client that
could set one at will could point its profile at any object in the bucket and be handed a presigned
URL for it. The key is written server-side by the upload endpoint, when that exists.

| | |
|---|---|
| `400` | `VALIDATION_FAILED` — unknown field, or a value that fails its format |
| `403` | `FORBIDDEN` (not yours, no permission) or `FIELD_NOT_WRITABLE` (yours, wrong field) |
| `404` | `USER_NOT_FOUND` |
| `409` | `EMAIL_IN_USE` |

A name is trimmed, and one that is then empty clears the field. A form submitting `"   "` means "I
removed my name", and storing the spaces would leave a profile that renders blank without being null —
two states that look identical and behave differently.

---

## 4. Changing an address as Self

### 4.1 `POST /users/:userId/email-change`

```jsonc
{ "newEmail": "ada@example.com" }
→ { "requiresConfirmation": true, "challengeId": "…", "method": "otp", "expiresAt": "…" }
```

Self only. No permission opens this to anyone else — an administrator has the direct path and does not
need to impersonate a confirmation.

It reuses registration's challenge machinery with `type = 'email_change'`, so the TTL, the attempt cap,
the constant-time comparison, the atomic single-use consumption and the resend interval are the same
code rather than a second implementation of the same rules
([REGISTRATION.md §5](REGISTRATION.md)). The numbers the requirement asked to have fixed:

| | |
|---|---|
| OTP | 6 digits, **10 minutes** |
| magic link | **10 minutes** — not registration's 24 hours |
| attempts | **5** per challenge |
| resend | **60 s** apart, 5 per hour |

The link gets the short life a login link gets, for the same reason: a live one moves the account to
whoever opens it.

**The address being claimed lives on the challenge row**, not in the confirming request. That is what
makes the address that was proved necessarily the address that gets applied — taking it from the
confirmation instead would let a code mailed to one address be quoted back alongside another.

**An address another account holds is a plain `409`**, unlike registration's deliberate silence. The
difference is that this caller is authenticated: an account probing addresses is traceable and
rate-limited, so the enumeration argument is far weaker — and somebody who mistypes a colleague's
address deserves to be told, rather than left waiting for mail that will never come.

### 4.2 `POST /users/:userId/email-change/confirm`

```jsonc
{ "challengeId": "…", "code": "123456" }   // or { "token": "…" }
→ { "status": "email_changed", "userId": "…", "email": "ada@example.com" }
```

**No session required**, which §1.3.3 left open. The link is opened in the *new* mailbox, usually on a
phone that is not logged in; requiring a session there would break the ordinary case without adding a
factor the initiating request had not already supplied. What authorises the change is the secret —
which only the holder of that mailbox received, and which an authenticated Self had to ask for in the
first place.

Two checks beyond the secret itself. The challenge's **type** must be `email_change`: without that, an
email-verification code — a weaker challenge with a day-long link — would move the account. And the
**path segment must name the challenge's owner**; it proves nothing on its own, but a mismatch means
the client is confused about which account it is changing, and applying it anyway would be worse.

The address is re-checked for collisions *after* the code is consumed. Somebody may have claimed it
during the ten minutes; the citext unique index is the real guarantee, and this turns it into a `409`
rather than a constraint violation surfacing as a `500`.

### 4.3 The old address is told

Both paths publish `user.email_changed` to the address that just **lost** the account, carrying
`actorUserId` when an administrator was responsible. It is the only way that mailbox's owner learns
their account has been moved, which makes it the one notification that matters after a takeover.

Published through the outbox in the same transaction as the write, so a rolled-back change cannot
announce itself.

---

## 5. Limits and audit

| Endpoint | Limit |
|---|---|
| `PATCH /users/:userId` | 60/hour per IP, and 60/hour per viewer for writes to someone else |
| `POST …/email-change` | 5/hour per IP |
| `POST …/email-change/confirm` | 10/hour per IP |

The initiation limit is the tight one: it sends mail to an address the caller chose, so the ceiling is
what stops it being used to post letters.

Audit (§1.5) logs `actorUserId`, `targetUserId`, the field **names** and the outcome. Never the values,
and never the address being claimed — those are the thing being protected, and a log that copies them
doubles the number of places they have to be protected in.

---

## 6. A note on module structure

`VerificationModule` was split out of `AuthModule` for this feature. `AuthModule` imports
`UsersModule`, so leaving the challenge lifecycle there would have made `UsersModule` import
`AuthModule` back. A `forwardRef` would have papered over it, but the honest reading is that issuing
and consuming a challenge is not specific to authentication — registration, login and an address
change all lean on the same rules, and they now lean on the same module.

---

## 7. Where the code lives

| Concern | File |
|---|---|
| `PATCH`, §3 | [profile-update.service.ts](../apps/identity-service/src/modules/users/profile-update.service.ts) |
| Email change, §4 | [email-change.service.ts](../apps/identity-service/src/modules/users/email-change.service.ts) |
| Both field policies | [users.messages.ts](../libs/contracts/src/messages/users.messages.ts) |
| Challenge lifecycle | [verification.service.ts](../apps/identity-service/src/modules/auth/verification.service.ts) |
| HTTP surface | [gateway users.controller.ts](../apps/api-gateway/src/modules/users/users.controller.ts) |
| Schema | [migration](../apps/identity-service/prisma/migrations/20260923120000_profile_update/) — `users.display_name`, `verification_tokens.new_email` |

---

## 8. Still open

1. **Nothing has been run.** Docker is unavailable in the development environment used so far, so all
   three endpoints, the migration and the mail are covered by unit tests and by reading — not by a
   live Postgres and RabbitMQ.
2. `notification-service` renders neither `user.email_change_requested` nor `user.email_changed`.
   Identity publishes both; nothing consumes them, so **no mail is sent and no code arrives**. This is
   the one gap that stops the flow working end to end today.
3. Uploading a photo is still not built, so `photo` remains unwritable and always null.
4. Changing an address does not end existing sessions. It cannot: refresh tokens are not stored, so
   there is nothing to revoke ([AUTHORIZATION.md §5](AUTHORIZATION.md)). An attacker who changed the
   address keeps their session for up to 30 days, which is the strongest argument in this codebase for
   the `tokens_valid_from` column that document sketches.
5. `displayName` is not screened for abuse — no profanity list, no homoglyph check, no uniqueness. It
   is a label, and a product decision rather than a technical one.
