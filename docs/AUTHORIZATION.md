# File Converter — Authorization (sessions)

**Status:** implemented — see §7 for where the code lives
**Date:** 2026-09-22
**Owning service:** `api-gateway` (enforcement), `identity-service` (issuance)
**Related:** [AUTHENTICATION.md](AUTHENTICATION.md) · [RBAC.md](RBAC.md) · [REGISTRATION.md](REGISTRATION.md) · [NON-FUNCTIONAL-REQUIREMENTS.md](NON-FUNCTIONAL-REQUIREMENTS.md)

---

## 1. Scope and the one constraint that shapes everything

A request is authenticated by a JWT the browser sends in a cookie. There are two
tokens: an **access token** (15 minutes) and a **refresh token** (30 days), rotated
as a pair on every refresh.

**No refresh token is stored on the server** — no allowlist, no denylist, no persisted
`jti`, no session row. This is a requirement, not a choice made here, and it decides
most of what follows: a refresh token is valid for its full 30 days and cannot be
recalled. §5 is about what that costs and what is left to limit it.

The `refresh_tokens` table that backed the previous design was dropped
([migration](../apps/identity-service/prisma/migrations/20260922160000_drop_refresh_tokens/)).
Everyone signs in again once; those rows were the only record of a live session.

---

## 2. The two tokens

| | Access | Refresh |
|---|---|---|
| Lifetime | 15 min (`JWT_ACCESS_TTL`) | 30 days (`REFRESH_TOKEN_TTL_DAYS`) |
| Signed with | `JWT_SECRET` | `JWT_REFRESH_SECRET` |
| Claims | `sub`, `roles`, `jti` | `sub`, `jti`, `typ: "refresh"` |
| Verified by | the gateway, locally | identity, on `/auth/refresh` only |

**Two secrets, not one.** The gateway holds `JWT_SECRET` because verifying every
request locally is the entire reason the roles travel inside the token
([RBAC.md §1.3.1](RBAC.md)). If both tokens shared that key, a compromised gateway
— a service that by design only ever needs to *read* tokens — could mint 30-day
refresh tokens. Joi refuses to boot identity if the two values match.

The type claim is checked as well, so an access token presented at `/auth/refresh`
is refused. Without it, 15 minutes of access could be traded for 30 days.

**A refresh token carries no roles.** It authorises nothing on its own; it names an
account that may be re-issued a session. The roles are read from the database at
every refresh (§4).

---

## 3. Cookies, and what a request looks like

Both tokens go into `httpOnly` cookies. Neither is ever returned in a response body.

| Cookie | Path | Lifetime |
|---|---|---|
| `access_token` | `/` | 15 min |
| `refresh_token` | `/auth` | 30 days |

The refresh cookie is scoped to `/auth` on purpose: `/auth/refresh` and
`/auth/logout` are the only endpoints with a use for it, so it never rides along on
an ordinary API call and never lands in a proxy log for one. Each cookie's `maxAge`
is computed from the expiry the token itself reports, so the two cannot drift apart.

`httpOnly` is the trade being made: a script injected into the page cannot read
these cookies, which `localStorage` can never promise — at the price of the browser
attaching them automatically, which is what `SameSite` is then for.

| Variable | Default | |
|---|---|---|
| `COOKIE_SAMESITE` | `strict` | `none` for a cross-origin front end, which then forces `Secure` |
| `COOKIE_SECURE` | `true` under `NODE_ENV=production`, else `false` | derived, so http://localhost works and production does not ship plaintext sessions |
| `COOKIE_DOMAIN` | unset — this host only | set only when the API is shared across subdomains |

`SameSite` is the whole CSRF defence for a cookie-authenticated API, so the config
refuses `none` together with `COOKIE_SECURE=false`: a browser silently discards
that combination, which presents as "nobody can log in" long after the deploy.

**Verifying a request** is local — signature, `exp`, and `sub` present — and costs no
call to identity. `Authorization: Bearer` still works as a fallback for callers that
are not browsers (scripts, tests). It weakens nothing: building that header requires
having read the cookie first, which is exactly what `httpOnly` prevents.

The requirement also lists "load the user and check their status" as part of this
step. **That is deliberately not done per request.** It would put a database round
trip on every call and make the token's self-contained claims pointless. It happens
at refresh instead — §4.

| Failure | Answer |
|---|---|
| no cookie and no bearer header | `401 UNAUTHENTICATED` |
| bad signature, wrong shape | `401 UNAUTHENTICATED` |
| expired | `401 TOKEN_EXPIRED` |

`TOKEN_EXPIRED` is its own code so a client refreshes rather than bouncing the user
to a login form.

---

## 4. `POST /auth/refresh`

Takes the `refresh_token` cookie and nothing else; returns `200` and a **new pair**
in new cookies. Half a rotation is not an option — leaving the old refresh token
live for another 30 days is the thing rotation exists to prevent.

It runs in identity rather than at the gateway, and does three things the gateway
could not:

1. **Verifies against `JWT_REFRESH_SECRET`**, which only identity holds.
2. **Resolves the subject and checks the account may still hold a session** — the
   requirement's steps 3–4. A user deleted since the token was signed still holds a
   perfectly valid signature, because the signature is all the token is.
3. **Re-reads the roles from the database.**

Point 3 is the interesting one. With nothing stored to revoke, *this is the only
moment in a session's life when the database is consulted about the account* — and
therefore the only moment a change to it can take effect. A role taken away reaches
the user on their next refresh, at most one access-token lifetime later, instead of
in thirty days. This is the answer to the open question in [RBAC.md §4](RBAC.md).

**A login lockout is not a barrier here.** It exists to stop password guessing, and
the holder of a refresh token guessed nothing. Letting it block a refresh would hand
anyone who knows an email address a way to knock that account's live sessions offline
by failing five logins against it.

Every failure — missing cookie, bad signature, expired, unknown subject, unverified
address — answers `401 UNAUTHENTICATED` with one message. A client's only useful
reaction to any of them is to sign in again, and separating the cases would tell
someone probing with a stolen token which half of their guess was right.

Rate limit: 60/hour per IP. A legitimate client refreshes about four times an hour,
several tabs may each do it, and the ceiling still bounds anyone replaying a stolen
token to keep a session alive indefinitely.

---

## 5. `POST /auth/logout`, and what it cannot do

Clears both cookies. `204`, always, including when there was no session — a client's
next move is the same either way.

**That is the entirety of it.** There is nothing to revoke, so both tokens remain
cryptographically valid until they expire. Logging out stops *this browser* sending
them; it does not stop anyone else who has a copy.

This is the accepted consequence of §1, and it is worth stating plainly:

- A stolen refresh token is good for up to 30 days, and nothing can shorten that.
- Logout on a shared machine protects against the next person at that machine, and
  against nothing else.
- "Sign out everywhere" cannot be built without reversing §1.

Two things still limit the blast radius, and neither is a substitute for revocation:
the refresh cookie is `httpOnly` and scoped to `/auth`, so reading it requires
something stronger than an XSS payload reading `document.cookie`; and the roles are
re-read at every refresh, so a compromised session at least loses the privileges an
administrator takes away (§4).

If revocation is ever wanted back, the smallest honest version is a per-user
`tokens_valid_from` timestamp checked at refresh — one column, no session table —
which turns "sign out everywhere" into a single write. It is still a server-side
record, so it is out of scope until §1 changes.

---

## 6. Audit

| Event | Level | Notes |
|---|---|---|
| `auth.token.rejected` | warn | reason: `expired` / `invalid` |
| `auth.refresh.rejected` | warn | reason: `expired` / `invalid` / `wrong_type` / `unknown_subject` / `email_not_verified` |
| `auth.refresh.succeeded` | info | with the roles the new token was signed with |

Never the token itself. A refresh token in a log aggregator is a credential good for
the next thirty days sitting in a system designed for wide read access — the pino
redaction list covers `req.headers.cookie`, `set-cookie`, `*.accessToken` and
`*.refreshToken` for exactly this reason ([NFR §6](NON-FUNCTIONAL-REQUIREMENTS.md)).

---

## 7. Where the code lives

| Concern | File |
|---|---|
| Signing, verifying, rotation, §2 | [tokens.service.ts](../apps/identity-service/src/modules/tokens/tokens.service.ts) |
| Refresh, §4 | [refresh.service.ts](../apps/identity-service/src/modules/auth/refresh.service.ts) |
| Cookie attributes, §3 | [session-cookies.service.ts](../apps/api-gateway/src/modules/auth/session-cookies.service.ts) |
| Per-request verification, §3 | [jwt-auth.guard.ts](../apps/api-gateway/src/modules/auth/jwt-auth.guard.ts) |
| `/auth/refresh`, `/auth/logout` | [gateway auth.controller.ts](../apps/api-gateway/src/modules/auth/auth.controller.ts) |
| Cookie config and its defaults | [config.validation.ts](../libs/core/src/config/config.validation.ts) |

---

## 8. Still open

1. **Nothing has been run against a live stack.** Docker is not available in the
   development environment used so far, so the cookie round trip, the rotation and
   the `drop_refresh_tokens` migration are covered by unit tests and by reading —
   not by a browser and a Postgres.
2. No account-status column exists yet (`blocked`, `suspended`). §4 checks existence
   and a confirmed address, which is everything the schema currently knows. A status
   column is a one-line addition there when one is added.
3. `POST /auth/logout` sends nothing to identity, because there is nothing for
   identity to do. `IDENTITY_PATTERNS.LOGOUT` is reserved and unhandled.
4. CSRF rests entirely on `SameSite`. A deployment that needs `COOKIE_SAMESITE=none`
   should add a double-submit token before going live; nothing here provides one.
