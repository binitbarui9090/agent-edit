import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const API = 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    strictPort: true,
    // Same origin in dev, so the session cookie behaves as it does in production.
    proxy: { '/api': { target: API, ws: true }, '/health': API },
  },
});
