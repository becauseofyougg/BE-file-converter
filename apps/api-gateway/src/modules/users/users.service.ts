import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  USERS_PATTERNS,
  type GetUserProfileRequest,
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
