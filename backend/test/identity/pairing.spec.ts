import { describe, expect, it, vi } from 'vitest';
import {
  formatPairingCode,
  PAIRING_TTL_SECONDS,
  pairingRefusal,
  parsePairingCode,
} from '../../src/modules/identity/domain/pairing.js';
import { PairingService } from '../../src/modules/identity/application/pairing-service.js';
import type {
  PairableUser,
  PairingPersistence,
  PairingRepository,
} from '../../src/modules/identity/application/pairing-port.js';
import type { IdentityCrypto } from '../../src/modules/identity/application/identity-port.js';
import type { TenantActor } from '../../src/shared/domain/context.js';

const SECRET = 'A'.repeat(21) + '_-' + 'z9'.repeat(10); // 43 caracteres base64url

describe('código de pareamento', () => {
  it('ida e volta preserva o segredo', () => {
    const code = formatPairingCode(SECRET);
    expect(code).toBe(`estoque-pair:1:${SECRET}`);
    expect(parsePairingCode(code)).toBe(SECRET);
  });

  it('tolera espaço e quebra de linha em volta, como sai de um leitor', () => {
    expect(parsePairingCode(`  ${formatPairingCode(SECRET)}\r\n`)).toBe(SECRET);
  });

  it.each([
    ['outro prefixo', `outro-app:1:${SECRET}`],
    ['outra versão', `estoque-pair:2:${SECRET}`],
    ['segredo curto', `estoque-pair:1:${SECRET.slice(1)}`],
    ['segredo longo', `estoque-pair:1:${SECRET}A`],
    ['caractere fora do base64url', `estoque-pair:1:${SECRET.slice(1)}+`],
    ['partes a mais', `estoque-pair:1:${SECRET}:x`],
    ['código de barras', '7890000000017'],
    ['vazio', ''],
  ])('recusa %s', (_, value) => {
    expect(parsePairingCode(value)).toBeNull();
  });

  it('não formata segredo fora do padrão', () => {
    expect(() => formatPairingCode('curto')).toThrow();
  });
});

describe('quem pode ser pareado', () => {
  const base = { role: 'OPERATOR' as const, active: true, mustChangePassword: false };

  it('operador ativo com senha definitiva pode', () => {
    expect(pairingRefusal(base)).toBeNull();
  });

  it('proprietário e gestor entram com senha', () => {
    expect(pairingRefusal({ ...base, role: 'OWNER' })).toBe('NOT_OPERATOR');
    expect(pairingRefusal({ ...base, role: 'MANAGER' })).toBe('NOT_OPERATOR');
  });

  it('senha provisória pendente bloqueia', () => {
    expect(pairingRefusal({ ...base, mustChangePassword: true })).toBe('PASSWORD_PENDING');
  });

  it('inativo tem precedência sobre as outras recusas', () => {
    expect(pairingRefusal({ ...base, role: 'OWNER', active: false })).toBe('INACTIVE');
  });
});

describe('PairingService', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const owner: TenantActor = {
    storeId: 'store-a',
    userId: 'owner',
    role: 'OWNER',
    sessionId: 's',
    restricted: false,
  };
  const operator: PairableUser = {
    id: 'op',
    username: 'repositor',
    role: 'OPERATOR',
    active: true,
    mustChangePassword: false,
  };
  const crypto = {
    opaqueToken: () => SECRET,
    hashToken: (value: string) => `hash(${value})`,
    uuid: () => 'pairing-1',
  } as unknown as IdentityCrypto;

  function setup(overrides: Partial<PairingRepository> = {}) {
    const repository: PairingRepository = {
      user: vi.fn(async () => operator),
      insert: vi.fn(async () => {}),
      consume: vi.fn(async () => ({ userId: 'op', issuedBy: 'owner' })),
      audit: vi.fn(async () => {}),
      ...overrides,
    };
    const persistence: PairingPersistence = {
      resolve: vi.fn(async () => ({ storeId: 'store-a', pairingId: 'pairing-1' })),
      tenant: vi.fn(async (_storeId, action) => action(repository)),
    };
    const sessions = { issueDeviceSession: vi.fn(async () => ({ accessToken: 't' }) as never) };
    const service = new PairingService(persistence, sessions, crypto, { now: () => now });
    return { service, repository, persistence, sessions };
  }

  it('grava só o hash e expira no prazo configurado', async () => {
    const { service, repository } = setup();
    const issued = await service.issue(owner, 'op');
    expect(issued.code).toBe(`estoque-pair:1:${SECRET}`);
    expect(issued.expiresAt).toBe(
      new Date(now.getTime() + PAIRING_TTL_SECONDS * 1000).toISOString(),
    );
    expect(repository.insert).toHaveBeenCalledWith({
      id: 'pairing-1',
      userId: 'op',
      tokenHash: `hash(${SECRET})`,
      issuedBy: 'owner',
      expiresAt: new Date(now.getTime() + PAIRING_TTL_SECONDS * 1000),
    });
  });

  it('recusa emitir para quem não é operador, sem gravar nada', async () => {
    const { service, repository } = setup({
      user: vi.fn(async () => ({ ...operator, role: 'MANAGER' as const })),
    });
    await expect(service.issue(owner, 'op')).rejects.toMatchObject({
      code: 'PAIRING_NOT_OPERATOR',
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('cada recusa é um erro novo, não uma instância reaproveitada', async () => {
    const { service } = setup({ user: vi.fn(async () => undefined) });
    const first = await service.issue(owner, 'x').catch((e: unknown) => e);
    const second = await service.issue(owner, 'x').catch((e: unknown) => e);
    expect(first).not.toBe(second);
  });

  it('código ilegível não chega a consultar o banco', async () => {
    const { service, persistence } = setup();
    await expect(service.redeem('lixo')).rejects.toMatchObject({ code: 'INVALID_PAIRING' });
    expect(persistence.resolve).not.toHaveBeenCalled();
  });

  it('código já consumido não emite sessão', async () => {
    const { service, sessions } = setup({ consume: vi.fn(async () => undefined) });
    await expect(service.redeem(`estoque-pair:1:${SECRET}`)).rejects.toMatchObject({
      code: 'INVALID_PAIRING',
    });
    expect(sessions.issueDeviceSession).not.toHaveBeenCalled();
  });

  it('consome antes de emitir e passa a origem para a auditoria', async () => {
    const order: string[] = [];
    const { service, sessions } = setup({
      consume: vi.fn(async () => {
        order.push('consume');
        return { userId: 'op', issuedBy: 'owner' };
      }),
    });
    sessions.issueDeviceSession.mockImplementation(async () => {
      order.push('session');
      return { accessToken: 't' } as never;
    });
    await service.redeem(`estoque-pair:1:${SECRET}`);
    expect(order).toEqual(['consume', 'session']);
    expect(sessions.issueDeviceSession).toHaveBeenCalledWith('store-a', 'op', {
      pairingId: 'pairing-1',
      issuedBy: 'owner',
    });
  });
});
