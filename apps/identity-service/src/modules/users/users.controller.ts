import { Controller, UseFilters, ValidationPipe } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';

import {
  USERS_PATTERNS,
  type ConfirmEmailChangeResponse,
  type StartEmailChangeResponse,
  type UserProfileRecord,
} from '@contracts/messages/users.messages';
import { RpcAppExceptionFilter } from '@core/errors/rpc-app-exception.filter';
import { settleRpc } from '@core/messaging/rmq-ack';
import { GetUserProfileMessageDto } from './dto/get-profile.dto';
import {
  ConfirmEmailChangeMessageDto,
  StartEmailChangeMessageDto,
  UpdateUserProfileMessageDto,
} from './dto/update-profile.dto';
import { EmailChangeService } from './email-change.service';
import { ProfileUpdateService } from './profile-update.service';
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
  constructor(
    private readonly profiles: ProfileService,
    private readonly updates: ProfileUpdateService,
    private readonly emailChange: EmailChangeService,
  ) {}

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

  @MessagePattern(USERS_PATTERNS.UPDATE_PROFILE)
  async updateProfile(
    @Payload(messageValidationPipe) dto: UpdateUserProfileMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<UserProfileRecord> {
    return settleRpc(context, () =>
      this.updates.updateProfile({
        targetUserId: dto.targetUserId,
        viewerUserId: dto.viewerUserId,
        viewerRoles: dto.viewerRoles,
        patch: dto.patch,
        correlationId: dto.correlationId,
      }),
    );
  }

  @MessagePattern(USERS_PATTERNS.START_EMAIL_CHANGE)
  async startEmailChange(
    @Payload(messageValidationPipe) dto: StartEmailChangeMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<StartEmailChangeResponse> {
    return settleRpc(context, () =>
      this.emailChange.start({
        targetUserId: dto.targetUserId,
        viewerUserId: dto.viewerUserId,
        newEmail: dto.newEmail,
        correlationId: dto.correlationId,
      }),
    );
  }

  @MessagePattern(USERS_PATTERNS.CONFIRM_EMAIL_CHANGE)
  async confirmEmailChange(
    @Payload(messageValidationPipe) dto: ConfirmEmailChangeMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ConfirmEmailChangeResponse> {
    return settleRpc(context, () =>
      this.emailChange.confirm({
        targetUserId: dto.targetUserId,
        challengeId: dto.challengeId,
        code: dto.code,
        token: dto.token,
        correlationId: dto.correlationId,
      }),
    );
  }
}
