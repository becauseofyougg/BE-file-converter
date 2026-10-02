# File Converter — Text format conversion

**Status:** implemented — see §10 for where the code lives
**Date:** 2026-10-02
**Owning service:** `conversion-service` (conversion, history), `api-gateway` (`/api/convert`)
**Related:** [ARCHITECTURE.md](ARCHITECTURE.md) · [NON-FUNCTIONAL-REQUIREMENTS.md](NON-FUNCTIONAL-REQUIREMENTS.md) · [AUTHORIZATION.md](AUTHORIZATION.md)

---

## 1. Scope

CSV, JSON, XML and YAML, each to each of the other three: twelve directions. A user uploads one
file and gets the converted file back **in the same response**. Every attempt is recorded in their
history, failures included. The result is kept only if they ask for it (`save=true`).

This is the synchronous path: small text files, a 30-second budget. The queued path for heavy
families (images, documents, audio/video), with `conversion_jobs`, progress events and the
command queues already declared in `libs/contracts`, is still to come. Both share the converter
abstraction in §8.

---

## 2. API

Every route needs a session (`401 UNAUTHENTICATED` without one) and no permission: converting is
what an account is for, and each user sees only their own history. The routes are the only ones
under `/api`. The older routes keep their paths.

### `POST /api/convert`

`multipart/form-data`, fields in any order:

| Field | Required | |
|---|---|---|
| `file` | yes | exactly one file |
| `targetFormat` | yes | `csv`, `json`, `xml` or `yaml`, in any case |
| `save` | no | `true`/`false` (also `1`/`0`), default `false` |

Any other field is a `400`, as on the JSON routes.

**200**: the converted file as the body, with:

```
Content-Type: application/json; charset=utf-8        (the target's type)
Content-Disposition: attachment; filename="converted.json"
Content-Length: 1234
X-Conversion-Id: 6f1c2f34-…                          (the history entry)
```

The response is all or nothing. The whole conversion finishes and the result is stored before a
single byte of the response is written. Any failure before that point is an ordinary error
response, never a `200` that stops half-way. If storage fails during the transfer itself, the
connection is cut short of `Content-Length`, which every HTTP client reports as an error.

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | not multipart; no file, or two; a missing or malformed `targetFormat`; an unknown field |
| 400 | `UNSUPPORTED_CONVERSION` | `targetFormat` is not a format we write, or the pair does not exist (`csv` → `csv`) |
| 400 | `INVALID_SOURCE` | empty file; not UTF-8; not valid in its format (the message says why, and where for XML) |
| 401 | `UNAUTHENTICATED` | no session |
| 413 | `FILE_TOO_LARGE` | over the format's limit (§5), or over the gateway's ceiling for any upload |
| 415 | `UNSUPPORTED_FORMAT` | the file is not recognisably CSV, JSON, XML or YAML (§3) |
| 422 | `CONVERSION_TIMEOUT` | did not finish within the time limit |
| 503 | `STORAGE_UNAVAILABLE` | storage is down; retryable |

The checks run in a fixed order, so a file with several problems always gets the same answer:
target → format → size → pair → content → time.

### `GET /api/convert/formats`

```json
[
  { "source": "csv",  "target": ["json", "xml", "yaml"] },
  { "source": "json", "target": ["csv", "xml", "yaml"] },
  { "source": "xml",  "target": ["csv", "json", "yaml"] },
  { "source": "yaml", "target": ["csv", "json", "xml"] }
]
```

This list is built from whatever converter modules are registered (§8), not maintained by hand.

### History

| Route | |
|---|---|
| `GET /api/convert/history?limit=&cursor=` | newest first, `limit` 1–100 (default 20), `nextCursor` for the next page |
| `GET /api/convert/history/:id` | one entry; `404 JOB_NOT_FOUND` for an id that is not yours |
| `GET /api/convert/history/:id/download` | a saved result; `404 RESULT_NOT_SAVED` if it was not saved or did not succeed |

An entry holds the file name, the formats, the sizes, SHA-256 checksums of the source and the
result, the status, the error code and message when it failed, the duration, and whether the
result can be downloaded. It never holds the content.

---

## 3. Recognising the source format

1. **By extension:** `.csv`, `.json`, `.xml`, `.yaml`, `.yml`, in any case. The extension is what
   the user meant.
2. **Otherwise by content, for JSON and XML only.** After an optional byte-order mark, a file
   whose first character is `{` or `[` is JSON, and one whose first character is `<` is XML.
3. CSV and YAML are **never guessed** from content. One line of CSV is valid YAML, and most short
   text is valid YAML, so a guess would be wrong as often as right. Without an extension they
   are `415`.

A file named `.json` that holds XML is read as JSON and fails as `400 INVALID_SOURCE`. The service
does not override the name the user gave the file.

---

## 4. How data maps between formats

Every format is read into one model, the JSON data model (objects, lists, strings, numbers,
booleans, null), and written out of it. So each format defines its own rules once, and no rule is
written per pair. The rules below are the decisions for the pairs where the formats do not line
up.

### Reading

| Format | Becomes |
|---|---|
| **CSV** | a list of objects, one per row, keyed by the header row. **Every cell is a string**: CSV does not say `007` is a number, and reading it as one would drop the leading zeros of every postcode. A blank header cell is named `column_<n>`; a repeated one gets `_2`, `_3`. A row with the wrong number of cells is an error, not something to guess about. LF and CRLF are both accepted. |
| **JSON** | itself. Numbers beyond 2⁵³ lose precision, as in any JavaScript reader. |
| **XML** | an element is a key; its attributes are `@name` keys; its text is `#text` when it also has attributes or children, otherwise the value itself; a repeated element is a list. **Everything is a string**: XML has no types. The declaration, comments and processing instructions are dropped. |
| **YAML** | YAML 1.2 core schema: `yes`, `no`, `on` and `off` are **strings**, as 1.2 says. A file of several documents (`---`) becomes a list of them, and an empty one becomes `null`. Duplicate keys are an error. Values JSON cannot hold are mapped: `.inf`/`.nan` → `null`, timestamps → ISO strings, binary → base64. |

### Writing

| Format | From any data |
|---|---|
| **CSV** | Needs rows, so: single-key wrappers are looked through (`{"users": [...]}` and `<users><user/>…</users>` both reach the list); a list is the rows; a lone object is one row; a scalar is one `value` cell. A list of non-objects becomes a `value` column. Nested objects become dotted columns (`address.city`); a list inside a row is written as its JSON text, the one spelling that reads back unambiguously. The columns are the union over all rows, in first-seen order, and a missing value is empty. Written as RFC 4180 with CRLF line endings, quoting only where needed. |
| **JSON** | Indented by two spaces, with a final newline. |
| **XML** | Needs exactly one root. An object with a single key whose value is not a list already has one: that key. This is what XML read in looks like, so XML → JSON → XML keeps its root. Anything else is wrapped in `<root>`, and a list becomes repeated `<item>` elements. Keys that are not legal element names are repaired: a forbidden character becomes `_`, and a leading digit or a leading `xml` gets a `_` prefix (`first name` → `first_name`, `1st` → `_1st`). `@` keys become attributes and `#text` becomes text, so XML round-trips. `null` becomes an empty element. A UTF-8 declaration is written. |
| **YAML** | YAML 1.2, with long strings kept on one line. Strings that would read back as something else (`"1"`, `"true"`) are quoted. |

### What does not survive a round trip

Rules this simple have edges, and these are deliberate:

- **Types through CSV or XML.** `{"n": 1}` → CSV → JSON gives `{"n": "1"}`. Restoring types would
  mean guessing, and guessing breaks postcodes and IDs.
- **A single-element list through XML.** `[{"a": 1}]` → XML → JSON gives `{"root": {"item": {"a": "1"}}}`:
  XML cannot tell one repeated element from one element.
- **Dotted CSV columns stay flat.** `address.city` in CSV becomes the key `"address.city"`, not a
  nested object. A column may contain a dot for its own reasons.
- **Mixed XML content.** In `<p>a<b/>c</p>`, the text pieces are joined into one `#text`.
- **Comments and formatting** in any format.

---

## 5. Limits

| Setting | Where | Default | |
|---|---|---|---|
| `CONVERSION_MAX_BYTES_<FORMAT>` | conversion-service | — | one input format's limit, e.g. `CONVERSION_MAX_BYTES_XML=5242880` |
| `CONVERSION_MAX_BYTES_DEFAULT` | conversion-service | 10 MiB | every format without its own |
| `CONVERSION_UPLOAD_MAX_BYTES` | api-gateway | 50 MiB | the edge's ceiling on any upload, before anyone knows what it is |
| `CONVERSION_SYNC_TIMEOUT_MS` | conversion-service | 30 000 | the whole conversion: read, convert, store |
| `CONVERSION_RPC_TIMEOUT_MS` | api-gateway | 45 000 | longer than the above, so the client gets its `422` rather than a `504` racing it |
| `CONVERSION_MAX_DEPTH` | conversion-service | 64 | deepest nesting of objects and lists |
| `CONVERSION_WORKER_MEMORY_MB` | conversion-service | 256 | heap per conversion, past which it is stopped: `413` |
| `CONVERSION_RPC_CONCURRENCY` | conversion-service | 4 | conversions a replica runs at once |
| `CONVERSION_UNSAVED_RESULT_MINUTES` | conversion-service | 15 | the latest an unsaved result is deleted (usually: once sent) |

The per-format limits are set by whoever operates the service, in its environment, and are
checked at boot: `CONVERSION_MAX_BYTES_CSV=10mb` stops the service from starting. The size is
checked twice. The gateway counts the bytes as they stream in, and conversion-service counts them
again as it reads, so it does not depend on the gateway's count.

---

## 6. Streaming, threads and storage

What is streamed and what is not, stated plainly:

- **Upload: streamed.** The multipart file goes from the socket straight to storage
  (`uploads/<userId>/<operationId>`) through a byte counter. It is never held whole in the
  gateway's memory, and it never travels through the broker.
- **Conversion: bounded, not streamed.** The four formats are parsed whole. A streaming parser
  for each of them would still have to hold the whole document for the hard cases (XML's single
  root, CSV's column union, YAML anchors). So the file is read into memory, but only up to its
  format's limit and only inside a worker thread with its own heap limit.
- **Result: streamed.** It is written to storage (`results/<userId>/<operationId>.<ext>`) and
  streamed from there to the client.

**One worker thread per conversion.** Parsing is CPU work, and the main thread also answers the
broker and `/health`. A thread can also be stopped: `terminate()` ends a conversion past the time
limit, and the heap limit ends one that keeps growing. Code running inline can be stopped by
neither. The thread costs a few tens of milliseconds to start.

**Storage is chosen by configuration**: `STORAGE_DRIVER=s3` (MinIO locally) or `local` (a
directory, `STORAGE_LOCAL_ROOT`). Every stored file is recorded with the driver it was written to,
so a deployment that switches drivers can still read older files while the old driver stays
configured. With `local`, the gateway and conversion-service must see the same directory. In
compose it is the `converter_storage` volume.

**Clean-up.** conversion-service deletes the upload when it is done, whatever the outcome, and
the gateway deletes it too if conversion-service never received it. An unsaved result is deleted
once it has been sent. A cron job (`ConversionCleanupJob`, every minute) deletes any unsaved
result still there after `CONVERSION_UNSAVED_RESULT_MINUTES`, and fails operations that a crashed
replica left `PROCESSING` for more than 10 minutes.

---

## 7. Security

- **XML: no document type declarations.** `<!DOCTYPE` is refused outright, not parsed. It is the
  way in for external entities (XXE: reading `/etc/passwd`, or calling an internal URL) and for
  entity-expansion bombs, and a data file has no need for one.
- **YAML: alias bombs.** Expansion is capped (`maxAliasCount: 100`), so a few hundred bytes cannot
  become gigabytes.
- **Depth.** Nesting past `CONVERSION_MAX_DEPTH` is refused. A file nested far deeper, enough to
  overflow a recursive parser, gets the same `400`, not a crashed worker.
- **Resources.** Every conversion has a time limit, a heap limit and a size limit, and runs on a
  thread that can be killed (§6).
- **Encoding.** UTF-8 only. A UTF-8 byte-order mark is dropped (Excel puts one before every CSV).
  UTF-16 is refused with a message saying so, and bytes that are not valid UTF-8 are refused
  rather than silently replaced. Results are UTF-8 without a BOM, and non-ASCII text survives
  every direction.
- **Storage keys** are built from the user id and the operation id, never from the client's file
  name. The local driver also accepts only safe key characters, and checks that every resolved
  path stays inside its bucket.
- **Ownership.** Every history read is by id *and* user, so another user's id is indistinguishable
  from no id at all.

---

## 8. Extending: converter modules

`FileConverter` (abstract) is the extension point. A module is a subclass provided by its own
Nest module. On start-up `ConverterRegistry` finds every provider that extends it, through Nest's
`DiscoveryService`, so there is no central list to keep in step. A module declares what it reads,
what each format can become, how it recognises a file, and how it converts. The RPC contract, the
gateway and `GET /api/convert/formats` do not change when a module is added. Two modules with the
same id stop the service from booting.

Inside the data module, `DataFormat` (abstract) is the second extension point. A new text format
is one subclass added to `DATA_FORMATS`, and it then converts to and from every format already
there, because all of them meet in the shared data model (§4).

---

## 9. Audit and history

Every attempt writes one row to `conversion_operations` (the history) and one audit line to the
log:

```json
{ "event": "conversion.audit", "operationId": "…", "correlationId": "…", "userId": "…",
  "sourceFormat": "csv", "targetFormat": "json", "fileSize": 1234,
  "result": "success", "code": null, "durationMs": 41 }
```

The audit line holds neither the content nor the **file name**: the name belongs to the user, and
can tell a log pipeline more than they meant to share. The name is kept in the history row, which
only its owner reads. A failure is logged as a warning with its `code`. An unexpected error is
stored as `INTERNAL_ERROR` with no detail; its stack trace stays in the service's own log.

---

## 10. Where the code lives

| | |
|---|---|
| `apps/api-gateway/src/modules/conversions/` | the `/api/convert` controller; `upload-reader.ts` (streaming multipart); `conversions.service.ts` |
| `apps/conversion-service/src/modules/converters/` | `FileConverter`, `ConverterRegistry`, `WorkerRunner` |
| `apps/conversion-service/src/modules/data/` | `DataFormat`, the four formats, the mapping rules (`data-shapes.ts`), the worker entry, `DataConverter` |
| `apps/conversion-service/src/modules/operations/` | the RPC controller, the conversion flow and history, limits, the clean-up job |
| `libs/storage/src/` | `FileStorage`, `S3FileStorage`, `LocalFileStorage`, `StorageResolver` |
| `libs/contracts/src/messages/conversion.messages.ts` | the `conversion.rpc` contract |
| `apps/conversion-service/prisma/` | `conversion_operations` and its migration |

Tests: every format and all twelve pairs (`data-transform.spec.ts`, `formats.spec.ts`); the worker
runner on real threads, including the time and memory limits; the conversion flow against real
local storage; the gateway through real Fastify multipart (`apps/api-gateway/test/convert.e2e-spec.ts`);
and, against the running stack, `scripts/smoke.sh`.
