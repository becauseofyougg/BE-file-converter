# File Converter — Authentication (login)

**Status:** implemented — see §7 for where the code lives
**Date:** 2026-09-22
**Owning service:** `identity-service`, exposed through `api-gateway`
**Related:** [AUTHORIZATION.md](AUTHORIZATION.md) · [REGISTRATION.md](REGISTRATION.md) · [RBAC.md](RBAC.md) · [NON-FUNCTIONAL-REQUIREMENTS.md](NON-FUNCTIONAL-REQUIREMENTS.md)

---

## 1. Scope

Authenticate a user by email and password, optionally gated behind an emailed confirmation — the same
administrator switch registration uses, applied to the login scenario (`AUTH_CONFIRM_LOGIN`).

What happens to the session **after** it is issued — cookies, refresh, rotation, logout — is
[AUTHORIZATION.md](AUTHORIZATION.md). This document ends the moment a token pair exists.

---

## 2. `POST /auth/login`

```jsonc
{ "email": "user@example.com", "password": "…" }
```

**A — confirmation off:** `200`, and the session in two httpOnly cookies —
`access_token` and `refresh_token` ([AUTHORIZATION.md §3](AUTHORIZATION.md#3-cookies-and-what-a-request-looks-like)).
Neither token appears in the body.

```jsonc
{ "status": "authenticated", "userId": "…", "accessTokenExpiresAt": "…" }
```

`accessTokenExpiresAt` is there so a client can refresh before a request fails rather than after.

**B — confirmation on:** `202`, no tokens, and a challenge to complete.

```jsonc
{ "status": "confirmation_required", "challengeId": "…", "expiresAt": "…" }
```

The status is the contract, as in registration: a client tells the two modes apart without guessing
from which fields happen to be present.

**The password DTO has no minimum length**, unlike registration's. The policy may have been tightened
since an account was created, and rejecting a short password at the edge would tell an attacker that
anything shorter is not worth trying. Login checks the hash and nothing else. An **empty** password is
refused with `400 VALIDATION_FAILED`, though: it is a missing field rather than a short password, it
reveals nothing about the policy, and let through it would count towards the lockout as a wrong guess.

---

## 3. What a refusal reveals

Three of the four refusals are deliberately indistinguishable, and two are deliberately not.

| Case | Answer | Why |
|---|---|---|
| unknown address | `401 INVALID_CREDENTIALS` | identical to a wrong password, by design |
| wrong password | `401 INVALID_CREDENTIALS` | " |
| account locked | `429 ACCOUNT_LOCKED`, with `retryAfterSeconds` | reached only by having already guessed at this address five times, so it reveals nothing the attempts did not — and someone locked out needs to know to wait rather than keep guessing |
| email not confirmed | `403 EMAIL_NOT_VERIFIED` | the caller has just *proved* the password, so there is nobody left to hide the account's existence from, and this is the only message that leads anywhere |

**Timing is part of the answer.** An unknown address still spends one password verification's worth of
CPU against a throwaway hash before refusing. Returning early on a missed lookup makes the miss
measurably faster than a hit, and a reply that comes back ten times quicker is an account-existence
oracle that no wording in the body can hide.

---

## 4. Confirmation

Runs only when `AUTH_CONFIRM_LOGIN` is on. It reuses the challenge machinery registration already has
— `verification_tokens`, with `type = 'login_confirmation'` — so the OTP parameters, the attempt cap,
the constant-time comparison, the atomic single-use consumption and the resend limits are the same code
and not a second implementation of the same rules ([REGISTRATION.md §5](REGISTRATION.md#5-confirmation)).

Two differences that matter:

**The magic link lives 10 minutes, not 24 hours.** A registration link is often clicked hours later
from a different device; a live *login* link is a standing invitation to take over the session it
belongs to, so it expires with the attempt.

**`confirm-login` checks the challenge type.** Without that check an email-verification code — a
weaker challenge, with a 24-hour link — would complete a login. A challenge is only valid for the
thing it was issued for.

`POST /auth/confirm` takes `{ challengeId, code }` or `{ token }`. The magic link does not point at it
directly: the mail links to the frontend page `<APP_PUBLIC_URL>/login/confirm?token=…`, which posts the
token here. A link that hit the API itself would be confirmed by any mail scanner that prefetches
links — completing the login for whoever started it.
`POST /auth/resend-login-confirmation` takes `{ challengeId }` and answers `202` whether or not the
challenge is live, except inside the resend limits, which are `429 RESEND_TOO_SOON`.

The session belongs to **whoever completes the challenge**, and records that device: a link opened on
a phone signs the phone in. The mail carries the requesting user agent and IP so the owner can
recognise a sign-in that is not theirs, which is the main thing this second factor is good for.

---

## 5. Brute force

Two independent layers, because they stop different attacks ([NFR §3](NON-FUNCTIONAL-REQUIREMENTS.md#3-rate-limiting)):

| Layer | Limit | Stops |
|---|---|---|
| per IP (`@Throttle`) | 10 / hour | one host hammering many accounts |
| per email (`EmailRateLimitGuard`) | 5 / 15 min | a botnet hammering one account |
| per account (`failed_login_attempts`) | 5 consecutive, then locked 15 min | the same, once the IPs have rotated past the throttle |

The per-account counter is the one that actually protects a password: a spraying botnet rotates
addresses, and the thing being attacked is the account, not the connection. It is a **fixed window and
not an exponential backoff** — the counter resets on any success, so an attacker gets five guesses per
fifteen minutes however long they keep at it, while a user who mistypes twice and then succeeds is
never slowed at all. Both numbers are configurable (`LOGIN_MAX_FAILED_ATTEMPTS`,
`LOGIN_LOCKOUT_MINUTES`).

A lock is also re-checked when a confirmation is completed, so an attempt started before a lockout
cannot be cashed in after one.

---

## 6. Audit

| Event | Level | Notes |
|---|---|---|
| `auth.login.success` | info | with the roles the token was signed with |
| `auth.login.failed` | warn | reason: `unknown_account` / `account_deleted` / `bad_password` / `email_not_verified` — never the password |
| `auth.login.lockout_applied` | warn | |
| `auth.login.locked` | warn | a refused attempt against a locked account |
| `auth.login.confirmation_required` / `.confirmation_resent` / `.confirmed` | info | method only, never the code |
| `auth.verification.failed` | warn | `type: login_confirmation`; reason: `invalid` / `expired` / `attempts_exceeded` / `used` / `lost_race` / `unknown_challenge` / `wrong_type` / `account_removed` |

---

## 7. Where the code lives

| Concern | File |
|---|---|
| The flow, §2–5 | [login.service.ts](../apps/identity-service/src/modules/auth/login.service.ts) |
| Lockout state | [users.service.ts](../apps/identity-service/src/modules/users/users.service.ts), [migration](../apps/identity-service/prisma/migrations/20260922140000_login_lockout/) |
| Timing equalisation, §3 | [argon2-password-hasher.ts](../apps/identity-service/src/modules/auth/argon2-password-hasher.ts) |
| Challenge lifecycle, §4 | [verification.service.ts](../apps/identity-service/src/modules/auth/verification.service.ts) |
| Flags and limits | [auth-settings.service.ts](../apps/identity-service/src/modules/auth/auth-settings.service.ts) |
| HTTP surface | [gateway auth.controller.ts](../apps/api-gateway/src/modules/auth/auth.controller.ts) |

`/auth/*` is `@Public()`, since these routes are how a caller *gets* a token.

---

## 8. Still open

1. The confirmation link is `/login/confirm` on the frontend rather than the `/auth/confirm` the
   requirement names (§4) — a deliberate difference, to confirm with the mentor.
2. The lockout is per account and stored on the row. Under a distributed attack the write contention
   is on one row per targeted account, which is fine; if login volume ever makes that hot, the counter
   belongs in Redis alongside the throttler.
3. `AUTH_CONFIRM_PASSWORD_RESET` is still read but unacted on — password reset is not built.
4. A lockout blocks a *login*, not a refresh — an already-open session survives one
   ([AUTHORIZATION.md §4](AUTHORIZATION.md#4-post-authrefresh) says why that is deliberate).
