import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api/ws': { target: 'http://127.0.0.1:3080', ws: true },
      '/api': 'http://127.0.0.1:3080',
      '/healthz': 'http://127.0.0.1:3080',
      '/readyz': 'http://127.0.0.1:3080',
    },
  },
  build: {
    emptyOutDir: true,
  },
})
