import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The Arena preview proxies the dev server through a wildcard host, so
    // allow any Host header instead of rejecting non-localhost origins.
    allowedHosts: true,
    hmr: { protocol: 'wss', clientPort: 443 },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
