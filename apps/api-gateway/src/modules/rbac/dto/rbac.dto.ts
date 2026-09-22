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
 * Names end up in an access token and in a route declaration, so they are kept
 * to a shape that cannot be confused with the `resource@action` syntax or with
 * a list separator. Mirrors the rule identity-service enforces.
 */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const NAME_MESSAGE =
  'must start with a letter and contain only letters, digits, "_" or "-"';

export class CreateRoleDto {
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

export class UpdateRoleDto {
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

export class CreatePermissionDto {
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

export class UpdatePermissionDto {
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

export class CreateGrantDto {
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

export class UpdateGrantDto {
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

export class AssignUserRolesDto {
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, { each: true, message: `each role ${NAME_MESSAGE}` })
  roles: string[];
}
