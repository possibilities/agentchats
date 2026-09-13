import { resolve } from "node:path"
import { createServer } from "vite"

const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    process.env.PORTLESS_URL !== "https://agentchats.localhost") {
  throw new Error("Start the development reader with agentchats serve; portless must assign PORT and https://agentchats.localhost.")
}

// Portless normally adds a wildcard .localhost allowance. This reader serves
// private history and has exactly one named origin, including for static assets.
process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = "agentchats.localhost"
const root = resolve(import.meta.dirname, "..")
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: {
    host: "127.0.0.1", port, strictPort: true,
    allowedHosts: ["agentchats.localhost"], cors: false,
    hmr: { protocol: "wss", host: "agentchats.localhost", clientPort: 443 },
  },
})
await server.listen()
console.log("Agentchats reader: https://agentchats.localhost")
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.prependListener(signal, () => {
    // Keep a handler installed while Vite removes its TERM listener during close.
    // Both shutdown paths agree on a clean exit.
    process.exitCode = 0
    void server.close().then(() => process.exit(0))
  })
}
