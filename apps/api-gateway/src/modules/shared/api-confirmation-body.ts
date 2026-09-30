import { applyDecorators, type Type } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';

/**
 * What a confirmation body looks like in Swagger: two named examples instead
 * of one generated from every field.
 *
 * The DTOs behind these routes accept *either* a code quoted against its
 * challenge *or* a magic-link token — never both. Left to itself, Swagger
 * builds its example from every property, so "Try it out" pre-filled
 * `{ challengeId, code, token: "string" }`: a body that mixes the two
 * variants, with a placeholder token that the reader took for something
 * Swagger had kept from an earlier call. Named examples make the choice
 * visible, and the first — the default method — is what gets pre-filled.
 */
export function ApiConfirmationBody(type: Type<unknown>) {
  return applyDecorators(
    ApiBody({
      type,
      examples: {
        code: {
          summary: 'Code from the mail — the default (AUTH_CONFIRM_METHOD=otp)',
          description:
            '`challengeId` from the response that started this flow, `code` from the newest mail in Mailhog. The code lives 10 minutes.',
          value: {
            challengeId: '00000000-0000-4000-8000-000000000000',
            code: '123456',
          },
        },
        link: {
          summary: 'Token from a magic link (AUTH_CONFIRM_METHOD=link)',
          description:
            'The `token` query parameter of the link in the mail, on its own.',
          value: { token: 'paste-the-token-from-the-link' },
        },
      },
    }),
  );
}

/**
 * `resend-verification` has the same either/or shape: the challenge handle
 * from registration, or — when the client has lost it — the address.
 */
export function ApiResendVerificationBody(type: Type<unknown>) {
  return applyDecorators(
    ApiBody({
      type,
      examples: {
        challenge: {
          summary: 'The challengeId from registration',
          value: { challengeId: '00000000-0000-4000-8000-000000000000' },
        },
        email: {
          summary: 'The address, when the challengeId is lost',
          value: { email: 'user@example.com' },
        },
      },
    }),
  );
}
