import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { useBusinessMutation } from './hooks';
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  api: apiMock,
}));
vi.mock('../../features/auth/AuthProvider', () => ({
  useAuth: () => ({ session: { store: { id: 'store-a' } } }),
}));
let cache: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={cache}>{children}</QueryClientProvider>;
}
beforeEach(() => apiMock.mockReset());
describe('envio idempotente', () => {
  it('executa a navegação de sucesso sem aguardar recargas que podem remontar o formulário', async () => {
    apiMock.mockResolvedValue({ id: 'count-1' });
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () => useBusinessMutation<{ expectedVersion: number }>('/count-sessions/count-1/confirm'),
      { wrapper: Wrapper },
    );
    const refresh = vi
      .spyOn(cache, 'invalidateQueries')
      .mockImplementation(() => new Promise<void>(() => undefined));
    act(() => result.current.mutate({ expectedVersion: 2 }, { onSuccess }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('reutiliza a chave após resposta perdida e bloqueia alteração de dados até confirmar', async () => {
    apiMock
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Resposta perdida'))
      .mockResolvedValue({ id: 'receipt-1' });
    const { result } = renderHook(
      () => useBusinessMutation<{ quantity: number }>('/inventory/receipts'),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await expect(result.current.mutateAsync({ quantity: 4 })).rejects.toThrow('Resposta perdida');
    });
    expect(result.current.isUncertain).toBe(true);
    const firstKey = apiMock.mock.calls[0][1].headers['Idempotency-Key'];
    await act(async () => {
      await expect(result.current.mutateAsync({ quantity: 8 })).rejects.toThrow('envio anterior');
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.mutateAsync({ quantity: 4 });
    });
    expect(result.current.isUncertain).toBe(false);
    expect(apiMock.mock.calls[1][1].headers['Idempotency-Key']).toBe(firstKey);
    await act(async () => {
      await result.current.mutateAsync({ quantity: 4 });
    });
    expect(apiMock.mock.calls[2][1].headers['Idempotency-Key']).not.toBe(firstKey);
  });
  it('permite corrigir um comando rejeitado explicitamente pela API', async () => {
    apiMock
      .mockRejectedValueOnce(new ApiError(422, 'INVALID_QUANTITY', 'Quantidade inválida'))
      .mockResolvedValue({});
    const { result } = renderHook(
      () => useBusinessMutation<{ quantity: number }>('/inventory/receipts'),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await expect(result.current.mutateAsync({ quantity: 0 })).rejects.toThrow(
        'Quantidade inválida',
      );
    });
    await act(async () => {
      await result.current.mutateAsync({ quantity: 1 });
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});
