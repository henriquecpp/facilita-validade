import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Role } from '../../../../shared/domain/context.js';

export class LoginDto {
  @ApiProperty({ example: '11.222.333/0001-81' }) @IsString() @MaxLength(32) cnpj!: string;
  @ApiProperty({ example: 'admin' }) @IsString() @MinLength(1) @MaxLength(64) username!: string;
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
export class RefreshDto {
  @ApiProperty() @IsString() @MaxLength(128) refreshToken!: string;
}
export class LogoutDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) refreshToken?: string;
}
export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(128) currentPassword!: string;
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}
export class CompletePasswordResetDto {
  @ApiProperty() @IsString() @MaxLength(128) token!: string;
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}
export class CreateUserDto {
  @ApiProperty({ minLength: 3, maxLength: 64 })
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username!: string;
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  temporaryPassword!: string;
  @ApiProperty({ enum: ['OWNER', 'MANAGER', 'OPERATOR'] })
  @IsIn(['OWNER', 'MANAGER', 'OPERATOR'])
  role!: Role;
}
export class UpdateUserDto {
  @ApiProperty() @IsInt() @Min(1) @Max(2147483647) expectedVersion!: number;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username?: string;
  @ApiPropertyOptional({ enum: ['OWNER', 'MANAGER', 'OPERATOR'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['OWNER', 'MANAGER', 'OPERATOR'])
  role?: Role;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}
export class IssuePairingDto {
  @ApiProperty({ description: 'Operador que vai entrar no coletor.' }) @IsUUID() userId!: string;
}
export class RedeemPairingDto {
  @ApiProperty({ description: 'Conteúdo lido do QR gerado no painel.' })
  @IsString()
  @MaxLength(128)
  code!: string;
}
