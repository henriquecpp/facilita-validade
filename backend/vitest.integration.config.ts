import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['test/integration/**/*.spec.ts', 'test/identity/auth-database.spec.ts'],
      globalSetup: ['test/support/postgres-container.ts'],
      // Um único banco compartilhado; os arquivos usam lojas próprias, mas rodam em série.
      fileParallelism: false,
    },
  }),
);
