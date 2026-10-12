import {
  Controller,
  Post,
  Get,
  Headers,
  Body,
  Param,
  Inject,
  UseGuards,
  HttpCode,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentActor } from '../../../identity/adapters/in/auth.guard.js';
import type { TenantActor } from '../../../../shared/domain/context.js';
import { PrismaIntegration } from '../out/prisma-integration.js';
import { PrismaImports } from '../out/prisma-imports.js';
import {
  CatalogBatchDto,
  MovementBatchDto,
  CatalogReportDto,
  SalesReportDto,
  ConnectionDto,
  KeyDto,
  ListQueryDto,
} from '../../../inventory/adapters/in/dtos.js';
import { mapCatalogReport, mapSalesReport } from '../../domain/erp-report.js';
@Controller('integrations')
@ApiTags('Integração ERP')
@ApiBearerAuth('integration')
export class IntegrationController {
  constructor(@Inject(PrismaIntegration) readonly service: PrismaIntegration) {}
  @Post('catalog-batches') @HttpCode(202) async catalog(
    @Headers('authorization') token: string,
    @Body() input: CatalogBatchDto,
  ) {
    return this.service.ingest(
      await this.service.authenticate(token, 'catalog:write'),
      'CATALOG',
      input,
    );
  }
  @Post('movement-batches') @HttpCode(202) async movements(
    @Headers('authorization') token: string,
    @Body() input: MovementBatchDto,
  ) {
    return this.service.ingest(
      await this.service.authenticate(token, 'movements:write'),
      'MOVEMENTS',
      input,
    );
  }
  /**
   * Relatórios no formato da origem (`produtos` + `produtos_ean`, e as linhas de
   * venda). São traduzidos para o contrato canônico antes de entrar na inbox: o que
   * fica persistido é a forma canônica, cuja ordenação determinística faz o mesmo
   * relatório reexportado com as linhas em outra ordem gerar o mesmo hash.
   */
  @Post('reports/catalog') @HttpCode(202) async catalogReport(
    @Headers('authorization') token: string,
    @Body() input: CatalogReportDto,
  ) {
    const actor = await this.service.authenticate(token, 'catalog:write');
    const { batch, issues } = mapCatalogReport(input);
    return { ...(await this.service.ingest(actor, 'CATALOG', batch)), issues };
  }
  @Post('reports/sales') @HttpCode(202) async salesReport(
    @Headers('authorization') token: string,
    @Body() input: SalesReportDto,
  ) {
    const actor = await this.service.authenticate(token, 'movements:write');
    const { batch, issues, mergedRows } = mapSalesReport(input);
    return { ...(await this.service.ingest(actor, 'MOVEMENTS', batch)), issues, mergedRows };
  }
  @Get('batches/:id') async batch(
    @Headers('authorization') token: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.batch(await this.service.authenticate(token, 'batches:read'), id);
  }
}
@Controller()
@ApiTags('Administração de integração')
@ApiBearerAuth()
@UseGuards(AuthGuard)
export class IntegrationAdminController {
  constructor(
    @Inject(PrismaIntegration) readonly service: PrismaIntegration,
    @Inject(PrismaImports) readonly imports: PrismaImports,
  ) {}
  @Get('integration-connections') connections(@CurrentActor() a: TenantActor) {
    return this.service.connections(a);
  }
  @Post('integration-connections') create(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Body() input: ConnectionDto,
  ) {
    return this.service.createConnection(a, key, input.name);
  }
  @Post('integration-connections/:id/deactivate') deactivate(
    @CurrentActor() a: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.revoke(a, id, true);
  }
  @Post('integration-keys') issueKey(@CurrentActor() a: TenantActor, @Body() input: KeyDto) {
    return this.service.createKey(a, input.connectionId, input.scopes);
  }
  @Post('integration-keys/:id/revoke') revoke(
    @CurrentActor() a: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.revoke(a, id);
  }
  @Get('imports') list(@CurrentActor() a: TenantActor, @Query() options: ListQueryDto) {
    return this.imports.list(a, undefined, options);
  }
  @Get('imports/:id') get(@CurrentActor() a: TenantActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.list(a, id);
  }
  @Post('imports/:id/reprocess') reprocess(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.imports.reprocess(a, key, id);
  }
}
