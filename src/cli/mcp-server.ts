import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { commandError, runPrepared } from "./commands.ts";
import { CONTRACT } from "./contract.ts";
import { agentTools, invocationFor, jsonOutput, serverInstructions } from "./mcp-tools.ts";

export function createAgentchatsMcpServer(env = process.env) {
  const fixedEnv = { ...env };
  const lifetime = new AbortController();
  const active = new Set<Promise<CallToolResult>>();
  let queue: Promise<unknown> = Promise.resolve();
  const server = new McpServer(
    { name: CONTRACT.meta.name, version: CONTRACT.meta.version },
    { instructions: serverInstructions() },
  );
  server.server.onclose = () => lifetime.abort();
  for (const tool of agentTools()) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: tool.annotations,
    }, async (args: unknown, extra): Promise<CallToolResult> => {
      const signal = AbortSignal.any([lifetime.signal, extra.signal]);
      const running = queue.then(async (): Promise<CallToolResult> => {
        try {
          signal.throwIfAborted();
          const token = extra._meta?.progressToken;
          const output = await runPrepared(
            tool.name,
            invocationFor(tool, (args ?? {}) as Record<string, unknown>),
            fixedEnv,
            {
              signal,
              ...(token === undefined ? {} : {
                onProgress: (event: { handled: number; total: number }) => {
                  void extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken: token, progress: event.handled, total: event.total },
                  }).catch(() => {});
                },
              }),
            },
          );
          if (typeof output.value === "string") {
            return { content: output.value === "" ? [] : [{ type: "text", text: output.value }] };
          }
          const ok = output.exitCode === 0 && jsonOutput(tool.command, output.value);
          return {
            ...(ok ? {} : { isError: true }),
            structuredContent: output.value,
            content: [
              ...(!ok ? [{ type: "text" as const, text: "The index pass reported failures. Completed session transactions remain indexed; inspect failures before retrying." }] : []),
              { type: "text", text: JSON.stringify(output.value, null, 2) },
            ],
          };
        } catch (error) {
          if (signal.aborted) return { isError: true, content: [{ type: "text", text: "Call cancelled." }] };
          const failure = commandError(error, tool.name).value;
          return {
            isError: true,
            structuredContent: failure,
            content: [
              { type: "text", text: `${failure.error.code}: ${failure.error.message}${failure.error.hint ? `\nhint: ${failure.error.hint}` : ""}` },
              { type: "text", text: JSON.stringify(failure, null, 2) },
            ],
          };
        }
      });
      queue = running.then(() => undefined, () => undefined);
      active.add(running);
      try {
        return await running;
      } finally {
        active.delete(running);
      }
    });
  }
  return { server, drain: async () => { await Promise.allSettled([...active]); } };
}
