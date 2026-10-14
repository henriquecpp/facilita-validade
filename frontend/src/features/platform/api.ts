import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../shared/api/client';
import type { PlatformAdmin } from '../../shared/api/types';

/**
 * Pedido ao painel da plataforma. A sessão é um cookie HttpOnly, à parte da sessão da loja;
 * o cabeçalho anti-CSRF vai em todo pedido, porque o servidor o exige em toda escrita.
 */
export async function platformApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-CSRF-Protection', '1');
  if (options.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`/api/v1/platform${path}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: options.signal ?? AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Não foi possível falar com o servidor. Verifique a conexão e tente novamente.',
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string | string[];
      requestId?: string;
    };
    const message =
      typeof body.message === 'string'
        ? body.message
        : Array.isArray(body.message)
          ? body.message.join(' ')
          : 'Não foi possível concluir a operação.';
    throw new ApiError(response.status, body.code ?? 'REQUEST_FAILED', message, body.requestId);
  }
  return response.json() as Promise<T>;
}

/** Chaves das consultas da plataforma, longe das da loja. */
export const platformKey = (path: string) => ['platform', path] as const;
export const ME = platformKey('/me');

const signedOut = (error: unknown) => error instanceof ApiError && error.status === 401;

/** Quem está no painel; null quando ninguém entrou (ou a sessão acabou). */
export function usePlatformSession() {
  return useQuery({
    queryKey: ME,
    queryFn: async () => {
      try {
        return await platformApi<PlatformAdmin>('/me');
      } catch (error) {
        if (signedOut(error)) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Consulta da plataforma. Sessão vencida no meio do uso leva de volta ao login. */
export function usePlatformQuery<T>(path: string, options: { enabled?: boolean } = {}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: platformKey(path),
    queryFn: () => platformApi<T>(path),
    enabled: options.enabled ?? true,
    retry: (count, error) => !signedOut(error) && count < 1,
  });
  useEffect(() => {
    if (signedOut(query.error)) client.setQueryData(ME, null);
  }, [client, query.error]);
  return query;
}

/** Escrita da plataforma; ao concluir, as consultas dela se atualizam. */
export function usePlatformMutation<TInput, TResult>(path: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) =>
      platformApi<TResult>(path, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['platform'] }),
    onError: (error) => {
      if (signedOut(error)) client.setQueryData(ME, null);
    },
  });
}
