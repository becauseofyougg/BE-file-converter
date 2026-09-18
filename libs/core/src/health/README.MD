# Health Module

The Health module provides a health check endpoint at `GET /health`

## Enable / Disable

The health check is controlled by the `HEALTH_CHECK_ENABLED` environment variable:

| Value   | Behavior                                         |
| ------- | ------------------------------------------------ |
| `true`  | Full health check is performed                   |
| `false` | Returns an empty response (default)              |

Add to your `.env` file:

```env
HEALTH_CHECK_ENABLED=true
```

**Note:** When disabled (default), the endpoint still responds but skips all health indicators and returns `{ status: 'ok', details: {} }`.

## Adding New Health Checks

To add custom health indicators, modify `health.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import {
  HealthCheckService,
  HttpHealthIndicator,
  MemoryHealthIndicator,
} from '@nestjs/terminus';

@Injectable()
export class HealthService {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly http: HttpHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  checkHealth() {
    return this.healthCheckService.check([
      // Check external service
      () => this.http.pingCheck('api', 'https://api.example.com'),
      // Check memory heap
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),
    ]);
  }
}
```

For the full list of available health indicators and custom indicator creation, see the official NestJS documentation:
**[https://docs.nestjs.com/recipes/terminus](https://docs.nestjs.com/recipes/terminus)**
