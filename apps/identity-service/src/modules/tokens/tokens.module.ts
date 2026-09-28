import { Module } from '@nestjs/common';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';

import { ConfigService } from '@core/config/config.service';
import { IdentityConfig } from '../../config/identity.config';
import { JwtTokenIssuer } from './jwt-token-issuer';
import { TOKEN_ISSUER } from './token-issuer';

/**
 * Exports the {@link TOKEN_ISSUER} port, not the class behind it, so nothing
 * outside this module can come to depend on the JWT implementation. Swapping
 * it is the `useExisting` line below, plus whatever the replacement imports in
 * place of `JwtModule`.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<IdentityConfig>) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          // Joi guarantees the shape; `jsonwebtoken` types it as a template
          // literal union that a config string cannot be narrowed to.
          expiresIn: config.get(
            'JWT_ACCESS_TTL',
          ) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  providers: [
    JwtTokenIssuer,
    { provide: TOKEN_ISSUER, useExisting: JwtTokenIssuer },
  ],
  exports: [TOKEN_ISSUER],
})
export class TokensModule {}
