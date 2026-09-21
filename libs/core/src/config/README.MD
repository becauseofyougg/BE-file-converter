# Config Module

A type-safe configuration module that wraps NestJS `@nestjs/config` with Joi validation. Environment variables are validated at application startup, ensuring the app fails fast if required config is missing or invalid.

In the monorepo each service composes **its own** config from the fragments here and validates only the variables it needs — the conversion worker does not require SMTP credentials to boot, and the gateway declares no database variables at all.

## Usage

Each app defines its config shape in `apps/<app>/src/config`:

```typescript
// apps/notification-service/src/config/notification.config.ts
import { BaseConfig, PostgresConfig, baseConfigSchema, postgresConfigSchema } from '@core/config';

export interface NotificationConfig extends BaseConfig, PostgresConfig {
  SMTP_HOST: string;
}

export const notificationConfigSchema = Joi.object<NotificationConfig>({
  ...baseConfigSchema,
  ...postgresConfigSchema,
  SMTP_HOST: Joi.string().required(),
});
```

and registers it once in its root module:

```typescript
ConfigModule.forRoot({ validationSchema: notificationConfigSchema });
```

Inject `ConfigService` typed with that shape — `get('SMTP_HOST')` then only compiles in a service that actually declares it:

```typescript
@Injectable()
export class MailerService {
  constructor(private readonly config: ConfigService<NotificationConfig>) {}

  someMethod() {
    const host = this.config.get('SMTP_HOST');          // string
    const port = this.config.getNumber('SMTP_PORT');    // number
    const secure = this.config.getBoolean('SMTP_SECURE'); // boolean, "false" included
  }
}
```

## Adding New Options

**Shared by several services** — add a fragment here:

1. **Define the type** in `config.types.ts` (a new interface, or a field on an existing fragment).
2. **Add validation** in `config.validation.ts` as a schema map, so apps can spread it.

**Used by one service only** — put it directly in that app's `config` file, as in the example above.

Then set the environment variable and document it in `.env.example`. The new option is type-safe and validated at startup.
