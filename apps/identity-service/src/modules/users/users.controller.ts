import { Controller, UseFilters, ValidationPipe } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';

import {
  USERS_PATTERNS,
  type ConfirmDeletionResponse,
  type ConfirmEmailChangeResponse,
  type DeleteUserResponse,
  type ListUsersResponse,
  type StartEmailChangeResponse,
  type UserListItemRecord,
  type UserProfileRecord,
} from '@contracts/messages/users.messages';
import { RpcAppExceptionFilter } from '@core/errors/rpc-app-exception.filter';
import { settleRpc } from '@core/messaging/rmq-ack';
import { AccountDeletionService } from './account-deletion.service';
import {
  ConfirmDeletionMessageDto,
  DeleteUserMessageDto,
} from './dto/delete-user.dto';
import { GetUserProfileMessageDto } from './dto/get-profile.dto';
import { ListUsersMessageDto } from './dto/list-users.dto';
import { UserListService } from './user-list.service';
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
    private readonly deletion: AccountDeletionService,
    private readonly list: UserListService,
  ) {}

  /** Read-only, so no transaction and no outbox — docs/USER-LIST.md. */
  @MessagePattern(USERS_PATTERNS.LIST_USERS)
  async listUsers(
    @Payload(messageValidationPipe) dto: ListUsersMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ListUsersResponse<UserListItemRecord>> {
    return settleRpc(context, () =>
      this.list.listUsers({
        viewerUserId: dto.viewerUserId,
        viewerRoles: dto.viewerRoles,
        cursor: dto.cursor,
        limit: dto.limit,
        q: dto.q,
        status: dto.status,
        sort: dto.sort,
        order: dto.order,
        correlationId: dto.correlationId,
      }),
    );
  }

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

  @MessagePattern(USERS_PATTERNS.DELETE_USER)
  async deleteUser(
    @Payload(messageValidationPipe) dto: DeleteUserMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<DeleteUserResponse> {
    return settleRpc(context, () =>
      this.deletion.requestDeletion({
        targetUserId: dto.targetUserId,
        viewerUserId: dto.viewerUserId,
        viewerRoles: dto.viewerRoles,
        reason: dto.reason,
        correlationId: dto.correlationId,
      }),
    );
  }

  @MessagePattern(USERS_PATTERNS.CONFIRM_DELETION)
  async confirmDeletion(
    @Payload(messageValidationPipe) dto: ConfirmDeletionMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ConfirmDeletionResponse> {
    return settleRpc(context, () =>
      this.deletion.confirmDeletion({
        targetUserId: dto.targetUserId,
        viewerUserId: dto.viewerUserId,
        challengeId: dto.challengeId,
        code: dto.code,
        token: dto.token,
        correlationId: dto.correlationId,
      }),
    );
  }
}
