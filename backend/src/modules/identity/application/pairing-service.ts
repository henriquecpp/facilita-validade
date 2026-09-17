import { ApplicationError, requireRole, type TenantActor } from '../../../shared/domain/context.js';
import {
  formatPairingCode,
  PAIRING_TTL_SECONDS,
  pairingRefusal,
  parsePairingCode,
  type PairingRefusal,
} from '../domain/pairing.js';
import type { IdentityClock, IdentityCrypto } from './identity-port.js';
import type { DeviceSessionIssuer, PairingPersistence } from './pairing-port.js';
import type { SessionResult } from './auth-service.js';

// Genérico de propósito, como o de login: não revela se o código existiu, expirou
// ou já foi usado.
const invalidPairing = () =>
  new ApplicationError(
    'INVALID_PAIRING',
    'Código de pareamento inválido ou expirado. Gere um novo no painel.',
    401,
  );

// Fábricas, não instâncias: cada recusa lança um erro novo, com a própria pilha.
const REFUSALS: Record<PairingRefusal, () => ApplicationError> = {
  INACTIVE: () => new ApplicationError('USER_NOT_FOUND', 'Usuário não encontrado.', 404),
  NOT_OPERATOR: () =>
    new ApplicationError(
      'PAIRING_NOT_OPERATOR',
      'Só operadores podem entrar no coletor por QR. Proprietário e gestor entram com senha.',
      422,
    ),
  PASSWORD_PENDING: () =>
    new ApplicationError(
      'PAIRING_PASSWORD_PENDING',
      'Este operador ainda tem senha provisória. Ele precisa trocá-la no painel antes do pareamento.',
      422,
    ),
};

export interface IssuedPairing {
  code: string;
  expiresAt: string;
  user: { id: string; username: string };
}

export class PairingService {
  constructor(
    private readonly persistence: PairingPersistence,
    private readonly sessions: DeviceSessionIssuer,
    private readonly crypto: IdentityCrypto,
    private readonly clock: IdentityClock,
  ) {}

  /** Gera o código que o painel mostra em QR. Só o proprietário. */
  async issue(actor: TenantActor, userId: string): Promise<IssuedPairing> {
    requireRole(actor, ['OWNER']);
    return this.persistence.tenant(actor.storeId, async (repository) => {
      const user = await repository.user(userId);
      if (!user) throw REFUSALS.INACTIVE();
      const refusal = pairingRefusal(user);
      if (refusal) throw REFUSALS[refusal]();
      const secret = this.crypto.opaqueToken();
      const expiresAt = new Date(this.clock.now().getTime() + PAIRING_TTL_SECONDS * 1000);
      const id = this.crypto.uuid();
      await repository.insert({
        id,
        userId: user.id,
        tokenHash: this.crypto.hashToken(secret),
        issuedBy: actor.userId,
        expiresAt,
      });
      await repository.audit(actor.userId, 'DEVICE_PAIRING_ISSUED', id, { userId: user.id });
      return {
        code: formatPairingCode(secret),
        expiresAt: expiresAt.toISOString(),
        user: { id: user.id, username: user.username },
      };
    });
  }

  /**
   * Troca o código lido pelo coletor por uma sessão.
   *
   * O consumo acontece antes da emissão da sessão, em transações separadas: se a
   * emissão falhar, o código já está gasto e o proprietário gera outro. Falha
   * fechada — nunca há código reutilizável nem sessão sem pareamento consumido.
   */
  async redeem(code: string): Promise<SessionResult> {
    const secret = parsePairingCode(code);
    if (!secret) throw invalidPairing();
    const resolved = await this.persistence.resolve(this.crypto.hashToken(secret));
    if (!resolved) throw invalidPairing();
    const consumed = await this.persistence.tenant(resolved.storeId, (repository) =>
      repository.consume(resolved.pairingId, this.clock.now()),
    );
    if (!consumed) throw invalidPairing();
    return this.sessions.issueDeviceSession(resolved.storeId, consumed.userId, {
      pairingId: resolved.pairingId,
      issuedBy: consumed.issuedBy,
    });
  }
}
