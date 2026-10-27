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

- `GET /api/transformations/history/{id}`: one operation in full (file name, checksums, options);
- `GET /api/transformations/history/{id}/download`: a saved result, and an administrator's
  counterpart, in [SAVED-RESULTS.md](SAVED-RESULTS.md). Both moved here from `/api/transformations/history/{id}`.

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
      "fileId": "9b2e…",
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
      "fileId": null,
      "createdAt": "2026-10-12T09:40:59.002Z"
    }
  ],
  "nextCursor": "MjAyNi0xMC0xMlQwOTo0MDo1OS4wMDJafDFhMmI…"
}
```

The item is the spec's, with two notes:

- `sourceFormat` is `null` when the file was not recognised as any format (a `415`). The spec
  types it as a string, but there is no string that would be true.
- `fileId` is an addition: the saved file, while it can be downloaded, else `null`
  ([SAVED-RESULTS.md](SAVED-RESULTS.md)). It replaced an earlier `resultAvailable` flag.
