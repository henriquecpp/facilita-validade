import { randomInt } from 'node:crypto';
import type { ArgonJwtCrypto } from '../../../identity/adapters/out/identity-crypto.js';
import type { PlatformCrypto } from '../../application/platform-port.js';

/** Sem 0/O nem 1/l/I: a senha provisória é lida numa tela e digitada em outra. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Quatro grupos de quatro (`h7Kq-2mPx-…`): cerca de 92 bits, fácil de ditar e digitar. */
export function temporaryPassword(): string {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  ).join('-');
}

/** Argon2id e tokens os mesmos da identidade das lojas. */
export class PlatformCryptoAdapter implements PlatformCrypto {
  constructor(private readonly identity: ArgonJwtCrypto) {}
  hashPassword(password: string) {
    return this.identity.hashPassword(password);
  }
  verifyPassword(passwordHash: string, password: string) {
    return this.identity.verifyPassword(passwordHash, password);
  }
  dummyVerify(password: string) {
    return this.identity.dummyVerify(password);
  }
  opaqueToken() {
    return this.identity.opaqueToken();
  }
  hashToken(token: string) {
    return this.identity.hashToken(token);
  }
  uuid() {
    return this.identity.uuid();
  }
  temporaryPassword() {
    return temporaryPassword();
  }
}
