import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 开发时把 /api 与 /uploads 代理到本地 Go 服务
const backend = process.env.TRIPHUB_BACKEND ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    proxy: {
      '/api': backend,
      '/uploads': backend,
    },
  },
  build: {
    chunkSizeWarningLimit: 2500,
  },
})
