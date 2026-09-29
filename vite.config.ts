import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = Number(process.env.PORT ?? 3001);

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/socket.io': { target: `http://localhost:${SERVER_PORT}`, ws: true },
      '/api': { target: `http://localhost:${SERVER_PORT}` },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
