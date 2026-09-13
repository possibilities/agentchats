import {
  fetchThread,
  fetchThreadItems,
  type CodexTransportOptions,
} from "../lib/api/codex"
import type { TranscriptSource } from "./types"

export type { CodexTransportOptions } from "../lib/api/codex"

/** Map the existing reader HTTP API to portable transcript data. No database access. */
export function createCodexTranscriptSource(
  options: CodexTransportOptions = {},
): TranscriptSource {
  return {
    async load({ id, detail, signal }) {
      const view = await fetchThread(id, detail, signal, options)
      return {
        id: view.thread.id,
        title: view.thread.title,
        messages: view.thread.messages,
        cursor: String(view.latestOrdinal),
        status: view.status,
      }
    },
    async poll({ id, detail, cursor, signal }) {
      const ordinal = Number(cursor)
      if (
        !/^-?\d+$/.test(cursor) ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < -1
      ) {
        throw new Error("Invalid transcript cursor")
      }
      const update = await fetchThreadItems(
        id,
        ordinal,
        detail,
        signal,
        options,
      )
      return {
        messages: update.messages,
        cursor: String(update.latestOrdinal),
        status: update.status,
      }
    },
  }
}
