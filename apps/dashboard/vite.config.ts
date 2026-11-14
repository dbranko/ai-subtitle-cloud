import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard runs on its own port and proxies API calls to
// the API process, so the browser only ever talks to one origin (no CORS, and
// SSE works unchanged). In production the API serves the built files itself.
const apiTarget = `http://127.0.0.1:${process.env.API_PORT ?? '7001'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/health': apiTarget,
    },
  },
});
