import {
  ApplicationError,
  requireRole,
  type Role,
  type TenantActor,
} from '../../../shared/domain/context.js';
import {
  normalizeCnpj,
  normalizeUsername,
  publicUser,
  validatePassword,
  type IdentitySession,
  type IdentityStore,
  type IdentityUser,
} from '../domain/identity.js';
import { pairingRefusal } from '../domain/pairing.js';
import type {
  IdentityClock,
  IdentityCrypto,
  IdentityPersistence,
  IdentityRepository,
} from './identity-port.js';

const invalidCredentials = () =>
  new ApplicationError('INVALID_CREDENTIALS', 'CNPJ, usuário ou senha não conferem.', 401);
// Senha atual errada na troca não é sessão inválida: com 401, painel e coletor renovariam a
// sessão (ou, na senha provisória, que não tem renovação, sairiam dela) em vez de mostrar o erro.
const wrongCurrentPassword = () =>
  new ApplicationError('CURRENT_PASSWORD_INVALID', 'A senha atual não confere.', 422);
const invalidResetLink = () =>
  new ApplicationError(
    'RESET_LINK_INVALID',
    'Este link expirou ou já foi usado. Peça um novo ao responsável pela loja.',
    401,
  );
const invalidSession = () =>
  new ApplicationError('INVALID_SESSION', 'Sessão inválida ou expirada. Entre novamente.', 401);
// Encerrada pelo proprietário: o coletor diz isso no login, em vez de "sessão expirada".
const revokedByAdmin = () =>
  new ApplicationError(
    'SESSION_REVOKED',
    'O administrador da loja desconectou este aparelho. Entre de novo para continuar.',
    401,
  );
const notFound = () => new ApplicationError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
type Client = 'web' | 'mobile';
export interface LoginInput {
  cnpj: string;
  username: string;
  password: string;
}
export interface SessionResult {
  accessToken: string;
  refreshToken?: string;
  user: ReturnType<typeof publicUser>;
  store: { id: string; name: string; cnpj: string };
  mustChangePassword: boolean;
}

export class AuthService {
  constructor(
    private readonly persistence: IdentityPersistence,
    private readonly crypto: IdentityCrypto,
    private readonly clock: IdentityClock,
  ) {}
  private expired(date: string) {
    return Date.parse(date) <= this.clock.now().getTime();
  }
  private expires(seconds: number) {
    return new Date(this.clock.now().getTime() + seconds * 1000).toISOString();
  }
  private async current(
    repository: IdentityRepository,
    actor: TenantActor,
    restrictedAllowed = false,
  ) {
    const store = await repository.store();
    const user = await repository.user(actor.userId);
    const session = await repository.session(actor.sessionId);
    if (
      !store?.active ||
      !user?.active ||
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      this.expired(session.expiresAt)
    )
      throw invalidSession();
    if ((session.restricted || user.mustChangePassword) && !restrictedAllowed)
      throw new ApplicationError(
        'PASSWORD_CHANGE_REQUIRED',
        'Altere a senha provisória antes de continuar.',
        403,
      );
    return { store, user, session };
  }
  private async result(
    repository: IdentityRepository,
    store: IdentityStore,
    user: IdentityUser,
    session: IdentitySession,
  ): Promise<SessionResult> {
    const actor: TenantActor = {
      storeId: store.id,
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      restricted: session.restricted,
    };
    const accessToken = await this.crypto.sign(actor, session.restricted ? 300 : 600);
    let refreshToken: string | undefined;
    if (!session.restricted) {
      refreshToken = this.crypto.opaqueToken();
      await repository.insertRefresh({
        id: this.crypto.uuid(),
        sessionId: session.id,
        tokenHash: this.crypto.hashToken(refreshToken),
        expiresAt: session.expiresAt,
        consumedAt: null,
      });
    }
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      user: publicUser(user),
      store: { id: store.id, name: store.name, cnpj: store.cnpj },
      mustChangePassword: user.mustChangePassword,
    };
  }
  async login(input: LoginInput, client: Client): Promise<SessionResult> {
    let cnpj: string, username: string;
    try {
      cnpj = normalizeCnpj(input.cnpj);
      username = normalizeUsername(input.username);
    } catch {
      await this.crypto.dummyVerify(input.password);
      throw invalidCredentials();
    }
    const resolved = await this.persistence.resolveLogin(cnpj, username);
    if (!resolved) {
      await this.crypto.dummyVerify(input.password);
      throw invalidCredentials();
    }
    if (!(await this.crypto.verifyPassword(resolved.passwordHash, input.password)))
      throw invalidCredentials();
    return this.persistence.tenant(resolved.storeId, async (repository) => {
      const store = await repository.store(true);
      const user = await repository.user(resolved.userId);
      if (
        !store?.active ||
        !user?.active ||
        user.passwordHash !== resolved.passwordHash ||
        user.usernameNormalized !== username
      )
        throw invalidCredentials();
      const session: IdentitySession = {
        id: this.crypto.uuid(),
        storeId: store.id,
        userId: user.id,
        client,
        restricted: user.mustChangePassword,
        expiresAt: this.expires(user.mustChangePassword ? 300 : 30 * 86400),
        revokedAt: null,
      };
      await repository.insertSession(session);
      await repository.audit(user.id, 'AUTH_LOGIN', session.id, {
        client,
        restricted: session.restricted,
      });
      return this.result(repository, store, user, session);
    });
  }
  /**
   * Sessão de coletor para um pareamento já consumido. Revalida o usuário: entre a
   * geração do QR e a leitura, ele pode ter sido desativado, promovido ou ter a senha
   * redefinida. Os tokens seguem exatamente as regras do login mobile.
   */
  async issueDeviceSession(
    storeId: string,
    userId: string,
    detail: Record<string, unknown>,
  ): Promise<SessionResult> {
    return this.persistence.tenant(storeId, async (repository) => {
      const store = await repository.store(true);
      const user = await repository.user(userId);
      if (!store?.active || !user || pairingRefusal(user))
        throw new ApplicationError(
          'INVALID_PAIRING',
          'Código de pareamento inválido ou expirado. Gere um novo no painel.',
          401,
        );
      const session: IdentitySession = {
        id: this.crypto.uuid(),
        storeId: store.id,
        userId: user.id,
        client: 'mobile',
        restricted: false,
        expiresAt: this.expires(30 * 86400),
        revokedAt: null,
      };
      await repository.insertSession(session);
      await repository.audit(user.id, 'AUTH_DEVICE_PAIRED', session.id, detail);
      return this.result(repository, store, user, session);
    });
  }
  async authenticate(accessToken: string): Promise<TenantActor> {
    let claims;
    try {
      claims = await this.crypto.verify(accessToken);
    } catch {
      throw invalidSession();
    }
    return this.persistence.tenant(claims.storeId, async (repository) => {
      const { user, session } = await this.current(
        repository,
        { ...claims, role: 'OPERATOR', restricted: false },
        true,
      );
      return {
        ...claims,
        role: user.role,
        restricted: session.restricted || user.mustChangePassword,
      };
    });
  }
  async refresh(raw: string, client: Client): Promise<SessionResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw invalidSession();
    const tokenHash = this.crypto.hashToken(raw);
    const resolved = await this.persistence.resolveRefresh(tokenHash);
    if (!resolved) throw invalidSession();
    const result = await this.persistence.tenant(resolved.storeId, async (repository) => {
      const store = await repository.store(true);
      const token = await repository.refresh(tokenHash);
      const session = await repository.session(resolved.sessionId);
      if (session?.revokedAt && session.revokedReason === 'ADMIN' && session.client === client)
        return 'REVOKED_BY_ADMIN' as const;
      if (
        !store?.active ||
        !token ||
        !session ||
        session.client !== client ||
        session.restricted ||
        session.revokedAt ||
        this.expired(session.expiresAt)
      )
        return undefined;
      if (this.expired(token.expiresAt)) return undefined;
      const user = await repository.user(session.userId);
      if (!user?.active || user.mustChangePassword) return undefined;
      // Token já trocado. No coletor, o comum é a resposta da troca anterior ter se perdido —
      // Wi-Fi da loja, tempo esgotado, aparelho bloqueado no meio —: o token novo nunca chegou
      // e o aparelho tenta de novo com o antigo. No painel, duas abas renovam ao mesmo tempo.
      // Enquanto a cadeia não andou, isto é, nenhum token da sessão foi trocado depois deste,
      // é essa nova tentativa: sai mais um token, e o anterior segue valendo — no painel, o
      // cookie que ficar pode ser o de qualquer uma das respostas. Se a cadeia andou, mais
      // alguém tem um token da sessão, e ela é encerrada. Return a failure value so reuse
      // revocation COMMITs before returning 401.
      if (!(await repository.consumeRefresh(token.id))) {
        if (await repository.refreshRotatedAfter(token.id)) {
          await repository.revokeSession(session.id);
          await repository.audit(session.userId, 'AUTH_REFRESH_REUSE', session.id);
          return undefined;
        }
        await repository.audit(session.userId, 'AUTH_REFRESH_RETRY', session.id);
      }
      return this.result(repository, store, user, session);
    });
    if (result === 'REVOKED_BY_ADMIN') throw revokedByAdmin();
    if (!result) throw invalidSession();
    return result;
  }
  async logout(raw: string | undefined, accessToken: string | undefined, client: Client) {
    if (raw && /^[A-Za-z0-9_-]{43}$/.test(raw)) {
      const resolved = await this.persistence.resolveRefresh(this.crypto.hashToken(raw));
      if (resolved)
        await this.persistence.tenant(resolved.storeId, async (repository) => {
          await repository.store(true);
          const session = await repository.session(resolved.sessionId);
          if (session?.client === client) await repository.revokeSession(session.id);
        });
    }
    if (accessToken) {
      let claims;
      try {
        claims = await this.crypto.verify(accessToken);
      } catch {
        return { ok: true };
      }
      await this.persistence.tenant(claims.storeId, async (repository) => {
        await repository.store(true);
        const session = await repository.session(claims.sessionId);
        if (session?.client === client && session.userId === claims.userId)
          await repository.revokeSession(session.id);
      });
    }
    return { ok: true };
  }
  async me(actor: TenantActor) {
    return this.persistence.tenant(actor.storeId, async (repository) => {
      const { user, store } = await this.current(repository, actor, true);
      return {
        user: publicUser(user),
        store: { id: store.id, name: store.name, cnpj: store.cnpj },
        mustChangePassword: user.mustChangePassword,
      };
    });
  }
  async changePassword(actor: TenantActor, currentPassword: string, newPassword: string) {
    validatePassword(newPassword);
    if (currentPassword === newPassword)
      throw new ApplicationError('PASSWORD_UNCHANGED', 'Defina uma senha diferente da atual.', 400);
    const passwordHash = await this.crypto.hashPassword(newPassword);
    return this.persistence.tenant(actor.storeId, async (repository) => {
      await repository.store(true);
      const { user } = await this.current(repository, actor, true);
      if (!(await this.crypto.verifyPassword(user.passwordHash, currentPassword)))
        throw wrongCurrentPassword();
      await repository.updateUser(user.id, { passwordHash, mustChangePassword: false });
      await repository.revokeUserSessions(user.id);
      await repository.consumeUserResets(user.id);
      await repository.audit(user.id, 'PASSWORD_CHANGED', user.id);
      return { ok: true, requiresLogin: true };
    });
  }
  async users(actor: TenantActor) {
    return this.persistence.tenant(actor.storeId, async (repository) => {
      const { user } = await this.current(repository, actor);
      requireRole({ ...actor, role: user.role }, ['OWNER']);
      return { items: (await repository.users()).map(publicUser), nextCursor: null };
    });
  }
  async createUser(
    actor: TenantActor,
    input: { username: string; temporaryPassword: string; role: Role },
  ) {
    requireRole(actor, ['OWNER']);
    validatePassword(input.temporaryPassword);
    const usernameNormalized = normalizeUsername(input.username);
    const passwordHash = await this.crypto.hashPassword(input.temporaryPassword);
    return this.persistence.tenant(actor.storeId, async (repository) => {
      await repository.store(true);
      const { user: owner } = await this.current(repository, actor);
      requireRole({ ...actor, role: owner.role }, ['OWNER']);
      if ((await repository.users()).some((user) => user.usernameNormalized === usernameNormalized))
        throw new ApplicationError('USERNAME_EXISTS', 'Este usuário já existe nesta loja.', 409);
      const user: IdentityUser = {
        id: this.crypto.uuid(),
        storeId: actor.storeId,
        username: input.username.trim(),
        usernameNormalized,
        passwordHash,
        role: input.role,
        active: true,
        mustChangePassword: true,
        version: 1,
      };
      await repository.insertUser(user);
      await repository.audit(actor.userId, 'USER_CREATED', user.id, {
        username: user.username,
        role: user.role,
      });
      return publicUser(user);
    });
  }
  async updateUser(
    actor: TenantActor,
    id: string,
    input: { expectedVersion: number; username?: string; role?: Role; active?: boolean },
  ) {
    requireRole(actor, ['OWNER']);
    const usernameNormalized =
      input.username === undefined ? undefined : normalizeUsername(input.username);
    return this.persistence.tenant(actor.storeId, async (repository) => {
      await repository.store(true);
      const { user: owner } = await this.current(repository, actor);
      requireRole({ ...actor, role: owner.role }, ['OWNER']);
      const user = await repository.user(id);
      if (!user) throw notFound();
      if (user.version !== input.expectedVersion)
        throw new ApplicationError(
          'VERSION_CONFLICT',
          'O usuário foi alterado. Atualize a tela.',
          409,
        );
      const users = await repository.users();
      if (
        usernameNormalized &&
        users.some((other) => other.id !== id && other.usernameNormalized === usernameNormalized)
      )
        throw new ApplicationError('USERNAME_EXISTS', 'Este usuário já existe nesta loja.', 409);
      if (
        user.active &&
        user.role === 'OWNER' &&
        (input.active === false || (input.role !== undefined && input.role !== 'OWNER')) &&
        users.filter((other) => other.active && other.role === 'OWNER').length <= 1
      )
        throw new ApplicationError(
          'LAST_OWNER',
          'A loja precisa manter um proprietário ativo.',
          409,
        );
      await repository.updateUser(id, {
        username: input.username?.trim(),
        usernameNormalized,
        role: input.role,
        active: input.active,
      });
      await repository.revokeUserSessions(id, 'ADMIN');
      await repository.audit(actor.userId, 'USER_UPDATED', id, {
        username: input.username,
        role: input.role,
        active: input.active,
      });
      return publicUser((await repository.user(id))!);
    });
  }
  /** Coletores com sessão aberta na loja. Só o proprietário, como a lista de usuários. */
  async deviceSessions(actor: TenantActor) {
    requireRole(actor, ['OWNER']);
    return this.persistence.tenant(actor.storeId, async (repository) => {
      const { user } = await this.current(repository, actor);
      requireRole({ ...actor, role: user.role }, ['OWNER']);
      return { items: await repository.deviceSessions(), nextCursor: null };
    });
  }
  /**
   * Desconecta um coletor: a próxima chamada dele é recusada e a renovação diz que foi o
   * administrador. Encerrar de novo é inofensivo; sessão do painel não entra aqui.
   */
  async revokeDeviceSession(actor: TenantActor, id: string) {
    requireRole(actor, ['OWNER']);
    return this.persistence.tenant(actor.storeId, async (repository) => {
      await repository.store(true);
      const { user } = await this.current(repository, actor);
      requireRole({ ...actor, role: user.role }, ['OWNER']);
      const session = await repository.session(id);
      if (!session || session.client !== 'mobile')
        throw new ApplicationError('DEVICE_SESSION_NOT_FOUND', 'Coletor não encontrado.', 404);
      if (!session.revokedAt) {
        await repository.revokeSession(id, 'ADMIN');
        await repository.audit(actor.userId, 'AUTH_DEVICE_SESSION_REVOKED', id, {
          userId: session.userId,
        });
      }
      return { id };
    });
  }
  async resetPassword(actor: TenantActor, id: string) {
    requireRole(actor, ['OWNER']);
    return this.persistence.tenant(actor.storeId, async (repository) => {
      await repository.store(true);
      const { user: owner } = await this.current(repository, actor);
      requireRole({ ...actor, role: owner.role }, ['OWNER']);
      const user = await repository.user(id);
      if (!user?.active) throw notFound();
      if (user.id === actor.userId)
        throw new ApplicationError(
          'USE_PASSWORD_CHANGE',
          'Use a troca de senha da própria conta.',
          422,
        );
      const resetToken = this.crypto.opaqueToken(),
        expiresAt = this.expires(1800);
      await repository.consumeUserResets(id);
      // Invalidate the old password immediately; only the one-use reset can restore access.
      await repository.updateUser(id, {
        passwordHash: await this.crypto.hashPassword(this.crypto.opaqueToken()),
        mustChangePassword: true,
      });
      await repository.revokeUserSessions(id, 'ADMIN');
      await repository.insertReset({
        id: this.crypto.uuid(),
        userId: id,
        tokenHash: this.crypto.hashToken(resetToken),
        expiresAt,
        consumedAt: null,
      });
      await repository.audit(actor.userId, 'PASSWORD_RESET_ISSUED', id);
      return { resetToken, expiresAt };
    });
  }
  async completePasswordReset(raw: string, newPassword: string) {
    validatePassword(newPassword);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw invalidResetLink();
    const tokenHash = this.crypto.hashToken(raw),
      resolved = await this.persistence.resolveReset(tokenHash);
    if (!resolved) throw invalidResetLink();
    const passwordHash = await this.crypto.hashPassword(newPassword);
    return this.persistence.tenant(resolved.storeId, async (repository) => {
      const store = await repository.store(true);
      const token = await repository.reset(tokenHash),
        user = await repository.user(resolved.userId);
      if (
        !store?.active ||
        !user?.active ||
        !token ||
        token.userId !== user.id ||
        token.consumedAt ||
        this.expired(token.expiresAt)
      )
        throw invalidResetLink();
      await repository.consumeUserResets(user.id);
      await repository.updateUser(user.id, { passwordHash, mustChangePassword: false });
      await repository.revokeUserSessions(user.id);
      await repository.audit(user.id, 'PASSWORD_RESET_COMPLETED', user.id);
      return { ok: true, requiresLogin: true };
    });
  }
}
