/**
 * Gera o par de chaves VAPID do Web Push (notificações do painel instalado como aplicativo).
 * Gere uma vez por servidor: trocar a chave invalida as inscrições já feitas nos navegadores.
 *
 * Uso: node scripts/web-push-keys.mjs
 * Copie as linhas para o .env (desenvolvimento) ou para a configuração do servidor.
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
// Ponto público não comprimido (0x04 || x || y), como os navegadores esperam.
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]).toString('base64url');

console.log(`WEB_PUSH_PUBLIC_KEY=${publicKey}`);
console.log(`WEB_PUSH_PRIVATE_KEY=${jwk.d}`);
console.log('WEB_PUSH_SUBJECT=mailto:suporte@seu-dominio.com.br');
