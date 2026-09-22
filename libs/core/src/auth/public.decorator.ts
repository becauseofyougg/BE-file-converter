import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'IS_PUBLIC';

/**
 * Opts a route out of authentication.
 *
 * Opt-*out* rather than opt-in: the gateway registers its auth guard globally,
 * so a new controller is protected by the fact that nobody did anything, and a
 * forgotten decorator denies rather than exposes.
 *
 * It lives in `libs/core` because `HealthController` does too — a probe must
 * answer without a token, and the shared controller cannot reach into the
 * gateway to say so.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
