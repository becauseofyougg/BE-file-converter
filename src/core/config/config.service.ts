import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

import { Config } from './config.types';

@Injectable()
export class ConfigService extends NestConfigService {
  get<T extends keyof Config>(key: T): string {
    const value = super.get(key);
    return value as string;
  }
}
