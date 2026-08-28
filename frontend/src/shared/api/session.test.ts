import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './types';
const example: Session = {
  accessToken: 'token-new',
  user: { id: 'user-1', storeId: 'store-1', username: 'ana', role: 'OWNER' },
  store: { id: 'store-1', name: 'Loja 1', cnpj: '12345678000195' },
};
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('BroadcastChannel', undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessão web', () => {
  it('envia a proteção CSRF e mantém o token apenas na memória', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(example));
    vi.stubGlobal('fetch', fetcher);
    const { login, getSession } = await import('./session');
    await login('12345678000195', 'ana', 'minha-senha-segura');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/auth/web/login',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'X-CSRF-Protection': '1' }),
      }),
    );
    expect(getSession()).toEqual(example);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('distingue origem recusada de credencial errada', async () => {
    const reply = (status: number, code: string) =>
      Response.json({ code, message: 'recusado' }, { status });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply(403, 'CSRF_REJECTED'))
        .mockResolvedValueOnce(reply(401, 'INVALID_CREDENTIALS')),
    );
    const { login } = await import('./session');
    await expect(login('12345678000195', 'ana', 'senha')).rejects.toThrow(
      `não aceita login a partir de ${window.location.origin}`,
    );
    await expect(login('12345678000195', 'ana', 'senha')).rejects.toThrow(
      'Confira CNPJ, usuário e senha',
    );
  });
  it('coalesce duas renovações simultâneas para consumir o refresh token uma vez', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const { setSession, refreshSession } = await import('./session');
    setSession({ ...example, accessToken: 'old' });
    const first = refreshSession('old');
    const second = refreshSession('old');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish(Response.json(example));
    expect(await first).toEqual(example);
    expect(await second).toEqual(example);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/auth/web/refresh',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-CSRF-Protection': '1' }) }),
    );
  });
  it('remove a sessão quando o refresh foi revogado', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const { setSession, refreshSession, getSession } = await import('./session');
    setSession({ ...example, accessToken: 'old' });
    expect(await refreshSession('old')).toBeNull();
    expect(getSession()).toBeNull();
  });
  it('não perde a sessão local se o servidor não confirmou o logout', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const { setSession, logout, getSession } = await import('./session');
    setSession(example);
    await expect(logout()).rejects.toThrow('Não foi possível encerrar');
    expect(getSession()).toEqual(example);
  });
});
