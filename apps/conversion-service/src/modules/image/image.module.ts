import { Module } from '@nestjs/common';

import { ImageConverter } from './image.converter';

/**
 * PNG, JPEG and SVG. Importing it is all it takes to serve them, through
 * `/api/convert` and `/api/images/convert` alike: `ConverterRegistry` finds
 * `ImageConverter` because it extends `FileConverter`.
 */
@Module({
  providers: [ImageConverter],
})
export class ImageModule {}
