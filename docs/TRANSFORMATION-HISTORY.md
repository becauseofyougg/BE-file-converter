# File Converter — Transformation history

**Status:** implemented — see §8 for where the code lives
**Date:** 2026-10-12
**Owning services:** `api-gateway` (access, audit), `conversion-service` (the records, retention), `identity-service` (whether a user exists, the permission)
**Related:** [CONVERSIONS.md](CONVERSIONS.md) · [IMAGES.md](IMAGES.md) · [RBAC.md](RBAC.md)

---

## 1. Scope

Every conversion, of files and images alike, is one row in `conversion_operations`
([CONVERSIONS.md §9](CONVERSIONS.md#9-audit-and-history)). This is the read side of that table:

- a user reads their own history;
- an administrator reads any user's history, with the same filters.

It **replaces** the earlier `GET /api/convert/history` list, so there is one history in one
shape. Two routes stay as they were, because this spec does not cover them and a saved result
still needs a way out:

- `GET /api/convert/history/{id}`: one operation in full (file name, checksums, options);
- `GET /api/convert/history/{id}/download`: a saved result.

Both are the caller's own only.

---

## 2. API

### `GET /api/transformations/history`: one's own

Needs a session and nothing else.

| Query | | |
|---|---|---|
| `cursor` | optional | `nextCursor` from the previous page; opaque |
| `limit` | optional | 1–100, default 20 |
| `type` | optional | `file` \| `image` |
| `sourceFormat`, `targetFormat` | optional | any format the registry knows: `csv`, `json`, `xml`, `yaml`, `png`, `jpeg`, `svg` |
| `status` | optional | `success` \| `error` |
| `createdAtFrom`, `createdAtTo` | optional | ISO 8601 date-times, **both inclusive** |

Values are case-insensitive. Filters combine (AND). Any other parameter is a `400`; in
particular, there is no `userId`. Whose history this is comes from the token and nothing else.

```json
{
  "items": [
    {
      "id": "6f1c…",
      "type": "image",
      "sourceFormat": "svg",
      "targetFormat": "png",
      "status": "success",
      "fileSize": 2048,
      "durationMs": 37,
      "resultAvailable": true,
      "createdAt": "2026-10-12T09:41:07.123Z"
    },
    {
      "id": "1a2b…",
      "type": "file",
      "sourceFormat": null,
      "targetFormat": "json",
      "status": "error",
      "fileSize": 120,
      "durationMs": 4,
      "errorCode": "UNSUPPORTED_FORMAT",
      "resultAvailable": false,
      "createdAt": "2026-10-12T09:40:59.002Z"
    }
  ],
  "nextCursor": "MjAyNi0xMC0xMlQwOTo0MDo1OS4wMDJafDFhMmI…"
}
```

The item is the spec's, with two notes:

- `sourceFormat` is `null` when the file was not recognised as any format (a `415`). The spec
  types it as a string, but there is no string that would be true.
- `resultAvailable` is an addition. It says whether `…/history/{id}/download` will serve a
  saved result, which a list replacing the old one has to say somehow.

**Not in the item, on purpose:** the file name, checksums, storage keys, options, error
messages. An administrator reading someone's history learns what was converted and how it went,
not what it was. A user who wants the details of their own operation has `GET
/api/convert/history/{id}`.

| Status | `code` | When |
|---|---|---|
| 200 | | the page; an empty `items` is an empty history, not an error |
| 400 | `VALIDATION_FAILED` | a parameter's shape; a format the registry does not know (the message lists those it does); a period that ends before it starts; a cursor it did not issue |
| 401 | `UNAUTHENTICATED` | no session, or a session whose account has been erased since (§3) |
| 429 | `RATE_LIMITED` | over 120 requests a minute |

### `GET /admin/users/{userId}/transformations/history`: anyone's

The same query and the same answer, for the user in the path. Needs **`transformations@read`**.

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `userId` is not a UUID, or as above |
| 401 | `UNAUTHENTICATED` | no session |
| 403 | `FORBIDDEN` | the caller does not hold `transformations@read` |
| 404 | `USER_NOT_FOUND` | no such user, or an erased one |
| 429 | `RATE_LIMITED` | over 30 requests a minute; tighter than one's own, since reading other people's records is the thing to slow down |

---

## 3. Access, in order

The order is the defence, and it is fixed:

1. **Authority.** For another user's history, the caller must hold `transformations@read`.
2. **Existence**, only after that. Answering `404` before `403` would let anyone without the
   permission learn which user ids are real.
3. **The query**, for exactly one `userId`: the caller's own, or the one the permission was
   checked for. Nothing else reaches conversion-service.

**The permission** is new: resource `transformations`, action `read`. Identity's migration
`20261012130000_transformations_permission` creates it and grants it to ADMIN. A new permission
needs its own grant, because ADMIN's grants were made per permission when RBAC was set up. It is
not an action on `conversions`: every USER holds `conversions@read` for their own work, and
reading other people's is a different power. Like any permission, it can be granted to another
role at runtime through `/admin/rbac` ([RBAC.md](RBAC.md)).

**It is checked in the service, not with `@Permissions` on the route.** The global RBAC guard
runs before the handler, so a refusal there would never be audited, and the spec asks for every
outcome to be logged. The check is the same `decideAccess` over the same cached config the guard
uses.

**Whether the user exists** is asked of identity through a small RPC,
`identity.users.get-status`. It answers `{ active: true }`, or `404` for an unknown or erased
account, and nothing about the person. It carries no authorisation of its own: the gateway has
already decided who may ask. For one's own history the same question is asked too ("the user
exists and is active"). An access token outlives an erasure by up to 15 minutes, so a negative
answer there means a session without an account, which is a `401`.

---

## 4. Audit

One line per request, from the gateway, whatever the outcome:

```json
{ "event": "transformations.history.read", "actorUserId": "…", "targetUserId": "…",
  "scope": "admin", "query": { "type": "image", "cursor": "[present]" },
  "status": 200, "returned": 14 }
```

- `targetUserId` appears for administrators' requests; for one's own, it is the actor.
- `query` holds the filters as sent. They are formats, statuses, dates and a page size, nothing
  personal. The cursor is recorded only as present: it is a position, and noise.
- `status` is what the client got: 200, 400, 401, 403, 404, or 500 for something unexpected.
  Successful reads log at info, everything else at warn.
- The records themselves are never logged.

---

## 5. Pagination and performance

**Cursor, not offset.** The cursor is the position of the last row returned, `(created_at,
id)`. The same request returns the same page, and a conversion that finishes meanwhile does not
shift a later page by one. The cursor is a position, not a snapshot of the filters, so it stays
valid if the filters change between pages.

**Finished only.** An operation still `PROCESSING` has no status the spec can name and is not
history yet. `status` maps to the stored one: `success` = `COMPLETED`, `error` = `FAILED`.

**`type`** comes from the converter family that ran the operation (`image`, or anything else is
`file`), stored in the new `family` column. It is known even for failures:

- from the converter, when one ran;
- else from the recognised source format;
- else from the route (`/api/images/convert` is images);
- else from the target format;
- else `file`.

Rows written before the column existed were backfilled from their formats.

**Indexes**, each matching a query's filter and sort:

| Index | Serves |
|---|---|
| `(user_id, created_at DESC, id DESC)` | the unfiltered history, and date ranges |
| `(user_id, status, created_at DESC, id DESC)` | `status=…` |
| `(user_id, family, created_at DESC, id DESC)` | `type=…` |
| `(status, created_at)` | the retention sweep (§6) and the interrupted-operation sweep |

---

## 6. Retention

`HISTORY_RETENTION_DAYS` (conversion-service, default **90**) sets how long a record is kept. A
daily job (`HistoryRetentionJob`, 03:30) deletes finished operations older than that, oldest
first, in bounded batches.

**A saved result is deleted with its record.** The retention period is the promise, for the file
as for the record, and storage does not grow without end. The file goes first and then the row.
A file that cannot be deleted keeps its row, and the next run tries again; deleting the row first
would orphan the file, with nothing left that knows where it is.

Unsaved results are gone long before that, within minutes of being sent
([CONVERSIONS.md §6](CONVERSIONS.md#6-streaming-threads-and-storage)).

---

## 7. What changed elsewhere

- `GET /api/convert/history` (the list) is gone, together with its RPC
  (`conversion.rpc.history.list`). Its replacement is `conversion.rpc.transformations`.
- `conversion_operations` gained `family` and two indexes (migration
  `20261012120000_transformation_history`).
- `ConverterRegistry.familyOf(format)` says which family reads or writes a format.

---

## 8. Where the code lives

| | |
|---|---|
| `apps/api-gateway/src/modules/transformations/` | both routes, the access order, the audit line, the query DTO |
| `apps/conversion-service/src/modules/operations/transformation-history.service.ts` | the query: filters, cursor, the item shape |
| `apps/conversion-service/src/modules/operations/history-retention.job.ts` | retention |
| `apps/identity-service/src/modules/users/profile.service.ts` | `getStatus`, the existence check |
| `apps/identity-service/prisma/migrations/20261012130000_transformations_permission` | the permission and ADMIN's grant |
| `libs/contracts/src/messages/conversion.messages.ts` | `TransformationHistoryItem` and the rest of the contract |

Tests: each filter, the cursor, the shape and what it leaves out
(`transformation-history.service.spec.ts`); the access order and every audited outcome
(`transformations.service.spec.ts`); retention batching and file-first deletion
(`history-retention.job.spec.ts`); the routes over real HTTP with the RBAC config as the
migration makes it (`transformations.e2e-spec.ts`); and, against the running stack,
`scripts/smoke.sh` (`== transformation history`).
