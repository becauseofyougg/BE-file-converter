import { Module } from '@nestjs/common';

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
  controllers: [TransformationsController, AdminTransformationsController],
  providers: [TransformationsService],
})
export class TransformationsModule {}
