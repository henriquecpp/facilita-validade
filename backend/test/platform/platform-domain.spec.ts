import { describe, expect, it } from 'vitest';
import { validatePassword } from '../../src/modules/identity/domain/identity.js';
import { temporaryPassword } from '../../src/modules/platform/adapters/out/platform-crypto.js';
import {
  eventDetail,
  normalizeStoreName,
  requireReason,
} from '../../src/modules/platform/domain/platform.js';

describe('plataforma: regras sem banco', () => {
  it('senha provisória: legível, sem caracteres ambíguos e aceita pela regra de senha', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const value = temporaryPassword();
      expect(value).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
      expect(value).not.toMatch(/[0O1lI]/);
      expect(() => validatePassword(value)).not.toThrow();
      seen.add(value);
    }
    expect(seen.size).toBe(200);
  });

  it('nome da loja sem espaços sobrando; motivo obrigatório e curto', () => {
    expect(normalizeStoreName('  Mercado   do  Bairro ')).toBe('Mercado do Bairro');
    expect(() => normalizeStoreName('   ')).toThrow('1 a 160');
    expect(() => normalizeStoreName('x'.repeat(161))).toThrow('1 a 160');
    expect(requireReason('  Contrato encerrado ')).toBe('Contrato encerrado');
    expect(() => requireReason('ok')).toThrow('motivo');
    expect(() => requireReason('x'.repeat(501))).toThrow('motivo');
  });

  it('o histórico só mostra textos conhecidos do detalhe', () => {
    expect(
      eventDetail({ reason: 'Contrato', adminId: 'interno', username: 3, cnpj: '11222333000181' }),
    ).toEqual({ reason: 'Contrato', cnpj: '11222333000181' });
    expect(eventDetail(null)).toEqual({});
    expect(eventDetail('texto')).toEqual({});
  });
});
