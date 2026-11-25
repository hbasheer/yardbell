import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const yardbell = process.env.YARDBELL_URL ?? 'http://127.0.0.1:4110'

// Yardbell refuses a request whose Origin is not its own host, so the proxy speaks as Yardbell's origin.
const asYardbell: ProxyOptions = {
  target: yardbell,
  changeOrigin: true,
  ws: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (req) => {
      if (req.getHeader('origin')) req.setHeader('origin', yardbell)
    })
    proxy.on('proxyReqWs', (req) => {
      if (req.getHeader('origin')) req.setHeader('origin', yardbell)
    })
  }
}

export default defineConfig({
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '^/(?!ui(/|$)|@vite|@react-refresh|@fs|@id|node_modules|src/)': asYardbell }
  },
  build: { outDir: '../assets/app', emptyOutDir: true }
})
