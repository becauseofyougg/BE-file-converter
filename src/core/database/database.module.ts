import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { addTransactionalDataSource, deleteDataSourceByName } from 'typeorm-transactional';

import { ConfigModule } from '@/core/config/config.module';
import { ConfigService } from '@/core/config/config.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',

        host: config.get('POSTGRES_HOST'),
        port: Number(config.get('POSTGRES_PORT')),
        username: config.get('POSTGRES_USER'),
        password: config.get('POSTGRES_PASSWORD'),
        database: config.get('POSTGRES_DB'),

        entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
        autoLoadEntities: true,

        migrationsTableName: 'migrations',
        migrations: [__dirname + '/../../database/migrations/*.migration{.ts,.js}'],
        migrationsRun: String(config.get('POSTGRES_MIGRATIONS_RUN')) === 'true',

        synchronize: String(config.get('POSTGRES_SYNCHRONIZE')) === 'true',
        logging: String(config.get('POSTGRES_LOGGING')) === 'true',
      }),
      async dataSourceFactory(options) {
        if (!options) {
          throw new Error('Invalid options passed');
        }

        deleteDataSourceByName('default');

        return addTransactionalDataSource(new DataSource(options));
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
