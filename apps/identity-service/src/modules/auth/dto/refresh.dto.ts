import { IsJWT, IsOptional, IsString, MaxLength } from 'class-validator';

import type { RefreshRequest } from '@contracts/messages/identity.messages';

/**
 * `@IsJWT` is shape only — three base64url segments. It rejects the garbage
 * that a malformed cookie sends before it reaches the verifier, and proves
 * nothing at all about the signature, which `TokensService.verifyRefresh` is
 * the only place allowed to judge.
 */
export class RefreshMessageDto implements RefreshRequest {
  @IsJWT()
  @MaxLength(4096)
  refreshToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}
