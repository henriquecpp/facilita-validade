import { api } from '../api/client';
import type { PushConfig } from '../api/types';

/**
 * Push do painel instalado como aplicativo (PWA, AV18): o service worker recebe os avisos do
 * servidor mesmo com a aba fechada. Só o proprietário recebe; a inscrição vale para a sessão
 * em que foi feita.
 */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Registra o service worker do painel: instalação como aplicativo e recebimento do push. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null, key: string): boolean {
  if (!current) return false;
  const wanted = keyBytes(key);
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, index) => byte === wanted[index]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function register(subscription: PushSubscription) {
  const json = subscription.toJSON();
  await api('/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'WEB',
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
    }),
  });
}

/** Pede a permissão do navegador, inscreve e registra no servidor. */
export async function enablePush(config: PushConfig): Promise<void> {
  if (!pushSupported()) throw new Error('Este navegador não recebe notificações push.');
  if (!config.webPushPublicKey)
    throw new Error('O servidor ainda não tem as notificações push configuradas.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error(
      'As notificações estão bloqueadas neste navegador. Libere nas configurações do site.',
    );
  const registration =
    (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker());
  if (!registration) throw new Error('Não foi possível preparar o navegador para o push.');
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  // Outra chave do servidor: a inscrição antiga não recebe mais nada.
  if (
    subscription &&
    !sameKey(subscription.options.applicationServerKey, config.webPushPublicKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(config.webPushPublicKey),
  });
  await register(subscription);
}

/** Desliga o push neste navegador: no servidor e na inscrição do navegador. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api('/push/subscriptions/remove', {
    method: 'POST',
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

/**
 * Na saída: tira a inscrição do servidor, sem travar o logout. O navegador fica inscrito, e o
 * próximo login de proprietário volta a registrá-la ({@link resumePush}).
 */
export async function forgetPush(): Promise<void> {
  try {
    const subscription = await currentSubscription();
    if (subscription)
      await api('/push/subscriptions/remove', {
        method: 'POST',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
  } catch {
    // Sair não depende do push: a inscrição também deixa de valer quando a sessão termina.
  }
}

/** Depois do login do proprietário: o navegador já inscrito passa a valer para esta sessão. */
export async function resumePush(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const subscription = await currentSubscription();
    if (subscription) await register(subscription);
  } catch {
    // Sem rede ou sem push no servidor: o painel funciona igual.
  }
}
