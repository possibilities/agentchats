import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { readerApiMiddleware } from './server/reader-api.ts'

function readerLocalApi(): Plugin {
  return {
    name: 'agentchats-reader-api',
    configureServer(server) {
      server.middlewares.use(readerApiMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(readerApiMiddleware())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  // Prebundle the lazy diff renderer too, so opening the first file in dev
  // cannot trigger a dependency-optimizer reload and discard disclosure state.
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@tanstack/react-virtual",
    ],
  },
  plugins: [readerLocalApi(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
