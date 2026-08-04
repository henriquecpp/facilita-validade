import type {
  InventoryIssue,
  InventoryMovement,
  InventoryProjection,
  MovementResolution,
  MovementResult,
  MovementStatus,
  RebuildInventoryInput,
  ReplayCheckpoint,
  ReplayPosition,
  ResumeInput,
  StockAllocation,
  StockIdentification,
  StockRecord,
} from './types.js';
import {
  assertDate,
  assertIdentification,
  assertIdentifier,
  assertQuantity,
  assertScope,
  assertStockRecord,
  canonicalJson,
  compareText,
  compareTimestamps,
  invariant,
  normalizeLotCode,
  safeQuantitySum,
  timestampMicros,
} from './validation.js';

type MutableRecord = { -readonly [Key in keyof StockRecord]: StockRecord[Key] };

/** Fatos que só um comando autenticado do aplicativo ou do painel cria. */
const APP_ONLY = new Set<InventoryMovement['type']>([
  'APP_RECEIPT',
  'MANUAL_WRITE_OFF',
  'RECORD_EDIT',
  'RECORD_DELETE',
]);

/** Fatos com quantidade física: entram na conta da janela da contagem. */
const PHYSICAL = new Set<InventoryMovement['type']>([
  'SALE',
  'SCRAP',
  'APP_RECEIPT',
  'RETURN_RECEIPT',
]);

export function canonicalEventKey(movement: InventoryMovement): string {
  return movement.source.kind === 'ERP'
    ? canonicalJson(['ERP', movement.source.connectionId, movement.source.externalEventId])
    : canonicalJson(['APP', movement.source.commandId]);
}

function validateMovement(movement: InventoryMovement, input: RebuildInventoryInput): void {
  assertIdentifier(movement.id, 'movement.id');
  assertScope(movement, input.storeId, input.productId);
  timestampMicros(movement.occurredAt);
  if (movement.source.kind === 'ERP') {
    assertIdentifier(movement.source.connectionId, 'connectionId');
    assertIdentifier(movement.source.externalEventId, 'externalEventId');
    invariant(
      !APP_ONLY.has(movement.type),
      'INVALID_MOVEMENT_SOURCE',
      'ERP credentials cannot create app receipts or record corrections',
    );
  } else {
    invariant(
      movement.source.kind === 'APP' && APP_ONLY.has(movement.type),
      'INVALID_MOVEMENT_SOURCE',
      'App commands may only create app receipts and record corrections',
    );
    assertIdentifier(movement.source.commandId, 'commandId');
  }
  switch (movement.type) {
    case 'MANUAL_WRITE_OFF':
      assertQuantity(movement.quantity);
      assertIdentifier(movement.stockRecordId, 'stockRecordId');
      break;
    case 'RECORD_EDIT':
      assertIdentifier(movement.stockRecordId, 'stockRecordId');
      invariant(
        movement.expiresOn !== undefined || movement.quantity !== undefined,
        'EMPTY_RECORD_EDIT',
        'A record edit must change the expiration or the launched quantity',
      );
      if (movement.expiresOn !== undefined) assertDate(movement.expiresOn);
      if (movement.quantity !== undefined) assertQuantity(movement.quantity, true);
      break;
    case 'RECORD_DELETE':
      assertIdentifier(movement.stockRecordId, 'stockRecordId');
      break;
    case 'VOID_MOVEMENT':
      assertIdentifier(movement.originalMovementId, 'originalMovementId');
      break;
    case 'APP_RECEIPT':
    case 'RETURN_RECEIPT':
      assertQuantity(movement.quantity);
      assertIdentifier(movement.stockRecordId, 'stockRecordId');
      if (movement.expiresOn !== undefined) assertDate(movement.expiresOn);
      if (movement.type === 'APP_RECEIPT')
        invariant(movement.expiresOn, 'MISSING_EXPIRATION', 'App receipt expiration is required');
      normalizeLotCode(movement.lotCode);
      break;
    case 'SCRAP':
      assertQuantity(movement.quantity);
      assertIdentification(movement.identification);
      break;
    case 'SALE':
      assertQuantity(movement.quantity);
      break;
    default:
      invariant(false, 'INVALID_MOVEMENT_TYPE', 'Unknown inventory movement type');
  }
}

/**
 * Pure, deterministic projection of one product in one store.
 *
 * The adapter supplies stable IDs, all relevant canonical facts/resolutions and an
 * explicit clock. This function performs no writes and does not mutate its input.
 * Persist its complete result atomically under the product lock. Unknown products,
 * inbox payload hashes, permission checks and the five-minute ingestion tolerance
 * belong to the application/integration boundary, not to this historical replay.
 */
export function rebuildInventory(input: RebuildInventoryInput): InventoryProjection {
  return replay(input, null)!;
}

/**
 * A mesma reconstrução, partindo de um retrato (`ReplayCheckpoint`) em vez da contagem: só os
 * fatos depois da posição dele são refeitos, e o resultado é o da reconstrução completa — as
 * alocações e os resultados devolvidos são só os dos fatos refeitos. Devolve `null` quando
 * algo anterior à posição mudou (fato atrasado, cancelamento de fato anterior, exclusão de
 * registro, classificação, outra contagem): aí só a reconstrução completa serve.
 */
export function resumeInventory(
  input: RebuildInventoryInput,
  resume: ResumeInput,
): InventoryProjection | null {
  return replay(input, resume);
}

/** Um fato com o instante, a ordem de entrada e a chave já calculados. */
interface Prepared {
  readonly movement: InventoryMovement;
  readonly at: bigint;
  readonly inbound: number;
  readonly key: string;
}
type Ordered = Pick<Prepared, 'at' | 'inbound' | 'key'>;

const isIngress = (movement: InventoryMovement) =>
  movement.type === 'APP_RECEIPT' || movement.type === 'RETURN_RECEIPT';
const prepare = (movement: InventoryMovement): Prepared => ({
  movement,
  at: timestampMicros(movement.occurredAt),
  inbound: isIngress(movement) ? 0 : 1,
  key: canonicalEventKey(movement),
});
/** Ordem canônica da reconstrução: instante, entradas antes das saídas, chave do evento. */
const replayOrder = (a: Ordered, b: Ordered): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.inbound - b.inbound || compareText(a.key, b.key);

function replay(
  input: RebuildInventoryInput,
  resume: ResumeInput | null,
): InventoryProjection | null {
  assertIdentifier(input.storeId, 'storeId');
  assertIdentifier(input.productId, 'productId');
  const asOf = timestampMicros(input.projectionAsOf);
  const snapshotAt = input.snapshotAt === undefined ? null : timestampMicros(input.snapshotAt);
  invariant(
    input.trackingStatus === 'TRACKED' || input.trackingStatus === 'UNTRACKED',
    'INVALID_TRACKING_STATUS',
    'Invalid tracking status',
  );
  invariant(
    input.trackingStatus === 'TRACKED' ? input.baseline !== null : input.baseline === null,
    'INVALID_BASELINE',
    'Tracked products require exactly one current baseline',
  );

  const movements = new Map<string, Prepared>();
  const sourceKeys = new Map<string, string>();
  for (const movement of input.movements) {
    validateMovement(movement, input);
    const previous = movements.get(movement.id);
    invariant(
      !previous || canonicalJson(previous.movement) === canonicalJson(movement),
      'EVENT_PAYLOAD_CONFLICT',
      'An immutable movement ID cannot change its payload',
    );
    const prepared = previous ?? prepare(movement);
    invariant(
      !sourceKeys.has(prepared.key) || sourceKeys.get(prepared.key) === movement.id,
      'EVENT_IDENTITY_CONFLICT',
      'A canonical source event must retain its movement ID',
    );
    movements.set(movement.id, prepared);
    sourceKeys.set(prepared.key, movement.id);
  }
  const references = new Map<string, Prepared>();
  for (const movement of resume?.references ?? []) {
    validateMovement(movement, input);
    if (!movements.has(movement.id)) references.set(movement.id, prepare(movement));
  }
  const find = (id: string) => movements.get(id) ?? references.get(id);
  // Classificações valem desde o fato classificado: com elas, só a reconstrução completa.
  if (resume && (input.resolutions?.length ?? 0) > 0) return null;

  const resolutions = new Map<string, MovementResolution>();
  const resolutionIds = new Map<string, MovementResolution>();
  const resolutionVersions = new Set<string>();
  for (const resolution of input.resolutions ?? []) {
    assertIdentifier(resolution.id, 'resolution.id');
    assertScope(resolution, input.storeId, input.productId);
    const effectiveAt = timestampMicros(resolution.effectiveAt);
    invariant(
      Number.isSafeInteger(resolution.version) && resolution.version > 0,
      'INVALID_RESOLUTION_VERSION',
      'Resolution version must be a positive integer',
    );
    const movement = movements.get(resolution.movementId)?.movement;
    invariant(
      movement && (movement.type === 'SCRAP' || movement.type === 'RETURN_RECEIPT'),
      'INVALID_RESOLUTION_REFERENCE',
      'Only a known scrap or physical return can be classified',
    );
    assertIdentification(resolution.identification);
    if (resolution.expiresOn !== undefined) assertDate(resolution.expiresOn);
    normalizeLotCode(resolution.lotCode);
    const previousId = resolutionIds.get(resolution.id);
    invariant(
      !previousId || canonicalJson(previousId) === canonicalJson(resolution),
      'RESOLUTION_PAYLOAD_CONFLICT',
      'A classification ID cannot change its payload',
    );
    if (previousId) continue;
    resolutionIds.set(resolution.id, resolution);
    const versionKey = canonicalJson([resolution.movementId, resolution.version]);
    invariant(
      !resolutionVersions.has(versionKey),
      'RESOLUTION_VERSION_CONFLICT',
      'A movement classification version must be unique',
    );
    resolutionVersions.add(versionKey);
    if (effectiveAt > asOf) continue;
    const current = resolutions.get(resolution.movementId);
    if (
      !current ||
      compareTimestamps(current.effectiveAt, resolution.effectiveAt) < 0 ||
      (compareTimestamps(current.effectiveAt, resolution.effectiveAt) === 0 &&
        current.version < resolution.version)
    ) {
      resolutions.set(resolution.movementId, resolution);
    }
  }

  const checkpoint = resume?.checkpoint ?? null;
  const records = new Map<string, MutableRecord>();
  /** Quantidade lançada de cada registro, depois das edições aplicadas até aqui. */
  const launched = new Map<string, number>();
  /** O que saiu de cada registro: vendas e descartes, e baixas manuais. */
  const outflows = new Map<string, { sold: number; writtenOff: number }>();
  // A exclusão vale desde o lançamento: o registro some da reconstrução inteira, e as vendas
  // que estavam nele procuram outros registros.
  const deleted = new Set<string>(checkpoint?.deleted ?? []);
  for (const { movement, at } of movements.values())
    if (movement.type === 'RECORD_DELETE' && at <= asOf) {
      // Exclusão nova depois do retrato: muda o passado.
      if (checkpoint && !deleted.has(movement.stockRecordId)) return null;
      deleted.add(movement.stockRecordId);
    }
  let expectedTotal = 0;
  const allocations: StockAllocation[] = [];
  /** Pendências do retrato, dos cancelamentos (com o instante deles) e da reconstrução. */
  const priorIssues: InventoryIssue[] = [...(checkpoint?.issues ?? [])];
  const voidIssues: { issue: InventoryIssue; at: bigint }[] = [];
  const replayIssues: InventoryIssue[] = [];
  let countWindowQuantity = 0;
  const results = new Map<string, MovementResult>();
  const putResult = (
    movement: InventoryMovement,
    status: MovementStatus,
    allocatedQuantity = 0,
    unallocatedQuantity = 0,
  ): void => {
    results.set(movement.id, {
      movementId: movement.id,
      status,
      allocatedQuantity,
      unallocatedQuantity,
    });
  };
  let snapshot: ReplayCheckpoint | undefined;
  let position: Ordered | null = null;
  const replayed: string[] = [];
  const finish = (): InventoryProjection => {
    const finalRecords = [...records.values()]
      .sort((a, b) => compareText(a.id, b.id))
      .map((record) => ({
        ...record,
        launchedQuantity: launched.get(record.id) ?? record.quantity,
      }));
    const totalQuantity = finalRecords.reduce((sum, record) => {
      assertQuantity(record.quantity, true);
      return safeQuantitySum(sum, record.quantity);
    }, 0);
    invariant(
      totalQuantity === expectedTotal,
      'CONSERVATION_VIOLATION',
      'Final balance must equal baseline plus ingresses minus allocated outgoings',
    );
    const issues = [...priorIssues, ...voidIssues.map((entry) => entry.issue), ...replayIssues];
    return {
      records: finalRecords,
      totalQuantity,
      allocations,
      issues: issues.sort(
        (a, b) => compareText(a.movementId, b.movementId) || compareText(a.code, b.code),
      ),
      movementResults: [...results.values()].sort((a, b) =>
        compareText(a.movementId, b.movementId),
      ),
      countWindowQuantity,
      ...(snapshot ? { checkpoint: snapshot } : {}),
      ...(checkpoint
        ? {
            resumedFrom: checkpoint.position,
            replayed,
            priorOutflows: new Map(
              checkpoint.records.map((record) => [
                record.id,
                { sold: record.sold, writtenOff: record.writtenOff },
              ]),
            ),
          }
        : {}),
    };
  };

  if (input.trackingStatus === 'UNTRACKED') {
    if (checkpoint) return null;
    for (const { movement } of movements.values()) putResult(movement, 'NOT_TRACKED');
    return finish();
  }
  const baseline = input.baseline;
  invariant(baseline, 'INVALID_BASELINE', 'A baseline is required');
  assertIdentifier(baseline.id, 'baseline.id');
  assertScope(baseline, input.storeId, input.productId);
  const cutoff = timestampMicros(baseline.cutoffAt);
  const countStarted = timestampMicros(baseline.countStartedAt);
  invariant(
    countStarted <= cutoff && cutoff <= asOf,
    'INVALID_COUNT_WINDOW',
    'Count start must precede cutoff and projection time',
  );
  if (checkpoint && (checkpoint.version !== 1 || checkpoint.epochId !== baseline.id)) return null;
  const baselineIds = new Set<string>();
  for (const record of baseline.records) {
    assertStockRecord(record, input.storeId, input.productId);
    invariant(
      !baselineIds.has(record.id),
      'DUPLICATE_RECORD',
      'Baseline record IDs must be unique',
    );
    invariant(
      timestampMicros(record.allocationPriorityAt) <= cutoff,
      'INVALID_RECORD_PRIORITY',
      'A baseline record cannot be launched after its cutoff',
    );
    baselineIds.add(record.id);
    if (checkpoint || deleted.has(record.id)) continue;
    expectedTotal = safeQuantitySum(expectedTotal, record.quantity);
    records.set(record.id, { ...record, lotCode: normalizeLotCode(record.lotCode) });
    launched.set(record.id, record.quantity);
  }
  if (checkpoint) {
    position = prepareOrder(checkpoint.position);
    for (const { launchedQuantity, sold, writtenOff, ...record } of checkpoint.records) {
      records.set(record.id, { ...record });
      launched.set(record.id, launchedQuantity);
      outflows.set(record.id, { sold, writtenOff });
    }
    expectedTotal = checkpoint.expectedTotal;
    countWindowQuantity = checkpoint.countWindowQuantity;
    // Cancelamento antigo à espera do original: se o original chegou, o passado mudou.
    for (const pending of checkpoint.pendingVoids) {
      const original = find(pending.originalId);
      if (original && original.at <= asOf) return null;
    }
  }
  /** Depois da posição do retrato (sem retrato, todos os fatos). */
  const afterPosition = (entry: Ordered) => !position || replayOrder(entry, position) > 0;

  const voided = new Set<string>(checkpoint?.voided ?? []);
  /** Originais cancelados nesta reconstrução, para o próximo retrato. */
  const newlyVoided: Prepared[] = [];
  const pendingVoids: { voidId: string; originalId: string; at: bigint }[] = [];
  const knownIngressIds = new Set([...baselineIds, ...(checkpoint?.ingressIds ?? [])]);
  const ingresses: Prepared[] = [];
  for (const prepared of movements.values()) {
    const { movement, at } = prepared;
    const after = afterPosition(prepared);
    // Fato gravado depois do retrato, mas anterior à posição dele: chegou atrasado.
    if (!after && resume?.fresh.has(movement.id)) return null;
    if (isIngress(movement) && after) {
      const { stockRecordId } = movement as { stockRecordId: string };
      // Pre-cut facts belong to previous epochs and their records may be omitted.
      if (at > cutoff) {
        invariant(
          !knownIngressIds.has(stockRecordId),
          'DUPLICATE_RECORD',
          'Each ingress requires its own stable stock record ID',
        );
        knownIngressIds.add(stockRecordId);
        ingresses.push(prepared);
      }
    }
    if (at > asOf) {
      putResult(movement, 'PENDING_FUTURE');
      continue;
    }
    if (movement.type !== 'VOID_MOVEMENT') continue;
    const original = find(movement.originalMovementId);
    if (!original || original.at > asOf) {
      putResult(movement, 'PENDING_REFERENCE');
      voidIssues.push({ issue: { code: 'PENDING_REFERENCE', movementId: movement.id }, at });
      pendingVoids.push({ voidId: movement.id, originalId: movement.originalMovementId, at });
      continue;
    }
    invariant(
      original.movement.type !== 'VOID_MOVEMENT' &&
        original.movement.type !== 'APP_RECEIPT' &&
        original.movement.source.kind === 'ERP' &&
        movement.source.kind === 'ERP' &&
        original.movement.source.connectionId === movement.source.connectionId,
      'INVALID_VOID_REFERENCE',
      'A documentary void must target a physical event from the same integration connection',
    );
    if (!afterPosition(original)) {
      // Cancelamento de um fato anterior à posição: só vale se o retrato já o tinha.
      if (!voided.has(original.movement.id)) return null;
    } else if (!voided.has(original.movement.id)) newlyVoided.push(original);
    voided.add(original.movement.id);
    putResult(movement, 'APPLIED');
  }

  const active: Prepared[] = [];
  for (const prepared of movements.values()) {
    const { movement, at } = prepared;
    if (!afterPosition(prepared)) continue;
    replayed.push(movement.id);
    if (movement.type === 'VOID_MOVEMENT' || at > asOf) continue;
    if (voided.has(movement.id)) {
      putResult(movement, 'VOIDED');
      continue;
    }
    if (countStarted <= at && at <= cutoff && PHYSICAL.has(movement.type))
      countWindowQuantity = safeQuantitySum(
        countWindowQuantity,
        (movement as { quantity: number }).quantity,
      );
    if (at <= cutoff) putResult(movement, 'COVERED_BY_COUNT');
    else active.push(prepared);
  }
  active.sort(replayOrder);

  const priorities = new Map<string, bigint>();
  const priority = (record: StockRecord): bigint => {
    let value = priorities.get(record.id);
    if (value === undefined) {
      value = timestampMicros(record.allocationPriorityAt);
      priorities.set(record.id, value);
    }
    return value;
  };
  const launchOrder = (a: StockRecord, b: StockRecord): number => {
    const left = priority(a);
    const right = priority(b);
    return left < right ? -1 : left > right ? 1 : compareText(a.id, b.id);
  };
  // Ordem FEFO dos registros com saldo, refeita só quando um registro entra ou é editado: as
  // vendas só tiram saldo, e um registro zerado não volta a ter saldo sem edição.
  let fefo: MutableRecord[] | null = null;
  let fefoHead = 0;
  const saleCandidates = (): MutableRecord[] => {
    if (!fefo) {
      fefo = [...records.values()]
        .filter((record) => record.quantity > 0)
        .sort((a, b) => compareText(a.expiresOn, b.expiresOn) || launchOrder(a, b));
      fefoHead = 0;
    }
    while (fefoHead < fefo.length && fefo[fefoHead]!.quantity === 0) fefoHead++;
    return fefo;
  };
  const take = (recordId: string, type: StockAllocation['type'], quantity: number) => {
    const entry = outflows.get(recordId) ?? { sold: 0, writtenOff: 0 };
    if (type === 'MANUAL_WRITE_OFF') entry.writtenOff += quantity;
    else entry.sold += quantity;
    outflows.set(recordId, entry);
  };
  const capture = (last: Prepared): ReplayCheckpoint => ({
    version: 1,
    epochId: baseline.id,
    position: { occurredAt: last.movement.occurredAt, inbound: last.inbound, key: last.key },
    records: [...records.values()]
      .sort((a, b) => compareText(a.id, b.id))
      .map((record) => ({
        ...record,
        launchedQuantity: launched.get(record.id) ?? record.quantity,
        sold: outflows.get(record.id)?.sold ?? 0,
        writtenOff: outflows.get(record.id)?.writtenOff ?? 0,
      })),
    expectedTotal,
    countWindowQuantity,
    issues: [
      ...priorIssues,
      ...voidIssues.filter((entry) => entry.at < last.at).map((entry) => entry.issue),
      ...replayIssues,
    ],
    deleted: [...deleted],
    voided: [
      ...(checkpoint?.voided ?? []),
      ...newlyVoided
        .filter((original) => replayOrder(original, last) <= 0)
        .map((original) => original.movement.id),
    ],
    pendingVoids: [
      ...(checkpoint?.pendingVoids ?? []),
      ...pendingVoids
        .filter((entry) => entry.at < last.at)
        .map(({ voidId, originalId }) => ({ voidId, originalId })),
    ],
    ingressIds: [
      ...(checkpoint?.ingressIds ?? []),
      ...ingresses
        .filter((entry) => replayOrder(entry, last) <= 0)
        .map((entry) => (entry.movement as { stockRecordId: string }).stockRecordId),
    ],
  });

  let snapshotPassed = snapshotAt === null;
  let lastApplied: Prepared | null = null;
  for (const prepared of active) {
    if (!snapshotPassed && prepared.at > snapshotAt!) {
      snapshotPassed = true;
      if (lastApplied) snapshot = capture(lastApplied);
    }
    apply(prepared);
    lastApplied = prepared;
  }
  if (!snapshotPassed && lastApplied) snapshot = capture(lastApplied);
  return finish();

  function apply({ movement }: Prepared): void {
    const resolution = resolutions.get(movement.id);
    if (movement.type === 'RECORD_DELETE') {
      putResult(movement, 'APPLIED');
      return;
    }
    if (movement.type === 'RECORD_EDIT') {
      const record = records.get(movement.stockRecordId);
      if (!record) {
        putResult(movement, 'RECORD_DELETED');
        return;
      }
      if (movement.expiresOn !== undefined) record.expiresOn = movement.expiresOn;
      if (movement.quantity !== undefined) {
        // A edição troca a quantidade lançada daqui em diante; as baixas já feitas ficam. Se
        // vendas que chegaram atrasadas deixarem o lançado abaixo do que já saiu, o saldo
        // para em zero e a diferença vira pendência, como a venda sem lote.
        const delta = movement.quantity - (launched.get(record.id) ?? record.quantity);
        const balance = record.quantity + delta;
        const applied = balance < 0 ? -record.quantity : delta;
        if (balance < 0)
          replayIssues.push({
            code: 'EDIT_BELOW_ALLOCATED',
            movementId: movement.id,
            quantity: -balance,
          });
        record.quantity += applied;
        expectedTotal += applied;
        launched.set(record.id, movement.quantity);
      }
      fefo = null;
      putResult(movement, 'APPLIED');
      return;
    }
    if (movement.type === 'MANUAL_WRITE_OFF' && deleted.has(movement.stockRecordId)) {
      putResult(movement, 'RECORD_DELETED');
      return;
    }
    if (movement.type === 'APP_RECEIPT' || movement.type === 'RETURN_RECEIPT') {
      if (deleted.has(movement.stockRecordId)) {
        putResult(movement, 'RECORD_DELETED');
        return;
      }
      const expiresOn = resolution?.expiresOn ?? movement.expiresOn;
      if (!expiresOn) {
        replayIssues.push({
          code: 'PENDING_STOCK_IDENTIFICATION',
          movementId: movement.id,
          quantity: movement.quantity,
        });
        putResult(movement, 'PENDING_STOCK_IDENTIFICATION', 0, movement.quantity);
        return;
      }
      expectedTotal = safeQuantitySum(expectedTotal, movement.quantity);
      records.set(movement.stockRecordId, {
        id: movement.stockRecordId,
        storeId: input.storeId,
        productId: input.productId,
        expiresOn,
        lotCode: normalizeLotCode(
          resolution?.lotCode !== undefined ? resolution.lotCode : movement.lotCode,
        ),
        quantity: movement.quantity,
        allocationPriorityAt: movement.occurredAt,
      });
      launched.set(movement.stockRecordId, movement.quantity);
      fefo = null;
      putResult(movement, 'APPLIED');
      return;
    }
    if (
      movement.type !== 'SALE' &&
      movement.type !== 'SCRAP' &&
      movement.type !== 'MANUAL_WRITE_OFF'
    )
      return;
    let candidates: MutableRecord[];
    let first = 0;
    if (movement.type === 'SALE') {
      candidates = saleCandidates();
      first = fefoHead;
    } else if (movement.type === 'MANUAL_WRITE_OFF') {
      // Só o registro escolhido: o excedente não sai de outro lote.
      const record = records.get(movement.stockRecordId);
      candidates = record && record.quantity > 0 ? [record] : [];
    } else {
      const matches = identifyScrapRecords(resolution?.identification ?? movement.identification, [
        ...records.values(),
      ]);
      if (matches === null) {
        replayIssues.push({
          code: 'PENDING_STOCK_IDENTIFICATION',
          movementId: movement.id,
          quantity: movement.quantity,
        });
        putResult(movement, 'PENDING_STOCK_IDENTIFICATION', 0, movement.quantity);
        return;
      }
      candidates = matches.filter((record) => record.quantity > 0).sort(launchOrder);
    }
    let remaining = movement.quantity;
    for (let index = first; index < candidates.length; index++) {
      const record = candidates[index]!;
      if (remaining === 0) break;
      if (record.quantity === 0) continue;
      const quantity = Math.min(record.quantity, remaining);
      record.quantity -= quantity;
      remaining -= quantity;
      take(record.id, movement.type, quantity);
      allocations.push({
        movementId: movement.id,
        stockRecordId: record.id,
        quantity,
        type: movement.type,
      });
    }
    const allocated = movement.quantity - remaining;
    expectedTotal -= allocated;
    invariant(
      allocated + remaining === movement.quantity,
      'CONSERVATION_VIOLATION',
      'Outgoing quantities must be conserved',
    );
    if (remaining > 0)
      replayIssues.push({
        code:
          movement.type === 'SALE'
            ? 'UNALLOCATED_QUANTITY'
            : movement.type === 'SCRAP'
              ? 'UNALLOCATED_SCRAP'
              : 'UNALLOCATED_WRITE_OFF',
        movementId: movement.id,
        quantity: remaining,
      });
    putResult(movement, 'APPLIED', allocated, remaining);
  }
}

function prepareOrder(position: ReplayPosition): Ordered {
  return { at: timestampMicros(position.occurredAt), inbound: position.inbound, key: position.key };
}

function identifyScrapRecords(
  identification: StockIdentification | undefined,
  records: MutableRecord[],
): MutableRecord[] | null {
  if (!identification) return null;
  let matches = records;
  if (identification.stockRecordId !== undefined)
    matches = matches.filter((record) => record.id === identification.stockRecordId);
  const lotSpecified = identification.lotCode !== undefined;
  if (lotSpecified)
    matches = matches.filter(
      (record) => normalizeLotCode(record.lotCode) === normalizeLotCode(identification.lotCode),
    );
  if (identification.expiresOn !== undefined)
    matches = matches.filter((record) => record.expiresOn === identification.expiresOn);
  if (matches.length === 0) return null;
  if (identification.stockRecordId !== undefined) return matches;
  // An explicit null lot identifies records without a supplier lot number.
  if (!lotSpecified) return null;
  if (identification.expiresOn !== undefined) return matches;
  // A textual lot alone is sufficient only when it maps to one expiration date.
  if (
    normalizeLotCode(identification.lotCode) === null ||
    new Set(matches.map((record) => record.expiresOn)).size !== 1
  )
    return null;
  return matches;
}
