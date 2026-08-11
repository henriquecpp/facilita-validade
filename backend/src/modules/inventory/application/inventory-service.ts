import type { TenantActor } from '../../../shared/domain/context.js';
import type {
  InventoryPort,
  CountAction,
  ReceiptInput,
  WriteOffInput,
  RecordEditInput,
} from './inventory-port.js';
export class InventoryService {
  constructor(readonly repository: InventoryPort) {}
  createCount(actor: TenantActor, key: string, productId: string) {
    return this.repository.createCount(actor, key, productId);
  }
  /** Qualquer papel da loja conta, confirma e cancela: quem contou é quem confirma. */
  updateCount(actor: TenantActor, key: string, id: string, action: CountAction) {
    return this.repository.updateCount(actor, key, id, action);
  }
  receive(actor: TenantActor, key: string, input: ReceiptInput) {
    return this.repository.receive(actor, key, input);
  }
  /** Qualquer papel da loja dá baixa manual e exclui lote, no aplicativo e no painel. */
  writeOff(actor: TenantActor, key: string, id: string, input: WriteOffInput) {
    return this.repository.writeOff(actor, key, id, input);
  }
  deleteRecord(actor: TenantActor, key: string, id: string, expectedVersion: number) {
    return this.repository.deleteRecord(actor, key, id, expectedVersion);
  }
  /** Só o proprietário edita, e só pelo painel; o repositório confere o papel. */
  editRecord(actor: TenantActor, key: string, id: string, input: RecordEditInput) {
    return this.repository.editRecord(actor, key, id, input);
  }
}
