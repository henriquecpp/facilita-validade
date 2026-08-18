import type { PrismaDatabase } from '../../shared/infrastructure/prisma.js';
import { AuthService } from './application/auth-service.js';
import { PairingService } from './application/pairing-service.js';
import { ArgonJwtCrypto } from './adapters/out/identity-crypto.js';
import { PrismaIdentityPersistence } from './adapters/out/prisma-identity.js';
import { PrismaPairingPersistence } from './adapters/out/prisma-pairings.js';

const clock = { now: () => new Date() };

export function createAuthService(prisma: PrismaDatabase, jwtSecret: string) {
  return new AuthService(
    new PrismaIdentityPersistence(prisma),
    new ArgonJwtCrypto(jwtSecret),
    clock,
  );
}

/**
 * Autenticação e pareamento compartilham a mesma instância de crypto: o construtor
 * calcula um hash Argon2 de referência, e não há por que pagar isso duas vezes.
 */
export function createIdentityServices(
  prisma: PrismaDatabase,
  jwtSecret: string,
): { auth: AuthService; pairing: PairingService; crypto: ArgonJwtCrypto } {
  const crypto = new ArgonJwtCrypto(jwtSecret);
  const auth = new AuthService(new PrismaIdentityPersistence(prisma), crypto, clock);
  const pairing = new PairingService(new PrismaPairingPersistence(prisma), auth, crypto, clock);
  return { auth, pairing, crypto };
}
