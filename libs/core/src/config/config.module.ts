import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import Joi from 'joi';

import { ConfigService } from './config.service';

export interface ConfigModuleOptions {
  /**
   * The app's own schema, composed from the fragments in `config.validation.ts`.
   * Each service validates only the variables it needs, and refuses to boot on
   * an invalid one rather than failing on first use.
   */
  validationSchema: Joi.ObjectSchema;
}

@Global()
@Module({})
export class ConfigModule {
  static forRoot(options: ConfigModuleOptions): DynamicModule {
    return {
      module: ConfigModule,
      imports: [
        NestConfigModule.forRoot({
          isGlobal: true,
          validationSchema: options.validationSchema,
          validationOptions: {
            // Report every invalid variable at once instead of one per restart.
            abortEarly: false,
          },
        }),
      ],
      providers: [ConfigService],
      exports: [ConfigService],
    };
  }
}
