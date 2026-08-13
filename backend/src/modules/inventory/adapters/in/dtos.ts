import { ApiProperty as A, ApiPropertyOptional as O } from '@nestjs/swagger';
import {
  IsUUID,
  IsInt,
  Min,
  Max,
  IsString,
  MaxLength,
  MinLength,
  IsOptional,
  IsBoolean,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsDateString,
  Matches,
  IsIn,
  IsNumber,
  IsUrl,
  ArrayMinSize,
  IsEmail,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
export class VersionDto {
  @A() @IsInt() @Min(1) expectedVersion!: number;
}
export class CreateCountDto {
  @A() @IsUUID() productId!: string;
}
export class CountLineDto {
  @A() @IsUUID() id!: string;
  @A() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) expiresOn!: string;
  @A() @IsInt() @Min(0) @Max(1000000000) quantity!: number;
  @O() @IsOptional() @IsString() @MaxLength(100) lotCode?: string;
  @O() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class LinesDto extends VersionDto {
  @A({ type: [CountLineDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CountLineDto)
  lines!: CountLineDto[];
}
export class ConfirmCountDto extends VersionDto {
  @A() @IsBoolean() completeConfirmed!: boolean;
  @O() @IsOptional() @IsBoolean() emptyConfirmed?: boolean;
}
export class CancelCountDto extends VersionDto {
  @A() @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
export class ReceiptDto {
  @A() @IsUUID() productId!: string;
  @A() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) expiresOn!: string;
  @A() @IsInt() @Min(1) @Max(1000000000) quantity!: number;
  @O() @IsOptional() @IsString() @MaxLength(100) lotCode?: string;
  @O() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class WriteOffDto extends VersionDto {
  @A() @IsInt() @Min(1) @Max(1000000000) quantity!: number;
  @O() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class RecordEditDto extends VersionDto {
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expiresOn?: string;
  @O({ description: 'Nova quantidade lançada do lote.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000000)
  quantity?: number;
}
export class NoteDto extends VersionDto {
  @A() @IsString() @MaxLength(1000) note!: string;
}
export class SettingsDto extends VersionDto {
  @A() @IsString() @MaxLength(100) timezone!: string;
  @O({ type: [String], description: 'Destinatários do resumo diário de alertas; vazio desliga.' })
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : item))
      : value,
  )
  @IsArray()
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true })
  @MaxLength(254, { each: true })
  alertEmails?: string[];
  @O({ description: 'Hora local (0–23) a partir da qual o resumo do dia é enviado.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  digestHour?: number;
  @O({
    description:
      'Não alertar lote que a média de vendas prevê vender antes da validade (exceto os que vencem em até um dia).',
  })
  @IsOptional()
  @IsBoolean()
  salesForecastAlerts?: boolean;
}
export class ConnectionDto {
  @A() @IsString() @MinLength(1) @MaxLength(100) name!: string;
}
/**
 * Token e CNPJ não entram: o token é da aplicação, e o CNPJ é sempre o da loja. Categorias
 * também não: toda loja importa o catálogo inteiro.
 */
export class PagonetSourceDto {
  @A() @IsBoolean() active!: boolean;
}
export class KeyDto {
  @A() @IsUUID() connectionId!: string;
  @A({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(['catalog:write', 'movements:write', 'batches:read'], { each: true })
  scopes!: string[];
}
export class CatalogProductDto {
  @A() @IsString() @MinLength(1) @MaxLength(100) externalProductId!: string;
  @A() @IsString() @MinLength(1) @MaxLength(500) description!: string;
  @A({ type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @MinLength(1, { each: true })
  barcodes!: string[];
  @O() @IsOptional() @IsBoolean() active?: boolean;
  @O()
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  photoUrl?: string;
}
export class MovementDto {
  @A() @IsString() @MinLength(1) @MaxLength(200) externalEventId!: string;
  @A() @IsString() @MinLength(1) @MaxLength(100) externalProductId!: string;
  @A({ enum: ['SALE', 'SCRAP', 'RETURN_RECEIPT', 'VOID_MOVEMENT'] })
  @IsIn(['SALE', 'SCRAP', 'RETURN_RECEIPT', 'VOID_MOVEMENT'])
  type!: 'SALE' | 'SCRAP' | 'RETURN_RECEIPT' | 'VOID_MOVEMENT';
  @A() @IsDateString({ strict: true }) @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/) occurredAt!: string;
  @O() @IsOptional() @IsNumber() quantity?: number;
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expiresOn?: string;
  @O() @IsOptional() @IsString() @MaxLength(100) lotCode?: string;
  @O() @IsOptional() @IsUUID() stockRecordId?: string;
  @O() @IsOptional() @IsString() @MaxLength(200) originalExternalEventId?: string;
}
export class CatalogBatchDto {
  @A() @IsString() @MinLength(1) @MaxLength(200) externalBatchId!: string;
  @A({ type: [CatalogProductDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CatalogProductDto)
  products!: CatalogProductDto[];
}
export class MovementBatchDto {
  @A() @IsString() @MinLength(1) @MaxLength(200) externalBatchId!: string;
  @A({ type: [MovementDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => MovementDto)
  events!: MovementDto[];
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/)
  periodStart?: string;
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/)
  periodEnd?: string;
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/)
  completeThrough?: string;
}
export class ResolveDto {
  @A({ enum: ['CLASSIFY'] }) @IsIn(['CLASSIFY']) action!: string;
  @O() @IsOptional() @IsUUID() recordId?: string;
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expiresOn?: string;
  @O() @IsOptional() @IsString() @MaxLength(100) lotCode?: string;
  @A() @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
/** Busca no catálogo, para escolher um produto pelo nome ou pelo código. */
export class CatalogQueryDto {
  @O() @IsOptional() @IsUUID() cursor?: string;
  @O() @IsOptional() @IsString() @MaxLength(200) search?: string;
}
export class PageQueryDto {
  @O() @IsOptional() @IsUUID() cursor?: string;
  @O({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
export class HistoryQueryDto extends PageQueryDto {
  @O({ description: 'Só as movimentações deste lote.' }) @IsOptional() @IsUUID() recordId?: string;
}
export class ListQueryDto extends PageQueryDto {
  @O() @IsOptional() @IsString() @MaxLength(200) search?: string;
  @O()
  @IsOptional()
  @IsIn([
    'DRAFT',
    'COUNTING',
    'CONFIRMED',
    'CANCELLED',
    'OPEN',
    'RESOLVED',
    'COVERED_BY_COUNT',
    'RECEIVED',
    'PROCESSING',
    'COMPLETED',
    'COMPLETED_WITH_ISSUES',
    'FAILED',
  ])
  status?: string;
}

export class CountListQueryDto extends ListQueryDto {
  @O() @IsOptional() @IsUUID() productId?: string;
}

const UUID_OR_NONE = /^(?:NONE|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;

export class ExpiryQueryDto extends PageQueryDto {
  @O({ description: 'Só um nível de urgência da loja, ou NONE para os lotes fora de todos.' })
  @IsOptional()
  @Matches(UUID_OR_NONE)
  levelId?: string;
  @O({ description: 'true: só os lotes nos níveis que avisam.', enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  notify?: 'true' | 'false';
}

export class ProductQueryDto extends PageQueryDto {
  @O({ description: 'Nome ou código de barras.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
  @O({ enum: ['TRACKED', 'UNTRACKED'] })
  @IsOptional()
  @IsIn(['TRACKED', 'UNTRACKED'])
  trackingStatus?: 'TRACKED' | 'UNTRACKED';
  @O({ description: 'Grupo do ERP (529) ou grupo e categoria (529/889).' })
  @IsOptional()
  @Matches(/^\d{1,9}(\/\d{1,9})?$/)
  category?: string;
}

export class NotificationQueryDto extends PageQueryDto {
  @O({ enum: ['EXPIRY', 'DEPLETED'] })
  @IsOptional()
  @IsIn(['EXPIRY', 'DEPLETED'])
  type?: 'EXPIRY' | 'DEPLETED';
  @O({ description: 'Só os alertas de validade de um nível da loja.' })
  @IsOptional()
  @IsUUID()
  levelId?: string;
}

export class ExpiryLevelDto {
  @O({ description: 'Nível já existente; ausente cria um nível novo.' })
  @IsOptional()
  @IsUUID()
  id?: string;
  @A() @IsString() @MinLength(1) @MaxLength(40) name!: string;
  @O({
    type: Number,
    nullable: true,
    description:
      'Legado: aceito por compatibilidade, mas o servidor deriva o início pela ordem dos limites.',
  })
  @IsOptional()
  @IsInt()
  @Min(-36500)
  @Max(36501)
  minDays?: number | null;
  @O({
    type: Number,
    nullable: true,
    description:
      'Limite de dias do nível; negativo é vencido. Um único nível pode ficar sem limite.',
  })
  @IsOptional()
  @IsInt()
  @Min(-36500)
  @Max(36500)
  maxDays?: number | null;
  @A() @Matches(/^#[\da-fA-F]{6}$/) color!: string;
  @A({ description: 'Entra no resumo diário e nas notificações.' }) @IsBoolean() notify!: boolean;
}

export class ExpiryLevelsDto extends VersionDto {
  @A({ type: [ExpiryLevelDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ExpiryLevelDto)
  levels!: ExpiryLevelDto[];
}

/**
 * Formato nativo dos relatórios da origem. O adapter traduz para o contrato
 * canônico; ver `docs/especificacao-estoque.md`, seção 5.
 */
export class ProdutoRowDto {
  @O() @IsOptional() @IsString() @MaxLength(100) codprod?: string;
  @A() @IsString() @MinLength(1) @MaxLength(100) codformavenda!: string;
  @A() @IsString() @MinLength(1) @MaxLength(500) descricao!: string;
}

export class ProdutoEanRowDto {
  @A() @IsString() @MinLength(1) @MaxLength(100) codformavenda!: string;
  @A() @IsString() @MinLength(1) @MaxLength(100) ean!: string;
}

export class CatalogReportDto {
  @A() @IsString() @MinLength(1) @MaxLength(200) externalBatchId!: string;
  @A({ type: [ProdutoRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ProdutoRowDto)
  produtos!: ProdutoRowDto[];
  @O({ type: [ProdutoEanRowDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50000)
  @ValidateNested({ each: true })
  @Type(() => ProdutoEanRowDto)
  produtosEan?: ProdutoEanRowDto[];
}

export class VendaRowDto {
  @A() @IsDateString({ strict: true }) @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/) dataHora!: string;
  @O() @IsOptional() @IsString() @MaxLength(100) codprod?: string;
  @A() @IsString() @MinLength(1) @MaxLength(100) codformavenda!: string;
  @A() @IsNumber() quantidade!: number;
}

export class SalesReportDto {
  @A() @IsString() @MinLength(1) @MaxLength(200) externalBatchId!: string;
  @A({ type: [VendaRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => VendaRowDto)
  vendas!: VendaRowDto[];
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/)
  periodStart?: string;
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/)
  periodEnd?: string;
  @O()
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.+(?:Z|[+-]\d{2}:\d{2})$/)
  completeThrough?: string;
}
