import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import manifest from "./packages/transcript/package.json" with { type: "json" }

const external = [
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.peerDependencies),
]
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "packages/transcript/dist",
    lib: {
      entry: {
        index: "src/transcript/index.ts",
        react: "src/transcript/react.ts",
        codex: "src/transcript/codex.ts",
        styles: "src/transcript/styles.ts",
      },
      formats: ["es"],
      fileName: (_format, entry) => `${entry}.js`,
      cssFileName: "styles",
    },
    rolldownOptions: {
      external: (id) =>
        external.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
})
