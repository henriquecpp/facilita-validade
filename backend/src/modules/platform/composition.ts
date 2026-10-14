import type { PrismaDatabase } from '../../shared/infrastructure/prisma.js';
import type { ArgonJwtCrypto } from '../identity/adapters/out/identity-crypto.js';
import type { PagonetSync } from '../integration/adapters/out/pagonet-sync.js';
import { PlatformService } from './application/platform-service.js';
import { PlatformCryptoAdapter } from './adapters/out/platform-crypto.js';
import { PrismaPlatform } from './adapters/out/prisma-platform.js';

export function createPlatformService(
  prisma: PrismaDatabase,
  crypto: ArgonJwtCrypto,
  pagonet: PagonetSync,
) {
  return new PlatformService(new PrismaPlatform(prisma), new PlatformCryptoAdapter(crypto), {
    get configured() {
      return !!pagonet.token;
    },
    check: () => pagonet.checkToken(),
  });
}
