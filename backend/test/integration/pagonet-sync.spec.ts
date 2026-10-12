import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { PagonetClient } from '../../src/modules/integration/adapters/out/pagonet-client.js';
import { PagonetSync } from '../../src/modules/integration/adapters/out/pagonet-sync.js';
import { localClock, localInstant } from '../../src/modules/integration/domain/pagonet.js';
import { PrismaDigests } from '../../src/modules/notifications/adapters/out/prisma-digests.js';
import { testCnpj } from '../support/cnpj.js';

const TOKEN = 'pagonet-token-de-teste-0123';
const ZONE = 'America/Sao_Paulo';

/** Bridge da Pagonet falsa, com as rotas do Facilita Validade e respostas no formato real. */
function fakeBridge() {
  const state = {
    token: TOKEN,
    produtos: [
      {
        codprod: '1678',
        codformavenda: '1678',
        descricao: 'ACTIVIA IOGURTE 400G AMEIXA',
        descricao_venda: 'ACTIVIA IOGURTE 400G AMEIXA',
        ativo: '1',
        codgrupo: '529',
        codcategoria: '889',
        preco_custo: 1,
        preco_venda: 2,
        estoque_deposito: 0,
        estoque_gondola: 0,
      },
      {
        codprod: '1678',
        codformavenda: '1004775',
        descricao: 'ACTIVIA IOGURTE 400G AMEIXA',
        descricao_venda: 'OFERTA_ACTIVIA IOGURTE 400G AMEIXA',
        ativo: '1',
        codgrupo: '529',
        codcategoria: '889',
        preco_custo: 1,
        preco_venda: 2,
        estoque_deposito: 0,
        estoque_gondola: 0,
      },
      {
        codprod: '5',
        codformavenda: '5',
        descricao: 'OSSO BUCO BOVINO KG',
        descricao_venda: 'OSSO BUCO BOVINO KG',
        ativo: '1',
        codgrupo: '501',
        codcategoria: '838',
        preco_custo: 1,
        preco_venda: 2,
        estoque_deposito: 0,
        estoque_gondola: 0,
      },
    ],
    codigos: [
      { codformavenda: '1678', codigo_barras: '7891025103233', principal: true },
      { codformavenda: '1004775', codigo_barras: '5901234130202', principal: false },
      { codformavenda: '5', codigo_barras: '0418', principal: true },
    ],
    vendas: new Map<string, unknown[]>(),
    calls: [] as string[],
    /** CNPJ pedido em cada chamada de dados: a Bridge devolve os dados dele. */
    cnpjs: [] as string[],
  };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      state.calls.push(path);
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.headers.authorization !== `Bearer ${state.token}`)
        return send(401, { statusCode: 401, message: 'Invalid or expired token' });
      if (path === '/facilita-validade/status')
        return send(200, { status: 'ok', user: { id: 'u', name: 'Teste', role: 'standard' } });
      state.cnpjs.push(JSON.parse(body || '{}').cnpj);
      if (path === '/facilita-validade/produtos') return send(201, state.produtos);
      if (path === '/facilita-validade/codigos-barras') return send(201, state.codigos);
      if (path === '/facilita-validade/vendas')
        return send(201, state.vendas.get(JSON.parse(body).data) ?? []);
      send(404, { statusCode: 404, message: `Cannot ${request.method} ${path}` });
    });
  });
  return { state, server };
}

describe('Importação pela Pagonet (Facilita Validade)', () => {
  const storeId = randomUUID(),
    ownerId = randomUUID(),
    cnpj = testCnpj();
  const password = 'TestePagonet!2026';
  const bridge = fakeBridge();
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>, token: string;
  let productId: string, bridgeUrl: string;

  async function call(path: string, method: InjectOptions['method'] = 'GET', body?: unknown) {
    return ctx.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  }
  async function ok<T>(path: string, method: InjectOptions['method'] = 'GET', body?: unknown) {
    const response = await call(path, method, body);
    expect(response.statusCode, `${method} ${path}: ${response.body}`).toBeLessThan(300);
    return response.json() as T;
  }
  /** O que o worker faria: processa os lotes recebidos, na ordem de chegada. */
  async function processBatches() {
    const { rows } = await admin.query<{ id: string }>(
      "SELECT id FROM import_batches WHERE store_id=$1 AND status='RECEIVED' ORDER BY created_at",
      [storeId],
    );
    for (const row of rows) await ctx.integration.process(storeId, row.id);
    return rows.length;
  }
  /** Os testes não esperam 5 minutos entre uma leitura e outra. */
  async function openWindow() {
    await admin.query(
      'UPDATE pagonet_sources SET catalog_attempted_at=NULL, sales_attempted_at=NULL WHERE store_id=$1',
      [storeId],
    );
  }
  async function dbNow() {
    return new Date(
      (await admin.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now,
    );
  }
  const balance = async () =>
    (await ok<{ totalQuantity: number }>(`/inventory/products/${productId}`)).totalQuantity;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja Pagonet')", [
      storeId,
      cnpj,
    ]);
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'dono','dono',$3,'OWNER',false)",
      [
        ownerId,
        storeId,
        await hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      ],
    );
    await new Promise<void>((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
    bridgeUrl = url;
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({
      jobs,
      jwtSecret: 'test-pagonet-secret-at-least-thirty-two-bytes',
      notificationChannels: [],
      pagonet: (prisma, queue, integration) =>
        new PagonetSync(prisma, queue, integration, new PagonetClient(url, 10_000), TOKEN),
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj, username: 'dono', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    token = login.json().accessToken;
  });

  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    if (admin) {
      await admin.query("DELETE FROM pgboss.job WHERE data->>'storeId'=$1", [storeId]);
      await admin.query('UPDATE product_inventory SET epoch_id=NULL WHERE store_id=$1', [storeId]);
      for (const table of [
        'notification_reads',
        'notifications',
        'movement_allocations',
        'stock_projections',
        'projection_runs',
        'movement_resolutions',
        'reconciliation_issues',
        'stock_movements',
        'integration_events',
        'import_batches',
        'stock_records',
        'inventory_epochs',
        'count_lines',
        'count_sessions',
        'product_inventory',
        'product_barcodes',
        'products',
        'pagonet_sources',
        'integration_keys',
        'integration_connections',
        'command_receipts',
        'audit_events',
        'refresh_tokens',
        'push_subscriptions',
        'auth_sessions',
        'store_users',
        'expiry_levels',
        'store_settings',
      ])
        await admin.query(`DELETE FROM ${table} WHERE store_id=$1`, [storeId]);
      await admin.query('DELETE FROM stores WHERE id=$1', [storeId]);
      await admin.end();
    }
    await ctx?.prisma.close();
    await ctx?.database.close();
  });

  it('lê só o CNPJ da própria loja, com o token da aplicação, e o catálogo inteiro', async () => {
    // CNPJ, token e categorias deixaram de ser da loja: a API recusa os campos.
    for (const extra of [
      { cnpj: '37.466.214/0001-68' },
      { token: TOKEN },
      { categories: ['529/889'] },
    ]) {
      const refused = await call('/pagonet-source', 'POST', { ...extra, active: true });
      expect(refused.statusCode, refused.body).toBe(400);
    }

    const saved = await ok<{ cnpj: string; available: boolean }>('/pagonet-source', 'POST', {
      active: true,
    });
    expect(saved).toMatchObject({ configured: true, cnpj, available: true });
    expect(saved).not.toHaveProperty('categories');

    await ctx.pagonet.syncCatalog(storeId);
    // O catálogo é gravado direto, sem lote de importação.
    expect(await processBatches()).toBe(0);
    // Catálogo e códigos pedidos com o CNPJ da loja, nunca outro.
    expect(bridge.state.cnpjs).toEqual([cnpj, cnpj]);
    const product = await ok<{ id: string; description: string; active: boolean }>(
      '/products/by-barcode/7891025103233',
    );
    expect(product).toMatchObject({ description: 'ACTIVIA IOGURTE 400G AMEIXA', active: true });
    productId = product.id;
    expect((await call('/products/by-barcode/5901234130202')).statusCode).toBe(200);
    // O catálogo inteiro: o osso buco, de outra categoria, também entra.
    expect((await call('/products/by-barcode/0418')).statusCode).toBe(200);
    // Todos os campos do cadastro ficam no produto.
    const stored = await admin.query<{
      erp_group: string;
      erp_category: string;
      sale_price: string;
      cost: number;
    }>(
      "SELECT erp_group, erp_category, sale_price, (erp_attributes->>'preco_custo')::numeric AS cost FROM products WHERE store_id=$1 AND external_product_id='5'",
      [storeId],
    );
    expect(stored.rows[0]).toMatchObject({
      erp_group: '501',
      erp_category: '838',
      sale_price: '2.00',
    });
    expect(Number(stored.rows[0]!.cost)).toBe(1);
    // Grupos e categorias para o filtro da lista de produtos.
    expect(await ok('/products/categories')).toEqual({
      items: [
        { code: '501/838', products: 1 },
        { code: '529/889', products: 2 },
      ],
    });
    const filtered = await ok<{ items: { productName: string; category: string }[] }>(
      '/inventory?category=529/889',
    );
    expect(filtered.items.map((item) => item.category)).toEqual(['529/889', '529/889']);

    // Ler um código desconhecido pede um catálogo novo, mas não logo depois de uma leitura:
    // no máximo a cada 10 minutos.
    const pending = async () =>
      (
        await admin.query<{ pending: boolean }>(
          'SELECT coalesce(catalog_requested_at > catalog_synced_at, false) AS pending FROM pagonet_sources WHERE store_id=$1',
          [storeId],
        )
      ).rows[0]!.pending;
    expect((await call('/products/by-barcode/0000000000')).statusCode).toBe(404);
    expect(await pending()).toBe(false);
    await admin.query(
      "UPDATE pagonet_sources SET catalog_synced_at=catalog_synced_at - interval '11 minutes', catalog_requested_at=NULL WHERE store_id=$1",
      [storeId],
    );
    expect(await pending()).toBe(false);
    // EAN-13 com o último dígito errado nem é procurado: não pede catálogo novo.
    expect((await call('/products/by-barcode/7891025103234')).statusCode).toBe(422);
    expect(await pending()).toBe(false);
    expect((await call('/products/by-barcode/0000000000')).statusCode).toBe(404);
    expect(await pending()).toBe(true);

    // Dentro da janela de 5 minutos, nenhuma chamada nova à Pagonet.
    const calls = bridge.state.calls.length;
    await ctx.pagonet.syncCatalog(storeId);
    expect(bridge.state.calls.length).toBe(calls);
    // Catálogo igual ao anterior: lido, mas nenhum produto é gravado de novo.
    await openWindow();
    const before = await admin.query<{ xmin: string }>(
      'SELECT xmin::text FROM products WHERE store_id=$1 ORDER BY id',
      [storeId],
    );
    await ctx.pagonet.syncCatalog(storeId);
    expect(bridge.state.calls.length).toBe(calls + 2);
    expect(
      (
        await admin.query('SELECT xmin::text FROM products WHERE store_id=$1 ORDER BY id', [
          storeId,
        ])
      ).rows,
    ).toEqual(before.rows);

    // Só o produto que mudou é gravado.
    bridge.state.produtos[2] = { ...bridge.state.produtos[2]!, preco_venda: 3.5 };
    await openWindow();
    await ctx.pagonet.syncCatalog(storeId);
    const changed = await admin.query<{ sale_price: string }>(
      "SELECT sale_price FROM products WHERE store_id=$1 AND external_product_id='5'",
      [storeId],
    );
    expect(changed.rows[0]!.sale_price).toBe('3.50');

    expect(await ok('/pagonet-source')).toMatchObject({
      configured: true,
      catalogProducts: 3,
      lastError: null,
      available: true,
    });
  });

  it('leitura interrompida antes dos códigos é refeita na seguinte, com os códigos', async () => {
    // Código novo no osso buco: o produto mudou e é gravado de novo. O worker cai entre os
    // produtos e os códigos, como num reinício no meio da leitura.
    bridge.state.codigos.push({
      codformavenda: '5',
      codigo_barras: '2000000000053',
      principal: false,
    });
    const crash = vi
      .spyOn(ctx.integration, 'addBarcodes')
      .mockRejectedValueOnce(new Error('worker reiniciado'));
    await openWindow();
    await expect(ctx.pagonet.syncCatalog(storeId)).rejects.toThrow('worker reiniciado');
    crash.mockRestore();
    expect((await call('/products/by-barcode/2000000000053')).statusCode).toBe(404);
    // O produto ficou sem o resumo: a leitura seguinte não o pula e grava o código.
    await openWindow();
    await ctx.pagonet.syncCatalog(storeId);
    expect((await call('/products/by-barcode/2000000000053')).statusCode).toBe(200);
    expect((await call('/products/by-barcode/0418')).statusCode).toBe(200);
    const missing = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM products WHERE store_id=$1 AND erp_hash IS NULL',
      [storeId],
    );
    expect(missing.rows[0]!.count).toBe(0);
    expect(await ok('/pagonet-source')).toMatchObject({ lastError: null });
  });

  it('o botão Forçar lê o catálogo e as vendas já, ou diz quando começa', async () => {
    await admin.query(
      'UPDATE pagonet_sources SET catalog_attempted_at=clock_timestamp() WHERE store_id=$1',
      [storeId],
    );
    type View = {
      syncRequestedAt: string | null;
      syncRunning: boolean;
      syncStartsAt: string | null;
    };
    const queued = await ok<View>('/pagonet-source/sync', 'POST');
    expect(queued.syncRequestedAt).not.toBeNull();
    expect(queued.syncRunning).toBe(false);
    // A rota acabou de ser chamada: a leitura espera a janela de 5 minutos.
    expect(Date.parse(queued.syncStartsAt!)).toBeGreaterThan(Date.now() + 4 * 60_000);
    await openWindow();
    await ctx.pagonet.cycle(storeId);
    // Fechar ontem não conclui o pedido: hoje ainda precisa ser consultado.
    expect(await ok('/pagonet-source')).toMatchObject({
      syncRequestedAt: queued.syncRequestedAt,
      syncRunning: false,
      salesDelayed: false,
    });
    await openWindow();
    const send = vi.spyOn(jobs, 'send');
    await ctx.pagonet.schedule(storeId);
    expect(send.mock.calls.some((args) => args[2] === 'pagonet.sales')).toBe(true);
    send.mockRestore();
    await ctx.pagonet.syncSales(storeId);
    expect(await ok<View>('/pagonet-source')).toMatchObject({
      syncRequestedAt: null,
      syncRunning: false,
      syncStartsAt: null,
    });
  });

  it('baixa as vendas posteriores à contagem e cancela a que sumiu da origem', async () => {
    const expiresOn = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    let session = await ok<{ id: string; version: number }>('/count-sessions', 'POST', {
      productId,
    });
    session = await ok(`/count-sessions/${session.id}/lines`, 'PUT', {
      expectedVersion: session.version,
      lines: [{ id: randomUUID(), expiresOn, quantity: 10 }],
    });
    const confirmed = await ok<{ cutoffAt: string }>(
      `/count-sessions/${session.id}/confirm`,
      'POST',
      { expectedVersion: session.version, completeConfirmed: true },
    );
    expect(await balance()).toBe(10);

    // A Pagonet só dá o minuto: a venda depois da contagem é a do minuto seguinte ao corte.
    const cutoff = new Date(confirmed.cutoffAt);
    const before = localClock(new Date(cutoff.getTime() - 120_000), ZONE);
    const next = new Date(Math.floor(cutoff.getTime() / 60_000) * 60_000 + 60_000);
    const after = localClock(next, ZONE);
    const hhmm = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    while ((await dbNow()) < next) await new Promise((resolve) => setTimeout(resolve, 1000));

    // A primeira leitura de todas é a do dia anterior, só para aprender o horário da loja.
    await openWindow();
    await ctx.pagonet.syncSales(storeId);
    expect(await processBatches()).toBe(0);

    const day = after.date;
    const row = (id: string, minutes: number, codprod?: string, qtd = 1) => ({
      id,
      data: `${day}T00:00:00`,
      hora: hhmm(minutes),
      codcaixa: '5',
      coo: '593475',
      ...(codprod ? { codprod, descricao: 'ITEM' } : {}),
      qtd,
    });
    bridge.state.vendas.set(day, [
      ...(before.date === day ? [row('499', before.minutes, '1678', 5)] : []),
      row('500', after.minutes, '1678', 2),
      row('501', after.minutes, '1678', 1),
      row('502', after.minutes),
      row('503', after.minutes, '9999', 4),
      // Produto do catálogo sem contagem: a venda não é guardada.
      row('504', after.minutes, '5', 3),
    ]);
    await openWindow();
    await ctx.pagonet.syncSales(storeId);
    expect(await processBatches()).toBe(1);
    // As 5 de antes já estavam fora da gôndola na contagem; as 3 de depois descontam.
    expect(await balance()).toBe(7);
    const imported = await admin.query<{ external_event_id: string }>(
      'SELECT external_event_id FROM integration_events WHERE store_id=$1 ORDER BY 1',
      [storeId],
    );
    expect(imported.rows.map((r) => r.external_event_id)).toEqual(
      [
        ...(before.date === day ? [`venda:${day}:499`] : []),
        `venda:${day}:500`,
        `venda:${day}:501`,
      ].sort(),
    );

    // A lista de importações mostra quanto de cada lote já foi processado.
    const imports = await ok<{
      items: { externalBatchId: string; eventCount: number; processedCount: number }[];
    }>('/imports');
    const salesBatch = imports.items.find((item) =>
      item.externalBatchId.startsWith(`pagonet:vendas:${day}:`),
    )!;
    expect(salesBatch.eventCount).toBe(before.date === day ? 3 : 2);
    expect(salesBatch.processedCount).toBe(salesBatch.eventCount);
    expect(
      imports.items.find((item) => item.externalBatchId.startsWith('pagonet:catalogo:')),
    ).toBeUndefined();

    // Ler de novo não duplica.
    await openWindow();
    await ctx.pagonet.syncSales(storeId);
    expect(await processBatches()).toBe(0);

    // O item 501 foi cancelado no caixa: some da rota. Uma leitura só não basta.
    bridge.state.vendas.set(
      day,
      bridge.state.vendas.get(day)!.filter((sale) => (sale as { id: string }).id !== '501'),
    );
    await openWindow();
    await ctx.pagonet.syncSales(storeId);
    expect(await processBatches()).toBe(0);
    expect(await balance()).toBe(7);
    await openWindow();
    await ctx.pagonet.syncSales(storeId);
    expect(await processBatches()).toBe(1);
    expect(await balance()).toBe(8);

    expect(await ok('/pagonet-source')).toMatchObject({
      salesThrough: `${day} ${hhmm(after.minutes)}`,
      lastError: null,
    });
  }, 150_000);

  it('aprende o horário da loja e acusa vendas paradas no painel e no resumo', async () => {
    // Leitura final de ontem, à meia-noite e vinte: o dia inteiro, das 06:57 às 22:11.
    const today = localClock(await dbNow(), ZONE).date;
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await admin.query(
      `UPDATE pagonet_sources SET sales_state = jsonb_build_object('days', jsonb_build_object($2::text, '{"closingReads":0,"missing":{}}'::jsonb))
        WHERE store_id=$1`,
      [storeId, yesterday],
    );
    const sale = (id: string, hora: string) => ({
      id,
      data: `${yesterday}T00:00:00`,
      hora,
      codcaixa: '5',
      coo: '1',
      codprod: '1678',
      qtd: 1,
      descricao: 'ITEM',
    });
    bridge.state.vendas.set(yesterday, [sale('900', '22:11'), sale('901', '06:57')]);
    const midnight = new Date(localInstant(today, '00:20', ZONE));
    await openWindow();
    await new PagonetSync(
      ctx.prisma,
      jobs,
      ctx.integration,
      new PagonetClient(bridgeUrl, 10_000),
      TOKEN,
      () => midnight,
    ).syncSales(storeId);
    expect(await processBatches()).toBe(1);
    // Vendas de ontem são anteriores à contagem: o saldo não muda.
    expect(await balance()).toBe(8);
    // Dia encerrado: as vendas dele, de todo o catálogo, entram na média de vendas.
    const daily = await admin.query<{ items: number; units: string }>(
      'SELECT items, units::text FROM sales_days WHERE store_id=$1 AND day=$2::date',
      [storeId, yesterday],
    );
    expect(daily.rows).toEqual([{ items: 2, units: '2.000' }]);
    // Guardado no dia da semana de ontem (ou no domingo, se ontem foi feriado).
    const { rows } = await admin.query<{ seen: unknown }>(
      `SELECT h AS seen FROM pagonet_sources s, jsonb_each(s.sales_state->'hours') d(key, list),
              jsonb_array_elements(d.list) h
        WHERE s.store_id=$1 AND h->>'date'=$2`,
      [storeId, yesterday],
    );
    expect(rows.map((row) => row.seen)).toEqual([
      { date: yesterday, first: '06:57', last: '22:11' },
    ]);

    // Loja que vende o dia todo. O horário antigo, sozinho, não confirma atraso.
    const always = Object.fromEntries(
      ['0', '1', '2', '3', '4', '5', '6'].map((day) => [
        day,
        [{ date: yesterday, first: '00:00', last: '23:59' }],
      ]),
    );
    const stamp = (instant: Date) => {
      const clock = localClock(instant, ZONE);
      const hhmm = `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`;
      return `${clock.date} ${hhmm}`;
    };
    const observed = await dbNow();
    const stale = stamp(new Date(observed.getTime() - 3 * 3_600_000));
    const state = {
      days: {},
      hours: always,
      lastReadDate: today,
      freshness: {
        date: today,
        through: stale,
        firstSeenAt: new Date(observed.getTime() - 3_600_000).toISOString(),
        lastSeenAt: observed.toISOString(),
        backlogMinutes: 180,
      },
    };
    await admin.query(
      `UPDATE pagonet_sources SET sales_through=$2, sales_state=$3::jsonb - 'freshness',
         sales_catchup=false, catalog_requested_at=NULL, catalog_attempted_at=NULL,
         sales_attempted_at=NULL, sales_synced_at=clock_timestamp(), last_error=NULL
       WHERE store_id=$1`,
      [storeId, stale, JSON.stringify(state)],
    );
    expect(await ok('/pagonet-source')).toMatchObject({ salesThrough: stale, salesDelayed: false });
    await admin.query('UPDATE pagonet_sources SET sales_state=$2::jsonb WHERE store_id=$1', [
      storeId,
      JSON.stringify(state),
    ]);
    expect(await ok('/pagonet-source')).toMatchObject({ salesThrough: stale, salesDelayed: true });
    const [date, time] = stale.split(' ') as [string, string];
    expect(await ok('/dashboard/summary')).toMatchObject({
      salesThroughAt: localInstant(date, time, ZONE),
      salesDelayed: true,
    });
    const digests = new PrismaDigests(ctx.prisma);
    expect((await digests.schedule(storeId))?.salesDelayedThrough).toBe(stale);

    // A evidência não autoriza alertar durante uma leitura, recuperação ou erro.
    for (const condition of [
      'sales_catchup=true',
      'catalog_requested_at=clock_timestamp()',
      'sales_attempted_at=clock_timestamp()',
      'catalog_attempted_at=clock_timestamp()',
      "last_error='Consulta indisponível'",
    ]) {
      await admin.query(`UPDATE pagonet_sources SET ${condition} WHERE store_id=$1`, [storeId]);
      expect(await ok('/pagonet-source')).toMatchObject({ salesDelayed: false });
      expect(await ok('/dashboard/summary')).toMatchObject({ salesDelayed: false });
      expect((await digests.schedule(storeId))?.salesDelayedThrough).toBeNull();
      await admin.query(
        `UPDATE pagonet_sources SET sales_catchup=false,
        catalog_requested_at=NULL, catalog_attempted_at=NULL, sales_attempted_at=NULL,
        last_error=NULL WHERE store_id=$1`,
        [storeId],
      );
    }

    // Vendas em dia: nenhum aviso.
    await admin.query('UPDATE pagonet_sources SET sales_through=$2 WHERE store_id=$1', [
      storeId,
      stamp(await dbNow()),
    ]);
    expect(await ok('/pagonet-source')).toMatchObject({ salesDelayed: false });
    expect(await ok('/dashboard/summary')).toMatchObject({ salesDelayed: false });
    expect((await digests.schedule(storeId))?.salesDelayedThrough).toBeNull();
  });

  it('continua uma consulta que atravessa meia-noite sem reabrir pedidos já concluídos', async () => {
    const day = '2026-10-20',
      next = '2026-10-21';
    await admin.query(
      'UPDATE pagonet_sources SET sales_state=$2::jsonb, sales_catchup=false WHERE store_id=$1',
      [storeId, JSON.stringify({ days: { [day]: { closingReads: 0, missing: {} } } })],
    );
    const request = await ok<{ syncRequestedAt: string }>('/pagonet-source/sync', 'POST');
    await openWindow();
    await ctx.pagonet.syncCatalog(storeId);
    let clockCalls = 0;
    const crossing = new PagonetSync(
      ctx.prisma,
      jobs,
      ctx.integration,
      new PagonetClient(bridgeUrl, 10_000),
      TOKEN,
      () =>
        new Date(
          clockCalls++ === 0 ? localInstant(day, '23:59', ZONE) : localInstant(next, '00:01', ZONE),
        ),
    );
    await crossing.syncSales(storeId);
    // A consulta iniciada às 23:59 não substitui uma leitura final após 00:15.
    expect(
      (
        await admin.query(
          "SELECT sales_state->'days'->$2->>'closingReads' AS reads FROM pagonet_sources WHERE store_id=$1",
          [storeId, day],
        )
      ).rows[0].reads,
    ).toBe('0');
    expect(
      (await admin.query('SELECT sales_catchup FROM pagonet_sources WHERE store_id=$1', [storeId]))
        .rows[0].sales_catchup,
    ).toBe(true);
    expect(await ok('/pagonet-source')).toMatchObject({
      syncRequestedAt: request.syncRequestedAt,
      salesDelayed: false,
    });

    let now = new Date(localInstant(next, '00:20', ZONE));
    const sync = new PagonetSync(
      ctx.prisma,
      jobs,
      ctx.integration,
      new PagonetClient(bridgeUrl, 10_000),
      TOKEN,
      () => now,
    );
    await openWindow();
    await sync.syncSales(storeId); // Primeira leitura final, após 00:15.
    expect(await ok('/pagonet-source')).toMatchObject({ syncRequestedAt: request.syncRequestedAt });
    now = new Date(localInstant(next, '00:25', ZONE));
    await openWindow();
    await sync.syncSales(storeId); // Segunda leitura final do dia anterior.
    expect(await ok('/pagonet-source')).toMatchObject({ syncRequestedAt: request.syncRequestedAt });
    now = new Date(localInstant(next, '00:30', ZONE));
    await openWindow();
    await sync.syncSales(storeId); // Só a leitura do dia atual conclui o pedido.
    expect(await ok('/pagonet-source')).toMatchObject({ syncRequestedAt: null });
    now = new Date(localInstant('2026-10-22', '09:00', ZONE));
    const actor = {
      storeId,
      userId: ownerId,
      role: 'OWNER' as const,
      sessionId: randomUUID(),
      restricted: false,
    };
    expect(await sync.view(actor)).toMatchObject({ syncRequestedAt: null });
    await openWindow();
    await sync.syncSales(storeId); // Um fechamento posterior não reabre o pedido.
    expect(await sync.view(actor)).toMatchObject({ syncRequestedAt: null });
  });

  it('confirma estagnação com consultas reais e reinicia a evidência quando chegam vendas', async () => {
    const day = '2026-10-19';
    const hours = { '1': [{ date: '2026-10-05', first: '07:00', last: '22:00' }] };
    await admin.query(
      `UPDATE pagonet_sources SET sales_state=$2::jsonb,
      sales_through=$3, sales_catchup=false, catalog_requested_at=NULL,
      last_error=NULL, last_error_at=NULL WHERE store_id=$1`,
      [
        storeId,
        JSON.stringify({ days: { [day]: { closingReads: 0, missing: {} } }, hours }),
        `${day} 08:00`,
      ],
    );
    const sale = (hora: string) => ({
      id: '950',
      data: `${day}T00:00:00`,
      hora,
      codcaixa: '5',
      coo: '1',
      codprod: '9999',
      qtd: 1,
      descricao: 'ITEM',
    });
    bridge.state.vendas.set(day, [sale('08:00')]);
    let now = new Date(localInstant(day, '12:00', ZONE));
    const sync = new PagonetSync(
      ctx.prisma,
      jobs,
      ctx.integration,
      new PagonetClient(bridgeUrl, 10_000),
      TOKEN,
      () => now,
    );
    const actor = {
      storeId,
      userId: ownerId,
      role: 'OWNER' as const,
      sessionId: randomUUID(),
      restricted: false,
    };
    const readAt = async (time: string) => {
      now = new Date(localInstant(day, time, ZONE));
      await openWindow();
      await sync.syncSales(storeId);
      return sync.view(actor);
    };
    expect(await readAt('12:00')).toMatchObject({ salesDelayed: false });
    expect(await readAt('12:59')).toMatchObject({ salesDelayed: false });
    expect(await readAt('13:00')).toMatchObject({
      salesDelayed: true,
      salesThrough: `${day} 08:00`,
    });
    bridge.state.vendas.set(day, [sale('13:01')]);
    expect(await readAt('13:05')).toMatchObject({
      salesDelayed: false,
      salesThrough: `${day} 13:01`,
    });
    const { rows } = await admin.query<{
      observation: { firstSeenAt: string; lastSeenAt: string };
    }>("SELECT sales_state->'freshness' AS observation FROM pagonet_sources WHERE store_id=$1", [
      storeId,
    ]);
    expect(rows[0]!.observation.firstSeenAt).toBe(now.toISOString());
    expect(rows[0]!.observation.lastSeenAt).toBe(now.toISOString());
  });

  it('lê o histórico de 6 meses um dia por vez, na janela livre da rota de vendas', async () => {
    const today = localClock(await dbNow(), ZONE).date;
    const ago = (days: number) =>
      new Date(Date.parse(`${today}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
    // Ontem fica com as leituras de fechamento; o histórico começa anteontem.
    await admin.query('DELETE FROM sales_days WHERE store_id=$1 AND day < $2::date', [
      storeId,
      ago(1),
    ]);
    const row = (id: string, day: string, codprod: string | undefined, qtd: number) => ({
      id,
      data: `${day}T00:00:00`,
      hora: '10:00',
      codcaixa: '5',
      coo: '1',
      ...(codprod ? { codprod, descricao: 'ITEM' } : {}),
      qtd,
    });
    bridge.state.vendas.set(ago(2), [
      row('700', ago(2), '1678', 2),
      row('701', ago(2), '1678', 3),
      // Vendido por peso.
      row('702', ago(2), '5', 1.5),
      row('703', ago(2), undefined, 1),
      row('704', ago(2), '9999', 4),
    ]);
    const events = async () =>
      Number(
        (
          await admin.query('SELECT count(*) n FROM integration_events WHERE store_id=$1', [
            storeId,
          ])
        ).rows[0].n,
      );
    const eventsBefore = await events();
    const salesCalls = () =>
      bridge.state.calls.filter((path) => path === '/facilita-validade/vendas').length;
    const callsBefore = salesCalls();
    await openWindow();
    await ctx.pagonet.syncHistory(storeId);
    expect(salesCalls()).toBe(callsBefore + 1);
    const daily = await admin.query<{ external: string; units: string }>(
      `SELECT p.external_product_id AS external, d.units::text FROM product_daily_sales d
         JOIN products p ON p.store_id = d.store_id AND p.id = d.product_id
        WHERE d.store_id=$1 AND d.day=$2::date ORDER BY 1`,
      [storeId, ago(2)],
    );
    expect(daily.rows).toEqual([
      { external: '1678', units: '5.000' },
      { external: '5', units: '1.500' },
    ]);
    const day = await admin.query<{ items: number; units: string }>(
      'SELECT items, units::text FROM sales_days WHERE store_id=$1 AND day=$2::date',
      [storeId, ago(2)],
    );
    expect(day.rows).toEqual([{ items: 4, units: '10.500' }]);
    // Só a soma por dia: nada de baixa nos lotes.
    expect(await events()).toBe(eventsBefore);
    // A janela da rota de vendas foi usada: sem nova chamada antes de 5 minutos.
    await ctx.pagonet.syncHistory(storeId);
    expect(salesCalls()).toBe(callsBefore + 1);
    // Na janela seguinte, o dia anterior.
    await openWindow();
    await ctx.pagonet.syncHistory(storeId);
    expect(salesCalls()).toBe(callsBefore + 2);
    expect(
      (
        await admin.query('SELECT items FROM sales_days WHERE store_id=$1 AND day=$2::date', [
          storeId,
          ago(3),
        ])
      ).rows,
    ).toEqual([{ items: 0 }]);
    // Falha do histórico: não vira erro da leitura de vendas e espera horas para tentar de novo.
    const lastError = async () =>
      (
        await admin.query<{ last_error: string | null }>(
          'SELECT last_error FROM pagonet_sources WHERE store_id=$1',
          [storeId],
        )
      ).rows[0]!.last_error;
    const previousError = await lastError();
    bridge.state.token = 'outro-token';
    await openWindow();
    await ctx.pagonet.syncHistory(storeId);
    const failed = await admin.query<{ last_error: string | null; history_error: string | null }>(
      'SELECT last_error, history_error FROM pagonet_sources WHERE store_id=$1',
      [storeId],
    );
    expect(failed.rows[0]!.history_error).toBeTruthy();
    expect(failed.rows[0]!.last_error).toBe(previousError);
    bridge.state.token = TOKEN;
    await openWindow();
    const callsAfterFailure = salesCalls();
    await ctx.pagonet.syncHistory(storeId);
    expect(salesCalls()).toBe(callsAfterFailure);
    await admin.query(
      'UPDATE pagonet_sources SET history_error=NULL, history_error_at=NULL WHERE store_id=$1',
      [storeId],
    );
  });

  it('token recusado vira aviso no painel e interrompe a evidência de estagnação', async () => {
    bridge.state.token = 'outro-token';
    await openWindow();
    await expect(ctx.pagonet.syncSales(storeId)).resolves.toBeUndefined();
    const view = await ok<{ lastError: string | null; lastErrorAt: string | null }>(
      '/pagonet-source',
    );
    expect(view.lastError).toContain('recusou o token');
    expect(view.lastErrorAt).not.toBeNull();
    const { rows } = await admin.query(
      "SELECT sales_state->'freshness' AS observation FROM pagonet_sources WHERE store_id=$1",
      [storeId],
    );
    expect(rows[0].observation).toBeNull();
  });

  it('loja suspensa não chama a Pagonet, nem com um job que já estava na fila', async () => {
    await admin.query('UPDATE stores SET active = false WHERE id = $1', [storeId]);
    try {
      const calls = bridge.state.calls.length;
      await openWindow();
      await ctx.pagonet.syncCatalog(storeId);
      await ctx.pagonet.syncSales(storeId);
      expect(bridge.state.calls.length).toBe(calls);
    } finally {
      await admin.query('UPDATE stores SET active = true WHERE id = $1', [storeId]);
    }
  });

  it('sem o token da aplicação: manter ligada e pausar podem, ligar não; nada é lido', async () => {
    const offline = new PagonetSync(
      ctx.prisma,
      jobs,
      ctx.integration,
      new PagonetClient(bridgeUrl, 10_000),
      null,
    );
    const owner = {
      storeId,
      userId: ownerId,
      role: 'OWNER' as const,
      sessionId: randomUUID(),
      restricted: false,
    };
    // Já ligada: salvar de novo não a pausa por tabela.
    const kept = await offline.configure(owner, randomUUID(), { active: true });
    expect(kept).toMatchObject({ active: true, available: false });
    const paused = await offline.configure(owner, randomUUID(), { active: false });
    expect(paused).toMatchObject({ active: false });
    await expect(offline.configure(owner, randomUUID(), { active: true })).rejects.toMatchObject({
      code: 'PAGONET_UNAVAILABLE',
      status: 503,
    });
    const calls = bridge.state.calls.length;
    await openWindow();
    await offline.syncCatalog(storeId);
    await offline.syncSales(storeId);
    expect(bridge.state.calls.length).toBe(calls);
    expect(await offline.checkToken()).toMatchObject({ ok: false });
  });
});
