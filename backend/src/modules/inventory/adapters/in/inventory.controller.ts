import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Headers,
  Inject,
  UseGuards,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentActor } from '../../../identity/adapters/in/auth.guard.js';
import { requireRole, type TenantActor } from '../../../../shared/domain/context.js';
import { InventoryService } from '../../application/inventory-service.js';
import { PrismaInventory } from '../out/prisma-inventory.js';
import { PrismaCatalog } from '../../../catalog/adapters/out/prisma-catalog.js';
import {
  CreateCountDto,
  LinesDto,
  ConfirmCountDto,
  CancelCountDto,
  ReceiptDto,
  NoteDto,
  WriteOffDto,
  RecordEditDto,
  VersionDto,
  CatalogQueryDto,
  HistoryQueryDto,
  ResolveDto,
  ListQueryDto,
  PageQueryDto,
  CountListQueryDto,
  ExpiryQueryDto,
  ProductQueryDto,
} from './dtos.js';
@Controller()
@ApiTags('Estoque')
@ApiBearerAuth()
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(
    @Inject(InventoryService) readonly service: InventoryService,
    @Inject(PrismaInventory) readonly inventory: PrismaInventory,
    @Inject(PrismaCatalog) readonly catalog: PrismaCatalog,
  ) {}
  @Get('products') products(@CurrentActor() a: TenantActor, @Query() query: CatalogQueryDto) {
    return this.catalog.list(a.storeId, query.search, query.cursor);
  }
  @Get('products/by-barcode/:barcode') barcode(
    @CurrentActor() a: TenantActor,
    @Param('barcode') barcode: string,
  ) {
    return this.catalog.find(a.storeId, barcode, true);
  }
  @Get('products/:id') product(
    @CurrentActor() a: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.find(a.storeId, id);
  }
  /** Grupos e categorias do ERP com produtos na loja, para o filtro da lista de produtos. */
  @Get('products/categories') categories(@CurrentActor() a: TenantActor) {
    return this.inventory.categories(a.storeId);
  }
  @Get('inventory') list(@CurrentActor() a: TenantActor, @Query() options: ProductQueryDto) {
    return this.inventory.list(a.storeId, options);
  }
  /** Validades com saldo positivo, da mais próxima de vencer para a mais distante. */
  @Get('inventory/expiries') expiries(
    @CurrentActor() a: TenantActor,
    @Query() options: ExpiryQueryDto,
  ) {
    return this.inventory.expiries(a.storeId, { ...options, notify: options.notify === 'true' });
  }
  /** Lotes e unidades em cada faixa de validade, para as abas da tela de validades. */
  @Get('inventory/expiries/summary') expirySummary(@CurrentActor() a: TenantActor) {
    return this.inventory.expirySummary(a.storeId);
  }
  @Get('inventory/products/:id') detail(
    @CurrentActor() a: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventory.detail(a.storeId, id);
  }
  @Get('inventory/products/:id/history') history(
    @CurrentActor() a: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() options: HistoryQueryDto,
  ) {
    return this.inventory.history(a.storeId, id, options);
  }
  /** Lotes baixados, excluídos e substituídos por contagem, do mais recente ao mais antigo. */
  @Get('inventory/products/:id/closed-records') closedRecords(
    @CurrentActor() a: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() options: PageQueryDto,
  ) {
    return this.inventory.closedRecords(a.storeId, id, options);
  }
  @Post('inventory/receipts') receive(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Body() input: ReceiptDto,
  ) {
    return this.service.receive(a, key, input);
  }
  @Patch('inventory/records/:id/metadata') metadata(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: NoteDto,
  ) {
    return this.inventory.metadata(a, key, id, input.expectedVersion, input.note);
  }
  @Post('inventory/records/:id/write-off') writeOff(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: WriteOffDto,
  ) {
    return this.service.writeOff(a, key, id, input);
  }
  @Post('inventory/records/:id/delete') deleteRecord(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: VersionDto,
  ) {
    return this.service.deleteRecord(a, key, id, input.expectedVersion);
  }
  @Patch('inventory/records/:id') editRecord(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: RecordEditDto,
  ) {
    return this.service.editRecord(a, key, id, input);
  }
  @Get('count-sessions') counts(
    @CurrentActor() a: TenantActor,
    @Query() options: CountListQueryDto,
  ) {
    return this.inventory.counts(a.storeId, options);
  }
  @Get('count-sessions/:id') count(
    @CurrentActor() a: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventory.count(a.storeId, id);
  }
  @Post('count-sessions') create(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Body() input: CreateCountDto,
  ) {
    return this.service.createCount(a, key, input.productId);
  }
  @Put('count-sessions/:id/lines') lines(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: LinesDto,
  ) {
    return this.service.updateCount(a, key, id, { ...input, type: 'lines' });
  }
  @Post('count-sessions/:id/confirm') confirm(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ConfirmCountDto,
  ) {
    return this.service.updateCount(a, key, id, { ...input, type: 'confirm' });
  }
  @Post('count-sessions/:id/cancel') cancel(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CancelCountDto,
  ) {
    return this.service.updateCount(a, key, id, { ...input, type: 'cancel' });
  }
  @Get('reconciliation-issues') issues(
    @CurrentActor() a: TenantActor,
    @Query() options: ListQueryDto,
  ) {
    return this.inventory.issues(a.storeId, options);
  }
  @Post('reconciliation-issues/:id/resolve') resolve(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ResolveDto,
  ) {
    requireRole(a, ['OWNER', 'MANAGER']);
    return this.inventory.resolve(a, key, id, input);
  }
}
