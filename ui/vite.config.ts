import { defineConfig } from 'vite';

// The UI only ever talks to the middleware through relative `/api/...` URLs.
// In production nginx proxies that prefix to the API container; in `vite dev`
// this proxy does the same job so the browser sees a single origin either way.
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
