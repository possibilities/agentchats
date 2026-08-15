// Incremental JSONL reader with follow: read everything present, then keep
// reading appended bytes as the harness writes them. Partial trailing lines
// are buffered until their newline arrives. Watching uses fs.watch with a
// polling fallback timer — harnesses write with plain appends, so change
// events are reliable on APFS, and the poll catches anything missed.
import { watch, type FSWatcher } from "node:fs"
import { open } from "node:fs/promises"

export type Tail = {
  stop(): void
}

export function tailFile(input: {
  path: string
  live: boolean
  onLine(line: string): void
  onBatch?(): void
  onGone?(): void
}): Promise<Tail> {
  let offset = 0
  let carry = ""
  let reading = false
  let pending = false
  let stopped = false
  let watcher: FSWatcher | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  async function readMore() {
    if (reading) {
      pending = true
      return
    }
    reading = true
    try {
      do {
        pending = false
        let handle
        try {
          handle = await open(input.path, "r")
        } catch {
          input.onGone?.()
          return
        }
        try {
          const stat = await handle.stat()
          if (stat.size < offset) {
            // Truncated/rewritten underneath us; start over.
            offset = 0
            carry = ""
          }
          while (offset < stat.size) {
            const length = Math.min(1 << 20, stat.size - offset)
            const buffer = Buffer.alloc(length)
            const { bytesRead } = await handle.read(buffer, 0, length, offset)
            if (bytesRead <= 0) break
            offset += bytesRead
            carry += buffer.toString("utf8", 0, bytesRead)
            let index
            while ((index = carry.indexOf("\n")) !== -1) {
              const line = carry.slice(0, index)
              carry = carry.slice(index + 1)
              if (line.trim()) input.onLine(line)
            }
          }
        } finally {
          await handle.close()
        }
      } while (pending && !stopped)
      input.onBatch?.()
    } finally {
      reading = false
    }
  }

  return readMore().then(() => {
    if (input.live && !stopped) {
      try {
        watcher = watch(input.path, () => void readMore())
      } catch {
        input.onGone?.()
      }
      poll = setInterval(() => void readMore(), 2000)
    }
    return {
      stop() {
        stopped = true
        watcher?.close()
        if (poll) clearInterval(poll)
      },
    }
  })
}
