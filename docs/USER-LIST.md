# File Converter — The administrative user list

**Status:** implemented — see §8 for where the code lives
**Date:** 2026-09-25
**Owning service:** `identity-service`, exposed through `api-gateway`
**Related:** [USER-PROFILE.md](USER-PROFILE.md) · [RBAC.md](RBAC.md) · [ACCOUNT-DELETION.md](ACCOUNT-DELETION.md) · [NON-FUNCTIONAL-REQUIREMENTS.md](NON-FUNCTIONAL-REQUIREMENTS.md)

---

## 1. Scope

`GET /admin/users` — a paginated, searchable, filterable list of accounts, for whoever holds
`users@list`.

---

## 2. `GET /admin/users`

| Query | | |
|---|---|---|
| `cursor` | opaque | from the previous page's `nextCursor`; never constructed by a client |
| `limit` | 1–100, default 20 | bounded at both ends |
| `q` | ≤128 chars | exact id, exact address, or part of a display name (§6) |
| `status` | `active` · `locked` · `unverified` · `deleted` | default: everything except erased (§4) |
| `sort` | `created_at` · `last_login` · `email` | default `created_at` |
| `order` | `asc` · `desc` | default `desc` |

```jsonc
{
  "items": [{
    "id": "…", "email": "ada@example.com", "displayName": "Ada Lovelace",
    "photo": null, "status": "active",
    "createdAt": "2026-01-01T00:00:00.000Z", "lastLoginAt": "2026-06-01T00:00:00.000Z"
  }],
  "nextCursor": "eyJpZCI6…"   // null on the last page
}
```

`200` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `400 VALIDATION_FAILED` (a bad cursor, or a
value outside one of the closed sets) · `429 RATE_LIMITED` at 120/hour per IP.

**The address is returned in full**, not masked. This list exists to be matched against a
support ticket, and the unmasked address is one request away at `GET /users/:id` regardless —
masking here would be friction that reads as security without being any. What actually protects
it is the permission below and the audit line in §7.

`displayName` is included beyond the fields the requirement lists, because it is the human-readable
label an operator scans down a column for.

---

## 3. `users@list`, and why it is its own permission

`/admin/users`, not `GET /users` with a role check — §1.3.1 left that open. It sits beside
`/admin/rbac/*`, so the administrative surface is one prefix a proxy can treat as a unit, and
`/users/:userId` already means "a profile, self or otherwise", which is a different thing from a
directory of everyone.

**`users@list` is deliberately not `users@read`.** Reading one profile means looking up the
account named in a ticket; paging through every account turns the API into a directory of
everybody who has ever signed up. A support role can reasonably have the first without the
second, so they are separate actions and the migration adds `list` to the `users` permission.
ADMIN needs no new grant — its row has an empty `actions` array, which the evaluator reads as
every action *including ones added later*, which is exactly this case.

This is also **the one users route whose rule a decorator can express.** Every other one turns on
whether the target happens to be the caller, which a route decorator cannot weigh
([USER-PROFILE.md §3](USER-PROFILE.md)); here there is no self case at all, so the gateway
declares `@Permissions('users@list')` in the ordinary way. Identity checks it again, because a
value the gateway puts into a message is not a credential.

---

## 4. Status is four states, not three

The requirement asks for `active | blocked | deleted`. Nothing in this system is ever *blocked* —
there is no administrative suspension. Three other things do stop an account being usable, and
naming them for what they are makes each filter answer a real question:

| | means | the question it answers |
|---|---|---|
| `active` | live, confirmed, not locked | — |
| `locked` | locked out by failed passwords ([AUTHENTICATION.md §5](AUTHENTICATION.md)) | "who is locked out right now?" |
| `unverified` | registered, never confirmed the address | "who never finished signing up?" |
| `deleted` | erased ([ACCOUNT-DELETION.md](ACCOUNT-DELETION.md)) | — |

They are evaluated in that order of precedence: an erased account is erased whatever else its
columns say.

**No filter means live accounts only.** Erased rows are tombstones, and every other read path in
the service already treats them as absent — a list that mixed them in by default would be the one
place that disagrees.

---

## 5. Cursor pagination, and the tie-break that makes it work

Offset pagination was not an option. `OFFSET 5000` makes the database count past five thousand
rows it will then discard, and a row inserted or deleted meanwhile shifts every later page by one,
so a reader walking the list sees an account twice and never sees another. §1.6 asks for stable
cursor pagination for exactly this reason.

Each page asks for **one row more than requested**. Its presence is the answer to "is there
another page", which a `COUNT(*)` would also give — at the cost of a second scan of everything the
filter matched, on every page.

**Every ordering carries `id` as a second key.** This is the load-bearing detail. Two accounts
created in the same millisecond have no defined order between them, so between one page and the
next the database may return them the other way round — and a cursor sitting on that boundary then
skips one row and repeats another. Ordering by `(sort key, id)` makes the sequence total, and the
[migration](../apps/identity-service/prisma/migrations/20260925090000_user_list/) indexes the same
pairs so the walk stays an index scan.

**The cursor carries the sort and order it was made under**, and a request whose `sort` disagrees
is refused. A position in one ordering means nothing in another; interpreting it anyway silently
skips and repeats rows, and a `400` is the only answer that cannot be quietly wrong. The cursor is
also treated as hostile input — it arrives in a query string — so anything that does not decode
into the exact expected shape is a `400` rather than a page that quietly restarts from the
beginning.

**Accounts that have never signed in sort last in both directions.** "Never" is not a date, and
treating it as the smallest one puts every dormant account at the top of "least recent".

`last_login_at` is new, written when a session is actually issued rather than when a password is
accepted — a login waiting on an emailed confirmation has not happened yet. It shares the statement
that clears the brute-force counter, so a successful login is still one write.

---

## 6. What is searchable, and what is not

`q` matches an **exact id**, an **exact address**, or a **substring of the display name**. Every
one of those is index-backed: the id and the address by their unique indexes, the name by a GIN
trigram index the migration adds — `ILIKE '%…%'` has no leading anchor, so without one a search is
a sequential scan of every user in the system.

**Substring search on the address is deliberately not offered.** It cannot use the unique `citext`
index, and adding a second trigram index over every address in the system to support a convenience
is the wrong trade — an administrator searching by email has the whole address in front of them,
on a ticket. §1.4 asks for the searchable fields to be limited so a query cannot get heavy; this is
where that is honoured, along with the 128-character cap on the term itself.

`sort`, `order` and `status` are closed sets validated against the contract's constants at both
boundaries. They end up in an `ORDER BY` and a `WHERE`, and the one reliable way to stop a caller
steering those is never to let an unrecognised value past.

---

## 7. What comes back, and what is logged

The projection **names every field and never spreads the row** — the same rule the profile
projection follows. A column added to `users` later cannot appear here by accident, which is what
§1.4's "no sensitive fields" needs in order to hold without anyone having to remember it. The
password hash, the lockout counter and the verification state are all absent; `status` is derived
from the last of those rather than exposing it.

`photo` is a short-lived presigned URL, swapped in by the gateway from the storage key identity
returns — the same two-name arrangement, and the same reason, as
[USER-PROFILE.md §4](USER-PROFILE.md).

Audit (§1.5) records `actorUserId`, the filters, the sort, the limit and how many rows came back.
**Never `q` itself** — it is whatever an administrator typed, which is routinely somebody's
address, and a search log is a strange place to accumulate those.

---

## 8. Where the code lives

| Concern | File |
|---|---|
| Query, filters, projection | [user-list.service.ts](../apps/identity-service/src/modules/users/user-list.service.ts) |
| Cursor encoding and its checks, §5 | [user-list.cursor.ts](../apps/identity-service/src/modules/users/user-list.cursor.ts) |
| The page query | [users.service.ts](../apps/identity-service/src/modules/users/users.service.ts) |
| HTTP surface | [admin-users.controller.ts](../apps/api-gateway/src/modules/users/admin-users.controller.ts) |
| Query validation | [gateway list-users.dto.ts](../apps/api-gateway/src/modules/users/dto/list-users.dto.ts) |
| Column, indexes, `users@list` | [migration](../apps/identity-service/prisma/migrations/20260925090000_user_list/) |

---

## 9. Still open

1. **Nothing has been run.** Docker is unavailable in the development environment used so far, so
   the query, the cursor walk and the migration — including the `pg_trgm` extension and the
   trigram index — are covered by unit tests and by reading, not by a live Postgres. The index
   definitions in particular are the kind of thing only a real `EXPLAIN` confirms.
2. **No role holds `users@list` except ADMIN.** A `SUPPORT` role that can look accounts up without
   being able to enumerate them is exactly what §3 makes possible, and creating one needs no
   deploy — `/admin/rbac/*` is there for it.
3. There is no total count, deliberately: it costs a second scan per page. If an operator ever
   needs "how many locked accounts are there", that is a separate endpoint with its own cache, not
   a field on every page of this one.
4. `lastLoginAt` starts null for every existing account and fills in as people sign in, so
   `sort=last_login` will look sparse until the population turns over. The migration does not
   backfill it, because nothing in the schema records when anyone last signed in before now.
5. The list is per-service. It shows identity's view of an account and knows nothing about the
   user's conversion jobs; a combined operator view would have to query both services.
