import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const web = path.resolve(import.meta.dirname, "..")
const directory = await mkdtemp(path.join(tmpdir(), "agentchats-package-"))
function run(command: string[], cwd = directory) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return result.stdout.toString()
}
try {
  const packed = JSON.parse(
    run(
      [
        "npm",
        "pack",
        "--workspace",
        "@agentchats/transcript",
        "--pack-destination",
        directory,
        "--json",
      ],
      web,
    ),
  )
  if (
    packed[0].files.some((file: { path: string }) =>
      /(?:^|\/)(?:App|reader-api|session-sidebar)\./.test(file.path),
    )
  )
    throw new Error("Package contains app internals")
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  run([
    "npm",
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    path.join(directory, packed[0].filename),
    "react@19.2.8",
    "react-dom@19.2.8",
    "@types/react@19.2.18",
    "typescript@6.0.2",
  ])
  await writeFile(
    path.join(directory, "consumer.tsx"),
    `
import { groupTranscript, mergeTranscript, type TranscriptMessage, type TranscriptSource } from '@agentchats/transcript'
import { Transcript, TranscriptBlock, useTranscript } from '@agentchats/transcript/react'
import { createCodexTranscriptSource } from '@agentchats/transcript/codex'
const messages: TranscriptMessage[] = [{ id: 'one', role: 'user', content: 'Hello', status: 'complete' }]
const source: TranscriptSource = createCodexTranscriptSource()
export function Consumer() {
  const { snapshot } = useTranscript(source, null)
  return <><Transcript transcriptId="one" messages={snapshot?.messages ?? messages} /><TranscriptBlock block={groupTranscript(messages)[0]} /></>
}
if (typeof mergeTranscript !== 'function') throw new Error('Missing data entry')
`,
  )
  run([
    process.execPath,
    path.join(directory, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--module",
    "nodenext",
    "--target",
    "es2023",
    "--jsx",
    "react-jsx",
    "consumer.tsx",
  ])
  run([
    process.execPath,
    "--eval",
    "const data = await import('@agentchats/transcript'); if (data.groupTranscript([]).length) throw new Error('Invalid data entry'); await import('@agentchats/transcript/react'); await import('@agentchats/transcript/codex')",
  ])
  const css = await readFile(
    path.join(directory, "node_modules/@agentchats/transcript/dist/styles.css"),
    "utf8",
  )
  if (!css.includes("@scope (.agentchats-transcript)"))
    throw new Error("Missing scoped stylesheet")
  console.log(
    "Packed transcript package: isolated install, strict consumer types, runtime imports, and stylesheet passed.",
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
