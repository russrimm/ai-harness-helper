import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI is served by the CLI's Fastify server from `packages/cli/public`.
// Relative asset paths keep the bundle mount-point agnostic.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
    },
  },
});
