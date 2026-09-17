import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../generated/prisma/client.js';
import type { Role } from '../../../../shared/domain/context.js';
import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import type {
  ConsumedPairing,
  NewPairing,
  PairableUser,
  PairingPersistence,
  PairingRepository,
} from '../../application/pairing-port.js';

class PrismaPairingRepository implements PairingRepository {
  constructor(
    private readonly tx: PrismaTx,
    private readonly storeId: string,
  ) {}

  async user(id: string): Promise<PairableUser | undefined> {
    // O RLS já restringe à loja da transação: um id de outra loja volta vazio.
    const row = await this.tx.store_users.findUnique({
      where: { id },
      select: { id: true, username: true, role: true, active: true, must_change_password: true },
    });
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role as Role,
      active: row.active,
      mustChangePassword: row.must_change_password,
    };
  }

  async insert(pairing: NewPairing): Promise<void> {
    await this.tx.device_pairings.create({
      data: {
        id: pairing.id,
        store_id: this.storeId,
        user_id: pairing.userId,
        token_hash: pairing.tokenHash,
        issued_by: pairing.issuedBy,
        expires_at: pairing.expiresAt,
      },
      select: { id: true },
    });
  }

  async consume(id: string, now: Date): Promise<ConsumedPairing | undefined> {
    // Um único UPDATE condicional. Leituras simultâneas do mesmo QR disputam a
    // linha: a segunda espera o commit da primeira e, ao reavaliar o WHERE, já
    // encontra consumed_at preenchido e não altera nada.
    const updated = await this.tx.device_pairings.updateMany({
      where: { id, consumed_at: null, expires_at: { gt: now } },
      data: { consumed_at: now },
    });
    if (updated.count !== 1) return undefined;
    const row = await this.tx.device_pairings.findUnique({
      where: { id },
      select: { user_id: true, issued_by: true },
    });
    return row ? { userId: row.user_id, issuedBy: row.issued_by } : undefined;
  }

  async audit(
    actorId: string,
    action: string,
    entityId: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.tx.audit_events.create({
      data: {
        id: randomUUID(),
        store_id: this.storeId,
        actor_id: actorId,
        action,
        entity_id: entityId,
        detail: detail as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
  }
}

export class PrismaPairingPersistence implements PairingPersistence {
  constructor(private readonly prisma: PrismaDatabase) {}

  async resolve(tokenHash: string) {
    // Papel de pré-autenticação: só executa a função SECURITY DEFINER, sem ler tabelas.
    const rows = await this.prisma.auth.$queryRaw<{ store_id: string; pairing_id: string }[]>`
      SELECT store_id, pairing_id FROM auth.resolve_device_pairing(${tokenHash})`;
    const row = rows[0];
    return row ? { storeId: row.store_id, pairingId: row.pairing_id } : undefined;
  }

  tenant<T>(storeId: string, action: (repository: PairingRepository) => Promise<T>): Promise<T> {
    return this.prisma.tenant(storeId, (tx) => action(new PrismaPairingRepository(tx, storeId)));
  }
}
