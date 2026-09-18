import 'reflect-metadata';
import 'dotenv/config';

import { DataSource } from 'typeorm';

/**
 * Standalone TypeORM DataSource used by the TypeORM CLI
 * (migration:generate, migration:run, migration:revert, etc.).
 *
 * The Nest runtime uses the DataSource built inside `DatabaseModule`;
 * this file exists solely so the CLI can load the same connection
 * settings from .env without booting the whole Nest application.
 *
 * One data source and one migrations directory per owning service — this file
 * is the `identity` schema's, and no other service's CLI points at it.
 */
export const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,

  entities: [__dirname + '/../modules/**/*.entity{.ts,.js}'],

  migrationsTableName: 'migrations',
  migrations: [__dirname + '/migrations/*.migration{.ts,.js}'],

  synchronize: false,
  logging: process.env.POSTGRES_LOGGING === 'true',
});

export default dataSource;
