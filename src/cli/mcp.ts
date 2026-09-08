import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentchatsMcpServer } from "./mcp-server.ts";

/** Stdout remains JSON-RPC until EOF or a signal closes this owned server. */
export async function serveAgentchatsMcp(): Promise<void> {
  const { server, drain } = createAgentchatsMcpServer();
  const abortCalls = server.server.onclose;
  let stopping = false;
  let rejectClosed: ((reason: unknown) => void) | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    rejectClosed = reject;
    server.server.onclose = () => { abortCalls?.(); resolve(); };
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().catch((error: unknown) => rejectClosed?.(error));
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.connect(new StdioServerTransport());
    if (process.stdin.readableEnded || process.stdin.destroyed) stop();
    await closed;
  } finally {
    process.stdin.off("end", stop);
    process.stdin.off("close", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.close();
    await drain();
  }
}
