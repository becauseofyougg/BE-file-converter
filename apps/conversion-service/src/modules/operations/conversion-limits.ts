import { Injectable } from '@nestjs/common';

import { ConfigService } from '@core/config/config.service';
import {
  type ConversionConfig,
  perFormatLimitKey,
} from '../../config/conversion.config';

/**
 * The largest source accepted for each input format. Set by whoever runs the
 * service, in the environment: `CONVERSION_MAX_BYTES_<FORMAT>` for one format,
 * `CONVERSION_MAX_BYTES_DEFAULT` for the rest.
 */
@Injectable()
export class ConversionLimits {
  constructor(private readonly config: ConfigService<ConversionConfig>) {}

  maxBytesFor(format: string): number {
    const own = this.config.get(
      perFormatLimitKey(format) as keyof ConversionConfig,
    ) as string | number | undefined;

    if (own !== undefined && own !== '') {
      return Number(own);
    }

    return this.config.getNumber('CONVERSION_MAX_BYTES_DEFAULT');
  }
}
