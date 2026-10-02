import { Module } from '@nestjs/common';

import { ConvertersModule } from '../converters/converters.module';
import { DataConverter } from './data.converter';

/**
 * The data formats module. Importing it is all it takes to serve its formats:
 * `ConverterRegistry` finds `DataConverter` because it extends `FileConverter`.
 */
@Module({
  imports: [ConvertersModule],
  providers: [DataConverter],
})
export class DataModule {}
