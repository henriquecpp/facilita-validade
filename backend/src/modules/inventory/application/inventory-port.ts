import type { ListOptions } from '../../../shared/domain/pagination.js';
import type { TenantActor } from '../../../shared/domain/context.js';
export interface CountLineInput {
  id: string;
  expiresOn: string;
  quantity: number;
  lotCode?: string;
  note?: string;
}
export interface ReceiptInput {
  productId: string;
  quantity: number;
  expiresOn: string;
  lotCode?: string;
  note?: string;
}
/** Baixa manual de um lote: até o saldo dele, com motivo opcional. */
export interface WriteOffInput {
  expectedVersion: number;
  quantity: number;
  reason?: string;
}
/** Edição pelo painel: validade e/ou quantidade lançada. */
export interface RecordEditInput {
  expectedVersion: number;
  expiresOn?: string;
  quantity?: number;
}
export interface ExpiryOptions {
  cursor?: string;
  limit?: number;
  /** Um nível da loja, ou `NONE` para os lotes fora de todos. */
  levelId?: string;
  /** Só os lotes nos níveis que avisam. */
  notify?: boolean;
}
/** Lista de produtos da loja: busca por nome ou código de barras e filtros. */
export interface ProductListOptions {
  cursor?: string;
  limit?: number;
  search?: string;
  trackingStatus?: 'TRACKED' | 'UNTRACKED';
  /** Grupo do ERP (`529`) ou grupo e categoria (`529/889`). */
  category?: string;
}
export interface HistoryOptions {
  cursor?: string;
  limit?: number;
  /** Só as movimentações daquele lote. */
  recordId?: string;
}
export type CountAction =
  | { type: 'lines'; expectedVersion: number; lines: CountLineInput[] }
  | {
      type: 'confirm';
      expectedVersion: number;
      completeConfirmed: boolean;
      emptyConfirmed?: boolean;
    }
  | { type: 'cancel'; expectedVersion: number; reason: string };
export interface InventoryPort {
  list(storeId: string, options?: ProductListOptions): Promise<unknown>;
  detail(storeId: string, productId: string): Promise<unknown>;
  counts(storeId: string, options?: ListOptions): Promise<unknown>;
  count(storeId: string, id: string): Promise<unknown>;
  createCount(actor: TenantActor, key: string, productId: string): Promise<unknown>;
  updateCount(actor: TenantActor, key: string, id: string, action: CountAction): Promise<unknown>;
  receive(actor: TenantActor, key: string, input: ReceiptInput): Promise<unknown>;
  history(storeId: string, productId: string, options?: HistoryOptions): Promise<unknown>;
  closedRecords(
    storeId: string,
    productId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<unknown>;
  writeOff(actor: TenantActor, key: string, id: string, input: WriteOffInput): Promise<unknown>;
  deleteRecord(
    actor: TenantActor,
    key: string,
    id: string,
    expectedVersion: number,
  ): Promise<unknown>;
  editRecord(actor: TenantActor, key: string, id: string, input: RecordEditInput): Promise<unknown>;
  metadata(
    actor: TenantActor,
    key: string,
    id: string,
    expectedVersion: number,
    note: string,
  ): Promise<unknown>;
}
