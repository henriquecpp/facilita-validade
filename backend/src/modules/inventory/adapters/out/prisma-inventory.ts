import type { ListOptions } from '../../../../shared/domain/pagination.js';
import { Prisma } from '../../../../generated/prisma/client.js';
import { page } from '../../../../shared/infrastructure/pagination.js';
import { randomUUID } from 'node:crypto';
import {
  ApplicationError,
  requireRole,
  type TenantActor,
} from '../../../../shared/domain/context.js';
import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { command, audit, hashPayload } from '../../../../shared/infrastructure/commands.js';
import { civilDateSql, instantSql } from '../../../../shared/infrastructure/instants.js';
import type { Jobs } from '../../../../shared/infrastructure/jobs.js';
import { productSearch } from '../../../../shared/infrastructure/product-search.js';
import { countedLots, lotDays, lotLevel, NO_LEVEL } from './lot-levels.js';
import { recordTotals } from '../../domain/record-totals.js';
import {
  rebuildInventory,
  resumeInventory,
  confirmCount,
  type InventoryIssue,
  type InventoryMovement,
  type InventoryBaseline,
  type StockRecord,
  type MovementResolution,
  type InventoryProjection,
  type RebuildInventoryInput,
  type ReplayCheckpoint,
} from '../../domain/index.js';
import type {
  InventoryPort,
  CountAction,
  ReceiptInput,
  CountLineInput,
  WriteOffInput,
  RecordEditInput,
  HistoryOptions,
  ExpiryOptions,
  ProductListOptions,
} from '../../application/inventory-port.js';

/**
 * Atraso do retrato da reconstrução: fatos que chegam com até esse atraso (fechamento do dia,
 * até 7 dias recuperados de uma vez) e cancelamentos deles ainda retomam do retrato.
 */
const CHECKPOINT_LAG_MS = 8 * 86_400_000;
type FactRow = { payload: InventoryMovement; seq: string };
type ProjectionRow = {
  record_id: string;
  quantity: number;
  expires_on: string;
  launched: number;
  sold: number;
  written_off: number;
  status: string;
};
/** Maior `seq` entre os fatos lidos, ou o do retrato. */
const maxSeq = (rows: readonly FactRow[], floor: bigint | null) =>
  rows.reduce((max, row) => (BigInt(row.seq) > max ? BigInt(row.seq) : max), floor ?? 0n);

/** Valor em R$ com centavos, sem resto de ponto flutuante. */
const round = (value: number) => Math.round(value * 100) / 100;

/*
 * Instantes e datas deste módulo saem do banco sempre como texto: instantes em ISO 8601
 * UTC com microssegundos (`instantSql`) e datas como `YYYY-MM-DD` (`civilDateSql`). O
 * domínio compara instantes em microssegundos, e um `Date` do Prisma só tem
 * milissegundos. Pelo mesmo motivo, instantes são gravados por SQL com o texto como
 * parâmetro — a API tipada do Prisma os converteria em `Date` antes de gravar.
 */

interface State {
  epoch_id: string | null;
  tracking_status: 'TRACKED' | 'UNTRACKED';
  input_revision: string;
  projection_revision: string;
  applied_input_revision: string;
}
interface Session {
  id: string;
  product_id: string;
  status: string;
  version: number;
  started_at: string | null;
  cutoff_at: string | null;
  lines_saved_at: string | null;
}
interface Line {
  id: string;
  expires_on: string;
  quantity: number;
  lot_code: string | null;
  note: string | null;
  created_at: string;
}
interface Correctable {
  epoch_id: string;
  version: number;
  deleted: boolean;
  quantity: number;
  launched: number;
  sold: number;
  written_off: number;
  expires_on: string;
}
const notFound = () => new ApplicationError('NOT_FOUND', 'Registro não encontrado.', 404);
const countActive = () =>
  new ApplicationError('COUNT_ACTIVE', 'Há uma contagem ativa para este produto.', 409);

/** Colunas de um lote para as telas: validade e lançado atuais, o que saiu e quem lançou. */
const recordColumns = Prisma.sql`
  r.id, ${civilDateSql('s.expires_on')} AS "expiresOn", r.lot_code AS "lotCode", s.quantity,
  r.note, r.version, r.origin, s.launched AS "launchedQuantity", s.sold AS "soldQuantity",
  s.written_off AS "writtenOffQuantity", ${instantSql('r.available_at')} AS "launchedAt",
  cu.username AS "launchedBy", ${instantSql('r.deleted_at')} AS "deletedAt",
  du.username AS "deletedBy", d.days AS "daysToExpiry", lv.id AS "levelId",
  lv.name AS "levelName", lv.color AS "levelColor"`;
const recordJoins = Prisma.sql`
  JOIN stock_projections s ON s.store_id = r.store_id AND s.record_id = r.id
  JOIN stores st ON st.id = r.store_id
  ${lotDays}
  ${lotLevel}
  LEFT JOIN store_users cu ON cu.store_id = r.store_id AND cu.id = r.created_by
  LEFT JOIN store_users du ON du.store_id = r.store_id AND du.id = r.deleted_by`;
type RecordRow = {
  id: string;
  expiresOn: string;
  lotCode: string | null;
  quantity: number;
  note: string | null;
  version: number;
  origin: string;
  launchedQuantity: number;
  soldQuantity: number;
  writtenOffQuantity: number;
  launchedAt: string;
  launchedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  daysToExpiry: number;
  levelId: string | null;
  levelName: string | null;
  levelColor: string | null;
  status: string;
};

/**
 * Lotes com saldo na época atual de cada produto, com os dias até vencer, o nível de urgência
 * da loja e o preço de venda do produto, para os valores em R$.
 */
export class PrismaInventory implements InventoryPort {
  constructor(
    readonly prisma: PrismaDatabase,
    readonly jobs: Jobs,
  ) {}
  /** Trava o produto: toda alteração do estoque de um produto passa por aqui, em série. */
  async lock(tx: PrismaTx, storeId: string, productId: string): Promise<State> {
    const [state] = await tx.$queryRaw<State[]>`
      SELECT epoch_id, tracking_status, input_revision::text AS input_revision,
             projection_revision::text AS projection_revision,
             applied_input_revision::text AS applied_input_revision
        FROM product_inventory
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
         FOR UPDATE`;
    if (!state) throw notFound();
    return state;
  }
  /** Relógio do banco, o mesmo de todos os instantes gravados. */
  async now(tx: PrismaTx) {
    const [row] = await tx.$queryRaw<{ instant: string }[]>`
      SELECT ${instantSql('clock_timestamp()')} AS instant`;
    return row!.instant;
  }
  async facts(tx: PrismaTx, storeId: string, productId: string) {
    return (await this.factRows(tx, storeId, productId)).map((row) => row.payload);
  }
  /** Fatos do produto na ordem de gravação, com `seq`; com `from`, só os desse instante em diante. */
  private factRows(tx: PrismaTx, storeId: string, productId: string, from?: string) {
    return tx.$queryRaw<FactRow[]>`
      SELECT payload, seq::text AS seq FROM stock_movements
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
         AND (${from ?? null}::timestamptz IS NULL OR occurred_at >= ${from ?? null}::timestamptz)
       ORDER BY occurred_at, id`;
  }
  async baseline(
    tx: PrismaTx,
    storeId: string,
    productId: string,
    epochId: string,
  ): Promise<InventoryBaseline> {
    const [epoch] = await tx.$queryRaw<{ cutoff_at: string; count_started_at: string }[]>`
      SELECT ${instantSql('cutoff_at')} AS cutoff_at,
             ${instantSql('count_started_at')} AS count_started_at
        FROM inventory_epochs
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
         AND id = ${epochId}::uuid`;
    if (!epoch) throw notFound();
    const records = await tx.$queryRaw<StockRecord[]>`
      SELECT id, store_id AS "storeId", product_id AS "productId",
             ${civilDateSql('expires_on')} AS "expiresOn", lot_code AS "lotCode",
             initial_quantity AS quantity,
             ${instantSql('allocation_priority_at')} AS "allocationPriorityAt"
        FROM stock_records
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
         AND epoch_id = ${epochId}::uuid AND origin = 'COUNT'`;
    return {
      id: epochId,
      storeId,
      productId,
      cutoffAt: epoch.cutoff_at,
      countStartedAt: epoch.count_started_at,
      records,
    };
  }
  private resolutions(tx: PrismaTx, storeId: string, productId: string) {
    return tx.$queryRaw<{ payload: MovementResolution }[]>`
      SELECT payload FROM movement_resolutions
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
       ORDER BY created_at, id`.then((rows) => rows.map((r) => r.payload));
  }
  /** O que a reconstrução completa de um produto lê: fatos, resoluções e a contagem atual. */
  async inputs(tx: PrismaTx, storeId: string, productId: string, epochId: string | null) {
    const facts = await this.facts(tx, storeId, productId);
    const resolutions = await this.resolutions(tx, storeId, productId);
    const baseline = epochId ? await this.baseline(tx, storeId, productId, epochId) : null;
    return { facts, resolutions, baseline };
  }
  /**
   * Reconstrói o saldo dos lotes do produto e grava o que mudou.
   *
   * Com um retrato válido da época atual (`inventory_checkpoints`), só os fatos depois dele são
   * refeitos (`resumeInventory`); senão, todos (`rebuildInventory`). O resultado é o mesmo — a
   * conferência (`pnpm inventory:audit`) refaz tudo e compara. Toda reconstrução tira um retrato
   * novo de {@link CHECKPOINT_LAG_MS} atrás: vendas que chegam com até esse atraso (leituras de
   * fechamento, dias recuperados) e cancelamentos delas ainda retomam do retrato.
   */
  async rebuild(tx: PrismaTx, storeId: string, productId: string): Promise<InventoryProjection> {
    const state = await this.lock(tx, storeId, productId);
    const now = await this.now(tx);
    if (!state.epoch_id) {
      const { facts, resolutions } = await this.inputs(tx, storeId, productId, null);
      const projection = rebuildInventory({
        storeId,
        productId,
        trackingStatus: state.tracking_status,
        baseline: null,
        movements: facts,
        resolutions,
        projectionAsOf: now,
      });
      await tx.$executeRaw`
        UPDATE product_inventory SET applied_input_revision = input_revision
         WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid`;
      return projection;
    }
    const baseline = await this.baseline(tx, storeId, productId, state.epoch_id);
    const snapshotAt = new Date(Date.parse(now) - CHECKPOINT_LAG_MS).toISOString();
    const input = {
      storeId,
      productId,
      trackingStatus: state.tracking_status,
      baseline,
      projectionAsOf: now,
      snapshotAt,
    };
    let replay = await this.resume(tx, storeId, productId, input);
    if (!replay) {
      const rows = await this.factRows(tx, storeId, productId);
      const projection = rebuildInventory({
        ...input,
        movements: rows.map((row) => row.payload),
        resolutions: await this.resolutions(tx, storeId, productId),
      });
      replay = { projection, rows, maxSeq: maxSeq(rows, null) };
    }
    const { projection, rows } = replay;
    const revision = Number(state.projection_revision) + 1;
    const epochId = baseline.id;

    // Registros das entradas aplicadas agora pela primeira vez.
    const known = new Set(
      (
        await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM stock_records
           WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
             AND epoch_id = ${epochId}::uuid`
      ).map((row) => row.id),
    );
    const receipts = new Map<string, InventoryMovement>();
    for (const { payload } of rows)
      if (payload.type === 'APP_RECEIPT' || payload.type === 'RETURN_RECEIPT')
        receipts.set(payload.stockRecordId, payload);
    for (const record of projection.records) {
      const fact = known.has(record.id) ? undefined : receipts.get(record.id);
      if (fact && (fact.type === 'APP_RECEIPT' || fact.type === 'RETURN_RECEIPT'))
        await tx.$executeRaw`
          INSERT INTO stock_records(id, store_id, product_id, epoch_id, origin, expires_on, lot_code,
                                    initial_quantity, available_at, allocation_priority_at, created_by)
          VALUES (${record.id}::uuid, ${storeId}::uuid, ${productId}::uuid, ${epochId}::uuid,
                  ${fact.type}, ${fact.expiresOn ?? record.expiresOn}::date, ${record.lotCode ?? null},
                  ${fact.quantity}::int, ${fact.occurredAt}::timestamptz,
                  ${record.allocationPriorityAt}::timestamptz, ${fact.actorId ?? null}::uuid)
          ON CONFLICT (id) DO NOTHING`;
    }

    // Lançado, vendido, baixa manual, saldo e status de cada lote: só as linhas que mudaram.
    const stored = new Map(
      (
        await tx.$queryRaw<ProjectionRow[]>`
          SELECT p.record_id, p.quantity, ${civilDateSql('p.expires_on')} AS expires_on,
                 p.launched, p.sold, p.written_off, p.status
            FROM stock_projections p
            JOIN stock_records r ON r.store_id = p.store_id AND r.id = p.record_id
           WHERE r.store_id = ${storeId}::uuid AND r.product_id = ${productId}::uuid
             AND r.epoch_id = ${epochId}::uuid`
      ).map((row) => [row.record_id, row]),
    );
    const changed = recordTotals(projection).filter((row) => {
      const old = stored.get(row.recordId);
      return (
        !old ||
        old.quantity !== row.quantity ||
        old.expires_on !== row.expiresOn ||
        old.launched !== row.launched ||
        old.sold !== row.sold ||
        old.written_off !== row.writtenOff ||
        old.status !== row.status
      );
    });
    if (changed.length)
      await tx.$executeRaw`
        INSERT INTO stock_projections(store_id, record_id, quantity, revision, expires_on, launched,
                                      sold, written_off, status)
        SELECT ${storeId}::uuid, c.record_id, c.quantity, ${revision}::int8, c.expires_on,
               c.launched, c.sold, c.written_off, c.status
          FROM unnest(${changed.map((c) => c.recordId)}::uuid[],
                      ${changed.map((c) => c.quantity)}::int[],
                      ${changed.map((c) => c.expiresOn)}::date[],
                      ${changed.map((c) => c.launched)}::int[],
                      ${changed.map((c) => c.sold)}::int[],
                      ${changed.map((c) => c.writtenOff)}::int[],
                      ${changed.map((c) => c.status)}::text[])
               AS c(record_id, quantity, expires_on, launched, sold, written_off, status)
        ON CONFLICT (store_id, record_id)
        DO UPDATE SET quantity = excluded.quantity, revision = excluded.revision,
                      expires_on = excluded.expires_on, launched = excluded.launched,
                      sold = excluded.sold, written_off = excluded.written_off,
                      status = excluded.status`;
    // Registro excluído, ou entrada invalidada, sai do conjunto reconstruído: saldo zero.
    await tx.$executeRaw`
      UPDATE stock_projections p
         SET quantity = 0, revision = ${revision}::int8, sold = 0, written_off = 0,
             status = CASE WHEN r.deleted_at IS NULL THEN 'EMPTY' ELSE 'DELETED' END
        FROM stock_records r
       WHERE p.store_id = ${storeId}::uuid AND r.store_id = p.store_id AND r.id = p.record_id
         AND r.product_id = ${productId}::uuid AND r.epoch_id = ${epochId}::uuid
         AND NOT (r.id = ANY(${projection.records.map((r) => r.id)}::uuid[]))
         AND (p.quantity <> 0 OR p.sold <> 0 OR p.written_off <> 0
              OR p.status <> CASE WHEN r.deleted_at IS NULL THEN 'EMPTY' ELSE 'DELETED' END)`;

    // Alocações: na retomada, só as dos fatos refeitos podem mudar; grava a diferença.
    const scope = projection.replayed ?? null;
    const before = await tx.$queryRaw<
      { movement_id: string; record_id: string; quantity: number }[]
    >`
      SELECT movement_id, record_id, quantity FROM movement_allocations
       WHERE store_id = ${storeId}::uuid AND epoch_id = ${epochId}::uuid
         AND (${scope}::uuid[] IS NULL OR movement_id = ANY(${scope}::uuid[]))`;
    const pair = (movementId: string, recordId: string) => `${movementId}|${recordId}`;
    const wanted = new Map(
      projection.allocations.map((a) => [pair(a.movementId, a.stockRecordId), a]),
    );
    const removed = before.filter((a) => {
      const next = wanted.get(pair(a.movement_id, a.record_id));
      return !next || next.quantity !== a.quantity;
    });
    const present = new Map(before.map((a) => [pair(a.movement_id, a.record_id), a.quantity]));
    const added = projection.allocations.filter(
      (a) => present.get(pair(a.movementId, a.stockRecordId)) !== a.quantity,
    );
    if (removed.length)
      await tx.$executeRaw`
        DELETE FROM movement_allocations a
         USING unnest(${removed.map((a) => a.movement_id)}::uuid[],
                      ${removed.map((a) => a.record_id)}::uuid[]) AS d(movement_id, record_id)
         WHERE a.store_id = ${storeId}::uuid AND a.epoch_id = ${epochId}::uuid
           AND a.movement_id = d.movement_id AND a.record_id = d.record_id`;
    if (added.length)
      await tx.$executeRaw`
        INSERT INTO movement_allocations(store_id, epoch_id, movement_id, record_id, quantity, revision)
        SELECT ${storeId}::uuid, ${epochId}::uuid, n.movement_id, n.record_id, n.quantity,
               ${revision}::int8
          FROM unnest(${added.map((a) => a.movementId)}::uuid[],
                      ${added.map((a) => a.stockRecordId)}::uuid[],
                      ${added.map((a) => a.quantity)}::int[]) AS n(movement_id, record_id, quantity)`;

    // Pendências: a lista inteira vem da reconstrução; só o que mudou é gravado.
    const issues = new Map(
      projection.issues.map((issue) => [`${issue.code}:${issue.movementId}`, issue]),
    );
    const open = await tx.$queryRaw<{ identity: string; detail: InventoryIssue }[]>`
      SELECT identity, detail FROM reconciliation_issues
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid AND status = 'OPEN'`;
    const same = (a: InventoryIssue, b: InventoryIssue) =>
      a.code === b.code &&
      a.movementId === b.movementId &&
      (a.quantity ?? null) === (b.quantity ?? null);
    const resolved = open.filter((row) => !issues.has(row.identity)).map((row) => row.identity);
    const openNow = new Map(open.map((row) => [row.identity, row.detail]));
    const raised = [...issues].filter(([identity, issue]) => {
      const old = openNow.get(identity);
      return !old || !same(old, issue);
    });
    if (resolved.length)
      await tx.$executeRaw`
        UPDATE reconciliation_issues SET status = 'RESOLVED'
         WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid AND status = 'OPEN'
           AND identity = ANY(${resolved}::text[])`;
    if (raised.length)
      await tx.$executeRaw`
        INSERT INTO reconciliation_issues(id, store_id, product_id, identity, code, detail)
        SELECT gen_random_uuid(), ${storeId}::uuid, ${productId}::uuid, n.identity, n.code, n.detail
          FROM unnest(${raised.map(([identity]) => identity)}::text[],
                      ${raised.map(([, issue]) => issue.code)}::text[],
                      ${raised.map(([, issue]) => JSON.stringify(issue))}::jsonb[])
               AS n(identity, code, detail)
        ON CONFLICT (store_id, product_id, identity)
        DO UPDATE SET status = 'OPEN', detail = excluded.detail`;

    // O retrato para a próxima. Sem retrato novo numa reconstrução completa, o antigo não vale.
    if (projection.checkpoint)
      await tx.$executeRaw`
        INSERT INTO inventory_checkpoints(store_id, product_id, epoch_id, max_seq, state)
        VALUES (${storeId}::uuid, ${productId}::uuid, ${epochId}::uuid, ${replay.maxSeq}::int8,
                ${JSON.stringify(projection.checkpoint)}::jsonb)
        ON CONFLICT (store_id, product_id)
        DO UPDATE SET epoch_id = excluded.epoch_id, max_seq = excluded.max_seq,
                      state = excluded.state, created_at = clock_timestamp()`;
    else if (!projection.resumedFrom)
      await tx.$executeRaw`
        DELETE FROM inventory_checkpoints
         WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid`;
    await tx.$executeRaw`
      UPDATE product_inventory
         SET applied_input_revision = input_revision, projection_revision = ${revision}::int8,
             projected_at = ${now}::timestamptz,
             count_window_quantity = ${projection.countWindowQuantity}::int8
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid`;
    await tx.$executeRaw`
      INSERT INTO projection_runs(id, store_id, product_id, epoch_id, revision, input_revision,
                                  fingerprint, summary)
      VALUES (${randomUUID()}::uuid, ${storeId}::uuid, ${productId}::uuid, ${epochId}::uuid,
              ${revision}::int8, ${state.input_revision}::int8,
              ${hashPayload({ epochId, maxSeq: replay.maxSeq.toString(), from: projection.resumedFrom ?? null, asOf: now })},
              ${JSON.stringify({
                totalQuantity: projection.totalQuantity,
                issues: projection.issues.length,
                mode: projection.resumedFrom ? 'RESUMED' : 'FULL',
                facts: rows.length,
              })}::jsonb)`;
    await this.jobs.send(tx, storeId, 'notifications.evaluate', { productId });
    return projection;
  }
  /**
   * Retomada a partir do retrato da época atual, quando ele ainda vale: nenhum fato gravado
   * depois dele com instante anterior, e nenhuma classificação de devolução ou descarte. Lê só
   * os fatos de instante igual ou posterior ao da posição do retrato, e os originais dos
   * cancelamentos que estão entre eles ou que o retrato esperava.
   */
  private async resume(
    tx: PrismaTx,
    storeId: string,
    productId: string,
    input: Omit<RebuildInventoryInput, 'movements' | 'resolutions'>,
  ): Promise<{ projection: InventoryProjection; rows: FactRow[]; maxSeq: bigint } | null> {
    const [saved] = await tx.$queryRaw<{ max_seq: string; state: ReplayCheckpoint }[]>`
      SELECT max_seq::text AS max_seq, state FROM inventory_checkpoints
       WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
         AND epoch_id = ${input.baseline!.id}::uuid`;
    if (!saved) return null;
    const boundary = saved.state.position.occurredAt;
    const [blocked] = await tx.$queryRaw<{ late: boolean; classified: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM stock_movements
                      WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
                        AND seq > ${saved.max_seq}::int8
                        AND occurred_at < ${boundary}::timestamptz) AS late,
             EXISTS (SELECT 1 FROM movement_resolutions
                      WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid) AS classified`;
    if (blocked!.late || blocked!.classified) return null;
    const rows = await this.factRows(tx, storeId, productId, boundary);
    const loaded = new Set(rows.map((row) => row.payload.id));
    const originals = [
      ...new Set([
        ...rows.flatMap(({ payload }) =>
          payload.type === 'VOID_MOVEMENT' ? [payload.originalMovementId] : [],
        ),
        ...saved.state.pendingVoids.map((entry) => entry.originalId),
      ]),
    ].filter((id) => !loaded.has(id));
    const references = originals.length
      ? (
          await tx.$queryRaw<{ payload: InventoryMovement }[]>`
            SELECT payload FROM stock_movements
             WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
               AND id = ANY(${originals}::uuid[])`
        ).map((row) => row.payload)
      : [];
    const since = BigInt(saved.max_seq);
    const projection = resumeInventory(
      { ...input, movements: rows.map((row) => row.payload), resolutions: [] },
      {
        checkpoint: saved.state,
        fresh: new Set(rows.filter((row) => BigInt(row.seq) > since).map((row) => row.payload.id)),
        references,
      },
    );
    return projection ? { projection, rows, maxSeq: maxSeq(rows, since) } : null;
  }
  /**
   * Reconstrói só se houver entrada ainda não aplicada. Reprocessamentos e jobs repetidos
   * chegam aqui sem nada novo, e cada reconstrução regrava as alocações do produto.
   */
  async rebuildIfStale(tx: PrismaTx, storeId: string, productId: string): Promise<boolean> {
    const state = await this.lock(tx, storeId, productId);
    if (state.input_revision === state.applied_input_revision) return false;
    await this.rebuild(tx, storeId, productId);
    return true;
  }
  async readDetail(tx: PrismaTx, storeId: string, productId: string) {
    const [row] = await tx.$queryRaw<
      {
        description: string;
        active: boolean;
        photo_url: string | null;
        tracking_status: string;
        cutoff_at: string | null;
        projected_at: string | null;
        input_revision: string;
        applied_input_revision: string;
        projection_revision: string;
        epoch_id: string | null;
        count_window_quantity: string;
        daily_sales: string | null;
        history_days: string | null;
      }[]
    >`SELECT p.description, p.active, p.photo_url, i.tracking_status,
             ${instantSql('e.cutoff_at')} AS cutoff_at, ${instantSql('i.projected_at')} AS projected_at,
             i.input_revision::text AS input_revision,
             i.applied_input_revision::text AS applied_input_revision,
             i.projection_revision::text AS projection_revision, i.epoch_id,
             i.count_window_quantity::text AS count_window_quantity,
             sr.daily_sales::text AS daily_sales, sr.history_days::text AS history_days
        FROM products p
        JOIN product_inventory i ON i.store_id = p.store_id AND i.product_id = p.id
        LEFT JOIN inventory_epochs e ON e.store_id = i.store_id AND e.id = i.epoch_id
        LEFT JOIN product_sales_rates sr
          ON sr.store_id = p.store_id AND sr.product_id = p.id AND i.tracking_status = 'TRACKED'
       WHERE p.store_id = ${storeId}::uuid AND p.id = ${productId}::uuid`;
    if (!row) throw notFound();
    // Só produto controlado tem lotes que contam.
    const records =
      row.tracking_status === 'TRACKED'
        ? await this.detailRecords(tx, storeId, productId, row.epoch_id)
        : [];
    return {
      product: {
        id: productId,
        description: row.description,
        active: row.active,
        photoUrl: row.photo_url,
      },
      trackingStatus: row.tracking_status,
      lastCountAt: row.cutoff_at,
      projectedAt: row.projected_at,
      inputRevision: Number(row.input_revision),
      appliedInputRevision: Number(row.applied_input_revision),
      projectionRevision: Number(row.projection_revision),
      stale: row.input_revision !== row.applied_input_revision,
      countWindowQuantity: Number(row.count_window_quantity),
      records,
      totalQuantity: records.reduce((s, r) => s + r.quantity, 0),
      // Média de vendas por dia (uma casa) e os dias de histórico em que ela se baseia; nula
      // com histórico curto. A sobra prevista de cada lote vem em `records`.
      dailySales: row.daily_sales === null ? null : Math.round(Number(row.daily_sales) * 10) / 10,
      salesHistoryDays: row.history_days === null ? null : Math.floor(Number(row.history_days)),
    };
  }
  /**
   * Lotes ativos (com saldo) da época atual; baixados e excluídos ficam em
   * {@link closedRecords}. Separado de {@link readDetail} só para os testes de snapshot.
   */
  async detailRecords(tx: PrismaTx, storeId: string, productId: string, epochId: string | null) {
    return tx.$queryRaw<(RecordRow & { forecastLeftover: number | null })[]>`
      SELECT ${recordColumns}, s.status, f.forecast_leftover AS "forecastLeftover"
        FROM stock_records r
        ${recordJoins}
        LEFT JOIN (${countedLots(storeId, productId)}) f ON f.id = r.id
       WHERE r.store_id = ${storeId}::uuid AND r.product_id = ${productId}::uuid
         AND r.epoch_id = ${epochId}::uuid AND s.quantity > 0
       ORDER BY s.expires_on, r.allocation_priority_at, r.id`;
  }
  /**
   * Histórico de lotes do produto: os baixados e os excluídos da época atual e os das épocas
   * anteriores. Um lote de época anterior que ainda tinha saldo foi substituído pela
   * contagem que abriu a época seguinte. Do lançamento mais recente para o mais antigo.
   */
  closedRecords(
    storeId: string,
    productId: string,
    options: Pick<ListOptions, 'cursor' | 'limit'> = {},
  ) {
    const limit = options.limit ?? 50;
    const cursor = options.cursor ?? null;
    return this.prisma.tenant(
      storeId,
      async (tx) => {
        await this.requireProduct(tx, storeId, productId);
        return page(
          await tx.$queryRaw<RecordRow[]>`
            SELECT ${recordColumns},
                   CASE WHEN r.epoch_id IS DISTINCT FROM i.epoch_id AND s.status = 'PENDING'
                        THEN 'REPLACED' ELSE s.status END AS status
              FROM stock_records r
              ${recordJoins}
              JOIN product_inventory i ON i.store_id = r.store_id AND i.product_id = r.product_id
             WHERE r.store_id = ${storeId}::uuid AND r.product_id = ${productId}::uuid
               AND NOT (r.epoch_id IS NOT DISTINCT FROM i.epoch_id AND s.quantity > 0)
               AND (${cursor}::uuid IS NULL OR (r.available_at, r.id) <
                    (SELECT available_at, id FROM stock_records
                      WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
                        AND id = ${cursor}::uuid))
             ORDER BY r.available_at DESC, r.id DESC
             LIMIT ${limit + 1}`,
          limit,
        );
      },
      { readOnlySnapshot: true },
    );
  }
  private async requireProduct(tx: PrismaTx, storeId: string, productId: string) {
    if (
      !(await tx.products.findFirst({
        where: { store_id: storeId, id: productId },
        select: { id: true },
      }))
    )
      throw notFound();
  }
  detail(storeId: string, productId: string) {
    return this.prisma.tenant(storeId, (tx) => this.readDetail(tx, storeId, productId), {
      readOnlySnapshot: true,
    });
  }
  /**
   * Produtos da loja, para o módulo Produtos: busca por nome ou código de barras, filtros por
   * situação (controlado ou não) e por grupo/categoria do ERP. Controlados primeiro, depois em
   * ordem alfabética: o catálogo inteiro chega do ERP, e os produtos que a loja acompanha não
   * podem se perder no meio dele. Com busca, os mais relevantes antes (ver
   * {@link productSearch}). O cursor segue a mesma ordem, comparando a linha inteira.
   *
   * A página é escolhida antes, só com colunas do produto, e o saldo e a próxima validade são
   * somados só para os produtos dela: somar o catálogo inteiro a cada página custava caro. Só
   * produto controlado tem saldo.
   */
  list(storeId: string, options: ProductListOptions = {}) {
    const limit = options.limit ?? 50;
    const cursor = options.cursor ?? null;
    const tracking = options.trackingStatus ?? null;
    const [group, category] = options.category?.split('/') ?? [];
    const search = productSearch(storeId, options.search, 'p');
    const cursorRelevance = productSearch(storeId, options.search, 'cp').rank;
    return this.prisma.tenant(storeId, async (tx) =>
      page(
        await tx.$queryRaw<Record<string, unknown>[]>`
          WITH chosen AS (
            SELECT p.id, p.description, p.erp_group, p.erp_category, p.sale_price,
                   i.tracking_status, i.epoch_id,
                   i.input_revision > i.applied_input_revision AS stale,
                   ${search.rank} AS relevance
              FROM products p
              JOIN product_inventory i ON i.store_id = p.store_id AND i.product_id = p.id
             WHERE p.store_id = ${storeId}::uuid
               AND (${tracking}::text IS NULL OR i.tracking_status = ${tracking}::text)
               AND (${group ?? null}::text IS NULL OR p.erp_group = ${group ?? null}::text)
               AND (${category ?? null}::text IS NULL OR p.erp_category = ${category ?? null}::text)
               AND (${cursor}::uuid IS NULL OR
                    (${search.rank}, i.tracking_status = 'UNTRACKED', p.description, p.id) >
                    (SELECT ${cursorRelevance}, ci.tracking_status = 'UNTRACKED', cp.description,
                            cp.id
                       FROM products cp
                       JOIN product_inventory ci
                         ON ci.store_id = cp.store_id AND ci.product_id = cp.id
                      WHERE cp.store_id = ${storeId}::uuid AND cp.id = ${cursor}::uuid))
               ${search.filter}
             ORDER BY relevance, i.tracking_status = 'UNTRACKED', p.description, p.id
             LIMIT ${limit + 1})
          SELECT c.id AS "productId", c.description AS "productName",
                 c.tracking_status AS "trackingStatus",
                 (SELECT min(b.barcode) FROM product_barcodes b
                   WHERE b.store_id = ${storeId}::uuid AND b.product_id = c.id) AS barcode,
                 CASE WHEN c.erp_group IS NULL THEN NULL
                      ELSE c.erp_group || COALESCE('/' || c.erp_category, '') END AS category,
                 c.sale_price::float8 AS "salePrice",
                 COALESCE(stock.quantity, 0)::float8 AS "estimatedQuantity",
                 ${civilDateSql('stock.nearest')} AS "nearestExpiry",
                 c.stale,
                 EXISTS (SELECT 1 FROM count_sessions cs
                          WHERE cs.store_id = ${storeId}::uuid AND cs.product_id = c.id
                            AND cs.status IN ('DRAFT', 'COUNTING')) AS "countActive"
            FROM chosen c
            LEFT JOIN LATERAL (
              SELECT sum(s.quantity) AS quantity,
                     min(s.expires_on) FILTER (WHERE s.quantity > 0) AS nearest
                FROM stock_records r
                JOIN stock_projections s ON s.store_id = r.store_id AND s.record_id = r.id
               WHERE r.store_id = ${storeId}::uuid AND r.product_id = c.id
                 AND r.epoch_id = c.epoch_id AND c.tracking_status = 'TRACKED') stock ON true
           ORDER BY c.relevance, c.tracking_status = 'UNTRACKED', c.description, c.id`,
        limit,
      ),
    );
  }
  /** Grupos e categorias do ERP com produtos na loja, para o filtro da lista de produtos. */
  categories(storeId: string) {
    return this.prisma.tenant(
      storeId,
      async (tx) => ({
        items: await tx.$queryRaw<{ code: string; products: number }[]>`
          SELECT erp_group || COALESCE('/' || erp_category, '') AS code, count(*)::int AS products
            FROM products
           WHERE store_id = ${storeId}::uuid AND erp_group IS NOT NULL
           GROUP BY erp_group, erp_category
           ORDER BY length(erp_group), erp_group, length(erp_category) NULLS FIRST, erp_category`,
      }),
      { readOnlySnapshot: true },
    );
  }
  /**
   * Validades com saldo, da mais próxima à mais distante. Com `levelId`, só um nível (ou
   * `NONE`, os lotes fora de todos): como as faixas não se sobrepõem e o nível cresce com a
   * data, cada nível é um trecho contínuo da lista, e o cursor (data, id) pagina dentro dele.
   */
  expiries(storeId: string, options: ExpiryOptions = {}) {
    const limit = options.limit ?? 50;
    const cursor = options.cursor ?? null;
    const levelId = options.levelId ?? null;
    return this.prisma.tenant(
      storeId,
      async (tx) =>
        page(
          await tx.$queryRaw<
            {
              id: string;
              productId: string;
              productName: string;
              barcode: string | null;
              expiresOn: string;
              lotCode: string | null;
              quantity: number;
              daysToExpiry: number;
              levelId: string | null;
              levelName: string | null;
              levelColor: string | null;
              forecastLeftover: number | null;
            }[]
          >`WITH lots AS (${countedLots(storeId)})
            SELECT l.id, p.id AS "productId", p.description AS "productName",
                   (SELECT min(barcode) FROM product_barcodes b
                     WHERE b.store_id = p.store_id AND b.product_id = p.id) AS barcode,
                   ${civilDateSql('l.expires_on')} AS "expiresOn", l.lot_code AS "lotCode",
                   l.quantity, l.days AS "daysToExpiry", l.level_id AS "levelId",
                   l.level_name AS "levelName", l.level_color AS "levelColor",
                   l.forecast_leftover AS "forecastLeftover"
              FROM lots l
              JOIN products p ON p.store_id = ${storeId}::uuid AND p.id = l.product_id
             WHERE (${levelId}::text IS NULL
                    OR (${levelId}::text = 'NONE' AND l.level_id IS NULL)
                    OR l.level_id::text = ${levelId}::text)
               -- Os que alertam: com a opção da loja, sai o lote previsto para vender a tempo.
               AND (${options.notify ?? false}::boolean IS NOT TRUE OR l.alerting)
               AND (${cursor}::uuid IS NULL
                    OR (l.expires_on, l.id) >
                       (SELECT sp.expires_on, sp.record_id FROM stock_projections sp
                         WHERE sp.store_id = ${storeId}::uuid AND sp.record_id = ${cursor}::uuid))
             ORDER BY l.expires_on, l.id
             LIMIT ${limit + 1}`,
          limit,
        ),
      { readOnlySnapshot: true },
    );
  }
  /**
   * Lotes, unidades e valor em R$ (preço de venda) em cada nível da loja, do mais urgente ao
   * mais tranquilo, sempre com todos os níveis. A faixa sem nível entra no fim só quando há
   * lote nela.
   */
  expirySummary(storeId: string) {
    return this.prisma.tenant(storeId, (tx) => this.levelTotals(tx, storeId), {
      readOnlySnapshot: true,
    });
  }
  /** {@link expirySummary} numa transação já aberta, para a conferência usar o mesmo retrato. */
  async levelTotals(tx: PrismaTx, storeId: string) {
    const rows = await tx.$queryRaw<
      { level_id: string | null; lots: number; units: number; value: number }[]
    >`WITH lots AS (${countedLots(storeId)})
      SELECT level_id, count(*)::int AS lots, COALESCE(sum(quantity), 0)::float8 AS units,
             COALESCE(sum(quantity * sale_price), 0)::float8 AS value
        FROM lots
       GROUP BY level_id`;
    const levels = await tx.$queryRaw<
      {
        id: string;
        name: string;
        color: string;
        minDays: number | null;
        maxDays: number | null;
        notify: boolean;
      }[]
    >`SELECT id, name, color, min_days AS "minDays", max_days AS "maxDays", notify
        FROM expiry_levels WHERE store_id = ${storeId}::uuid
       ORDER BY min_days NULLS FIRST, max_days NULLS LAST, id`;
    const totals = (id: string | null) => {
      const row = rows.find((item) => item.level_id === id);
      return { lots: row?.lots ?? 0, units: row?.units ?? 0, value: round(row?.value ?? 0) };
    };
    const none = totals(null);
    return {
      items: [
        ...levels.map(({ id, ...level }) => ({ levelId: id, ...level, ...totals(id) })),
        ...(none.lots
          ? [
              {
                levelId: null,
                ...NO_LEVEL,
                minDays: null,
                maxDays: null,
                notify: false,
                ...none,
              },
            ]
          : []),
      ],
    };
  }
  /** Sessão de contagem com os instantes em texto, prontos para o domínio. */
  private async session(tx: PrismaTx, storeId: string, id: string, lock = false) {
    const [session] = lock
      ? await tx.$queryRaw<Session[]>`
          SELECT id, product_id, status, version, ${instantSql('started_at')} AS started_at,
                 ${instantSql('cutoff_at')} AS cutoff_at,
                 ${instantSql('lines_saved_at')} AS lines_saved_at
            FROM count_sessions WHERE store_id = ${storeId}::uuid AND id = ${id}::uuid
             FOR UPDATE`
      : await tx.$queryRaw<Session[]>`
          SELECT id, product_id, status, version, ${instantSql('started_at')} AS started_at,
                 ${instantSql('cutoff_at')} AS cutoff_at,
                 ${instantSql('lines_saved_at')} AS lines_saved_at
            FROM count_sessions WHERE store_id = ${storeId}::uuid AND id = ${id}::uuid`;
    return session;
  }
  async readCount(tx: PrismaTx, storeId: string, id: string) {
    const s = await this.session(tx, storeId, id);
    if (!s) throw notFound();
    const lines = await this.countLines(tx, storeId, id);
    return {
      id: s.id,
      productId: s.product_id,
      status: s.status,
      version: s.version,
      startedAt: s.started_at,
      cutoffAt: s.cutoff_at,
      lines,
    };
  }
  /** Linhas da contagem. Separado de {@link readCount} só para os testes de snapshot. */
  async countLines(tx: PrismaTx, storeId: string, sessionId: string) {
    return tx.$queryRaw<
      {
        id: string;
        expiresOn: string;
        lotCode: string | null;
        quantity: number;
        note: string | null;
      }[]
    >`SELECT id, ${civilDateSql('expires_on')} AS "expiresOn", lot_code AS "lotCode", quantity, note
        FROM count_lines
       WHERE store_id = ${storeId}::uuid AND session_id = ${sessionId}::uuid
       ORDER BY created_at, id`;
  }
  counts(storeId: string, options: ListOptions & { productId?: string } = {}) {
    const limit = options.limit ?? 50;
    const status = options.status ?? null;
    const cursor = options.cursor ?? null;
    const productId = options.productId ?? null;
    return this.prisma.tenant(storeId, async (tx) =>
      page(
        await tx.$queryRaw<Record<string, unknown>[]>`
          SELECT c.id, c.product_id AS "productId", p.description AS "productName", c.status,
                 c.version, ${instantSql('c.created_at')} AS "createdAt"
            FROM count_sessions c
            JOIN products p ON p.store_id = c.store_id AND p.id = c.product_id
           WHERE c.store_id = ${storeId}::uuid
             AND (${status}::text IS NULL OR c.status = ${status}::text)
             AND (${productId}::uuid IS NULL OR c.product_id = ${productId}::uuid)
             AND (${cursor}::uuid IS NULL OR (c.created_at, c.id) <
                  (SELECT created_at, id FROM count_sessions
                    WHERE store_id = ${storeId}::uuid AND id = ${cursor}::uuid
                      AND (${productId}::uuid IS NULL OR product_id = ${productId}::uuid)))
           ORDER BY c.created_at DESC, c.id DESC
           LIMIT ${limit + 1}`,
        limit,
      ),
    );
  }
  count(storeId: string, id: string) {
    return this.prisma.tenant(storeId, (tx) => this.readCount(tx, storeId, id), {
      readOnlySnapshot: true,
    });
  }
  /** Contagem em andamento do produto, se houver: no máximo uma por produto. */
  private activeCount(tx: PrismaTx, storeId: string, productId: string) {
    return tx.count_sessions.findFirst({
      where: {
        store_id: storeId,
        product_id: productId,
        status: { in: ['DRAFT', 'COUNTING'] },
      },
      select: { id: true },
    });
  }
  createCount(actor: TenantActor, key: string, productId: string) {
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'count.create', key, { productId }, async () => {
        const state = await this.lock(tx, storeId, productId);
        const product = await tx.products.findFirst({
          where: { store_id: storeId, id: productId },
          select: { active: true },
        });
        if (!product?.active && state.tracking_status === 'UNTRACKED')
          throw new ApplicationError('PRODUCT_INACTIVE', 'Produto inativo.');
        if (await this.activeCount(tx, storeId, productId))
          throw new ApplicationError('COUNT_ACTIVE', 'Já existe contagem em andamento.', 409);
        const id = randomUUID();
        // Abrir a contagem já a inicia: não há etapa de preparação nem pausa declarada.
        await tx.$executeRaw`
          INSERT INTO count_sessions(id, store_id, product_id, actor_id, status, started_at)
          VALUES (${id}::uuid, ${storeId}::uuid, ${productId}::uuid, ${userId}::uuid, 'COUNTING',
                  clock_timestamp())`;
        await audit(tx, storeId, userId, 'count.create', id);
        return this.readCount(tx, storeId, id);
      }),
    );
  }
  updateCount(actor: TenantActor, key: string, id: string, action: CountAction) {
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, `count.${action.type}`, key, { id, ...action }, async () => {
        const before = await this.session(tx, storeId, id);
        if (!before) throw notFound();
        // Produto antes da sessão: a mesma ordem de travas de todos os outros comandos.
        await this.lock(tx, storeId, before.product_id);
        const session = (await this.session(tx, storeId, id, true))!;
        if (session.version !== action.expectedVersion)
          throw new ApplicationError(
            'VERSION_CONFLICT',
            'A contagem foi alterada. Atualize antes de continuar.',
            409,
          );
        if (action.type === 'cancel') {
          if (!['DRAFT', 'COUNTING'].includes(session.status))
            throw new ApplicationError('INVALID_COUNT_STATE', 'Contagem já encerrada.', 409);
          await tx.count_sessions.updateMany({
            where: { store_id: storeId, id },
            data: { status: 'CANCELLED', cancel_reason: action.reason, version: { increment: 1 } },
          });
        } else {
          if (session.status !== 'COUNTING' || !session.started_at)
            throw new ApplicationError('INVALID_COUNT_STATE', 'Contagem já encerrada.', 409);
          if (action.type === 'lines') await this.replaceLines(tx, storeId, id, action.lines);
          if (action.type === 'confirm')
            await this.confirm(
              tx,
              storeId,
              session,
              action.completeConfirmed,
              action.emptyConfirmed ?? false,
              userId,
            );
          await tx.count_sessions.updateMany({
            where: { store_id: storeId, id },
            data: { version: { increment: 1 } },
          });
        }
        await audit(tx, storeId, userId, `count.${action.type}`, id);
        return this.readCount(tx, storeId, id);
      }),
    );
  }
  async replaceLines(tx: PrismaTx, storeId: string, id: string, lines: CountLineInput[]) {
    if (new Set(lines.map((l) => l.id)).size !== lines.length)
      throw new ApplicationError('DUPLICATE_LINE', 'Linhas duplicadas.');
    for (const line of lines) {
      const old = await tx.count_lines.findFirst({
        where: { store_id: storeId, id: line.id },
        select: { session_id: true },
      });
      if (old && old.session_id !== id)
        throw new ApplicationError('LINE_CONFLICT', 'Linha pertence a outra contagem.', 409);
      await tx.$executeRaw`
        INSERT INTO count_lines(id, store_id, session_id, expires_on, lot_code, quantity, note)
        VALUES (${line.id}::uuid, ${storeId}::uuid, ${id}::uuid, ${line.expiresOn}::date,
                ${line.lotCode?.normalize('NFC').trim() || null}, ${line.quantity}::int,
                ${line.note ?? null})
        ON CONFLICT (id) DO UPDATE
           SET expires_on = excluded.expires_on, lot_code = excluded.lot_code,
               quantity = excluded.quantity, note = excluded.note`;
    }
    await tx.$executeRaw`
      DELETE FROM count_lines
       WHERE store_id = ${storeId}::uuid AND session_id = ${id}::uuid
         AND NOT (id = ANY(${lines.map((l) => l.id)}::uuid[]))`;
    // O corte da contagem é a última alteração das linhas, não o instante da confirmação.
    await tx.$executeRaw`
      UPDATE count_sessions SET lines_saved_at = clock_timestamp()
       WHERE store_id = ${storeId}::uuid AND id = ${id}::uuid`;
  }
  async confirm(
    tx: PrismaTx,
    storeId: string,
    session: Session,
    complete: boolean,
    empty: boolean,
    /** Quem confirmou: fica como quem lançou cada lote da contagem. */
    actorId: string | null = null,
  ) {
    // Vendas entre a última linha salva e a confirmação saem do saldo contado normalmente.
    const cutoff = session.lines_saved_at ?? (await this.now(tx));
    const epochId = randomUUID();
    const lines = await tx.$queryRaw<Line[]>`
      SELECT id, ${civilDateSql('expires_on')} AS expires_on, quantity, lot_code, note,
             ${instantSql('created_at')} AS created_at
        FROM count_lines
       WHERE store_id = ${storeId}::uuid AND session_id = ${session.id}::uuid
       ORDER BY created_at, id`;
    const baseline = confirmCount({
      baselineId: epochId,
      storeId,
      productId: session.product_id,
      countStartedAt: session.started_at!,
      cutoffAt: cutoff,
      lines: lines.map((l) => ({
        id: randomUUID(),
        storeId,
        productId: session.product_id,
        expiresOn: l.expires_on,
        lotCode: l.lot_code,
        quantity: l.quantity,
        allocationPriorityAt: l.created_at,
      })),
      completeProductConfirmed: complete,
      emptyProductConfirmed: empty,
    });
    await tx.$executeRaw`
      UPDATE inventory_epochs SET closed_at = ${cutoff}::timestamptz
       WHERE store_id = ${storeId}::uuid AND product_id = ${session.product_id}::uuid
         AND closed_at IS NULL`;
    await tx.$executeRaw`
      INSERT INTO inventory_epochs(id, store_id, product_id, session_id, cutoff_at, count_started_at)
      VALUES (${epochId}::uuid, ${storeId}::uuid, ${session.product_id}::uuid, ${session.id}::uuid,
              ${cutoff}::timestamptz, ${session.started_at}::timestamptz)`;
    for (const r of baseline.records) {
      const note = lines
        .filter((l) => l.expires_on === r.expiresOn && (l.lot_code ?? null) === (r.lotCode ?? null))
        .map((l) => l.note)
        .filter(Boolean)
        .join('\n');
      await tx.$executeRaw`
        INSERT INTO stock_records(id, store_id, product_id, epoch_id, origin, expires_on, lot_code,
                                  initial_quantity, available_at, allocation_priority_at, note,
                                  created_by)
        VALUES (${r.id}::uuid, ${storeId}::uuid, ${session.product_id}::uuid, ${epochId}::uuid,
                'COUNT', ${r.expiresOn}::date, ${r.lotCode ?? null}, ${r.quantity}::int,
                ${cutoff}::timestamptz, ${r.allocationPriorityAt}::timestamptz, ${note || null},
                ${actorId}::uuid)`;
    }
    await tx.$executeRaw`
      UPDATE product_inventory
         SET epoch_id = ${epochId}::uuid, tracking_status = 'TRACKED',
             input_revision = input_revision + 1
       WHERE store_id = ${storeId}::uuid AND product_id = ${session.product_id}::uuid`;
    await tx.$executeRaw`
      UPDATE count_sessions SET status = 'CONFIRMED', cutoff_at = ${cutoff}::timestamptz
       WHERE store_id = ${storeId}::uuid AND id = ${session.id}::uuid`;
    await this.rebuild(tx, storeId, session.product_id);
  }
  receive(actor: TenantActor, key: string, input: ReceiptInput) {
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'inventory.receipt', key, input, async () => {
        const state = await this.lock(tx, storeId, input.productId);
        if (!state.epoch_id)
          throw new ApplicationError(
            'INITIAL_COUNT_REQUIRED',
            'Faça o inventário inicial deste produto.',
          );
        if (await this.activeCount(tx, storeId, input.productId)) throw countActive();
        const fact: InventoryMovement = {
          id: randomUUID(),
          storeId,
          productId: input.productId,
          type: 'APP_RECEIPT',
          quantity: input.quantity,
          expiresOn: input.expiresOn,
          lotCode: input.lotCode ?? undefined,
          stockRecordId: randomUUID(),
          actorId: userId,
          occurredAt: await this.now(tx),
          source: { kind: 'APP', commandId: key },
        };
        await this.appendFact(tx, storeId, fact);
        await this.rebuild(tx, storeId, input.productId);
        if (input.note)
          await tx.stock_records.updateMany({
            where: { store_id: storeId, id: fact.stockRecordId },
            data: { note: input.note },
          });
        await audit(tx, storeId, userId, 'inventory.receipt', fact.stockRecordId, {
          quantity: input.quantity,
        });
        return this.readDetail(tx, storeId, input.productId);
      }),
    );
  }
  async appendFact(tx: PrismaTx, storeId: string, fact: InventoryMovement, eventId?: string) {
    await this.lock(tx, storeId, fact.productId);
    const added = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO stock_movements(id, store_id, product_id, event_id, occurred_at, payload)
      VALUES (${fact.id}::uuid, ${storeId}::uuid, ${fact.productId}::uuid, ${eventId ?? null}::uuid,
              ${fact.occurredAt}::timestamptz, ${JSON.stringify(fact)}::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING id`;
    if (added.length)
      await tx.$executeRaw`
        UPDATE product_inventory SET input_revision = input_revision + 1
         WHERE store_id = ${storeId}::uuid AND product_id = ${fact.productId}::uuid`;
  }
  /**
   * Fatos de um produto vindos da integração, numa gravação só: o id de cada fato é o do evento
   * de origem. Quem chama já tem a trava do produto. Como `appendFact`, fato repetido não conta.
   */
  async appendFacts(
    tx: PrismaTx,
    storeId: string,
    productId: string,
    facts: readonly InventoryMovement[],
  ) {
    const added = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO stock_movements(id, store_id, product_id, event_id, occurred_at, payload)
      SELECT f.id, ${storeId}::uuid, ${productId}::uuid, f.id, f.occurred_at, f.payload
        FROM unnest(${facts.map((fact) => fact.id)}::uuid[],
                    ${facts.map((fact) => fact.occurredAt)}::timestamptz[],
                    ${facts.map((fact) => JSON.stringify(fact))}::jsonb[])
             WITH ORDINALITY AS f(id, occurred_at, payload, n)
       ORDER BY f.n
      ON CONFLICT (id) DO NOTHING
      RETURNING id`;
    if (added.length)
      await tx.$executeRaw`
        UPDATE product_inventory SET input_revision = input_revision + ${added.length}::int
         WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid`;
  }
  /**
   * Registro da época atual para uma correção, com o produto travado e a projeção em dia: o
   * saldo e o que já saiu do lote valem para as regras do comando.
   */
  private async correctable(
    tx: PrismaTx,
    storeId: string,
    id: string,
    expectedVersion: number,
  ): Promise<{ productId: string; record: Correctable }> {
    const found = await tx.stock_records.findFirst({
      where: { store_id: storeId, id },
      select: { product_id: true },
    });
    if (!found) throw notFound();
    const productId = found.product_id;
    const state = await this.lock(tx, storeId, productId);
    if (await this.activeCount(tx, storeId, productId)) throw countActive();
    await this.rebuildIfStale(tx, storeId, productId);
    const [record] = await tx.$queryRaw<Correctable[]>`
      SELECT r.epoch_id, r.version, r.deleted_at IS NOT NULL AS deleted, s.quantity, s.launched,
             s.sold, s.written_off, ${civilDateSql('s.expires_on')} AS expires_on
        FROM stock_records r
        JOIN stock_projections s ON s.store_id = r.store_id AND s.record_id = r.id
       WHERE r.store_id = ${storeId}::uuid AND r.id = ${id}::uuid`;
    if (!record) throw notFound();
    if (record.deleted)
      throw new ApplicationError('RECORD_DELETED', 'Este lote já foi excluído.', 409);
    if (record.epoch_id !== state.epoch_id)
      throw new ApplicationError(
        'RECORD_REPLACED',
        'Este lote foi substituído por uma contagem do produto.',
        409,
      );
    if (record.version !== expectedVersion)
      throw new ApplicationError(
        'VERSION_CONFLICT',
        'O lote foi alterado. Atualize antes de continuar.',
        409,
      );
    return { productId, record };
  }
  /** Grava a correção como fato e refaz a projeção do produto na mesma transação. */
  private async applyCorrection(
    tx: PrismaTx,
    storeId: string,
    fact: InventoryMovement & { stockRecordId: string },
    changes: Prisma.Sql = Prisma.empty,
  ) {
    await this.appendFact(tx, storeId, fact);
    await tx.$executeRaw`
      UPDATE stock_records SET version = version + 1 ${changes}
       WHERE store_id = ${storeId}::uuid AND id = ${fact.stockRecordId}::uuid`;
    await this.rebuild(tx, storeId, fact.productId);
  }
  /**
   * Baixa manual de parte ou de todo o saldo de um lote, por qualquer papel da loja. Sai só
   * daquele lote; as vendas seguintes consomem o restante.
   */
  writeOff(actor: TenantActor, key: string, id: string, input: WriteOffInput) {
    const { storeId, userId } = actor;
    const operation = 'inventory.write-off';
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, operation, key, { id, ...input }, async () => {
        const { productId, record } = await this.correctable(
          tx,
          storeId,
          id,
          input.expectedVersion,
        );
        if (input.quantity > record.quantity)
          throw new ApplicationError(
            'WRITE_OFF_ABOVE_BALANCE',
            `A baixa passa do saldo do lote (${record.quantity}).`,
          );
        const reason = input.reason?.normalize('NFC').trim() || null;
        await this.applyCorrection(tx, storeId, {
          id: randomUUID(),
          storeId,
          productId,
          type: 'MANUAL_WRITE_OFF',
          quantity: input.quantity,
          stockRecordId: id,
          reason,
          actorId: userId,
          occurredAt: await this.now(tx),
          source: { kind: 'APP', commandId: `${operation}:${key}` },
        });
        await audit(tx, storeId, userId, operation, id, { quantity: input.quantity, reason });
        return this.readDetail(tx, storeId, productId);
      }),
    );
  }
  /**
   * Exclui um lote, por qualquer papel da loja, mesmo com vendas: a reconstrução passa a
   * desconsiderá-lo desde o lançamento, e as vendas dele vão para os outros lotes.
   */
  deleteRecord(actor: TenantActor, key: string, id: string, expectedVersion: number) {
    const { storeId, userId } = actor;
    const operation = 'inventory.delete';
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, operation, key, { id, expectedVersion }, async () => {
        const { productId } = await this.correctable(tx, storeId, id, expectedVersion);
        const now = await this.now(tx);
        await this.applyCorrection(
          tx,
          storeId,
          {
            id: randomUUID(),
            storeId,
            productId,
            type: 'RECORD_DELETE',
            stockRecordId: id,
            actorId: userId,
            occurredAt: now,
            source: { kind: 'APP', commandId: `${operation}:${key}` },
          },
          Prisma.sql`, deleted_at = ${now}::timestamptz, deleted_by = ${userId}::uuid`,
        );
        await audit(tx, storeId, userId, operation, id);
        return this.readDetail(tx, storeId, productId);
      }),
    );
  }
  /**
   * Edição da validade e da quantidade lançada, só pelo painel e só pelo proprietário. Vale
   * dali em diante: o que já saiu do lote fica como está.
   */
  editRecord(actor: TenantActor, key: string, id: string, input: RecordEditInput) {
    requireRole(actor, ['OWNER']);
    const { storeId, userId } = actor;
    const operation = 'inventory.edit';
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, operation, key, { id, ...input }, async () => {
        const { productId, record } = await this.correctable(
          tx,
          storeId,
          id,
          input.expectedVersion,
        );
        const expiresOn =
          input.expiresOn !== undefined && input.expiresOn !== record.expires_on
            ? input.expiresOn
            : undefined;
        const quantity =
          input.quantity !== undefined && input.quantity !== record.launched
            ? input.quantity
            : undefined;
        if (expiresOn === undefined && quantity === undefined)
          throw new ApplicationError('NO_CHANGES', 'A validade e a quantidade são as mesmas.');
        const taken = record.sold + record.written_off;
        // O saldo nunca fica negativo: o lançado não desce abaixo do que já saiu do lote.
        if (quantity !== undefined && quantity < taken)
          throw new ApplicationError(
            'EDIT_BELOW_ALLOCATED',
            `A quantidade lançada não pode ficar abaixo do que já saiu do lote (${taken}).`,
          );
        const previous = { expiresOn: record.expires_on, quantity: record.launched };
        await this.applyCorrection(tx, storeId, {
          id: randomUUID(),
          storeId,
          productId,
          type: 'RECORD_EDIT',
          stockRecordId: id,
          ...(expiresOn !== undefined ? { expiresOn } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
          previous,
          actorId: userId,
          occurredAt: await this.now(tx),
          source: { kind: 'APP', commandId: `${operation}:${key}` },
        });
        await audit(tx, storeId, userId, operation, id, { expiresOn, quantity, previous });
        return this.readDetail(tx, storeId, productId);
      }),
    );
  }
  /**
   * Movimentações do produto, da mais recente para a mais antiga. Com `recordId`, só as que
   * mexeram naquele lote: o lançamento, as correções dele e as saídas atribuídas a ele, com a
   * quantidade que saiu do lote.
   */
  history(storeId: string, productId: string, options: HistoryOptions = {}) {
    const limit = options.limit ?? 50;
    const cursor = options.cursor ?? null;
    const recordId = options.recordId ?? null;
    return this.prisma.tenant(
      storeId,
      async (tx) => {
        await this.requireProduct(tx, storeId, productId);
        const after = Prisma.sql`(${cursor}::uuid IS NULL OR (m.occurred_at, m.id) <
                    (SELECT occurred_at, id FROM stock_movements
                      WHERE store_id = ${storeId}::uuid AND product_id = ${productId}::uuid
                        AND id = ${cursor}::uuid))`;
        // A página primeiro, e só ela ganha autor e baixa: com meses de vendas, juntar antes
        // fazia o banco percorrer o histórico inteiro do produto. Num lote, os fatos dele saem
        // das baixas do lote e dos que se referem a ele (entrada, edição, baixa manual).
        const pageRows = recordId
          ? Prisma.sql`
            WITH ids AS (
              SELECT a.movement_id AS id FROM movement_allocations a
               WHERE a.store_id = ${storeId}::uuid AND a.record_id = ${recordId}::uuid
              UNION
              SELECT f.id FROM stock_movements f
               WHERE f.store_id = ${storeId}::uuid AND f.record_ref = ${recordId}::uuid
            ), page AS MATERIALIZED (
              SELECT m.id, m.store_id, m.occurred_at, m.payload, m.record_ref,
                     (m.payload->>'actorId')::uuid AS actor_ref, m.payload->>'type' AS type_ref
                FROM ids JOIN stock_movements m ON m.store_id = ${storeId}::uuid AND m.id = ids.id
               WHERE m.product_id = ${productId}::uuid AND ${after}
               ORDER BY m.occurred_at DESC, m.id DESC
               LIMIT ${limit + 1})`
          : Prisma.sql`
            WITH page AS MATERIALIZED (
              SELECT m.id, m.store_id, m.occurred_at, m.payload, m.record_ref,
                     (m.payload->>'actorId')::uuid AS actor_ref, m.payload->>'type' AS type_ref
                FROM stock_movements m
               WHERE m.store_id = ${storeId}::uuid AND m.product_id = ${productId}::uuid
                 AND ${after}
               ORDER BY m.occurred_at DESC, m.id DESC
               LIMIT ${limit + 1})`;
        return page(
          await tx.$queryRaw<Record<string, unknown>[]>`
            ${pageRows}
            SELECT m.id, ${instantSql('m.occurred_at')} AS "occurredAt", m.payload->>'type' AS type,
                   (m.payload->>'quantity')::int AS quantity,
                   m.payload->>'stockRecordId' AS "recordId",
                   m.payload->>'expiresOn' AS "expiresOn",
                   m.payload->'previous'->>'expiresOn' AS "previousExpiresOn",
                   (m.payload->'previous'->>'quantity')::int AS "previousQuantity",
                   m.payload->>'reason' AS reason, u.username AS "actorName",
                   a.quantity AS "allocatedQuantity"
              FROM page m
              -- Entradas antigas não guardavam o autor no fato; o lote guarda.
              LEFT JOIN stock_records rr
                ON rr.store_id = m.store_id AND rr.id = m.record_ref AND m.type_ref = 'APP_RECEIPT'
              LEFT JOIN store_users u
                ON u.store_id = m.store_id AND u.id = COALESCE(m.actor_ref, rr.created_by)
              LEFT JOIN movement_allocations a
                ON a.store_id = m.store_id AND a.movement_id = m.id
               AND a.record_id = ${recordId}::uuid
             ORDER BY m.occurred_at DESC, m.id DESC`,
          limit,
        );
      },
      { readOnlySnapshot: true },
    );
  }
  metadata(actor: TenantActor, key: string, id: string, version: number, note: string) {
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'inventory.metadata', key, { id, version, note }, async () => {
        const [row] = await tx.$queryRaw<{ id: string; note: string | null; version: number }[]>`
          UPDATE stock_records SET note = ${note}, version = version + 1
           WHERE store_id = ${storeId}::uuid AND id = ${id}::uuid AND version = ${version}::int
          RETURNING id, note, version`;
        if (!row)
          throw new ApplicationError(
            'VERSION_CONFLICT',
            'Atualize o registro antes de editar.',
            409,
          );
        await audit(tx, storeId, userId, 'inventory.metadata', id);
        return row;
      }),
    );
  }
  issues(storeId: string, options: ListOptions = {}) {
    const limit = options.limit ?? 50;
    const status = options.status ?? 'OPEN';
    const cursor = options.cursor ?? null;
    return this.prisma.tenant(storeId, async (tx) =>
      page(
        await tx.$queryRaw<Record<string, unknown>[]>`
          -- A página primeiro: as pendências de venda sem lote se acumulam, e juntar antes com
          -- os movimentos fazia o banco ler todos. O id do movimento sai do JSON aqui: sob a
          -- segurança por loja, o JSON na condição da junção impede o uso do índice.
          WITH i AS MATERIALIZED (
            SELECT i.*, (i.detail->>'movementId')::uuid AS movement_ref FROM reconciliation_issues i
             WHERE i.store_id = ${storeId}::uuid AND i.status = ${status}
               AND (${cursor}::uuid IS NULL OR (i.created_at, i.id) <
                    (SELECT created_at, id FROM reconciliation_issues
                      WHERE store_id = ${storeId}::uuid AND id = ${cursor}::uuid))
             ORDER BY i.created_at DESC, i.id DESC
             LIMIT ${limit + 1})
          SELECT i.id, i.code AS type, i.product_id AS "productId", p.description AS "productName",
                 (i.detail->>'quantity')::int AS quantity, i.code AS message,
                 i.detail->>'movementId' AS "movementId", m.payload->>'type' AS "movementType",
                 i.status, ${instantSql('i.created_at')} AS "createdAt"
            FROM i
            JOIN products p ON p.store_id = i.store_id AND p.id = i.product_id
            LEFT JOIN stock_movements m ON m.store_id = i.store_id AND m.id = i.movement_ref
           ORDER BY i.created_at DESC, i.id DESC`,
        limit,
      ),
    );
  }
  resolve(
    actor: TenantActor,
    key: string,
    id: string,
    input: {
      action: string;
      recordId?: string;
      expiresOn?: string;
      lotCode?: string;
      reason: string;
    },
  ) {
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'inventory.resolve', key, { id, ...input }, async () => {
        const before = await tx.reconciliation_issues.findFirst({
          where: { store_id: storeId, id },
          select: { product_id: true },
        });
        if (!before) throw notFound();
        const state = await this.lock(tx, storeId, before.product_id);
        if (state.input_revision !== state.applied_input_revision)
          await this.rebuild(tx, storeId, before.product_id);
        const [issue] = await tx.$queryRaw<
          {
            product_id: string;
            status: string;
            code: string;
            detail: { movementId: string };
          }[]
        >`SELECT product_id, status, code, detail FROM reconciliation_issues
           WHERE store_id = ${storeId}::uuid AND id = ${id}::uuid
             FOR UPDATE`;
        if (!issue) throw notFound();
        if (issue.status !== 'OPEN')
          throw new ApplicationError(
            'ISSUE_ALREADY_RESOLVED',
            'A pendência já foi resolvida. Atualize antes de continuar.',
            409,
          );
        if (issue.code !== 'PENDING_STOCK_IDENTIFICATION' || input.action !== 'CLASSIFY')
          throw new ApplicationError(
            'RECOUNT_REQUIRED',
            'Esta divergência precisa de uma recontagem do produto.',
          );
        const fact = await tx.stock_movements.findFirst({
          where: { store_id: storeId, product_id: issue.product_id, id: issue.detail.movementId },
          select: { payload: true },
        });
        if (!fact) throw notFound();
        const payload = fact.payload as unknown as InventoryMovement;
        if (!['SCRAP', 'RETURN_RECEIPT'].includes(payload.type))
          throw new ApplicationError(
            'RECOUNT_REQUIRED',
            'Esta divergência precisa de uma recontagem do produto.',
          );
        if (
          input.recordId &&
          !(await tx.stock_records.findFirst({
            where: { store_id: storeId, product_id: issue.product_id, id: input.recordId },
            select: { id: true },
          }))
        )
          throw notFound();
        if (payload.type === 'RETURN_RECEIPT' && !input.expiresOn)
          throw new ApplicationError('EXPIRY_REQUIRED', 'Informe a validade do retorno.');
        if (payload.type === 'SCRAP' && !input.recordId && !input.lotCode)
          throw new ApplicationError(
            'IDENTIFICATION_REQUIRED',
            'Identifique o registro ou lote descartado.',
          );
        const [next] = await tx.$queryRaw<{ version: number }[]>`
          SELECT COALESCE(MAX((payload->>'version')::int), 0) + 1 AS version
            FROM movement_resolutions
           WHERE store_id = ${storeId}::uuid AND movement_id = ${issue.detail.movementId}::uuid`;
        const version = next!.version;
        const resolution: MovementResolution = {
          id: randomUUID(),
          storeId,
          productId: issue.product_id,
          movementId: issue.detail.movementId,
          effectiveAt: await this.now(tx),
          version,
          identification: {
            stockRecordId: input.recordId ?? undefined,
            lotCode: input.lotCode ?? undefined,
            expiresOn: input.expiresOn ?? undefined,
          },
          expiresOn: input.expiresOn ?? undefined,
          lotCode: input.lotCode ?? undefined,
        };
        await tx.$executeRaw`
          INSERT INTO movement_resolutions(id, store_id, product_id, movement_id, actor_id, payload,
                                           reason)
          VALUES (${resolution.id}::uuid, ${storeId}::uuid, ${issue.product_id}::uuid,
                  ${issue.detail.movementId}::uuid, ${userId}::uuid,
                  ${JSON.stringify(resolution)}::jsonb, ${input.reason})`;
        await tx.$executeRaw`
          UPDATE product_inventory SET input_revision = input_revision + 1
           WHERE store_id = ${storeId}::uuid AND product_id = ${issue.product_id}::uuid`;
        await this.rebuild(tx, storeId, issue.product_id);
        await audit(tx, storeId, userId, 'inventory.resolve', id, { reason: input.reason });
        return { id };
      }),
    );
  }
}
