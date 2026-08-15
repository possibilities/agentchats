// The viewer's data plane: the same shape the opencode TUI's sync context
// exposes (context/sync.tsx upstream), fed by normalizers instead of a server.
// The vendored renderer reads it through useSync(); normalizers write through
// the exported mutators. Parts are keyed by message id, mirroring upstream.
import { createStore, produce, reconcile } from "solid-js/store"
import type { Message, Part, Provider, Session, SessionStatus } from "./vendor/types"

type Data = {
  session: Session[]
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_status: Record<string, SessionStatus>
  permission: Record<string, never[]>
  question: Record<string, never[]>
  capabilities: { experimentalBackgroundSubagents?: boolean }
  provider: Provider[]
}

const [data, setData] = createStore<Data>({
  session: [],
  message: {},
  part: {},
  session_status: {},
  permission: {},
  question: {},
  capabilities: {},
  provider: [],
})

export function useSync() {
  return {
    data,
    session: {
      get(id: string) {
        return data.session.find((session) => session.id === id)
      },
      // Subagent hydration is a server affordance; the viewer has no server.
      sync(_id: string) {
        return Promise.resolve()
      },
    },
  }
}

export function upsertSession(session: Session) {
  setData(
    produce((draft) => {
      const index = draft.session.findIndex((row) => row.id === session.id)
      if (index === -1) draft.session.push(session)
      else draft.session[index] = session
    }),
  )
}

export function upsertMessage(message: Message) {
  setData(
    produce((draft) => {
      const list = (draft.message[message.sessionID] ??= [])
      const index = list.findIndex((row) => row.id === message.id)
      if (index === -1) list.push(message)
      else list[index] = message
    }),
  )
}

export function upsertPart(part: Part) {
  setData(
    produce((draft) => {
      const list = (draft.part[part.messageID] ??= [])
      const index = list.findIndex((row) => row.id === part.id)
      if (index === -1) list.push(part)
      else list[index] = part
    }),
  )
}

export function setSessionStatus(sessionID: string, status: SessionStatus) {
  setData("session_status", sessionID, reconcile(status))
}

export function setProviders(providers: Provider[]) {
  setData("provider", providers)
}
