import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { useAuth } from '../../features/auth/AuthProvider';
import { randomUuid } from '../lib/uuid';
/**
 * `poll`: true atualiza a cada minuto; um número, a cada tantos milissegundos; uma função
 * escolhe o intervalo pelos dados recebidos.
 */
export function useApiQuery<T>(
  path: string,
  options: {
    poll?: boolean | number | ((data: T | undefined) => number | false);
    enabled?: boolean;
    refetchOnWindowFocus?: boolean;
  } = {},
) {
  const poll = options.poll;
  const { session } = useAuth();
  return useQuery({
    queryKey: [session?.store.id, path],
    queryFn: () => api<T>(path),
    enabled: !!session && options.enabled !== false,
    refetchInterval:
      typeof poll === 'function'
        ? (query: { state: { data: T | undefined } }) => poll(query.state.data)
        : typeof poll === 'number'
          ? poll
          : poll
            ? 60000
            : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: options.refetchOnWindowFocus,
  });
}
export function useBusinessMutation<TBody, TResult = unknown>(path: string, method = 'POST') {
  const cache = useQueryClient();
  const { session } = useAuth();
  const [isUncertain, setIsUncertain] = useState(false);
  const pending = useRef<{ fingerprint: string; key: string; uncertain: boolean } | null>(null);
  const mutation = useMutation({
    mutationFn: async (body: TBody) => {
      const fingerprint = JSON.stringify(body);
      if (pending.current?.uncertain && pending.current.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          'UNCONFIRMED_COMMAND',
          'O envio anterior ainda não foi confirmado. Mantenha os mesmos dados e tente novamente antes de iniciar outra operação.',
        );
      if (!pending.current || pending.current.fingerprint !== fingerprint)
        pending.current = { fingerprint, key: randomUuid(), uncertain: false };
      const command = pending.current;
      try {
        const result = await api<TResult>(path, {
          method,
          body: fingerprint,
          headers: { 'Idempotency-Key': command.key },
        });
        pending.current = null;
        setIsUncertain(false);
        return result;
      } catch (error) {
        command.uncertain =
          !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
        setIsUncertain(command.uncertain);
        if (!command.uncertain) pending.current = null;
        throw error;
      }
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: [session?.store.id] });
    },
  });
  return { ...mutation, isUncertain };
}
