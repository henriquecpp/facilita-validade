import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildPushAlert, buildPushDigest } from '../../src/modules/notifications/domain/push.js';
import {
  encryptPayload,
  isPushServiceEndpoint,
  vapidFromEnv,
  WebPushSender,
} from '../../src/modules/notifications/adapters/out/web-push.js';
import { FcmSender, fcmFromEnv } from '../../src/modules/notifications/adapters/out/fcm.js';

const decode = (value: string) => Buffer.from(value, 'base64url');

/** Decifra como o navegador (RFC 8291), com a chave privada da inscrição. */
function decrypt(body: Buffer, receiverPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  expect(body.readUInt32BE(16)).toBe(4096);
  const sender = body.subarray(21, 21 + body[20]!);
  const ciphertext = body.subarray(21 + body[20]!);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivate);
  const shared = ecdh.computeSecret(sender);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), sender]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
  const key = (label: string, length: number) =>
    Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(`Content-Encoding: ${label}\0`), length));
  const decipher = createDecipheriv('aes-128-gcm', key('aes128gcm', 16), key('nonce', 12));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString('utf8');
}

describe('Mensagens de push', () => {
  const alert = {
    type: 'EXPIRY' as const,
    productId: 'p1',
    productName: 'Iogurte natural',
    levelName: 'Urgente',
    quantity: 6,
    expiresOn: '2026-10-20',
    days: 3,
  };

  it('um alerta vira um push do lote, com o nível e o prazo', () => {
    expect(buildPushAlert([alert])).toEqual({
      title: 'Urgente: Iogurte natural',
      body: '6 un. com validade 20/10/2026 (vence em 3 dias).',
      url: '/products/p1',
      tag: 'lote-p1',
    });
    expect(buildPushAlert([{ ...alert, type: 'DEPLETED', levelName: null }])?.title).toBe(
      'Lote baixado: Iogurte natural',
    );
    expect(buildPushAlert([])).toBeNull();
  });

  it('vários alertas do mesmo minuto vão num push só, contados por nível', () => {
    const message = buildPushAlert([
      alert,
      { ...alert, productId: 'p2', levelName: 'Vencido', days: -1 },
      { ...alert, productId: 'p3' },
      { ...alert, productId: 'p4', type: 'DEPLETED', levelName: null },
    ]);
    expect(message).toEqual({
      title: '4 alertas de validade',
      body: 'Urgente: 2 · Vencido: 1 · Lotes baixados: 1',
      url: '/alerts',
      tag: 'alertas',
    });
  });

  it('o resumo diário leva a contagem do e-mail', () => {
    expect(buildPushDigest('Loja\nCentro', 'Vencido: 1, Urgente: 2')).toMatchObject({
      title: 'Facilita Validade: resumo do dia',
      body: 'Loja Centro · Vencido: 1, Urgente: 2',
    });
  });
});

describe('Web Push', () => {
  // Vetor do RFC 8291, apêndice A.
  const vector = {
    plaintext: 'When I grow up, I want to be a watermelon',
    senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    receiverPublic:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };

  it('cifra exatamente como o vetor do RFC 8291', () => {
    const sender = createECDH('prime256v1');
    sender.setPrivateKey(decode(vector.senderPrivate));
    const body = encryptPayload(
      Buffer.from(vector.plaintext),
      vector.receiverPublic,
      vector.auth,
      decode(vector.salt),
      sender,
    );
    expect(body.toString('base64url')).toBe(vector.body);
  });

  it('o navegador decifra o que o servidor cifra com chave efêmera', () => {
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const body = encryptPayload(
      Buffer.from('{"title":"Olá"}'),
      receiver.getPublicKey().toString('base64url'),
      auth.toString('base64url'),
    );
    expect(decrypt(body, receiver.getPrivateKey(), auth)).toBe('{"title":"Olá"}');
  });

  it('aceita só endereços dos serviços de push dos navegadores', () => {
    expect(isPushServiceEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushServiceEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(
      true,
    );
    expect(isPushServiceEndpoint('https://web.push.apple.com/QK')).toBe(true);
    expect(isPushServiceEndpoint('https://wns2-par02p.notify.windows.com/w/?token=1')).toBe(true);
    expect(isPushServiceEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isPushServiceEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isPushServiceEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isPushServiceEndpoint('https://user:pass@fcm.googleapis.com/x')).toBe(false);
  });

  it('assina o VAPID para o serviço do endereço e envia o conteúdo cifrado', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), decode(jwk.x!), decode(jwk.y!)]);
    const vapid = vapidFromEnv({
      WEB_PUSH_PUBLIC_KEY: point.toString('base64url'),
      WEB_PUSH_PRIVATE_KEY: jwk.d!,
      WEB_PUSH_SUBJECT: 'mailto:suporte@example.com',
    })!;
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    const auth = Buffer.from('fedcba9876543210');
    const requests: { url: string; init: RequestInit }[] = [];
    const sender = new WebPushSender(vapid, async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return new Response(null, { status: requests.length === 1 ? 201 : 410 });
    });
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: receiver.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    };
    const message = { title: 'Urgente: Iogurte', body: '6 un.', url: '/alerts', tag: 'x' };
    expect(await sender.send(subscription, message)).toBe('SENT');
    expect(await sender.send(subscription, message)).toBe('GONE');
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization!)!;
    expect(key).toBe(vapid.publicKey);
    expect(decodeProtectedHeader(token!)).toMatchObject({ alg: 'ES256' });
    const { payload } = await jwtVerify(
      token!,
      await importJWK(publicKey.export({ format: 'jwk' }), 'ES256'),
    );
    expect(payload).toMatchObject({
      aud: 'https://fcm.googleapis.com',
      sub: 'mailto:suporte@example.com',
    });
    const body = Buffer.from(requests[0]!.init.body as Uint8Array);
    expect(JSON.parse(decrypt(body, receiver.getPrivateKey(), auth))).toEqual(message);
  });

  it('exige as duas chaves VAPID e o contato juntos', () => {
    expect(vapidFromEnv({})).toBeNull();
    expect(() => vapidFromEnv({ WEB_PUSH_PUBLIC_KEY: 'x' })).toThrow('juntos');
  });
});

describe('Firebase Cloud Messaging', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const env = {
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'facilita-validade',
      client_email: 'push@facilita-validade.iam.gserviceaccount.com',
      private_key: privateKey,
    }),
    FCM_APP_ID: '1:123:android:abc',
    FCM_API_KEY: 'AIza-test',
    FCM_SENDER_ID: '123',
  };

  it('troca a conta de serviço por um token, reaproveita e envia ao aparelho', async () => {
    const calls: { url: string; body: string }[] = [];
    const sender = new FcmSender(fcmFromEnv(env)!, async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      if (String(url).includes('oauth2'))
        return Response.json({ access_token: 'ya29.token', expires_in: 3600 });
      return calls.filter((call) => call.url.includes('messages')).length === 1
        ? Response.json({ name: 'projects/x/messages/1' })
        : Response.json(
            { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
            { status: 404 },
          );
    });
    const message = { title: 'Urgente: Iogurte', body: '6 un.', url: '/alerts', tag: 'alertas' };
    expect(await sender.send('device-token', message)).toBe('SENT');
    expect(await sender.send('device-token', message)).toBe('GONE');
    expect(calls.filter((call) => call.url.includes('oauth2'))).toHaveLength(1);
    expect(calls[1]!.url).toBe(
      'https://fcm.googleapis.com/v1/projects/facilita-validade/messages:send',
    );
    expect(JSON.parse(calls[1]!.body)).toMatchObject({
      message: { token: 'device-token', notification: { title: 'Urgente: Iogurte' } },
    });
  });

  it('desliga sem conta de serviço e exige os dados do app Android', () => {
    expect(fcmFromEnv({})).toBeNull();
    expect(() => fcmFromEnv({ FCM_SERVICE_ACCOUNT_JSON: env.FCM_SERVICE_ACCOUNT_JSON })).toThrow(
      'FCM_APP_ID',
    );
  });
});
