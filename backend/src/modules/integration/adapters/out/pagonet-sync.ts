import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../../generated/prisma/client.js';
import {
  ApplicationError,
  requireRole,
  type TenantActor,
} from '../../../../shared/domain/context.js';
import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import type { Jobs } from '../../../../shared/infrastructure/jobs.js';
import { audit, command, hashPayload } from '../../../../shared/infrastructure/commands.js';
import { isoOrNull } from '../../../../shared/infrastructure/instants.js';
import { isDataConflict } from '../../../../shared/infrastructure/database-errors.js';
import {
  decideVoids,
  localClock,
  pagonetCatalog,
  planSalesRead,
  readSales,
  recordSalesObservation,
  recordSalesRead,
  saleEvent,
  voidEvent,
  type SalesState,
} from '../../domain/pagonet.js';
import { PagonetClient, PagonetError } from './pagonet-client.js';
import type { CatalogProduct, IntegrationActor, PrismaIntegration } from './prisma-integration.js';
import { salesFreshness } from './sales-freshness.js';
import {
  recordDailySales,
  refreshSalesRates,
} from '../../../inventory/adapters/out/sales-rates.js';
import { SALES_WINDOW_MONTHS } from '../../../inventory/domain/sales-forecast.js';

const CONNECTION_NAME = 'Pagonet — Facilita Validade';
/** Lote do contrato de importação. */
const BATCH = 1000;
/** Produtos do catálogo gravados por transação. */
const CATALOG_CHUNK = 100;
/** Cada rota de dados da Pagonet aceita uma chamada a cada 5 minutos. */
const WINDOW_MS = 5 * 60_000;
/** Depois de uma falha na leitura do histórico de vendas, espera este tanto para tentar de novo. */
const HISTORY_RETRY = '6 hours';
/**
 * Leitura de um dia encerrado com bem menos itens que a anterior do mesmo dia (resposta
 * cortada da origem) não substitui as vendas gravadas dele.
 */
const MIN_REREAD_SHARE = 0.5;
/**
 * O dia mais recente da janela da média (6 meses até anteontem) ainda sem leitura, no fuso da
 * loja; nulo quando a janela está completa. Ontem fica com as leituras de fechamento do dia.
 * Espera os apelidos `s` (pagonet_sources) e `st` (stores).
 */
const missingHistoryDay = Prisma.sql`(
  SELECT to_char(d, 'YYYY-MM-DD')
    FROM generate_series((clock_timestamp() AT TIME ZONE st.timezone)::date - 2,
                         ((clock_timestamp() AT TIME ZONE st.timezone)::date
                           - make_interval(months => ${SALES_WINDOW_MONTHS}::int))::date,
                         interval '-1 day') d
   WHERE NOT EXISTS (SELECT 1 FROM sales_days x
                      WHERE x.store_id = s.store_id AND x.day = d::date)
   LIMIT 1)`;

/** O token da Bridge, um só para a aplicação. Sem ele, a leitura da Pagonet fica desligada. */
export function pagonetTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PAGONET_TOKEN?.trim() || null;
}

export interface PagonetConfigInput {
  active: boolean;
}

export interface PagonetSourceView {
  configured: boolean;
  active: boolean;
  /** O CNPJ da própria loja: é o que vai em toda leitura. */
  cnpj: string;
  /** O servidor tem o token da aplicação (PAGONET_TOKEN). */
  available: boolean;
  catalogSyncedAt: string | null;
  catalogProducts: number | null;
  salesSyncedAt: string | null;
  salesThrough: string | null;
  /** Nenhuma venda nova há um tempo, no horário em que a loja costuma vender. */
  salesDelayed: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Leitura pedida (botão Forçar) e ainda não concluída: catálogo e vendas. */
  syncRequestedAt: string | null;
  /** A leitura pedida já está em andamento. */
  syncRunning: boolean;
  /** Quando a leitura pedida começa, se ainda espera a janela de 5 minutos da Pagonet. */
  syncStartsAt: string | null;
}

interface ClaimedSource {
  connection_id: string;
  /** Da tabela de lojas, nunca digitado: cada loja lê só os próprios dados. */
  cnpj: string;
  catalog_hash: string | null;
  sales_state: SalesState | null;
  sales_through: string | null;
  timezone: string;
}

/**
 * Importação pela Bridge da Pagonet (rotas do Facilita Validade): o próprio servidor
 * busca o catálogo e as vendas, em vez de esperar o ERP enviar. O que chega entra pelo
 * mesmo caminho das outras origens — lotes de importação de uma conexão de integração —,
 * então idempotência, pendências e reconstrução do saldo são as de sempre.
 *
 * Token e CNPJ: a Bridge tem um token só, da aplicação (`PAGONET_TOKEN`), e devolve os dados
 * do CNPJ pedido. Por isso o CNPJ de cada leitura é sempre o da própria loja, lido da tabela
 * de lojas; ninguém o digita, e uma loja não consegue pedir os dados de outra.
 *
 * Ritmo: cada rota de dados aceita uma chamada a cada 5 minutos por CNPJ, e chamada com erro
 * também conta. Antes de chamar, a tentativa é registrada no banco; outra execução só passa
 * depois da janela, mesmo com jobs repetidos ou concorrentes.
 */
export class PagonetSync {
  constructor(
    readonly prisma: PrismaDatabase,
    readonly jobs: Jobs,
    readonly integration: PrismaIntegration,
    readonly client = new PagonetClient(),
    readonly token: string | null = pagonetTokenFromEnv(),
    readonly now: () => Date = () => new Date(),
  ) {}

  view(actor: TenantActor) {
    requireRole(actor, ['OWNER']);
    return this.prisma.tenant(actor.storeId, (tx) => this.read(tx, actor.storeId));
  }

  /**
   * O proprietário liga ou pausa a leitura; token e CNPJ não. Toda loja lê o catálogo
   * inteiro: não há escolha de categorias.
   */
  async configure(actor: TenantActor, key: string, input: PagonetConfigInput) {
    requireRole(actor, ['OWNER']);
    const { storeId, userId } = actor;
    const payload = { active: input.active };
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'pagonet.configure', key, payload, async () => {
        const [current] = await tx.$queryRaw<{ active: boolean }[]>`
          SELECT active FROM pagonet_sources WHERE store_id = ${storeId}::uuid FOR UPDATE`;
        // Ligar sem o token da aplicação não leria nada: melhor dizer já. Pausar sempre pode.
        if (input.active && !current?.active && !this.token)
          throw new ApplicationError(
            'PAGONET_UNAVAILABLE',
            'A leitura da Pagonet não está disponível neste servidor. Fale com o suporte.',
            503,
          );
        let connectionId: string;
        if (current) {
          const [updated] = await tx.$queryRaw<{ connection_id: string }[]>`
            UPDATE pagonet_sources
               SET active = ${input.active}, updated_at = clock_timestamp(),
                   sales_state = CASE WHEN active = ${input.active} THEN sales_state
                                      ELSE sales_state - 'freshness' END
             WHERE store_id = ${storeId}::uuid
            RETURNING connection_id`;
          connectionId = updated!.connection_id;
        } else {
          connectionId = await this.connection(tx, storeId);
          await tx.$executeRaw`
            INSERT INTO pagonet_sources(store_id, connection_id, active, catalog_requested_at)
            VALUES (${storeId}::uuid, ${connectionId}::uuid, ${input.active}, clock_timestamp())`;
        }
        await audit(tx, storeId, userId, 'pagonet.configure', connectionId, payload);
        return this.read(tx, storeId);
      }),
    );
  }

  /** Confere o token da aplicação na Pagonet (rota sem limite), para o painel da plataforma. */
  async checkToken(): Promise<
    { ok: true; userName: string | null } | { ok: false; message: string }
  > {
    if (!this.token) return { ok: false, message: 'PAGONET_TOKEN não configurado no servidor.' };
    try {
      const { userName } = await this.client.status(this.token);
      return { ok: true, userName };
    } catch (error) {
      if (error instanceof PagonetError) return { ok: false, message: error.message };
      throw error;
    }
  }

  /**
   * Botão Forçar: lê o catálogo e, em seguida, as vendas, já. Só espera se a Pagonet ainda não
   * liberou a rota (uma chamada a cada 5 minutos); a resposta diz se a leitura começou ou
   * quando começa, e o painel acompanha até terminar.
   */
  requestSync(actor: TenantActor, key: string) {
    requireRole(actor, ['OWNER']);
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'pagonet.sync', key, {}, async () => {
        const updated = await tx.$executeRaw`
          UPDATE pagonet_sources SET catalog_requested_at = clock_timestamp()
           WHERE store_id = ${storeId}::uuid`;
        if (!updated)
          throw new ApplicationError(
            'PAGONET_NOT_CONFIGURED',
            'Configure a Pagonet antes de sincronizar.',
            409,
          );
        await this.jobs.send(
          tx,
          storeId,
          'pagonet.catalog',
          {},
          { singletonKey: `pagonet.catalog:${storeId}`, singletonSeconds: 60 },
        );
        return this.read(tx, storeId);
      }),
    );
  }

  /**
   * Chamado pelo worker a cada minuto: enfileira o que estiver na vez desta loja. De hora em
   * hora, o catálogo e logo depois as vendas, no mesmo job. Leituras de dias já encerrados
   * (fechamento do dia, dias sem leitura) e o pedido do botão Forçar não esperam a hora, só a
   * janela de 5 minutos de cada rota. Com a rota de vendas livre e nada disso na vez, um dia do
   * histórico da média de vendas.
   */
  async schedule(storeId: string) {
    if (!this.token) return;
    await this.prisma.tenant(storeId, async (tx) => {
      const [due] = await tx.$queryRaw<{ catalog: boolean; sales: boolean; history: boolean }[]>`
        WITH base AS (
          SELECT *,
                 (catalog_attempted_at IS NULL
                  OR catalog_attempted_at <= clock_timestamp() - interval '5 minutes 5 seconds')
                 AND (catalog_synced_at IS NULL
                      OR catalog_requested_at > catalog_synced_at
                      OR catalog_synced_at <= clock_timestamp() - interval '1 hour') AS catalog_due,
                 -- Catálogo em leitura: as vendas esperam por ele, para vir sempre depois.
                 coalesce(catalog_attempted_at > clock_timestamp() - interval '15 minutes'
                          AND catalog_attempted_at > coalesce(catalog_synced_at, '-infinity')
                          AND catalog_attempted_at > coalesce(last_error_at, '-infinity'),
                          false) AS catalog_running
            FROM pagonet_sources
           WHERE store_id = ${storeId}::uuid AND active
        ), due AS (
          SELECT *,
                 NOT catalog_due AND NOT catalog_running AND catalog_synced_at IS NOT NULL
                 AND (sales_attempted_at IS NULL
                      OR sales_attempted_at <= clock_timestamp() - interval '5 minutes 5 seconds')
                 AS sales_free
            FROM base)
        SELECT s.catalog_due AS catalog,
               s.sales_free
               AND (s.sales_synced_at IS NULL OR s.sales_catchup
                    OR s.catalog_requested_at > s.sales_synced_at
                    OR s.sales_synced_at <= clock_timestamp() - interval '1 hour') AS sales,
               s.sales_free AND s.sales_synced_at IS NOT NULL
               AND (s.history_error_at IS NULL
                    OR s.history_error_at <= clock_timestamp() - ${HISTORY_RETRY}::interval)
               AND ${missingHistoryDay} IS NOT NULL AS history
          FROM due s JOIN stores st ON st.id = s.store_id`;
      if (due?.catalog)
        await this.jobs.send(
          tx,
          storeId,
          'pagonet.catalog',
          {},
          { singletonKey: `pagonet.catalog:${storeId}`, singletonSeconds: 60 },
        );
      else if (due?.sales)
        await this.jobs.send(
          tx,
          storeId,
          'pagonet.sales',
          {},
          { singletonKey: `pagonet.sales:${storeId}`, singletonSeconds: 60 },
        );
      else if (due?.history)
        await this.jobs.send(
          tx,
          storeId,
          'pagonet.history',
          {},
          { singletonKey: `pagonet.history:${storeId}`, singletonSeconds: 60 },
        );
    });
  }

  /** Uma volta da leitura: o catálogo primeiro e as vendas logo em seguida. */
  async cycle(storeId: string) {
    await this.syncCatalog(storeId);
    await this.syncSales(storeId);
  }

  /**
   * Catálogo inteiro da loja, com todos os campos de cada produto. Grava só os produtos que
   * mudaram desde a última leitura: o resumo de cada um fica no produto.
   */
  async syncCatalog(storeId: string) {
    const source = await this.claim(storeId, 'catalog');
    if (!source) return;
    try {
      const token = this.token!;
      const produtos = await this.client.products(token, source.cnpj);
      const codigos = await this.client.barcodes(token, source.cnpj);
      const { products, issues } = pagonetCatalog(produtos, codigos);
      if (!products.length)
        throw new PagonetError('REJECTED', 'A Pagonet devolveu o catálogo vazio.');
      const hashed = products.map((product) => ({ ...product, hash: hashPayload(product) }));
      const hash = hashPayload(hashed.map((product) => product.hash));
      let saved = 0;
      let conflicts = 0;
      if (hash !== source.catalog_hash) {
        const known = new Map(
          (
            await this.prisma.tenant(
              storeId,
              (tx) => tx.$queryRaw<{ id: string; hash: string | null }[]>`
                SELECT external_product_id AS id, erp_hash AS hash FROM products
                 WHERE store_id = ${storeId}::uuid
                   AND integration_connection_id = ${source.connection_id}::uuid`,
            )
          ).map((row) => [row.id, row.hash]),
        );
        ({ saved, conflicts } = await this.saveCatalog(
          storeId,
          source.connection_id,
          hashed.filter((product) => known.get(product.externalProductId) !== product.hash),
        ));
      }
      // Com conflito, o resumo geral não fica: a próxima leitura tenta de novo o que faltou.
      const stored = conflicts ? null : hash;
      await this.prisma.tenant(
        storeId,
        (tx) => tx.$executeRaw`
          UPDATE pagonet_sources
             SET catalog_synced_at = clock_timestamp(), catalog_hash = ${stored},
                 catalog_products = ${products.length}, last_error = NULL, last_error_at = NULL
           WHERE store_id = ${storeId}::uuid`,
      );
      console.log(
        'pagonet_catalog',
        JSON.stringify({
          storeId,
          products: products.length,
          saved,
          conflicts,
          issues: issues.length,
        }),
      );
    } catch (error) {
      await this.fail(storeId, error);
    }
  }

  /**
   * Grava os produtos novos ou alterados, em blocos. Dois passos, como na importação de
   * catálogo: primeiro os produtos, cada um sem os códigos que saíram dele; depois os códigos
   * novos, para um código que mudou de produto já estar livre quando o novo dono o recebe.
   *
   * O resumo de cada produto só é gravado depois dos códigos dele. Uma leitura interrompida
   * entre os dois passos (worker reiniciado, falha do banco) deixa o produto sem resumo, e a
   * próxima o grava de novo; com o resumo gravado antes, ele ficaria sem códigos para sempre,
   * porque o resumo já bateria. Um conflito também deixa só o produto dele sem resumo.
   */
  private async saveCatalog(storeId: string, connectionId: string, products: CatalogProduct[]) {
    const ids = new Map<string, string>();
    let conflicts = 0;
    const save = (tx: PrismaTx, product: CatalogProduct) =>
      this.integration.saveProduct(tx, storeId, connectionId, { ...product, hash: undefined });
    for (let i = 0; i < products.length; i += CATALOG_CHUNK) {
      const chunk = products.slice(i, i + CATALOG_CHUNK);
      try {
        const saved = await this.prisma.tenant(storeId, async (tx) => {
          const result: [string, string][] = [];
          for (const product of chunk)
            result.push([product.externalProductId, await save(tx, product)]);
          return result;
        });
        for (const [external, id] of saved) ids.set(external, id);
      } catch (error) {
        if (!isDataConflict(error)) throw error;
        // Um produto do bloco conflitou: os outros são gravados um a um.
        for (const product of chunk)
          try {
            ids.set(
              product.externalProductId,
              await this.prisma.tenant(storeId, (tx) => save(tx, product)),
            );
          } catch (inner) {
            if (!isDataConflict(inner)) throw inner;
            conflicts++;
          }
      }
    }
    for (let i = 0; i < products.length; i += CATALOG_CHUNK) {
      const chunk = products
        .slice(i, i + CATALOG_CHUNK)
        .filter((product) => ids.has(product.externalProductId));
      conflicts += await this.prisma.tenant(storeId, async (tx) => {
        let failed = 0;
        const done: { id: string; hash: string }[] = [];
        for (const product of chunk) {
          const id = ids.get(product.externalProductId)!;
          if ((await this.integration.addBarcodes(tx, storeId, id, product.barcodes)).length)
            failed++;
          else if (product.hash) done.push({ id, hash: product.hash });
        }
        if (done.length)
          await tx.$executeRaw`
            UPDATE products p SET erp_hash = d.hash
              FROM unnest(${done.map((d) => d.id)}::uuid[], ${done.map((d) => d.hash)}::text[])
                   AS d(id, hash)
             WHERE p.store_id = ${storeId}::uuid AND p.id = d.id`;
        return failed;
      });
    }
    return { saved: ids.size, conflicts };
  }

  /**
   * Vendas de um dia: importa os itens novos das formas de venda do catálogo e cancela os
   * que sumiram da origem em duas leituras seguidas. Cada item é um evento com o `id` da
   * Pagonet, então ler o mesmo dia de novo não duplica nada.
   */
  async syncSales(storeId: string) {
    const source = await this.claim(storeId, 'sales');
    if (!source) return;
    try {
      const now = this.now();
      const clock = localClock(now, source.timezone);
      const plan = planSalesRead(source.sales_state ?? { days: {} }, clock.date, clock.minutes);
      const date = plan.date;
      const rows = await this.client.sales(this.token!, source.cnpj, date);
      const { items, presentIds, invalid } = readSales(rows, date, source.timezone);
      const found = await this.prisma.tenant(storeId, async (tx) => {
        const candidates = [...new Set(items.map((item) => item.productId))];
        // Só os produtos controlados ou com contagem aberta: venda de produto sem contagem é
        // anterior a qualquer contagem futura e nunca mexe em saldo. Com o catálogo inteiro,
        // guardar as vendas da loja toda encheria o banco sem uso. A contagem aberta entra
        // porque o corte dela pode ficar antes da venda.
        const known = new Set(
          (
            await tx.$queryRaw<{ id: string }[]>`
              SELECT p.external_product_id AS id FROM products p
                JOIN product_inventory i ON i.store_id = p.store_id AND i.product_id = p.id
               WHERE p.store_id = ${storeId}::uuid
                 AND p.integration_connection_id = ${source.connection_id}::uuid
                 AND p.external_product_id = ANY(${candidates}::text[])
                 AND (i.tracking_status = 'TRACKED'
                      OR EXISTS (SELECT 1 FROM count_sessions c
                                  WHERE c.store_id = p.store_id AND c.product_id = p.id
                                    AND c.status IN ('DRAFT', 'COUNTING')))`
          ).map((row) => row.id),
        );
        const recorded = await tx.$queryRaw<{ id: string; product: string }[]>`
          SELECT external_event_id AS id, payload->>'externalProductId' AS product
            FROM integration_events
           WHERE store_id = ${storeId}::uuid AND connection_id = ${source.connection_id}::uuid
             AND (external_event_id LIKE ${`venda:${date}:%`}
                  OR external_event_id LIKE ${`cancelamento:${date}:%`})`;
        return { known, recorded };
      });
      const imported = new Map<string, string>();
      const voided = new Set<string>();
      for (const row of found.recorded) {
        const [kind, , id] = row.id.split(':');
        if (kind === 'venda') imported.set(id!, row.product);
        else voided.add(id!);
      }
      const fresh = items
        .filter((item) => found.known.has(item.productId) && !imported.has(item.id))
        .map((item) => saleEvent(date, item));
      const decision = decideVoids(
        [...imported.keys()].filter((id) => !voided.has(id)),
        presentIds,
        plan.state.days[date]?.missing ?? {},
      );
      const voids = decision.confirmed.map((id) =>
        voidEvent(date, id, imported.get(id)!, now.toISOString()),
      );
      const events = [...fresh, ...voids];
      for (let i = 0; i < events.length; i += BATCH) {
        const chunk = events.slice(i, i + BATCH);
        await this.integration.ingest(this.actor(storeId, source), 'MOVEMENTS', {
          externalBatchId: `pagonet:vendas:${date}:${hashPayload(chunk.map((event) => event.externalEventId)).slice(0, 16)}`,
          events: chunk,
        });
      }
      // Dia encerrado: as vendas dele, de todo o catálogo, entram na média de vendas.
      if (date < clock.date && !decision.suspicious)
        await this.saveDay(storeId, source.connection_id, date, items, true);
      const completedAt = this.now();
      const completedClock = localClock(completedAt, source.timezone);
      // Uma consulta iniciada antes da meia-noite não substitui as leituras finais após 00:15.
      const readState = recordSalesRead(
        plan.state,
        date,
        clock.date,
        decision.missing,
        items.map((item) => item.time),
      );
      const latest = items
        .map((item) => item.time)
        .sort()
        .at(-1);
      const receivedThrough = latest ? `${date} ${latest}` : null;
      const through =
        [source.sales_through, receivedThrough]
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null;
      const warning = decision.suspicious
        ? 'Muitas vendas sumiram de uma vez da Pagonet; nenhuma foi cancelada até a origem se normalizar.'
        : invalid.length
          ? `${invalid.length} itens de venda vieram em formato inesperado e foram ignorados.`
          : null;
      const state = recordSalesObservation(readState, {
        date,
        today: completedClock.date,
        minutes: completedClock.minutes,
        through,
        observedAt: completedAt,
        valid: warning === null,
      });
      // Após fechar o último dia pendente, ainda falta consultar hoje: não esperar uma hora.
      const catchup =
        date < completedClock.date ||
        planSalesRead(state, completedClock.date, completedClock.minutes).date <
          completedClock.date;
      await this.prisma.tenant(
        storeId,
        (tx) => tx.$executeRaw`
          UPDATE pagonet_sources
             SET sales_state = ${JSON.stringify(state)}::jsonb ||
                   CASE WHEN ${date === completedClock.date}
                        THEN jsonb_build_object('lastCurrentDayReadAt', clock_timestamp())
                        ELSE '{}'::jsonb END,
                 sales_synced_at = clock_timestamp(), sales_catchup = ${catchup},
                 sales_through = CASE WHEN ${through}::text IS NULL THEN sales_through
                                      ELSE greatest(coalesce(sales_through, ''), ${through}::text) END,
                 last_error = ${warning}::text,
                 last_error_at = CASE WHEN ${warning}::text IS NULL THEN NULL ELSE clock_timestamp() END
           WHERE store_id = ${storeId}::uuid`,
      );
      console.log(
        'pagonet_sales',
        JSON.stringify({
          storeId,
          date,
          rows: rows.length,
          items: items.length,
          imported: fresh.length,
          voided: voids.length,
          invalid: invalid.length,
        }),
      );
    } catch (error) {
      await this.fail(storeId, error, true);
    }
  }

  /**
   * Um dia do histórico da média de vendas (6 meses), o mais recente ainda sem leitura. Usa a
   * janela de 5 minutos da rota de vendas, como a leitura do dia, e só quando ela está livre.
   * As vendas do dia viram só a soma por produto: dia anterior à contagem não mexe em saldo.
   * Uma falha não aparece como erro da leitura de vendas; o histórico espera umas horas.
   */
  async syncHistory(storeId: string) {
    const claimed = await this.claimHistory(storeId);
    if (!claimed) return;
    try {
      const rows = await this.client.sales(this.token!, claimed.cnpj, claimed.day);
      const { items, invalid } = readSales(rows, claimed.day, claimed.timezone);
      await this.saveDay(storeId, claimed.connection_id, claimed.day, items, false);
      await this.prisma.tenant(
        storeId,
        (tx) => tx.$executeRaw`
          UPDATE pagonet_sources SET history_error = NULL, history_error_at = NULL
           WHERE store_id = ${storeId}::uuid`,
      );
      console.log(
        'pagonet_history',
        JSON.stringify({
          storeId,
          date: claimed.day,
          rows: rows.length,
          items: items.length,
          invalid: invalid.length,
        }),
      );
    } catch (error) {
      const expected = error instanceof PagonetError;
      console.error(
        'pagonet_history_failed',
        JSON.stringify({
          storeId,
          date: claimed.day,
          code: expected ? error.code : 'UNEXPECTED',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.prisma.tenant(
        storeId,
        (tx) => tx.$executeRaw`
          UPDATE pagonet_sources
             SET history_error = ${expected ? error.message : 'Falha inesperada; veja o log do worker.'},
                 history_error_at = clock_timestamp()
           WHERE store_id = ${storeId}::uuid`,
      );
      if (!expected) throw error;
    }
  }

  /**
   * Grava as vendas de um dia encerrado e refaz a média de vendas da loja. Na releitura de um dia
   * (`reread`, o fechamento), uma resposta com bem menos itens que a anterior fica de fora.
   */
  private saveDay(
    storeId: string,
    connectionId: string,
    day: string,
    items: readonly { productId: string; quantity: number }[],
    reread: boolean,
  ) {
    return this.prisma.tenant(storeId, async (tx) => {
      if (reread) {
        const [previous] = await tx.$queryRaw<{ items: number }[]>`
          SELECT items FROM sales_days WHERE store_id = ${storeId}::uuid AND day = ${day}::date`;
        if (previous && items.length < previous.items * MIN_REREAD_SHARE) return;
      }
      await recordDailySales(
        tx,
        storeId,
        connectionId,
        day,
        items.map((item) => ({ externalProductId: item.productId, quantity: item.quantity })),
      );
      await refreshSalesRates(tx, storeId);
    });
  }

  /** Como `claim`, na janela da rota de vendas, e com o dia do histórico a ler. */
  private claimHistory(storeId: string) {
    if (!this.token) return Promise.resolve(null);
    return this.prisma.tenant(storeId, async (tx) => {
      const [row] = await tx.$queryRaw<
        { connection_id: string; cnpj: string; timezone: string; day: string }[]
      >`
        WITH target AS (
          SELECT s.store_id, ${missingHistoryDay} AS day
            FROM pagonet_sources s JOIN stores st ON st.id = s.store_id
           WHERE s.store_id = ${storeId}::uuid AND s.active AND st.active
             AND s.catalog_synced_at IS NOT NULL
             AND (s.sales_attempted_at IS NULL
                  OR s.sales_attempted_at <= clock_timestamp() - interval '5 minutes')
             AND (s.history_error_at IS NULL
                  OR s.history_error_at <= clock_timestamp() - ${HISTORY_RETRY}::interval)
             FOR UPDATE OF s)
        UPDATE pagonet_sources s
           SET sales_attempted_at = clock_timestamp(), history_attempted_at = clock_timestamp()
          FROM target t, stores st
         WHERE s.store_id = t.store_id AND t.day IS NOT NULL AND st.id = s.store_id
        RETURNING s.connection_id, st.cnpj_normalized AS cnpj, st.timezone, t.day`;
      return row ?? null;
    });
  }

  /** A conexão de integração onde ficam os produtos e movimentos vindos da Pagonet. */
  private async connection(tx: PrismaTx, storeId: string): Promise<string> {
    const existing = await tx.integration_connections.findFirst({
      where: { store_id: storeId, name: CONNECTION_NAME },
      select: { id: true },
    });
    if (existing) {
      await tx.integration_connections.updateMany({
        where: { store_id: storeId, id: existing.id },
        data: { active: true },
      });
      return existing.id;
    }
    const id = randomUUID();
    await tx.integration_connections.create({
      data: { id, store_id: storeId, name: CONNECTION_NAME },
      select: { id: true },
    });
    return id;
  }

  /**
   * Registra a tentativa antes da chamada. Só passa uma execução por janela de 5 minutos,
   * mesmo com jobs repetidos: a Pagonet conta também as chamadas que falham. Loja suspensa
   * não lê nada, nem um job que já estava na fila.
   */
  private claim(storeId: string, kind: 'catalog' | 'sales'): Promise<ClaimedSource | null> {
    if (!this.token) return Promise.resolve(null);
    return this.prisma.tenant(storeId, async (tx) => {
      const [source] =
        kind === 'catalog'
          ? await tx.$queryRaw<ClaimedSource[]>`
              UPDATE pagonet_sources s SET catalog_attempted_at = clock_timestamp()
                FROM stores st
               WHERE s.store_id = ${storeId}::uuid AND st.id = s.store_id AND s.active AND st.active
                 AND (s.catalog_attempted_at IS NULL
                      OR s.catalog_attempted_at <= clock_timestamp() - interval '5 minutes')
              RETURNING s.connection_id, st.cnpj_normalized AS cnpj, s.catalog_hash,
                        s.sales_state, s.sales_through, st.timezone`
          : await tx.$queryRaw<ClaimedSource[]>`
              UPDATE pagonet_sources s SET sales_attempted_at = clock_timestamp()
                FROM stores st
               WHERE s.store_id = ${storeId}::uuid AND st.id = s.store_id AND s.active AND st.active
                 AND s.catalog_synced_at IS NOT NULL
                 AND (s.sales_attempted_at IS NULL
                      OR s.sales_attempted_at <= clock_timestamp() - interval '5 minutes')
              RETURNING s.connection_id, st.cnpj_normalized AS cnpj, s.catalog_hash,
                        s.sales_state, s.sales_through, st.timezone`;
      return source ?? null;
    });
  }

  private actor(storeId: string, source: ClaimedSource): IntegrationActor {
    return {
      storeId,
      connectionId: source.connection_id,
      scopes: ['catalog:write', 'movements:write'],
    };
  }

  private async fail(storeId: string, error: unknown, sales = false) {
    const expected = error instanceof PagonetError;
    const message = expected
      ? error.message
      : 'Falha inesperada ao sincronizar com a Pagonet; veja o log do worker.';
    console.error(
      'pagonet_sync_failed',
      JSON.stringify({
        storeId,
        code: expected ? error.code : 'UNEXPECTED',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await this.prisma.tenant(
      storeId,
      (tx) => tx.$executeRaw`
        UPDATE pagonet_sources SET last_error = ${message}, last_error_at = clock_timestamp(),
               sales_state = CASE WHEN ${sales} THEN sales_state - 'freshness' ELSE sales_state END
         WHERE store_id = ${storeId}::uuid`,
    );
    if (!expected) throw error;
  }

  private async read(tx: PrismaTx, storeId: string): Promise<PagonetSourceView> {
    const [row] = await tx.$queryRaw<
      (SourceTimes & {
        cnpj: string;
        configured: boolean;
        catalog_products: number | null;
        sales_through: string | null;
        last_error: string | null;
      })[]
    >`SELECT st.cnpj_normalized AS cnpj, s.store_id IS NOT NULL AS configured, s.active,
             s.catalog_requested_at, s.catalog_attempted_at, s.catalog_synced_at,
             s.catalog_products, s.sales_attempted_at, s.sales_synced_at, s.sales_through,
             s.last_error, s.last_error_at,
             (s.sales_state->>'lastCurrentDayReadAt')::timestamptz AS last_current_day_read_at
        FROM stores st
        LEFT JOIN pagonet_sources s ON s.store_id = st.id
       WHERE st.id = ${storeId}::uuid`;
    const configured = !!row?.configured;
    const freshness = configured ? await salesFreshness(tx, storeId, this.now()) : null;
    return {
      configured,
      active: row?.active ?? false,
      cnpj: row?.cnpj ?? '',
      available: !!this.token,
      catalogSyncedAt: isoOrNull(row?.catalog_synced_at),
      catalogProducts: row?.catalog_products ?? null,
      salesSyncedAt: isoOrNull(row?.sales_synced_at),
      salesThrough: row?.sales_through ?? null,
      salesDelayed: freshness?.delayed ?? false,
      lastError: row?.last_error ?? null,
      lastErrorAt: isoOrNull(row?.last_error_at),
      ...this.syncProgress(row ?? null),
    };
  }

  /**
   * Situação da leitura pedida: pendente até ler o catálogo e o dia corrente após o pedido.
   * A conclusão fica registrada: a virada do dia ou um fechamento posterior não a reabre.
   * Uma falha depois do pedido encerra a espera e o painel mostra o erro.
   */
  private syncProgress(
    row: SourceTimes | null,
  ): Pick<PagonetSourceView, 'syncRequestedAt' | 'syncRunning' | 'syncStartsAt'> {
    const idle = { syncRequestedAt: null, syncRunning: false, syncStartsAt: null };
    const requested = row?.catalog_requested_at?.getTime();
    if (!row?.active || requested === undefined) return idle;
    const at = (value: Date | null) => value?.getTime() ?? Number.NEGATIVE_INFINITY;
    const catalogDone = at(row.catalog_synced_at) >= requested;
    const salesDone = at(row.last_current_day_read_at) >= requested;
    if ((catalogDone && salesDone) || at(row.last_error_at) >= requested) return idle;
    const attempted = catalogDone ? row.sales_attempted_at : row.catalog_attempted_at;
    const synced = catalogDone ? row.sales_synced_at : row.catalog_synced_at;
    const running = at(attempted) >= requested && at(attempted) > at(synced);
    const opens = Math.max(at(attempted) + WINDOW_MS, this.now().getTime());
    return {
      syncRequestedAt: new Date(requested).toISOString(),
      syncRunning: running,
      syncStartsAt: running ? null : new Date(opens).toISOString(),
    };
  }
}

interface SourceTimes {
  last_current_day_read_at: Date | null;
  active: boolean | null;
  catalog_requested_at: Date | null;
  catalog_attempted_at: Date | null;
  catalog_synced_at: Date | null;
  sales_attempted_at: Date | null;
  sales_synced_at: Date | null;
  last_error_at: Date | null;
}
