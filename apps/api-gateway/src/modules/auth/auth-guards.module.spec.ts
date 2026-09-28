import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ConfigService } from '@core/config/config.service';
import { AuthGuardsModule } from './auth-guards.module';
import { AuthenticationGuard } from './authentication.guard';
import { AUTHENTICATORS, type Authenticator } from './authenticator';
import { JwtAuthenticator } from './authenticators/jwt.authenticator';

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: new ConfigService({
        JWT_SECRET: 'access-secret-that-is-long-enough-for-joi',
      }),
    },
  ],
  exports: [ConfigService],
})
class ConfigStubModule {}

/**
 * The list is the extension point, so what is on it — and in what order — is
 * worth pinning: adding a scheme should be an edit that shows up here.
 */
describe('AuthGuardsModule', () => {
  it('registers exactly the JWT authenticator today', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigStubModule, AuthGuardsModule],
    }).compile();

    const authenticators = moduleRef.get<Authenticator[]>(AUTHENTICATORS);

    expect(authenticators).toHaveLength(1);
    expect(authenticators[0]).toBeInstanceOf(JwtAuthenticator);
    expect(moduleRef.get(AuthenticationGuard)).toBeInstanceOf(
      AuthenticationGuard,
    );
  });
});
