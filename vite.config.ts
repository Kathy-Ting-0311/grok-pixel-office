import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const frontendPort = Number(process.env.OFFICE_FRONTEND_PORT ?? 5173);
const apiPort = Number(process.env.OFFICE_PORT ?? 4319);

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    host: '127.0.0.1',
    port: frontendPort,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  cacheDir: '.vite-cache',
  build: { chunkSizeWarningLimit: 2000 },
});