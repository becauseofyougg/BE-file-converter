# File Converter — Replacing or adding authentication

**Status:** implemented
**Date:** 2026-09-28
**Related:** [AUTHORIZATION.md](AUTHORIZATION.md) · [AUTHENTICATION.md](AUTHENTICATION.md) · [RBAC.md](RBAC.md)

---

## 1. Scope

Authentication sits behind three ports. Code that uses them never learns what is behind them, so a
change of scheme is a new implementation and a one-line binding, not a rewrite of the auth module.

| Port | Service | Asked for | Implementation today | Bound in |
|---|---|---|---|---|
| [`Authenticator`](../apps/api-gateway/src/modules/auth/authenticator.ts) | gateway | "who sent this request?" | [`JwtAuthenticator`](../apps/api-gateway/src/modules/auth/authenticators/jwt.authenticator.ts) — access JWT from the cookie, then `Bearer` | `AUTHENTICATORS` in [`AuthGuardsModule`](../apps/api-gateway/src/modules/auth/auth-guards.module.ts) |
| [`TokenIssuer`](../apps/identity-service/src/modules/tokens/token-issuer.ts) | identity | "issue a session" / "whose refresh token is this?" | [`JwtTokenIssuer`](../apps/identity-service/src/modules/tokens/jwt-token-issuer.ts) — two HS256 JWTs | `TOKEN_ISSUER` in [`TokensModule`](../apps/identity-service/src/modules/tokens/tokens.module.ts) |
| [`PasswordHasher`](../apps/identity-service/src/modules/auth/password-hasher.ts) | identity | "store this password" / "is this it?" | [`Argon2PasswordHasher`](../apps/identity-service/src/modules/auth/argon2-password-hasher.ts) | `PASSWORD_HASHER` in [`AuthModule`](../apps/identity-service/src/modules/auth/auth.module.ts) |

Past authentication, everything reads a [`RequestUser`](../apps/api-gateway/src/modules/auth/request-user.ts)
— `{ id, roles, tokenId }`. The RBAC guard, the controllers and the rate limiters depend on that and
on nothing else, so none of them change when the scheme does.

`JwtAuthenticator` and `JwtTokenIssuer` are the only two places in the codebase that know the access
token is a JWT.

---

## 2. How the gateway authenticates

[`AuthenticationGuard`](../apps/api-gateway/src/modules/auth/authentication.guard.ts) is global and
knows no scheme. For every request that is not `@Public()`, it asks each authenticator in
`AUTHENTICATORS` in turn. Each one gives one of three answers:

| Answer | Meaning | What the guard does |
|---|---|---|
| `null` | "nothing on this request is mine" | asks the next one |
| a `RequestUser` | authenticated | attaches it and stops |
| throws a 401 | "it is mine, and it is bad" | **fails**, and asks no one else |

The third row is a security property, not a convenience. A forged or expired credential must not fall
through to a later, possibly weaker, scheme that would accept the request on other grounds — so a bad
`access_token` cookie is a 401 even when the same request also carries a valid bearer header. There is
an e2e test for exactly that.

It fails closed: an empty list, or a list none of whose members recognise the request, is a 401.

---

## 3. Recipes

### 3.1 Add a second way in — API keys for scripts, say

```ts
@Injectable()
export class ApiKeyAuthenticator implements Authenticator {
  async authenticate(request: FastifyRequest): Promise<RequestUser | null> {
    const key = request.headers['x-api-key'];
    if (typeof key !== 'string') return null;          // not mine

    const owner = await this.keys.resolve(key);        // your lookup
    if (!owner) throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Invalid API key', 401);

    return { id: owner.userId, roles: owner.roles, tokenId: owner.keyId };
  }
}
```

```ts
// auth-guards.module.ts — list order is precedence
{ provide: AUTHENTICATORS, inject: [JwtAuthenticator, ApiKeyAuthenticator],
  useFactory: (...authenticators: Authenticator[]) => authenticators },
```

Nothing else changes. The roles it returns go through the same RBAC as a user's.

### 3.2 HS256 → RS256 / ES256

A configuration change in the two JWT classes' modules: identity signs with the private key
(`TokensModule`), and the gateway verifies with the public one (`AuthGuardsModule`,
`verifyOptions.algorithms`). The gateway then holds nothing that can mint a token, which is the reason
to do it.

### 3.3 An external identity provider (Keycloak, Auth0, Cognito)

- **Gateway:** a `JwksAuthenticator` that verifies the IdP's token against its JWKS and maps its claims
  to a `RequestUser`. It either replaces `JwtAuthenticator` or goes before it in the list during a
  migration.
- **Identity:** registration, login, confirmation and refresh move to the IdP, and most of
  `modules/auth` is deleted rather than rewritten. Profiles, RBAC and erasure stay.
- **What the ports do not solve:** roles. Ours live in the identity database, and an IdP token does
  not carry them. Either model them in the IdP, or look them up by subject and cache them. Users will
  also need an `external_id` column, since the IdP's `sub` is not our UUID.

### 3.4 Opaque tokens, or server-side sessions

A new `TokenIssuer`, plus an authenticator that looks the token up. That lookup is a round trip on
every request, which is what the self-contained JWT avoids. Note that storing refresh state on the
server is currently **forbidden** by [AUTHORIZATION.md §1](AUTHORIZATION.md), so this is a change of
requirement first and of code second.

### 3.5 A different password hash

Binding a new `PasswordHasher` is one line, but every existing row holds an argon2 hash. The workable
route is a transitional hasher that verifies both formats and hashes only in the new one, re-hashing
each account at its next successful login. `burnVerificationTime` must cost what the *new* `verify`
costs, or login answers faster for unknown addresses.

---

## 4. What each implementation must keep true

These are the properties callers rely on. They are written on each interface, and the existing tests
pin them for today's implementations.

- **Authenticator:** `null` for "not mine", throw for "mine and bad" — never `null` for a bad credential
  of its own kind.
- **TokenIssuer:** `issuePair` returns a new pair every time, because refresh *is* rotation.
  `verifyRefresh` accepts only a refresh credential it issued, never an access one, and every refusal
  is the same `UNAUTHENTICATED` 401. It returns `{ userId }` and nothing implementation-specific.
- **PasswordHasher:** `verify` never throws; a malformed hash is `false`. `burnVerificationTime` costs
  one real `verify`.

---

## 5. What is not behind a port

Fixed on purpose, because nothing in view needs them to vary:

- **Cookies as the session transport** — [`SessionCookiesService`](../apps/api-gateway/src/modules/auth/session-cookies.service.ts).
  The authoriser reads cookies first, but *writing* a session is always two cookies.
- **The shape of a session** — `TokenPair` in the contracts: an access and a refresh credential as
  strings, each with an expiry. That covers JWTs and opaque tokens alike.
- **The gateway ↔ identity contract** — `IDENTITY_PATTERNS`. Replacing identity with another service
  that answers them needs no gateway change; replacing it with something that speaks HTTP means
  rewriting the gateway's `AuthService`, which is exactly the adapter it already is.

---

## 6. Found along the way

- **A malformed refresh cookie answered 500, not 401.** The identity RPC DTO checked `@IsJWT()`, and
  a validation failure there becomes `INTERNAL_ERROR` through the RPC exception filter — the gateway
  forwards the cookie without shaping it, so this was reachable by anyone. The DTO now only bounds
  the string, and `verifyRefresh` refuses a malformed token with the same 401 as any other bad one.
  It was also the one place outside `JwtTokenIssuer` that knew the refresh token is a JWT.
- **The e2e suite was not testing the app that ships.** It built the app on Express with no exception
  filter, so every refusal came back as a 500, and it only ever called `/health`. It also took
  `JWT_SECRET` from a developer's local `.env` without saying so. The HTTP setup now lives in
  [`http-app.ts`](../apps/api-gateway/src/http-app.ts), used by `main.ts` and by the suite alike, and
  the suite covers authentication over real HTTP: no credential, a forged token, a genuine one by
  header and by cookie, and a bad cookie that must not fall back to a good header.
