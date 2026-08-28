import type { Session } from './types';
let current: Session | null = null;
let ready = false;
let refreshing: Promise<Session | null> | null = null;
const listeners = new Set<() => void>();
const channel =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('inventory-session');
function notify() {
  listeners.forEach((listener) => listener());
}
export function getSession() {
  return current;
}
export function isSessionReady() {
  return ready;
}
export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setSession(session: Session | null, broadcast = true) {
  current = session;
  ready = true;
  notify();
  if (broadcast) channel?.postMessage({ type: 'session', session });
}
channel?.addEventListener(
  'message',
  (event: MessageEvent<{ type: string; session?: Session | null }>) => {
    if (event.data.type === 'request' && current)
      channel?.postMessage({ type: 'session', session: current });
    if (event.data.type === 'session') setSession(event.data.session ?? null, false);
  },
);
export async function refreshSession(staleToken?: string): Promise<Session | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!current && !ready) {
      channel?.postMessage({ type: 'request' });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const execute = async () => {
      if (current && (!staleToken || current.accessToken !== staleToken)) return current;
      const response = await fetch('/api/v1/auth/web/refresh', {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
        body: '{}',
      });
      if (response.status === 401 || response.status === 403) {
        setSession(null);
        return null;
      }
      if (!response.ok) throw new Error('Não foi possível renovar a sessão. Tente novamente.');
      const session = (await response.json()) as Session;
      setSession(session);
      return session;
    };
    return typeof navigator !== 'undefined' && navigator.locks
      ? await navigator.locks.request('inventory-refresh', execute)
      : await execute();
  })().finally(() => {
    refreshing = null;
    ready = true;
    notify();
  });
  return refreshing;
}
export async function login(cnpj: string, username: string, password: string): Promise<Session> {
  const response = await fetch('/api/v1/auth/web/login', {
    method: 'POST',
    credentials: 'include',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
    body: JSON.stringify({ cnpj, username, password }),
  });
  if (!response.ok) {
    if (response.status === 429)
      throw new Error('Muitas tentativas. Aguarde um momento para tentar novamente.');
    if (response.status >= 500) throw new Error('O serviço está indisponível. Tente novamente.');
    // Origem recusada não é credencial errada: pedir para conferir a senha só confunde.
    const { code } = (await response.json().catch(() => ({}))) as { code?: string };
    if (code === 'CSRF_REJECTED')
      throw new Error(
        `O servidor não aceita login a partir de ${window.location.origin}. ` +
          'Abra o painel pelo endereço configurado no servidor.',
      );
    throw new Error('Não foi possível entrar. Confira CNPJ, usuário e senha.');
  }
  const session = (await response.json()) as Session;
  setSession(session);
  return session;
}
export async function logout(): Promise<void> {
  const response = await fetch('/api/v1/auth/web/logout', {
    method: 'POST',
    credentials: 'include',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Protection': '1',
      ...(current ? { Authorization: `Bearer ${current.accessToken}` } : {}),
    },
    body: '{}',
  });
  if (!response.ok && response.status !== 401)
    throw new Error('Não foi possível encerrar a sessão no servidor. Tente novamente.');
  setSession(null);
}
