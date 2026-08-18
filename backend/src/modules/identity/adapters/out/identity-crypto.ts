import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { IdentityCrypto } from '../../application/identity-port.js';
import type { TenantActor } from '../../../../shared/domain/context.js';

export class ArgonJwtCrypto implements IdentityCrypto {
  private readonly secret: Uint8Array;
  private readonly dummy: Promise<string>;
  constructor(secret: string) {
    if (Buffer.byteLength(secret) < 32)
      throw new Error('JWT_SECRET deve conter pelo menos 32 bytes.');
    this.secret = new TextEncoder().encode(secret);
    this.dummy = this.hashPassword(randomBytes(32).toString('base64url'));
  }
  hashPassword(password: string) {
    return hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }
  verifyPassword(passwordHash: string, password: string) {
    return verify(passwordHash, password);
  }
  async dummyVerify(password: string) {
    await this.verifyPassword(await this.dummy, password);
  }
  opaqueToken() {
    return randomBytes(32).toString('base64url');
  }
  hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  uuid() {
    return randomUUID();
  }
  sign(actor: TenantActor, seconds: number) {
    return new SignJWT({ store_id: actor.storeId, sid: actor.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(actor.userId)
      .setIssuer('controle-estoque')
      .setAudience('controle-estoque-api')
      .setIssuedAt()
      .setExpirationTime(`${seconds}s`)
      .sign(this.secret);
  }
  async verify(token: string) {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ['HS256'],
      issuer: 'controle-estoque',
      audience: 'controle-estoque-api',
      requiredClaims: ['sub', 'store_id', 'sid', 'iat', 'exp'],
    });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.store_id !== 'string' ||
      typeof payload.sid !== 'string' ||
      ![payload.sub, payload.store_id, payload.sid].every((value) => uuid.test(value))
    )
      throw new Error('Invalid token claims');
    return { userId: payload.sub, storeId: payload.store_id, sessionId: payload.sid };
  }
}
