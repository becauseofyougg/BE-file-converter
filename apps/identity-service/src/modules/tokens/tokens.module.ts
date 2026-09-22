import { Module } from '@nestjs/common';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';

import { ConfigService } from '@core/config/config.service';
import { IdentityConfig } from '../../config/identity.config';
import { TokensService } from './tokens.service';

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
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
