jest.mock('@nestjs-cls/transactional', () => ({
  Transactional:
    () =>
    (
      _target: unknown,
      _key: string,
      descriptor: PropertyDescriptor,
    ): PropertyDescriptor =>
      descriptor,
  TransactionHost: class {},
}));

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ConfigService } from '@core/config/config.service';
import { JwtTokenIssuer } from '../tokens/jwt-token-issuer';
import { TOKEN_ISSUER } from '../tokens/token-issuer';
import { TokensModule } from '../tokens/tokens.module';
import { Argon2PasswordHasher } from './argon2-password-hasher';
import { AuthModule } from './auth.module';
import { PASSWORD_HASHER } from './password-hasher';

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: new ConfigService({
        JWT_SECRET: 'access-secret-that-is-long-enough-for-joi',
        JWT_ACCESS_TTL: '15m',
      }),
    },
  ],
  exports: [ConfigService],
})
class ConfigStubModule {}

/**
 * The ports are only worth having if the binding really is one line. These
 * pin what each token resolves to, so a swap is a deliberate edit that fails
 * here first rather than a surprise somewhere downstream.
 */
describe('auth ports', () => {
  it('TokensModule exports the issuer port, bound to the JWT implementation', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigStubModule, TokensModule],
    }).compile();

    expect(moduleRef.get(TOKEN_ISSUER)).toBeInstanceOf(JwtTokenIssuer);
  });

  /**
   * Not the class: exporting only the port is what stops a consumer injecting
   * `JwtTokenIssuer` directly and quietly depending on it again.
   */
  it('does not export the JWT implementation itself', async () => {
    @Module({
      imports: [TokensModule],
      providers: [
        {
          provide: 'probe',
          inject: [JwtTokenIssuer],
          useFactory: (issuer: JwtTokenIssuer) => issuer,
        },
      ],
    })
    class ConsumerModule {}

    await expect(
      Test.createTestingModule({
        imports: [ConfigStubModule, ConsumerModule],
      }).compile(),
    ).rejects.toThrow(/JwtTokenIssuer/);
  });

  it('binds the password hasher port to argon2', () => {
    const providers = Reflect.getMetadata('providers', AuthModule) as Array<
      { provide?: unknown; useClass?: unknown } | (new () => unknown)
    >;

    expect(providers).toContainEqual({
      provide: PASSWORD_HASHER,
      useClass: Argon2PasswordHasher,
    });
  });
});
