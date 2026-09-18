import 'reflect-metadata';
import 'dotenv/config';

import { DataSource } from 'typeorm';

/**
 * TypeORM CLI data source for the `notification` schema. See the
 * identity-service copy for why this file exists.
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
