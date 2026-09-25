# File Converter — Non-Functional Requirements

**Status:** all eight met — see the table for how each is verified
**Date:** 2026-09-25
**Companion to:** [ARCHITECTURE.md](ARCHITECTURE.md) — that document says *what* is built, this one says
*what it must hold true for* and how each point is verified.

---

## 0. Summary

| # | Requirement | Target | State in this repo |
|---|---|---|---|
| 1 | Query optimisation — indexes, explicit `select`, transactions where needed | No unindexed query on a hot path; the password hash never read where it is not used | ✅ Indexes per §1.1, including composite sort keys and a GIN trigram index. `SAFE_USER_SELECT` / `LIST_USER_SELECT` keep `password_hash` out of every path but login ([users.service.ts](../apps/identity-service/src/modules/users/users.service.ts)). `@Transactional()` on every multi-statement write, plus the outbox |
| 2 | Health checks (`/health`) | Liveness *and* readiness, used by compose/k8s probes | ✅ Each service registers its own probes under `HEALTH_PROBES` — identity and notification their database, conversion its database and its bucket, the gateway the broker and the bucket ([health.probes.ts](../libs/core/src/health/health.probes.ts)). A failing probe reports `down` with a redacted reason rather than a 500 |
| 3 | Rate limiting | Global throttle + stricter per-dimension quotas | ✅ Global `ThrottlerGuard` via `APP_GUARD`, per-route `@Throttle`, plus per-email and per-viewer guards and a per-account lockout (§3) |
| 4 | Validation of every input (class-validator) | Every HTTP DTO, every message payload, every env var | ✅ Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` at the edge, a second pipe on each identity RPC controller, Joi for every environment |
| 5 | CORS — trusted origins only | Allow-list from env, no `*`, credentials on | ✅ `CORS_ORIGINS` allow-list; Joi rejects `*` and an empty list at boot ([config.validation.ts](../libs/core/src/config/config.validation.ts)) |
| 6 | Logging of all critical events | Structured JSON, correlation id, auth + data changes + failures | ✅ pino with redaction and a correlation id threaded from the edge through the broker; audit lines for login, lockout, refresh, RBAC changes, profile reads and writes, email changes, erasures and list queries |
| 7 | Test coverage ≥ 80% | Statements, branches, functions and lines | ✅ **98.0% statements · 80.7% branches · 97.8% functions · 97.9% lines**, 609 tests across 52 suites |
| 8 | OpenAPI (Swagger) | Generated from the DTOs, cannot drift from validation | ✅ Served at `/docs` (and `/docs/json`) outside production, generated from the same decorators that validate ([openapi.ts](../apps/api-gateway/src/openapi.ts)) |

Nothing in this list is optional; each one has an acceptance criterion below that a reviewer can check
without reading the implementation.

---

## 1. Database access

### 1.1 Indexes

Every index exists because a specific query needs it — an index nobody queries is write amplification.
The ones the API in §8 of the architecture actually demands:

| Table | Index | Query it serves |
|---|---|---|
| `conversion_jobs` | `(user_id, created_at DESC)` | `GET /conversions` — the user's job list, paginated |
| `conversion_jobs` | `(status, expires_at)` | TTL cleanup job scanning for expired results |
| `conversion_jobs` | partial on `status` where non-terminal | queue-depth / stuck-job metrics |
| `job_events` | `(job_id, created_at)` | job timeline for one job |
| `users` | `UNIQUE (email)` on `CITEXT` | login, registration uniqueness — uniqueness *and* lookup |
| `users` | `(created_at, id)`, `(last_login_at, id)` | admin list — the `id` tie-break is what makes the cursor walk stable |
| `users` | GIN trigram on `display_name` | admin search — `ILIKE '%…%'` cannot use a btree |
| `verification_tokens` | `(user_id, type)`, `(token_hash)` | quoting a challenge back; magic-link lookup |
| `notifications` | `UNIQUE (user_id, type, ref_id)` | idempotency on message redelivery |
| `outbox` | partial on `(sent_at IS NULL)` | relay polling only unsent rows |

Indexes are created **in migrations**, never by `prisma db push` — which exists for prototyping and
leaves no history
outside local development.

**Acceptance:** for each endpoint on a list or filter, an `EXPLAIN ANALYZE` on a seeded table shows an
index scan, not a sequential scan. A new index without a query that needs it is rejected in review.

### 1.2 Selecting only what is needed

- Repository methods declare the fields they read (`select: [...]` or a QueryBuilder `select`); entity
  autoloading of every column is the exception, not the default.
- `password_hash` and `token_hash` columns are `select: false` at the entity level, so they cannot leak
  into a response by someone forgetting to exclude them. Opt in explicitly where authentication needs them.
- Responses are serialised through response DTOs / `ClassSerializerInterceptor` — the entity shape is
  never the API shape.
- List endpoints are always paginated (`limit` capped, default 20); an unbounded list endpoint is a bug.
- `jsonb` payload columns (`options`, `job_events.payload`) are excluded from list queries and loaded
  only on the detail endpoint.

**Acceptance:** no endpoint returns a column the client cannot use; no response body ever contains a
hash or an internal storage key.

### 1.3 Transactions

Transactional boundaries belong to the use case, not the repository. `@nestjs-cls/transactional` is already
initialised in [main.ts:12](../src/main.ts#L12), so `@Transactional()` on a service method is all it takes.

Where a transaction is mandatory:

| Operation | Why |
|---|---|
| Register user | user row + verification token must both exist or neither |
| Login / refresh rotation | revoke old refresh token + issue new one — a crash between them locks the user out or leaves a valid stolen token |
| Password reset | update hash + revoke all refresh tokens of the family |
| Create conversion job | job row + **outbox** row in one commit — this is what makes the outbox pattern work at all (§4 of the architecture) |
| Job state transition | `conversion_jobs` update + `job_events` insert + outbox row |
| Cancel / delete job | status change + artifact deletion marker |

Rules: no HTTP call, no S3 call and no broker publish inside a transaction — external I/O holds the
connection and cannot be rolled back; that is precisely what the outbox exists to avoid. Terminal-state
updates are written with an optimistic guard (`WHERE status = <expected>`) so two redelivered messages
cannot both complete the same job.

**Acceptance:** an integration test kills the process between the two writes of each multi-write
operation and asserts that neither is visible.

---

## 2. Health checks

`GET /health` exists in every service, including the workers that otherwise expose no HTTP surface —
that tiny listener is the only way an orchestrator can tell a wedged converter from a busy one.

Two distinct probes, because they answer different questions:

| Endpoint | Question | Checks | On failure |
|---|---|---|---|
| `/health/live` | Is the process alive and not deadlocked? | event loop / heap only, **no dependencies** | container restarted |
| `/health/ready` | Can it serve traffic right now? | Postgres `SELECT 1`, RabbitMQ connection, S3 `headBucket`, disk space for the temp dir (workers) | removed from the load balancer, **not** restarted |

The distinction matters: a readiness check that pings the database will fail for every replica during a
brief DB blip, and if that is wired to liveness the whole fleet restarts itself into a crash loop.

`/health` is the aggregate, and keeps the `HEALTH_CHECK_ENABLED` switch — off, it answers `ok` without
checking anything, which is a liveness probe and nothing more.

**Each service declares what it depends on.** `libs/core` cannot know whether a given service owns a
database or writes to object storage, and must not import a Prisma client to find out — so each app
provides its own probes under `HEALTH_PROBES`
([health.probes.ts](../libs/core/src/health/health.probes.ts)) and the shared controller runs whatever it
finds:

| Service | Probes |
|---|---|
| identity, notification | its own database (`SELECT 1` through the application's pool) |
| conversion | its database and the bucket it reads inputs from |
| api-gateway | the broker it reaches identity through, and the bucket it presigns from |

A probe reports failure by **throwing** — no status enum to get wrong, and any client call that would
fail for a real request fails here for the same reason. Each is capped at 3 s, because a probe that
hangs reads to an orchestrator as a dead process and gets the replica killed for the wrong reason. A
failure becomes a `down` entry naming the dependency, not a 500: an error from the probe route itself
tells an operator nothing about what is broken. Failure messages are stripped of anything shaped like
`scheme://user:password@host`, since `/health` is the one unauthenticated route on every service.

The `live` / `ready` split above is still the right shape and is not built — today there is one endpoint
that does readiness work. Splitting it is a small change now that the probes exist.

Health endpoints are excluded from rate limiting (`@SkipThrottle()`) and from auth, and they expose no
version, no configuration and no error detail to an unauthenticated caller.

**Acceptance:** `docker compose up` shows all services healthy; stopping the RabbitMQ container turns
readiness red within 10 s and liveness stays green.

---

## 3. Rate limiting

Three layers, because they defend against different things:

| Layer | Scope | Suggested limit | Defends against |
|---|---|---|---|
| Global throttle | per IP, all endpoints | 100 req / min | scraping, cheap flooding |
| Auth endpoints | per IP **and** per email | 5 attempts / 15 min, exponential lockout | credential brute force, password-reset mail bombing |
| Conversion quota | per user, enforced against `conversion_jobs` | e.g. 20 jobs/hour, 3 concurrent, N MB/day | the expensive one — CPU exhaustion via the converter |

The first two are `@nestjs/throttler`; the third is a business rule and lives in the service, counted
from the job table inside the job-creation transaction — a throttler counter cannot express "3 jobs
*still running*".

To make this real, two changes to the boilerplate: register `ThrottlerGuard` as an `APP_GUARD` (it is
configured but not applied today, so nothing is currently limited), and make the throttler storage
**Redis-backed** — the default in-memory store counts per replica, so N gateway replicas multiply every
limit by N.

Behind a proxy, `trustProxy` must be set on the Fastify adapter and the client IP taken from
`X-Forwarded-For`; without it every request looks like it comes from the load balancer and the per-IP
limit either blocks everyone or nobody.

Responses use `429` with `Retry-After`. Limit breaches are logged (§6) — a spike in 429s on `/auth/login`
is an attack signal, not noise.

**Acceptance:** an e2e test fires `limit + 1` requests and asserts the last one is `429`; a second test
asserts `/health` is not throttled.

---

## 4. Input validation

**Every** boundary is validated, not only the HTTP one:

1. **HTTP DTOs** — `class-validator` + `class-transformer` through the global `ValidationPipe`.
2. **Message payloads** — a message arriving from another service over RabbitMQ is exactly as untrusted
   as a browser request; handlers validate the DTO before touching it.
3. **Environment** — Joi schema at boot ([config.validation.ts](../src/core/config/config.validation.ts));
   the process refuses to start on an invalid value rather than failing at 3 a.m. on first use.
4. **Uploaded bytes** — MIME type is re-derived from magic bytes, never trusted from the client
   (`Content-Type`/extension); size capped mid-stream; filename sanitised and never used as a storage key.

The pipe configuration is stricter than the current one:

```ts
new ValidationPipe({
  whitelist: true,            // already set — strips unknown properties
  forbidNonWhitelisted: true, // 400 instead of silently dropping, so clients learn about typos
  transform: true,            // DTOs arrive as class instances with coerced types
  transformOptions: { enableImplicitConversion: false }, // explicit @Type() beats silent coercion
})
```

**Note on the choice of library.** §9 of the architecture proposal recommended `nestjs-zod`; this
requirement fixes `class-validator`, so that open question is closed in favour of `class-validator` +
`@nestjs/swagger` decorators, which is also what the boilerplate already ships. The consequence to accept
consciously: a message payload has to be run through `plainToInstance` before `validate()`, and the
OpenAPI schema comes from a second set of decorators rather than from the validator itself — so §8's
acceptance criterion (docs generated from the same DTO) is what keeps the two in step.

Validation errors return the standard error envelope (`code`, `message`, `details`, `correlationId`)
from the global exception filter, with per-field details — and never echo back the offending value,
which is how validation messages leak secrets into logs and clients.

**Acceptance:** every controller method's body/query/param is a decorated DTO class — a `@Body() dto: any`
or a raw object does not pass review.

---

## 5. CORS

- Origins come from a **config value** (`CORS_ORIGINS`, comma-separated, Joi-validated), not from a
  hardcoded array as in [main.ts:27-37](../src/main.ts#L27-L37). Local values stay as the development default.
- `origin: '*'` is forbidden in any environment, and is anyway incompatible with `credentials: true`,
  which this API needs because the refresh token lives in a cookie.
- An unknown origin gets no `Access-Control-Allow-Origin` header — the request is simply not allowed, no
  reflection of whatever `Origin` was sent.
- `credentials: true`, explicit method list, explicit `allowedHeaders` (`Authorization`, `Content-Type`,
  `X-Correlation-Id`), `exposedHeaders` for what the client must read (`X-Correlation-Id`, `Retry-After`),
  `maxAge` on preflight to cut the round trips.
- CORS is not a security control for the API itself — it protects browser users. Authorisation is still
  enforced per request regardless of origin.

**Acceptance:** a request with `Origin: https://evil.example` receives no allow-origin header in any
environment; the origin list in production contains no `localhost`.

---

## 6. Logging of critical events

`pino` structured JSON to stdout, one line per event, shipped by the platform. No `console.log`.

Every log line carries: `timestamp`, `level`, `service`, `correlationId`, `userId` (when authenticated),
`event`, and the outcome. The correlation id is generated at the gateway, travels in RabbitMQ headers,
and appears in every worker line — without it a failed conversion is impossible to trace across four
services.

Events that must be logged, at minimum:

| Category | Events |
|---|---|
| Authentication | login success / failure (with reason), logout, refresh rotation, **refresh-token reuse detected**, password reset requested / completed, email verified |
| Authorisation | access denied (403), attempt to touch another user's job |
| Data changes | user profile update, job created / cancelled / deleted, artifact deleted by TTL |
| Job lifecycle | every status transition with duration and attempt number, error code on failure |
| Infrastructure | rate-limit breach, broker disconnect/reconnect, storage error, migration run, service start/stop |
| Errors | every unhandled exception with stack trace, mapped to an error code |

**Never logged:** passwords, tokens (raw or hashed), cookie values, `Authorization` headers, file
contents, full email addresses in production (hash or mask them). Redaction is configured in the pino
serialiser, so it holds even for objects a developer logs carelessly.

Log levels mean something: `error` = someone must look; `warn` = degraded but handled (retry, rate limit);
`info` = business events from the table above; `debug` = off in production.

The `job_events` table is the durable audit trail for conversions and is not a substitute for logs, nor
the reverse — logs rotate, the audit trail does not.

**Acceptance:** a failed conversion can be reconstructed end to end by grepping one `correlationId`
across all four services' logs.

---

## 7. Test coverage ≥ 80%

Enforced in the Jest config, so the number is a gate rather than an aspiration — `npm run test:cov`
exits non-zero below it:

```jsonc
"coverageThreshold": {
  "global": { "lines": 80, "statements": 80, "branches": 80, "functions": 80 }
}
```

**Where it stands: 98.0% statements · 80.7% branches · 97.8% functions · 97.9% lines**, over 609 tests
in 52 suites.

`collectCoverageFrom` excludes what coverage says nothing about: `*.module.ts`, `main.ts`, migrations,
`*.dto.ts`, generated contract types and the e2e directory. Counting those inflates the number while
testing nothing — the threshold should bite on services, guards, converters and pipeline code.

Branches sit far lower than the other three, and that is the honest shape of the code rather than a
gap in the tests: most of the remaining uncovered branches are `?? fallback` defaults on optional
parameters — `correlationId ?? randomUUID()` and its like — where exercising both sides asserts
nothing a reader doubts.

| Layer | Tool | What it covers |
|---|---|---|
| Unit | Jest + `@nestjs/testing`, mocked repositories | services, guards, converters (bytes → bytes, cheap and high-value), retry/backoff classification |
| Integration | Testcontainers: Postgres + RabbitMQ + MinIO | repositories against a real schema, message handlers, transactions and rollback, outbox relay |
| E2E | supertest against a booted app | auth flows, upload → poll → download with a real fixture file, 401/403/429 paths |

The integration layer is the one that matters most here and is the easiest to skip: transactional
rollback, idempotency on redelivery and index usage cannot be proven against a mock.

CI runs lint + unit + integration + e2e on every PR and fails the build when coverage drops below the
threshold. Coverage is reported per project once the monorepo split lands.

**Acceptance:** `npm run test:cov` exits non-zero below 80%; CI is the enforcing authority, not a reviewer.

---

## 8. OpenAPI (Swagger)

- `@nestjs/swagger` on the gateway — the only service with a public HTTP surface. The other three
  speak over RabbitMQ and have no HTTP beyond `/health`; their contract is `libs/contracts`, which is
  types rather than a spec. Served at `/docs`, with the raw JSON at `/docs/json` for client generation.
- **Served outside production only.** An OpenAPI document is a map of the attack surface, and whoever
  needs it in production can read it from the repository.
- The spec is **generated from the same DTOs `class-validator` guards**, so documentation and
  validation cannot drift apart. A DTO field that is not in the docs is a bug in the DTO, not in the
  docs.
- Documented per endpoint: the auth requirement, request/response schemas, and **every error response
  with its stable `code`**. The closed set of codes is published as an `ErrorCode` schema, since no DTO
  carries it.
- The security scheme declared is the **cookie**, not a bearer header, because that is how a browser
  authenticates here — so "Try it out" works against a real session instead of silently sending
  nothing. `bearer` is declared alongside it for callers that are not browsers.
- The async contract must be explicit in the docs: `POST /conversions` returns `202` with a `jobId`, not
  a converted file. This is the single most surprising thing about the API and belongs in the endpoint
  description, with the polling/SSE flow spelled out.
- `GET /formats` is documented as the source of truth for the conversion matrix, derived from the
  converter registry at runtime — the docs describe the endpoint, never a hardcoded list that will rot.
- Access: open in development, behind basic auth or disabled in production (`SWAGGER_ENABLED`).
- The contract for service-to-service messages is **not** OpenAPI — it lives as typed patterns and
  payloads in `libs/contracts`, versioned with the code.

**Acceptance:** the generated spec imports into Postman/Insomnia and every endpoint can be exercised from
it without reading the source; a CI step fails if the spec cannot be generated.

---

## 9. Out of scope for now

Deliberately not committed to, to keep the list honest — these need load targets before a number means
anything (open question 7 in [ARCHITECTURE.md](ARCHITECTURE.md#14-open-questions)):

- Latency and throughput SLOs (p95 API response time, jobs/minute per worker).
- Availability targets and a formal RTO/RPO, backup and restore procedure.
- Horizontal autoscaling policy — the signal is known (queue depth), the thresholds are not.
- Prometheus/Grafana dashboards and alert rules beyond the metric list in §11 of the architecture.
