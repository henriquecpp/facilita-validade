import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      // Só no container (compose define a variável): no host, eventos nativos bastam.
      watch:
        process.env.VITE_WATCH_POLLING === 'true' ? { usePolling: true, interval: 300 } : undefined,
      proxy: {
        '/api': { target: env.VITE_DEV_API_TARGET || 'http://127.0.0.1:3001', changeOrigin: false },
      },
    },
    build: { sourcemap: false },
  };
});
