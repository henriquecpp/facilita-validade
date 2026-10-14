import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PlatformLoginDto {
  @ApiProperty({ example: 'superadmin' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class PlatformPasswordDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}

export class CreateStoreDto {
  @ApiProperty({
    example: '11.222.333/0001-81',
    description: 'CNPJ da loja, também usado na Pagonet.',
  })
  @IsString()
  @MaxLength(18)
  cnpj!: string;
  @ApiProperty({ example: 'Supermercado Centro' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;
  @ApiProperty({ example: 'admin', description: 'Usuário do proprietário.' })
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  ownerUsername!: string;
}

export class ReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class OwnerAccessDto extends ReasonDto {
  @ApiProperty() @IsUUID() userId!: string;
}

export class HistoryQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
