import { ConfigService } from '@core/config/config.service';
import {
  type ConversionConfig,
  conversionConfigSchema,
} from '../../config/conversion.config';
import { ConversionLimits } from './conversion-limits';

describe('ConversionLimits', () => {
  const limitsWith = (env: Record<string, string | number>) =>
    new ConversionLimits({
      get: (key: string) => env[key],
      getNumber: (key: string) => Number(env[key]),
    } as unknown as ConfigService<ConversionConfig>);

  it("uses a format's own limit when it has one", () => {
    const limits = limitsWith({
      CONVERSION_MAX_BYTES_DEFAULT: 100,
      CONVERSION_MAX_BYTES_XML: 7,
    });

    expect(limits.maxBytesFor('xml')).toBe(7);
  });

  it('falls back to the default for the rest', () => {
    const limits = limitsWith({
      CONVERSION_MAX_BYTES_DEFAULT: 100,
      CONVERSION_MAX_BYTES_XML: '',
    });

    expect(limits.maxBytesFor('xml')).toBe(100);
    expect(limits.maxBytesFor('csv')).toBe(100);
  });
});

describe('conversionConfigSchema', () => {
  const base = {
    NODE_ENV: 'test',
    SERVICE_NAME: 'conversion-service',
    PORT: 3002,
    DATABASE_URL: 'postgresql://u:p@localhost:5432/conversion',
    RABBITMQ_URL: 'amqp://localhost',
    STORAGE_DRIVER: 'local',
    CONVERSION_FAMILY: 'data',
  };

  const validate = (extra: Record<string, unknown>) =>
    conversionConfigSchema.validate(
      { ...base, ...extra },
      { allowUnknown: true },
    );

  it('defaults the synchronous conversion settings', () => {
    const { error, value } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      CONVERSION_RPC_CONCURRENCY: 4,
      CONVERSION_SYNC_TIMEOUT_MS: 30_000,
      CONVERSION_MAX_BYTES_DEFAULT: 10 * 1024 * 1024,
      CONVERSION_MAX_DEPTH: 64,
      CONVERSION_WORKER_MEMORY_MB: 256,
      CONVERSION_UNSAVED_RESULT_MINUTES: 15,
    });
  });

  it('accepts a per-format limit, as a number', () => {
    const { error, value } = validate({ CONVERSION_MAX_BYTES_CSV: '2048' });

    expect(error).toBeUndefined();
    expect(value).toMatchObject({ CONVERSION_MAX_BYTES_CSV: 2048 });
  });

  it('refuses a per-format limit that is not a byte count', () => {
    expect(validate({ CONVERSION_MAX_BYTES_CSV: '10mb' }).error).toBeDefined();
    expect(validate({ CONVERSION_MAX_BYTES_YAML: 0 }).error).toBeDefined();
  });
});
