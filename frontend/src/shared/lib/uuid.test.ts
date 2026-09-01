import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from './uuid';

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('randomUuid', () => {
  it('usa o do navegador quando existe', () => {
    expect(randomUuid()).toMatch(UUID_V4);
  });

  it('sem contexto seguro (painel pelo IP, em HTTP), gera com getRandomValues', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const keys = new Set(Array.from({ length: 50 }, () => randomUuid()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(UUID_V4);
  });

  it('marca versão e variante quaisquer que sejam os bytes sorteados', () => {
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => array.fill(0xff) });
    expect(randomUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => array.fill(0) });
    expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000');
  });
});
