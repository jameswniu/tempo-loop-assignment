import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied so the browser talks to one origin in development.
    // Without this the page would be making cross-origin calls to :8080 and
    // every request would depend on the CORS allow-list lining up.
    proxy: { '/v1': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
});
