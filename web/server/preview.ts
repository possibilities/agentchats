import { resolve } from "node:path"
import { preview } from "vite"

const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    process.env.PORTLESS_URL !== "https://agentchats.localhost") {
  throw new Error("Start the production reader with agentchats serve; portless must assign PORT and https://agentchats.localhost.")
}

// Portless normally adds a wildcard .localhost allowance. This reader serves
// private history and has exactly one named origin, including for static assets.
process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = "agentchats.localhost"
const root = resolve(import.meta.dirname, "..")
const server = await preview({
  root,
  configFile: resolve(root, "vite.config.ts"),
  preview: {
    host: "127.0.0.1", port, strictPort: true,
    allowedHosts: ["agentchats.localhost"], cors: false,
  },
})
console.log("Agentchats reader: https://agentchats.localhost")
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.httpServer.close(() => process.exit(0)))
}
