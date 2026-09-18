import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
} from 'typeorm-transactional';

import { ConfigService } from '../config/config.service';
import { PostgresConfig } from '../config/config.types';

export interface DatabaseModuleOptions {
  /**
   * Migration globs of the owning service. Database per service: each service
   * owns its schema and its own migrations directory, and nobody else reads it.
   */
  migrations: string[];
}

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<PostgresConfig>) => ({
            type: 'postgres' as const,

            host: config.get('POSTGRES_HOST'),
            port: config.getNumber('POSTGRES_PORT'),
            username: config.get('POSTGRES_USER'),
            password: config.get('POSTGRES_PASSWORD'),
            database: config.get('POSTGRES_DB'),

            // Entities are registered per module via `TypeOrmModule.forFeature`,
            // so no filesystem glob is needed — and none would survive the
            // monorepo build layout anyway.
            autoLoadEntities: true,

            migrationsTableName: 'migrations',
            migrations: options.migrations,
            migrationsRun: config.getBoolean('POSTGRES_MIGRATIONS_RUN'),

            synchronize: config.getBoolean('POSTGRES_SYNCHRONIZE'),
            logging: config.getBoolean('POSTGRES_LOGGING'),
          }),
          dataSourceFactory(options) {
            if (!options) {
              throw new Error('Invalid options passed');
            }

            deleteDataSourceByName('default');

            return Promise.resolve(
              addTransactionalDataSource(new DataSource(options)),
            );
          },
        }),
      ],
      exports: [TypeOrmModule],
    };
  }
}
