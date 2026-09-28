import { Module } from '@nestjs/common';

import { LinkService } from './link.service';
import { TemplatesService } from './templates.service';

@Module({
  providers: [LinkService, TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
