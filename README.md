# File Converter — Backend

NestJS **monorepo**: four services in one repository, talking over RabbitMQ, with S3-compatible object
storage holding the bytes. HTTP kernel is **Fastify** (`@nestjs/platform-fastify`), not Express — use
Fastify plugins and types (`NestFastifyApplication`, `app.register(...)`).

The design and the reasoning behind the split live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
cross-cutting requirements in [docs/NON-FUNCTIONAL-REQUIREMENTS.md](docs/NON-FUNCTIONAL-REQUIREMENTS.md).

## Services

| Service | Port | Responsibility | Owns |
|---|---|---|---|
| `api-gateway` | 3000 | The only public HTTP surface: auth guards, rate limiting, uploads, presigned downloads, OpenAPI | — |
| `identity-service` | 3001 | Registration, login, JWT issuing/refresh, email verification, profile | `identity` DB |
| `conversion-service` | 3002 | Consumes conversion commands, runs the engines, writes results to storage. Stateless, N replicas | `conversion` DB |
| `notification-service` | 3003 | Consumes domain events, renders templates, sends SMTP mail | `notification` DB |

Only the gateway serves real HTTP traffic. The workers expose HTTP for `/health` alone — an orchestrator
needs a way to tell a wedged service from a busy one; their work arrives over AMQP.

## Project structure

```
apps/
├── api-gateway/          HTTP edge (Fastify) + RMQ clients
│   └── src/{config,messaging,modules/{auth,users,conversions,formats}}
├── identity-service/     RMQ request/response handlers
│   └── src/{config,database,modules/{auth,users,tokens}}
├── conversion-service/   RMQ consumer, one deployment per format family
│   └── src/{config,database,modules/{worker,converters,pipeline}}
└── notification-service/ RMQ consumer + SMTP
    └── src/{config,database,modules/{mailer,templates}}
libs/
├── core/                 config, database, health, throttler
├── contracts/            message patterns, event payloads, topology, error codes — types, no logic
├── storage/              S3/MinIO client: put, get stream, presign, delete
└── observability/        pino logger, redaction, correlation id
docker/                   Dockerfile per app + Postgres init
docs/                     architecture, NFRs, feature specs
```

`libs/contracts` is the only thing every service depends on, and it holds **types and names, no logic** —
that is what keeps the services independently deployable. A change there is a contract change.

## Running

```bash
cp .env.example .env
docker compose up -d           # postgres (3 DBs), rabbitmq, minio, mailhog, all four services
docker compose up --scale conversion-service=5 -d
```

| UI | URL |
|---|---|
| RabbitMQ management | http://localhost:15672 |
| MinIO console | http://localhost:9001 |
| Mailhog (catches all dev mail) | http://localhost:8025 |

Running a single service on the host instead:

```bash
npm run start:dev:api-gateway
npm run start:dev:identity-service
npm run start:dev:conversion-service
npm run start:dev:notification-service
```

## Scripts

```bash
npm run build                  # all four apps
npm run build:api-gateway      # one app
npm run lint                   # lint & fix
npm run test                   # unit tests (apps + libs)
npm run test:cov               # with coverage
npm run test:e2e               # gateway e2e
```

## Configuration

Every service validates **only the variables it needs** at boot (Joi, in `apps/<service>/src/config`) and
refuses to start on an invalid one — the conversion worker does not require SMTP credentials, the gateway
does not require a database. Shared fragments (`baseConfigSchema`, `postgresConfigSchema`,
`rabbitmqConfigSchema`, `s3ConfigSchema`, …) come from `libs/core` and `libs/storage`; `.env.example`
documents every key.

## Database

**Database per service.** Each service owns its schema and nobody else reads it — cross-service data
travels only as messages. Locally that is one PostgreSQL container with three databases (`identity`,
`conversion`, `notification`), created by `docker/postgres/init-databases.sh`.

The ORM is **Prisma**, one schema per service at `apps/<service>/prisma/schema.prisma`.

- **Connection:** `PrismaModule` in the owning service's `AppModule`; the client is `PrismaService`
- **Queries:** inject `TransactionHost` and go through `this.txHost.tx.<model>` — never `PrismaService`
  directly, or the query will not join an open transaction
- **Transactions:** `@Transactional()` from `@nestjs-cls/transactional`
- **Schema:** edit `schema.prisma`, then `npm run migrate:dev:identity` to generate a migration

```bash
npm run prisma:generate                 # all three clients; also runs on npm install
npm run migrate:dev:identity            # also :conversion, :notification
npm run migrate:deploy:identity         # apply without generating — what containers run
npm run migrate:status:identity
npm run studio:identity
```

**Two URLs, on purpose.** Each schema reads `IDENTITY_DATABASE_URL` / `CONVERSION_DATABASE_URL` /
`NOTIFICATION_DATABASE_URL`, used by the Prisma **CLI** only — the three schemas share one root `.env`
in development, so a single name would point every CLI at whichever database was configured last. The
**running service** reads `DATABASE_URL`, which is the one variable compose sets per container.

Clients are generated into `node_modules/@prisma-clients/<service>`, so a bare import resolves the same
from `src` and from `dist`. `npm install` and `npm prune` both delete them, which is why `postinstall`
regenerates and why the Dockerfiles generate again after pruning.

**Partial indexes** are not expressible in Prisma's schema language and are maintained by hand at the
end of the migration SQL. `prisma migrate dev` does not know about them and will propose dropping them
— keep them. One of them (`uq_verification_tokens_live`) is a correctness guarantee, not a performance
tweak.

## Authentication and authorisation

Two global guards on the gateway, in order: `JwtAuthGuard` verifies the access token locally,
`RbacGuard` decides against a cached RBAC config. Both are `APP_GUARD`, so **every route is
authenticated unless it declares `@Public()`** — opt-out, so a new controller is protected by the fact
that nobody did anything.

```ts
@Controller('conversions')
export class ConversionsController {
  @Post()
  @Permissions('conversions@create')   // resource@action; several means all of them
  create(@CurrentUser() user: RequestUser) { ... }
}
```

Roles, permissions and grants live in the `identity` database and are editable through
`/admin/rbac/*` **without a restart**: a change publishes `rbac.updated`, and every gateway replica
reloads its cache. The rule itself is one pure function, [`decideAccess`](libs/core/src/rbac/rbac-policy.ts),
shared by both services so they cannot disagree. It fails closed — an unknown permission, an unloaded
config or a role nobody recognises all deny.

Roles travel inside the access token, so a decision costs no I/O; the trade-off is that revoking a
role takes effect only when the token expires, 15 minutes later at worst, since the next refresh
re-reads them. Full reasoning in [docs/RBAC.md](docs/RBAC.md).

Sessions themselves are two JWTs in httpOnly cookies — access (15 min) and refresh (30 days), rotated
as a pair. **No refresh state is stored**, so there is no server-side logout and no "sign out
everywhere"; [docs/AUTHORIZATION.md](docs/AUTHORIZATION.md) sets out what that costs and what limits
it.

There is no seeded administrator — §8 of that document has the one-line SQL to promote the first one.

Ownership is kept separate from roles. `GET /users/:userId` is the first place the two meet: you may
read your own profile because it is yours, or someone else's because you hold `users@read`, and the
fields you get back differ between the two ([docs/USER-PROFILE.md](docs/USER-PROFILE.md)).

## Messaging

Two interaction styles, deliberately kept distinct — the names live in `libs/contracts/messaging`:

| Style | Exchange | Used for |
|---|---|---|
| Commands (direct, load-balanced) | `conversion.commands` → `conversion.jobs.<family>` | work that must happen exactly once |
| Events (topic, fan-out) | `domain.events` | facts other services may react to |
| RPC (queue) | `identity.rpc` | the gateway asking identity a question |

Consumers run with manual ack and `prefetchCount=1`, on durable quorum queues.

## Libraries

| Purpose | Library |
|---|---|
| HTTP | Fastify (`@nestjs/platform-fastify`) |
| Messaging | RabbitMQ (`@nestjs/microservices`) |
| Env validation | Joi |
| Request validation | class-validator |
| ORM | Prisma (`@prisma/client`) |
| Transactions | `@nestjs-cls/transactional` (AsyncLocalStorage) |
| Database | PostgreSQL |
| Object storage | S3 / MinIO (`@aws-sdk/client-s3`) |
| Logging | pino (`nestjs-pino`) |

## Code style

- Import across projects through the aliases: `@core/*`, `@contracts/*`, `@storage/*`, `@obs/*`
- Inside an app, import by relative path
- Run `npm run format` before committing
- Follow the NestJS module pattern
