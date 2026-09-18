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

- **Connection:** `DatabaseModule.forRoot({ migrations })` in the owning service's `AppModule`
- **Entities:** `TypeOrmModule.forFeature([YourEntity])` in a feature module, then `@InjectRepository(...)`
- **Transactions:** `@Transactional()` from `typeorm-transactional` (the context is initialised in each `main.ts`)
- **Schema:** migrations in `apps/<service>/src/database/migrations/`. `POSTGRES_SYNCHRONIZE` is `false` — do not rely on auto-sync

```bash
npm run migration:generate:identity     # also :conversion, :notification
npm run migration:run:identity
npm run migration:revert:identity
npm run migration:show:identity
```

Each service has its own CLI data source at `apps/<service>/src/database/data-source.ts`. At runtime Nest
uses the DataSource from `DatabaseModule`; with `POSTGRES_MIGRATIONS_RUN=true` pending migrations also run
on start.

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
| ORM | TypeORM (`@nestjs/typeorm`) |
| Database | PostgreSQL (`pg`) |
| Object storage | S3 / MinIO (`@aws-sdk/client-s3`) |
| Logging | pino (`nestjs-pino`) |

## Code style

- Import across projects through the aliases: `@core/*`, `@contracts/*`, `@storage/*`, `@obs/*`
- Inside an app, import by relative path
- Run `npm run format` before committing
- Follow the NestJS module pattern
