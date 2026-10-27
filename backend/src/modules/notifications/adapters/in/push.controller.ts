import { Body, Controller, Get, Headers, Inject, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiProperty as A, ApiPropertyOptional as O } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AuthGuard, CurrentActor } from '../../../identity/adapters/in/auth.guard.js';
import type { TenantActor } from '../../../../shared/domain/context.js';
import { PrismaPush } from '../out/prisma-push.js';

export class LevelPushPreferenceDto {
  @A({ format: 'uuid' }) @IsUUID() levelId!: string;
  @A() @IsBoolean() immediate!: boolean;
  @A({ type: Number, nullable: true, minimum: 1, maximum: 24 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  intervalHours!: number | null;
  @A({ type: String, nullable: true, pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
  @IsOptional()
  @IsString()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
  dailyTime!: string | null;
}
export class PushPreferencesDto {
  @A({ minimum: 0 }) @IsInt() @Min(0) expectedVersion!: number;
  @A() @IsBoolean() dailyDigestEnabled!: boolean;
  @A() @IsBoolean() depletedEnabled!: boolean;
  @A({ type: [LevelPushPreferenceDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LevelPushPreferenceDto)
  levels!: LevelPushPreferenceDto[];
}

export class PushSubscriptionDto {
  @A({ enum: ['WEB', 'FCM'] }) @IsIn(['WEB', 'FCM']) kind!: 'WEB' | 'FCM';
  @A({ description: 'Web Push: a URL do serviço de push. FCM: o token do aparelho.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  endpoint!: string;
  @O({ description: 'Chave pública da inscrição Web Push, em base64url.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  p256dh?: string;
  @O({ description: 'Segredo de autenticação da inscrição Web Push, em base64url.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  auth?: string;
}

export class PushEndpointDto {
  @A() @IsString() @MinLength(1) @MaxLength(2000) endpoint!: string;
}

/** Notificações push do proprietário, no painel (Web Push) e no coletor (Firebase). */
@Controller('push')
@ApiTags('Notificações push')
@ApiBearerAuth()
@UseGuards(AuthGuard)
export class PushController {
  constructor(@Inject(PrismaPush) readonly push: PrismaPush) {}
  @Get('config') config(@CurrentActor() a: TenantActor) {
    return this.push.config(a);
  }
  @Get('preferences') preferences(@CurrentActor() a: TenantActor) {
    return this.push.preferences(a);
  }
  @Put('preferences') savePreferences(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Body() input: PushPreferencesDto,
  ) {
    return this.push.savePreferences(a, key, input);
  }
  /** Inscreve este aparelho; só o proprietário recebe push. */
  @Post('subscriptions') subscribe(
    @CurrentActor() a: TenantActor,
    @Body() input: PushSubscriptionDto,
  ) {
    return this.push.subscribe(a, input);
  }
  @Post('subscriptions/remove') unsubscribe(
    @CurrentActor() a: TenantActor,
    @Body() input: PushEndpointDto,
  ) {
    return this.push.unsubscribe(a, input.endpoint);
  }
  @Post('test') test(@CurrentActor() a: TenantActor) {
    return this.push.test(a);
  }
}
