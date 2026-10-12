import { Module } from '@nestjs/common';

import { StorageModule } from '@storage/storage.module';
import {
  AdminTransformationsController,
  TransformationsController,
} from './transformations.controller';
import { TransformationsService } from './transformations.service';

/**
 * The transformation history — docs/TRANSFORMATION-HISTORY.md. The RBAC
 * cache it checks `transformations@read` against comes from the global
 * `RbacModule`; both RPC clients from the global `MessagingModule`.
 */
@Module({
  // Saved results are streamed from wherever they were written.
  imports: [StorageModule],
  controllers: [TransformationsController, AdminTransformationsController],
  providers: [TransformationsService],
})
export class TransformationsModule {}
