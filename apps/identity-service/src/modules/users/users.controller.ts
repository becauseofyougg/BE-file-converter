import { Controller, UseFilters, ValidationPipe } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';

import {
  USERS_PATTERNS,
  type UserProfileRecord,
} from '@contracts/messages/users.messages';
import { RpcAppExceptionFilter } from '@core/errors/rpc-app-exception.filter';
import { settleRpc } from '@core/messaging/rmq-ack';
import { GetUserProfileMessageDto } from './dto/get-profile.dto';
import { ProfileService } from './profile.service';

/** Mirrors the gateway's global pipe — this boundary is validated separately. */
const messageValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

@Controller()
@UseFilters(RpcAppExceptionFilter)
export class UsersController {
  constructor(private readonly profiles: ProfileService) {}

  /**
   * Read-only, so no transaction and no outbox — and a refusal is still a
   * completed handling, acked rather than requeued, since it would fail
   * identically forever.
   */
  @MessagePattern(USERS_PATTERNS.GET_PROFILE)
  async getProfile(
    @Payload(messageValidationPipe) dto: GetUserProfileMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<UserProfileRecord> {
    return settleRpc(context, () =>
      this.profiles.getProfile({
        targetUserId: dto.targetUserId,
        viewerUserId: dto.viewerUserId,
        viewerRoles: dto.viewerRoles,
        correlationId: dto.correlationId,
      }),
    );
  }
}
