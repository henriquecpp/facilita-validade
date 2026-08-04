/** Values cross this boundary as ISO dates/UTC timestamps, never as a local clock. */
export type TrackingStatus = 'TRACKED' | 'UNTRACKED';

export interface StockRecord {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly expiresOn: string;
  readonly lotCode?: string | null;
  readonly quantity: number;
  readonly allocationPriorityAt: string;
  /**
   * Quantidade lançada no registro, depois das edições. Só na projeção: na referência da
   * contagem, a quantidade lançada é a própria `quantity`.
   */
  readonly launchedQuantity?: number;
}

export interface InventoryBaseline {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly cutoffAt: string;
  readonly countStartedAt: string;
  readonly records: readonly StockRecord[];
}

export type MovementSource =
  | { readonly kind: 'ERP'; readonly connectionId: string; readonly externalEventId: string }
  | { readonly kind: 'APP'; readonly commandId: string };

interface MovementBase {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly occurredAt: string;
  readonly source: MovementSource;
}

export interface SaleMovement extends MovementBase {
  readonly type: 'SALE';
  readonly quantity: number;
}

export interface StockIdentification {
  readonly stockRecordId?: string;
  readonly lotCode?: string | null;
  readonly expiresOn?: string;
}

export interface ScrapMovement extends MovementBase {
  readonly type: 'SCRAP';
  readonly quantity: number;
  readonly identification?: StockIdentification;
}

export interface ReceiptMovement extends MovementBase {
  readonly type: 'RETURN_RECEIPT' | 'APP_RECEIPT';
  readonly quantity: number;
  /** Persist this ID when accepting the fact; never create a new ID on replay. */
  readonly stockRecordId: string;
  /** May be missing in a return awaiting manager classification. */
  readonly expiresOn?: string;
  readonly lotCode?: string | null;
  /** Quem lançou a entrada do aplicativo; informativo, a reconstrução não usa. */
  readonly actorId?: string;
}

export interface VoidMovement extends MovementBase {
  readonly type: 'VOID_MOVEMENT';
  readonly originalMovementId: string;
}

/**
 * Baixa manual de um registro, pelo aplicativo ou pelo painel: sai só daquele registro, até
 * o saldo dele. Na reconstrução, como o scrap identificado: o excedente vira pendência.
 */
export interface ManualWriteOffMovement extends MovementBase {
  readonly type: 'MANUAL_WRITE_OFF';
  readonly quantity: number;
  readonly stockRecordId: string;
  readonly reason?: string | null;
  readonly actorId?: string;
}

/**
 * Edição de validade e/ou quantidade lançada de um registro, só pelo painel. Vale do instante
 * da edição em diante: as baixas anteriores ficam como estão.
 */
export interface RecordEditMovement extends MovementBase {
  readonly type: 'RECORD_EDIT';
  readonly stockRecordId: string;
  readonly expiresOn?: string;
  /** Nova quantidade lançada. */
  readonly quantity?: number;
  /** Valores antes da edição, só para o histórico; a reconstrução não os usa. */
  readonly previous?: { readonly expiresOn: string; readonly quantity: number };
  readonly actorId?: string;
}

/**
 * Exclusão de um registro. Retroativa: a reconstrução passa a desconsiderar o registro desde
 * o lançamento, e as vendas que estavam nele vão para os outros registros ou ficam sem lote.
 */
export interface RecordDeleteMovement extends MovementBase {
  readonly type: 'RECORD_DELETE';
  readonly stockRecordId: string;
  readonly actorId?: string;
}

/** Fatos de comandos do aplicativo e do painel sobre registros já lançados. */
export type RecordCorrection = ManualWriteOffMovement | RecordEditMovement | RecordDeleteMovement;

export type InventoryMovement =
  SaleMovement | ScrapMovement | ReceiptMovement | VoidMovement | RecordCorrection;

/** Append-only classification; largest (effectiveAt, version, id) effective as of replay wins. */
export interface MovementResolution {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly movementId: string;
  readonly effectiveAt: string;
  readonly version: number;
  readonly identification?: StockIdentification;
  readonly expiresOn?: string;
  readonly lotCode?: string | null;
}

export interface RebuildInventoryInput {
  readonly storeId: string;
  readonly productId: string;
  readonly trackingStatus: TrackingStatus;
  readonly baseline: InventoryBaseline | null;
  readonly movements: readonly InventoryMovement[];
  readonly resolutions?: readonly MovementResolution[];
  readonly projectionAsOf: string;
  /**
   * Instante do retrato: a reconstrução devolve em `checkpoint` o estado depois do último fato
   * até esse instante, para a próxima começar dele. Sem ele, não há retrato.
   */
  readonly snapshotAt?: string;
}

/** Posição de um fato na ordem da reconstrução: instante, entradas antes de saídas, chave. */
export interface ReplayPosition {
  readonly occurredAt: string;
  /** 0 para entradas (do aplicativo e devoluções), 1 para os demais fatos. */
  readonly inbound: number;
  /** `canonicalEventKey` do fato. */
  readonly key: string;
}

/** Um registro no retrato: o saldo em `quantity` e o que já saiu dele. */
export interface CheckpointRecord extends StockRecord {
  readonly launchedQuantity: number;
  readonly sold: number;
  readonly writtenOff: number;
}

/**
 * Estado da reconstrução de um produto logo depois do fato em `position`. A reconstrução
 * seguinte parte dele e só refaz os fatos posteriores, desde que nada anterior tenha mudado:
 * fato atrasado, cancelamento de fato anterior, exclusão de registro ou classificação levam
 * de volta à reconstrução completa.
 */
export interface ReplayCheckpoint {
  readonly version: 1;
  readonly epochId: string;
  readonly position: ReplayPosition;
  readonly records: readonly CheckpointRecord[];
  readonly expectedTotal: number;
  readonly countWindowQuantity: number;
  /** Pendências dos fatos até a posição e dos cancelamentos de instante anterior ao dela. */
  readonly issues: readonly InventoryIssue[];
  /** Registros excluídos (a exclusão vale desde o lançamento). */
  readonly deleted: readonly string[];
  /** Fatos até a posição já cancelados. */
  readonly voided: readonly string[];
  /** Cancelamentos de instante anterior ao da posição cujo original ainda não valia. */
  readonly pendingVoids: readonly { readonly voidId: string; readonly originalId: string }[];
  /** Registros de entradas depois do corte, até a posição: a mesma entrada não se repete. */
  readonly ingressIds: readonly string[];
}

/** O que a retomada recebe além do que a reconstrução completa recebe. */
export interface ResumeInput {
  readonly checkpoint: ReplayCheckpoint;
  /**
   * Ids, entre os fatos recebidos, gravados depois do retrato. Em `movements` vêm só os fatos de
   * instante igual ou posterior ao da posição.
   */
  readonly fresh: ReadonlySet<string>;
  /** Originais de cancelamentos que não estão entre os fatos recebidos, quando existem. */
  readonly references: readonly InventoryMovement[];
}

export interface StockAllocation {
  readonly movementId: string;
  readonly stockRecordId: string;
  readonly quantity: number;
  readonly type: 'SALE' | 'SCRAP' | 'MANUAL_WRITE_OFF';
}

export type InventoryIssueCode =
  | 'UNALLOCATED_QUANTITY'
  | 'UNALLOCATED_SCRAP'
  | 'UNALLOCATED_WRITE_OFF'
  | 'EDIT_BELOW_ALLOCATED'
  | 'PENDING_STOCK_IDENTIFICATION'
  | 'PENDING_REFERENCE';

export interface InventoryIssue {
  readonly code: InventoryIssueCode;
  readonly movementId: string;
  readonly quantity?: number;
}

export type MovementStatus =
  | 'APPLIED'
  | 'VOIDED'
  | 'COVERED_BY_COUNT'
  | 'PENDING_FUTURE'
  | 'PENDING_REFERENCE'
  | 'PENDING_STOCK_IDENTIFICATION'
  | 'NOT_TRACKED'
  /** Fato de um registro excluído, ou correção de um registro que não existe na época atual. */
  | 'RECORD_DELETED';

export interface MovementResult {
  readonly movementId: string;
  readonly status: MovementStatus;
  readonly allocatedQuantity: number;
  readonly unallocatedQuantity: number;
}

export interface InventoryProjection {
  /** Stable ID order. quantity is the final derived balance, including zero records. */
  readonly records: readonly StockRecord[];
  readonly totalQuantity: number;
  /** Canonical event order, then allocation priority; never reception order. */
  readonly allocations: readonly StockAllocation[];
  readonly issues: readonly InventoryIssue[];
  readonly movementResults: readonly MovementResult[];
  /**
   * Units physically moved between count start and cutoff. The count covers them (never
   * deducted again), so this is the largest possible divergence of the snapshot. Informative
   * only: it never blocks a confirmation nor requires a recount.
   */
  readonly countWindowQuantity: number;
  /** Retrato pedido em `snapshotAt`, quando houve fato até aquele instante. */
  readonly checkpoint?: ReplayCheckpoint;
  /**
   * Só na retomada: a posição de onde ela continuou, os fatos recebidos depois dela (as
   * alocações em `allocations` e os resultados em `movementResults` são só deles) e o que já
   * tinha saído de cada registro até a posição.
   */
  readonly resumedFrom?: ReplayPosition;
  readonly replayed?: readonly string[];
  readonly priorOutflows?: ReadonlyMap<
    string,
    { readonly sold: number; readonly writtenOff: number }
  >;
}

export type CountLine = StockRecord;

export interface ConfirmCountInput {
  readonly baselineId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly countStartedAt: string;
  /**
   * Server instant of the last saved count line; for a count confirmed without lines, the
   * confirmation instant. Physical movements up to this instant are covered by the count.
   */
  readonly cutoffAt: string;
  readonly lines: readonly CountLine[];
  readonly completeProductConfirmed: boolean;
  readonly emptyProductConfirmed: boolean;
}
