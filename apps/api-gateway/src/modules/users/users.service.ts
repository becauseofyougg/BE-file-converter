import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  USERS_PATTERNS,
  type ConfirmDeletionRequest,
  type ConfirmDeletionResponse,
  type DeleteUserRequest,
  type DeleteUserResponse,
  type ListUsersRequest,
  type ListUsersResponse,
  type UserListItem,
  type UserListItemRecord,
  type ConfirmEmailChangeRequest,
  type ConfirmEmailChangeResponse,
  type GetUserProfileRequest,
  type StartEmailChangeRequest,
  type StartEmailChangeResponse,
  type UpdateUserProfileRequest,
  type UserProfile,
  type UserProfileRecord,
} from '@contracts/messages/users.messages';
import { StorageService } from '@storage/storage.service';
import { IDENTITY_CLIENT } from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';

/**
 * Where a profile photo lives. The `uploads` bucket rather than a third one of
 * its own: a private bucket and a presigned read is the same story the
 * conversion inputs already tell, and a new bucket would mean new config, a new
 * compose volume and a new thing to create on deploy for no separation that the
 * key prefix does not already give.
 */
export const PROFILE_PHOTO_BUCKET = 'uploads' as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: ClientProxy,
    private readonly storage: StorageService,
  ) {}

  async getProfile(input: GetUserProfileRequest): Promise<UserProfile> {
    const record = await sendRpc<UserProfileRecord, Record<string, unknown>>(
      this.identity,
      USERS_PATTERNS.GET_PROFILE,
      { ...input },
    );

    return this.toPublicProfile(record);
  }

  /**
   * One page of the admin list. Each item's photo key becomes a presigned URL,
   * the same swap the single-profile read makes — and the same reason the two
   * field names differ.
   */
  async listUsers(
    input: ListUsersRequest,
  ): Promise<ListUsersResponse<UserListItem>> {
    const page = await sendRpc<
      ListUsersResponse<UserListItemRecord>,
      Record<string, unknown>
    >(this.identity, USERS_PATTERNS.LIST_USERS, { ...input });

    return {
      items: await Promise.all(
        page.items.map(async ({ photoKey, ...rest }) => ({
          ...rest,
          photo: await this.presignPhoto(photoKey),
        })),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async updateProfile(input: UpdateUserProfileRequest): Promise<UserProfile> {
    const record = await sendRpc<UserProfileRecord, Record<string, unknown>>(
      this.identity,
      USERS_PATTERNS.UPDATE_PROFILE,
      { ...input },
    );

    return this.toPublicProfile(record);
  }

  startEmailChange(
    input: StartEmailChangeRequest,
  ): Promise<StartEmailChangeResponse> {
    return sendRpc<StartEmailChangeResponse, Record<string, unknown>>(
      this.identity,
      USERS_PATTERNS.START_EMAIL_CHANGE,
      { ...input },
    );
  }

  confirmEmailChange(
    input: ConfirmEmailChangeRequest,
  ): Promise<ConfirmEmailChangeResponse> {
    return sendRpc<ConfirmEmailChangeResponse, Record<string, unknown>>(
      this.identity,
      USERS_PATTERNS.CONFIRM_EMAIL_CHANGE,
      { ...input },
    );
  }

  deleteUser(input: DeleteUserRequest): Promise<DeleteUserResponse> {
    return sendRpc<DeleteUserResponse, Record<string, unknown>>(
      this.identity,
      USERS_PATTERNS.DELETE_USER,
      { ...input },
    );
  }

  confirmDeletion(
    input: ConfirmDeletionRequest,
  ): Promise<ConfirmDeletionResponse> {
    return sendRpc<ConfirmDeletionResponse, Record<string, unknown>>(
      this.identity,
      USERS_PATTERNS.CONFIRM_DELETION,
      { ...input },
    );
  }

  /**
   * Swaps the storage key identity returned for a short-lived presigned URL.
   *
   * Spread first, then overwrite: whatever identity chose to withhold stays
   * withheld, since this only ever renames a field the field policy already
   * allowed through.
   */
  private async toPublicProfile(
    record: UserProfileRecord,
  ): Promise<UserProfile> {
    const { photoKey, ...rest } = record;

    if (photoKey === undefined) {
      return rest;
    }

    return { ...rest, photo: await this.presignPhoto(photoKey) };
  }

  private async presignPhoto(key: string | null): Promise<string | null> {
    if (!key) {
      return null;
    }

    try {
      return await this.storage.presignGet(PROFILE_PHOTO_BUCKET, key);
    } catch (error) {
      // A profile is still worth serving without its picture. Failing the
      // whole read because object storage is unhappy would take the account
      // page down over an avatar.
      this.logger.warn({
        event: 'users.profile.photo_presign_failed',
        reason: error instanceof Error ? error.message : 'unknown',
      });

      return null;
    }
  }
}
