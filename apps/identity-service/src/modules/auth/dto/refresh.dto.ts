import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import type { RefreshRequest } from '@contracts/messages/identity.messages';

/**
 * A bounded string, and nothing more. What a refresh token looks like is the
 * `TokenIssuer`'s business — a JWT today, but this boundary must not be what
 * decides that.
 *
 * It also must not be what *refuses* one. A validation failure here surfaces
 * as a 500 through the RPC filter, whereas `verifyRefresh` answers every bad
 * token — malformed included — with the same 401 the spec asks for. The cookie
 * is the one field the gateway forwards without shaping, so this is the one
 * place that difference would show.
 */
export class RefreshMessageDto implements RefreshRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  refreshToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}
