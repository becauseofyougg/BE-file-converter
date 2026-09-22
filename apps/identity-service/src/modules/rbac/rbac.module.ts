import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { GrantsService } from './grants.service';
import { PermissionsService } from './permissions.service';
import { RbacConfigService } from './rbac-config.service';
import { RbacController } from './rbac.controller';
import { RolesService } from './roles.service';
import { UserRolesService } from './user-roles.service';

@Module({
  imports: [OutboxModule],
  controllers: [RbacController],
  providers: [
    RbacConfigService,
    RolesService,
    PermissionsService,
    GrantsService,
    UserRolesService,
  ],
  // AuthModule needs UserRolesService: a registration assigns the default role
  // and the token carries the names.
  exports: [RbacConfigService, UserRolesService],
})
export class RbacModule {}
