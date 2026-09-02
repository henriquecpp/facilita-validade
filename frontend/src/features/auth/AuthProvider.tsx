import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getSession,
  isSessionReady,
  refreshSession,
  subscribeSession,
} from '../../shared/api/session';
import type { Session } from '../../shared/api/types';
const Context = createContext<{ session: Session | null; ready: boolean }>({
  session: null,
  ready: false,
});
export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSession);
  const ready = useSyncExternalStore(subscribeSession, isSessionReady);
  const cache = useQueryClient();
  useEffect(() => {
    void refreshSession().catch(() => undefined);
  }, []);
  // Troca de pessoa ou de loja (ou saída) apaga os dados da anterior. A chegada da primeira
  // sessão não apaga nada: o cache ainda está vazio, e limpar ali cancelaria em silêncio as
  // consultas que acabaram de começar na mesma renderização (ao recarregar uma página).
  const identity = session ? `${session.store.id}:${session.user.id}` : null;
  const previous = useRef(identity);
  useEffect(() => {
    if (previous.current !== null && previous.current !== identity) cache.clear();
    previous.current = identity;
  }, [cache, identity]);
  return <Context.Provider value={{ session, ready }}>{children}</Context.Provider>;
}
export function useAuth() {
  return useContext(Context);
}
