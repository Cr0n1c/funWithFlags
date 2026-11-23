import { defineConfig } from 'vite';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

// Local development only: forward API calls to a separately running API server.
const apiProxyTarget = process.env.API_PROXY_TARGET;

export default defineConfig({
  base: basePath,
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: apiProxyTarget ? { '/api': { target: apiProxyTarget, changeOrigin: false } } : undefined,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
