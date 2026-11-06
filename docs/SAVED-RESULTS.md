# File Converter — Saved results

**Status:** implemented — see §7 for where the code lives
**Date:** 2026-10-12
**Owning services:** `conversion-service` (keeping, expiring, deleting), `api-gateway` (access, streaming, the download audit)
**Related:** [CONVERSIONS.md](CONVERSIONS.md) · [IMAGES.md](IMAGES.md) · [TRANSFORMATION-HISTORY.md](TRANSFORMATION-HISTORY.md)

---

## 1. Scope

A conversion run with `save=true` keeps its result in storage, where it can be downloaded from the
history (one's own, or, with `transformations@read`, anyone's) until the history retention
period ends. After that the file is deleted, and so is the record.

Much of this already existed: the `save` flag, the storage abstraction, deleting saved files with
their records. This spec adds:

- the download routes under `/api/transformations`, including an administrator's;
- an expiry on saved files equal to the retention period;
- a file identifier (`fileId`);
- a size limit on what is kept;
- the save and download audit lines.

---

## 2. API

### Saving: `save` on `POST /api/convert` and `POST /api/images/convert`

`save=true` (also `1`), default `false`. Anything else is a `400`. The conversion's responses are
unchanged, with one new header:

| Header | |
|---|---|
| `X-Result-Saved: true` | the result was kept; its `fileId` is in the history |
| `X-Result-Saved: false` | it was not: `save` was not asked for, or the result is larger than `CONVERSION_MAX_SAVED_BYTES` |

**A result too large to keep is still returned.** The conversion succeeded, and the spec keeps its
responses unchanged; only the keeping is refused, and the header says so. The operation is
recorded with `saved: false`, and the refusal is audited (§5).

**Saving does not slow the response.** Every result, saved or not, is written to storage, because
the gateway streams the response from there. Saving is the same write, kept for longer. Nothing
is done after the response, so there is no background job that could fail after the client was
told the file was kept.

### Downloading one's own: `GET /api/transformations/history/{itemId}/download`

Needs a session. Streamed, named after the upload with the new extension (§3).

| Status | `code` | When |
|---|---|---|
| 200 | | the file |
| 400 | `VALIDATION_FAILED` | `itemId` is not a UUID |
| 401 | `UNAUTHENTICATED` | no session, or an account erased since |
| 404 | `JOB_NOT_FOUND` | no such item **of yours**: another user's id is answered the same as no id (§4) |
| 404 | `RESULT_NOT_SAVED` | the item has no saved file: not saved, or the conversion failed |
| 410 | `RESULT_EXPIRED` | it was saved, and its time has passed, or the file has gone missing from storage |
| 503 | `STORAGE_UNAVAILABLE` | storage cannot be read; retryable |

### Downloading anyone's: `GET /admin/users/{userId}/transformations/history/{itemId}/download`

Needs `transformations@read`. The same as above, for the user in the path, with the order of
[TRANSFORMATION-HISTORY.md §3](TRANSFORMATION-HISTORY.md#3-access-in-order): **403** without the
permission, then **404 `USER_NOT_FOUND`** for an unknown or erased user, then the item. The item
is looked up by that user **and** the id, so an item of someone else is `404 JOB_NOT_FOUND`.
30 requests a minute.

### The item in full: `GET /api/transformations/history/{itemId}`

One's own, with what the list leaves out: the file name, sizes, checksums, options and the error
message. It moved here from `/api/convert/history/{id}`, as did the download. The old routes are
gone.

---

## 3. The file

| | |
|---|---|
| **Identifier** | `fileId`, a UUID made when the file is kept. Shown in the history while the file can be downloaded; `null` otherwise. Opaque: it is not the storage key, which never leaves conversion-service. |
| **Where** | the `results` bucket of whichever storage was configured when it was written (`STORAGE_DRIVER`), as `<userId>/<operationId>.<ext>`. Every record notes its driver, so a file is found again after the setting changes. |
| **Name** | the upload's, with the new extension: `people.csv` → `people.json`. Path parts, control characters and `" * : < > ? \|` are removed. In the header it is written twice: as plain ASCII in `filename`, and exactly, UTF-8-encoded, in `filename*` (RFC 6266). So `отчёт.csv` downloads as `отчёт.json` in any current browser. The conversion's own response keeps `converted.<ext>`, as its spec fixes. |
| **Lifetime** | `HISTORY_RETENTION_DAYS` (90) from the moment it was written, recorded on the row as `result_expires_at`. |
| **Size** | at most `CONVERSION_MAX_SAVED_BYTES` (50 MiB) to be kept. |

---

## 4. Security

- **Private.** Both buckets are private, the storage key never reaches a client, and there is no
  link to a file that bypasses the checks: every download goes through the gateway, streamed.
  Presigned URLs were an option the spec offered. They are not used, because a link that works
  for five minutes for whoever holds it would undo the per-request check below.
- **No IDOR.** A file is looked up by owner and id together: the caller's own id for one's own,
  the path's user for an administrator after the permission check. Someone else's id is
  indistinguishable from no id. This is a deliberate departure from the spec, which asks for 403
  when "the record does not belong to the user". A 403 would confirm that the id exists, and the
  rest of the API never does that.
- **Headers cannot be injected through a file name.** Quotes, backslashes and line breaks never
  reach `Content-Disposition`.

---

## 5. Expiry, deletion and audit

**Two clocks, one period.** A saved file expires `HISTORY_RETENTION_DAYS` after it was written.
The record goes when the history retention removes it, the same period counted from the
operation's creation, a few seconds earlier. So the two disappear together:

- the minute clean-up (`ConversionCleanupJob`) deletes a file at its expiry and marks it gone on
  the row;
- the daily retention job (`HistoryRetentionJob`) deletes the row, and the file too if it is
  somehow still there.

In the moments between, a download answers `410`.

**Storage and records out of step.** If a record says a file exists but storage does not have
it, the download answers `410` (the file is gone and asking again will not bring it back), and
the gateway logs `conversion.result_missing` at error level, because that should not happen.

**Audit**, one line per action, never the content:

```json
{ "event": "conversion.file.save", "userId": "…", "transformationId": "…", "fileId": "…",
  "fileSize": 169, "durationMs": 7, "result": "success" }

{ "event": "transformations.file.download", "actorUserId": "…", "targetUserId": "…",
  "scope": "admin", "transformationId": "…", "fileId": "…", "fileSize": 169,
  "status": 200, "result": "success", "durationMs": 12 }
```

- **Save.** A refused save (too large) is logged at warn, with `fileId: null` and the reason.
- **Download.** Logged when the transfer ends, so `durationMs` is the transfer itself, and a
  client that gives up part-way shows as `status: 499`. A refusal (400/401/403/404/410/503) is
  logged at once. `targetUserId` appears for administrators' downloads.

**Idempotent.** The same download returns the same bytes for as long as the file exists.

---

## 6. Differences from the spec, collected

| Spec | Here | Why |
|---|---|---|
| 403 for another user's record | 404 `JOB_NOT_FOUND` | a 403 confirms the id exists (§4) |
| `filename="<original-name>"` | the upload's name with the result's extension | `people.csv` for a JSON file would be wrong; the stem is what identifies it |
| storage failures "should return 500" | `503 STORAGE_UNAVAILABLE` | still a 5xx, and it tells the client that retrying makes sense; it is what the rest of the API answers |
| asynchronous saving, if possible | the same write the response streams from | adds no time, and nothing can fail after the response (§2) |
| the history item's file identifier | `fileId`, which replaced the earlier `resultAvailable` flag | one field that says both whether there is a file and which one |

---

## 7. Where the code lives

| | |
|---|---|
| `apps/conversion-service/src/modules/operations/conversion-operations.service.ts` | keeping (`keep`, `fileId`, expiry, the save audit) and `savedResult` (404/410) |
| `apps/conversion-service/src/modules/operations/operation-record.ts` | `isDownloadable`, `downloadName` |
| `apps/api-gateway/src/modules/transformations/` | the item, download and admin download routes; access order; the download audit |
| `apps/api-gateway/src/modules/conversions/attachment.ts` | `Content-Disposition` in both spellings; `X-Result-Saved` |
| `apps/api-gateway/src/modules/conversions/result-stream.ts` | opening a result: 410 when storage lost it, 503 when storage is down |
| `apps/conversion-service/prisma/migrations/20261012150000_saved_files` | `file_id` |
