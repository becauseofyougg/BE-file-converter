import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

import { BaseConfig } from './config.types';

/**
 * Typed wrapper over Nest's ConfigService.
 *
 * Generic over the app's own config shape, so `config.get('SMTP_HOST')` only
 * compiles in a service that actually declares SMTP variables:
 *
 * ```ts
 * constructor(private readonly config: ConfigService<NotificationConfig>) {}
 * ```
 */
@Injectable()
export class ConfigService<
  C extends object = BaseConfig,
> extends NestConfigService<C> {
  get<T extends keyof C>(key: T): string {
    const value: unknown = super.get(key as never);
    return value as string;
  }

  getNumber<T extends keyof C>(key: T): number {
    return Number(this.get(key));
  }

  /**
   * Joi coerces `"true"` into `true` when the schema declares a boolean, but an
   * unvalidated variable arrives as a raw string — handle both.
   */
  getBoolean<T extends keyof C>(key: T): boolean {
    const value: unknown = super.get(key as never);
    return value === true || String(value).toLowerCase() === 'true';
  }
}
