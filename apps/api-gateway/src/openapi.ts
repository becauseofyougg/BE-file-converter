import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { ACCESS_TOKEN_COOKIE } from './modules/auth/session-cookies.service';

export const OPENAPI_PATH = 'docs';

/**
 * The published contract of the only public surface —
 * NON-FUNCTIONAL-REQUIREMENTS.md §8.
 *
 * Generated from the DTOs and the decorators rather than written by hand, so it
 * cannot drift from the code the way a maintained document does: a field
 * renamed in a DTO is a field renamed here, and a route deleted disappears from
 * both at once.
 *
 * Only the gateway publishes one. The other three services speak over RabbitMQ
 * and have no HTTP surface beyond `/health`; their contract is
 * `libs/contracts`, which is types rather than a spec.
 */
export function setupOpenApi(app: NestFastifyApplication): void {
  const config = new DocumentBuilder()
    .setTitle('File Converter API')
    .setDescription(
      [
        'The public HTTP surface of the file-converter platform.',
        '',
        '**Authentication** is by JWT in an `httpOnly` cookie, not a bearer header.',
        'Sign in at `POST /auth/login`; the browser sends `access_token` on every',
        'subsequent request by itself. A `Bearer` header is accepted as a fallback',
        'for callers that are not browsers. See `docs/AUTHORIZATION.md`.',
        '',
        `**Errors** all share one envelope: \`{ code, message, details?, correlationId }\`,`,
        'where `code` is a stable identifier from a closed set — branch on it, never',
        'on the message text.',
      ].join('\n'),
    )
    .setVersion('1.0')
    // How a browser actually authenticates here. Declared so the "Try it out"
    // button works against a real session rather than silently sending nothing.
    .addCookieAuth(
      ACCESS_TOKEN_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        name: ACCESS_TOKEN_COOKIE,
        description: 'Set by `POST /auth/login`. 15 minutes.',
      },
      // The security *name*, which defaults to `cookie`. Named after the
      // cookie so `@ApiCookieAuth(ACCESS_TOKEN_COOKIE)` on a controller refers
      // to a scheme that exists — otherwise the reference dangles silently and
      // "Try it out" sends no credentials at all.
      ACCESS_TOKEN_COOKIE,
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .addTag('auth', 'Registration, login, sessions')
    .addTag('users', 'Profiles — read, update, erase')
    .addTag('admin', 'Administrative surfaces: RBAC and the user directory')
    .addTag('health', 'Liveness and readiness')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // Operation ids from the method names, so a generated client reads
    // `listUsers()` rather than `UsersController_listUsers_v1`.
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });

  // The error codes are a contract in their own right, and there is no DTO
  // whose shape would carry them — so they are attached to the schema the
  // envelope refers to.
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ErrorCode = {
    type: 'string',
    enum: Object.values(ERROR_CODES),
    description: 'The stable error identifiers a client may branch on.',
  };

  SwaggerModule.setup(OPENAPI_PATH, app, document, {
    jsonDocumentUrl: `${OPENAPI_PATH}/json`,
    swaggerOptions: {
      persistAuthorization: true,
      // Alphabetical, so a diff of the rendered page is reviewable.
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });
}
