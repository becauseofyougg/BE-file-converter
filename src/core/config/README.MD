# Config Module

A type-safe configuration module that wraps NestJS `@nestjs/config` with Joi validation. Environment variables are validated at application startup, ensuring the app fails fast if required config is missing or invalid.

## Usage

Inject `ConfigService` into any provider:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from './config/config.service';

@Injectable()
export class MyService {
  constructor(private readonly config: ConfigService) {}

  someMethod() {
    const port = this.config.get('PORT');      // Type-safe, autocomplete works
    const env = this.config.get('NODE_ENV');   // Returns 'development' | 'production'
  }
}
```

## Adding New Options

1. **Define the type** in `config.types.ts`:

```typescript
export interface Config {
  PORT: number;
  NODE_ENV: 'development' | 'production';
  DATABASE_URL: string;  // Add new option here
}
```

2. **Add validation** in `config.validation.ts`:

```typescript
export const configValidationSchema = Joi.object<Config>({
  PORT: Joi.number().port().required(),
  NODE_ENV: Joi.string().valid('development', 'production').required(),
  DATABASE_URL: Joi.string().uri().required(),  // Add validation here
});
```

3. **Set the environment variable** in your `.env` file or environment.

That's it. The new option is now type-safe and validated at startup.
