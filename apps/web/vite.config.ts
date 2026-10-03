import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: the API runs on :8040 serving /v1 and Socket.IO on /socket.io (no /att prefix locally).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://localhost:8040',
      '/socket.io': { target: 'http://localhost:8040', ws: true },
    },
  },
});
