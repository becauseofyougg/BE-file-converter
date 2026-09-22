import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Role and permission names end up in an access token and in a route
 * declaration, so they are restricted to a shape that cannot be confused with
 * the `resource@action` syntax or with a list separator.
 */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const NAME_MESSAGE =
  'must start with a letter and contain only letters, digits, "_" or "-"';

class ActorFields {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;

  /** Stamped by the gateway from the caller's token, for the audit trail. */
  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class CreateRoleMessageDto extends ActorFields {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(NAME_PATTERN, { message: `name ${NAME_MESSAGE}` })
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}

export class UpdateRoleMessageDto extends ActorFields {
  @IsUUID()
  id: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(NAME_PATTERN, { message: `name ${NAME_MESSAGE}` })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}

export class EntityIdMessageDto extends ActorFields {
  @IsUUID()
  id: string;
}

export class CreatePermissionMessageDto extends ActorFields {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(NAME_PATTERN, { message: `name ${NAME_MESSAGE}` })
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, { each: true, message: `each action ${NAME_MESSAGE}` })
  actions: string[];
}

export class UpdatePermissionMessageDto extends ActorFields {
  @IsUUID()
  id: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(NAME_PATTERN, { message: `name ${NAME_MESSAGE}` })
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, { each: true, message: `each action ${NAME_MESSAGE}` })
  actions?: string[];
}

export class CreateGrantMessageDto extends ActorFields {
  @IsUUID()
  roleId: string;

  @IsUUID()
  permissionId: string;

  /** Omitted or empty means every action the permission defines. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, { each: true, message: `each action ${NAME_MESSAGE}` })
  actions?: string[];
}

export class UpdateGrantMessageDto extends ActorFields {
  @IsUUID()
  id: string;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsUUID()
  permissionId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, { each: true, message: `each action ${NAME_MESSAGE}` })
  actions?: string[];
}

export class CheckAccessMessageDto {
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  roles: string[];

  @IsString()
  @MaxLength(64)
  permission: string;

  @IsString()
  @MaxLength(64)
  action: string;
}

export class AssignUserRolesMessageDto extends ActorFields {
  @IsUUID()
  userId: string;

  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, { each: true, message: `each role ${NAME_MESSAGE}` })
  roles: string[];
}

export class UserIdMessageDto {
  @IsUUID()
  userId: string;
}
