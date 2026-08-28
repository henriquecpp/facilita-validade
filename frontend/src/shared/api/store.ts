import { useEffect, useState } from 'react';
import { useApiQuery } from './hooks';
import type { Dashboard, ExpiryLevels, StoreSettings } from './types';
import { storeToday } from '../lib/risk';

/**
 * Níveis de urgência da loja e o dia de hoje no fuso dela. Os níveis são da loja: cada uma
 * define nome, faixa de dias, cor e se avisa (Configurações).
 */
export function useExpiryRules() {
  const settings = useApiQuery<StoreSettings>('/store/settings', { refetchOnWindowFocus: false });
  const levels = useApiQuery<ExpiryLevels>('/store/expiry-levels', {
    refetchOnWindowFocus: false,
  });
  const timezone = typeof settings.data?.timezone === 'string' ? settings.data.timezone : undefined;
  return { timezone, today: storeToday(timezone), levels: levels.data?.items ?? [] };
}
export type ExpiryRules = ReturnType<typeof useExpiryRules>;

/** Números do painel, compartilhados pelo menu, pelo sino e pela página inicial. */
export function useDashboard(enabled = true) {
  return useApiQuery<Dashboard>('/dashboard/summary', { poll: true, enabled });
}

/** O valor só muda depois de `delay` ms sem novas alterações: busca enquanto digita. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
