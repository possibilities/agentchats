import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { codexApiMiddleware } from './server/codex-api.ts'

function codexLocalApi(): Plugin {
  return {
    name: 'codex-local-api',
    configureServer(server) {
      server.middlewares.use(codexApiMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(codexApiMiddleware())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Prebundle the lazy diff renderer too, so opening the first file in dev
  // cannot trigger a dependency-optimizer reload and discard disclosure state.
  optimizeDeps: { include: ["@pierre/diffs", "@pierre/diffs/react"] },
  plugins: [codexLocalApi(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
