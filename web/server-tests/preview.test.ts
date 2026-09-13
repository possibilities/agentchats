import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createSchema } from "../../src/store/schema.ts"

async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No listening address")
  await new Promise<void>((done) => server.close(() => done()))
  return address.port
}

test("production preview serves the API through portless HTTPS, rejects duplicate binds, and closes on TERM", async () => {
  const web = resolve(import.meta.dirname, "..")
  // The check workflow builds before testing. Exercise those actual assets.
  if (!existsSync(join(web, "dist/index.html"))) throw new Error("Run bun run web:build before reader tests")
  const directory = mkdtempSync(join(tmpdir(), "agentchats-preview-"))
  const index = join(directory, "index.db")
  const database = new Database(index, { create: true })
  createSchema(database)
  database.close()
  const port = await freePort()
  const env = { ...process.env, PORT: String(port), PORTLESS_URL: "https://agentchats.localhost", AGENTCHATS_INDEX: index }
  const backend = Bun.spawn([process.execPath, join(web, "server/preview.ts")], { env, stdout: "pipe", stderr: "pipe" })
  let proxy: ReturnType<typeof Bun.spawn> | undefined
  try {
    const deadline = Date.now() + 5000
    let ready = false
    while (Date.now() < deadline) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/`)).ok } catch { /* starting */ }
      if (ready) break
      await Bun.sleep(25)
    }
    expect(ready).toBe(true)
    const certificate = join(directory, "cert.pem")
    const key = join(directory, "key.pem")
    const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=agentchats.localhost", "-keyout", key, "-out", certificate], { stdout: "ignore", stderr: "pipe" })
    expect(generated.exitCode).toBe(0)
    const proxyPortFile = join(directory, "proxy-port")
    const script = join(directory, "proxy.mjs")
    writeFileSync(script, `
      import { createProxyServer } from ${JSON.stringify(new URL("../node_modules/portless/dist/index.js", import.meta.url).href)};
      import { readFileSync, writeFileSync } from "node:fs";
      const server = createProxyServer({
        getRoutes: () => [{ hostname: "agentchats.localhost", port: ${port} }], proxyPort: 443,
        tls: { cert: readFileSync(${JSON.stringify(certificate)}), key: readFileSync(${JSON.stringify(key)}) }
      });
      server.listen(0, "127.0.0.1", () => writeFileSync(${JSON.stringify(proxyPortFile)}, String(server.address().port)));
    `)
    proxy = Bun.spawn(["node", script], { stdout: "ignore", stderr: "pipe" })
    const proxyDeadline = Date.now() + 3000
    while (!existsSync(proxyPortFile) && Date.now() < proxyDeadline) await Bun.sleep(20)
    expect(existsSync(proxyPortFile)).toBe(true)
    const proxyPort = Number(readFileSync(proxyPortFile, "utf8"))
    const headers = { Host: "agentchats.localhost", Origin: "https://agentchats.localhost" }
    // The certificate is synthetic, generated only inside this test directory.
    const options = { headers, tls: { rejectUnauthorized: false } }
    const base = `https://127.0.0.1:${proxyPort}`
    const html = await fetch(base, options)
    expect(await html.text()).toContain("<title>Agentchats</title>")
    const result = await fetch(`${base}/api/threads`, options)
    expect(result.status).toBe(200)
    expect(result.headers.get("x-portless")).toBe("1")
    expect(await result.json()).toEqual({ threads: [] })
    const foreign = await fetch(`${base}/api/threads`, { ...options, headers: { ...headers, Origin: "https://another.localhost" } })
    expect(foreign.status).toBe(403)
    const duplicate = Bun.spawn([process.execPath, join(web, "server/preview.ts")], { env, stdout: "pipe", stderr: "pipe" })
    expect(await duplicate.exited).toBe(1)
    expect(await new Response(duplicate.stderr).text()).toContain("already in use")
    expect((await fetch(`${base}/api/threads`, options)).status).toBe(200)
    backend.kill("SIGTERM")
    expect(await backend.exited).toBe(0)
    expect(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)).toBe(false)
  } finally {
    backend.kill("SIGTERM")
    proxy?.kill("SIGTERM")
    await Promise.all([backend.exited, proxy?.exited])
    rmSync(directory, { recursive: true, force: true })
  }
}, 15000)
