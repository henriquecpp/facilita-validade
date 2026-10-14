import { ApplicationError } from '../../../shared/domain/context.js';
import {
  normalizeCnpj,
  normalizeUsername,
  validatePassword,
} from '../../identity/domain/identity.js';
import {
  PLATFORM_SESSION_SECONDS,
  normalizeStoreName,
  requireReason,
  type PlatformActor,
  type PlatformAdmin,
  type PlatformOperator,
} from '../domain/platform.js';
import type { PagonetGateway, PlatformCrypto, PlatformPersistence } from './platform-port.js';

/** O segredo do cookie: 32 bytes em base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const invalidLogin = () =>
  new ApplicationError('INVALID_CREDENTIALS', 'Usuário ou senha não conferem.', 401);
const unauthorized = () =>
  new ApplicationError('UNAUTHORIZED', 'Entre no painel da plataforma para continuar.', 401);
const storeNotFound = () => new ApplicationError('STORE_NOT_FOUND', 'Loja não encontrada.', 404);

const operator = (actor: PlatformActor): PlatformOperator => ({
  operator: actor.username,
  adminId: actor.adminId,
});

/**
 * Casos de uso do painel da plataforma (super admin): entrar, cadastrar lojas, suspender e
 * reativar, devolver o acesso a um proprietário e acompanhar o histórico. Toda chamada, menos
 * entrar e sair, chega aqui já autenticada pelo guard da plataforma.
 */
export class PlatformService {
  constructor(
    private readonly persistence: PlatformPersistence,
    private readonly crypto: PlatformCrypto,
    private readonly pagonet: PagonetGateway,
  ) {}

  async login(username: string, password: string) {
    let normalized: string | undefined;
    try {
      normalized = normalizeUsername(username);
    } catch {
      normalized = undefined;
    }
    const admin = normalized ? await this.persistence.admin(normalized) : undefined;
    if (!admin) {
      // Quem não existe espera o mesmo que quem errou a senha.
      await this.crypto.dummyVerify(password);
      throw invalidLogin();
    }
    if (!(await this.crypto.verifyPassword(admin.passwordHash, password))) throw invalidLogin();
    const token = this.crypto.opaqueToken();
    const session = await this.persistence.openSession(
      admin.id,
      this.crypto.hashToken(token),
      PLATFORM_SESSION_SECONDS,
    );
    const view: PlatformAdmin = {
      id: admin.id,
      username: admin.username,
      mustChangePassword: admin.mustChangePassword,
    };
    return { token, expiresAt: session.expiresAt, admin: view };
  }

  async authenticate(token: string | undefined): Promise<PlatformActor> {
    if (!token || !TOKEN.test(token)) throw unauthorized();
    const session = await this.persistence.session(this.crypto.hashToken(token));
    if (!session) throw unauthorized();
    return {
      adminId: session.adminId,
      username: session.username,
      sessionId: session.sessionId,
      mustChangePassword: session.mustChangePassword,
    };
  }

  async logout(token: string | undefined) {
    if (token && TOKEN.test(token))
      await this.persistence.closeSession(this.crypto.hashToken(token));
    return { loggedOut: true };
  }

  me(actor: PlatformActor): PlatformAdmin {
    return {
      id: actor.adminId,
      username: actor.username,
      mustChangePassword: actor.mustChangePassword,
    };
  }

  async changePassword(actor: PlatformActor, currentPassword: string, newPassword: string) {
    validatePassword(newPassword);
    if (currentPassword === newPassword)
      throw new ApplicationError('PASSWORD_UNCHANGED', 'Defina uma senha diferente da atual.', 400);
    const admin = await this.persistence.admin(normalizeUsername(actor.username));
    if (!admin || admin.id !== actor.adminId) throw unauthorized();
    // 422, não 401: senha atual errada não é sessão inválida.
    if (!(await this.crypto.verifyPassword(admin.passwordHash, currentPassword)))
      throw new ApplicationError('CURRENT_PASSWORD_INVALID', 'A senha atual não confere.', 422);
    const changed = await this.persistence.changePassword(
      actor.sessionId,
      await this.crypto.hashPassword(newPassword),
    );
    if (!changed) throw unauthorized();
    return { id: actor.adminId, username: actor.username, mustChangePassword: false };
  }

  async stores() {
    return { items: await this.persistence.stores(), nextCursor: null };
  }

  async store(storeId: string) {
    const store = await this.persistence.store(storeId);
    if (!store) throw storeNotFound();
    return store;
  }

  /**
   * Cadastra a loja com o proprietário. A senha provisória é gerada aqui e sai uma vez só,
   * nesta resposta; no primeiro acesso, o proprietário troca. Perdida a resposta, o caminho é
   * gerar acesso novo para ele.
   */
  async createStore(
    actor: PlatformActor,
    input: { cnpj: string; name: string; ownerUsername: string },
  ) {
    const cnpj = normalizeCnpj(input.cnpj);
    const name = normalizeStoreName(input.name);
    const usernameNormalized = normalizeUsername(input.ownerUsername);
    const temporaryPassword = this.crypto.temporaryPassword();
    const storeId = this.crypto.uuid();
    const ownerId = this.crypto.uuid();
    await this.persistence.createStore({
      storeId,
      cnpj,
      name,
      ownerId,
      username: input.ownerUsername.trim(),
      usernameNormalized,
      passwordHash: await this.crypto.hashPassword(temporaryPassword),
      by: operator(actor),
    });
    return {
      store: await this.store(storeId),
      owner: { id: ownerId, username: input.ownerUsername.trim(), temporaryPassword },
    };
  }

  /**
   * Suspensa, a loja some do login, as sessões abertas param na próxima requisição, as chaves
   * de integração deixam de valer e o worker deixa de processá-la (Pagonet e alertas). Os
   * dados ficam: reativar devolve tudo como estava.
   */
  suspend(actor: PlatformActor, storeId: string, reason: string) {
    return this.setActive(actor, storeId, false, reason);
  }

  reactivate(actor: PlatformActor, storeId: string, reason: string) {
    return this.setActive(actor, storeId, true, reason);
  }

  /** Link de uso único (30 minutos) para o proprietário definir uma senha nova. */
  async ownerAccess(actor: PlatformActor, storeId: string, ownerId: string, reason: string) {
    const why = requireReason(reason);
    const resetToken = this.crypto.opaqueToken();
    const result = await this.persistence.issueOwnerAccess({
      storeId,
      ownerId,
      tokenHash: this.crypto.hashToken(resetToken),
      // A senha anterior deixa de valer já; ninguém conhece esta.
      disabledPasswordHash: await this.crypto.hashPassword(this.crypto.opaqueToken()),
      reason: why,
      by: operator(actor),
    });
    if (result === 'STORE_NOT_FOUND') throw storeNotFound();
    if (result === 'STORE_SUSPENDED')
      throw new ApplicationError(
        'STORE_SUSPENDED',
        'A loja está suspensa. Reative antes de gerar acesso.',
        409,
      );
    if (result === 'OWNER_NOT_FOUND')
      throw new ApplicationError(
        'OWNER_NOT_FOUND',
        'Proprietário ativo não encontrado nessa loja.',
        404,
      );
    return { username: result.username, resetToken, expiresAt: result.expiresAt };
  }

  async history(cursor: string | undefined, limit: number) {
    const rows = await this.persistence.history(cursor, limit + 1);
    return {
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }

  pagonetStatus() {
    return { configured: this.pagonet.configured };
  }

  /** Confere o token da aplicação na Pagonet, sem limite de chamadas. */
  async checkPagonet() {
    if (!this.pagonet.configured)
      return { configured: false, ok: false, userName: null, message: null };
    const result = await this.pagonet.check();
    return result.ok
      ? { configured: true, ok: true, userName: result.userName, message: null }
      : { configured: true, ok: false, userName: null, message: result.message };
  }

  private async setActive(actor: PlatformActor, storeId: string, active: boolean, reason: string) {
    const why = requireReason(reason);
    const result = await this.persistence.setStoreActive(storeId, active, why, operator(actor));
    if (result === 'NOT_FOUND') throw storeNotFound();
    return this.store(storeId);
  }
}
