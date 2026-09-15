# 8. Retire the web conversation reader

Status: Accepted
Date: 2026-09-15

Supersedes [ADR 0002](0002-own-the-web-conversation-reader.md),
[ADR 0003](0003-compose-transcript-surfaces.md),
[ADR 0004](0004-host-owned-agent-interaction.md),
[ADR 0005](0005-structured-transcript-presentation.md), and
[ADR 0007](0007-voice-inspection-and-optional-interruption.md) for AgentChats
ownership. Those records remain as the history of the reader and presentation
contracts that AgentChats previously hosted.

## Context

The React/Vite conversation reader and its reusable transcript package were
created for AgentVoice's application UI. Keeping them in AgentChats made a
search and evidence tool own another product's interface, dependencies,
browser tests, service command, and resident-service integration.

AgentChats still has a separate user interface with a current purpose: the
OpenTUI session picker behind bare `agentchats search`. It is consumed by
AgentSurface and remains part of AgentChats.

## Decision

Remove the `web/` tree, including the local reader, Codex committed-history
adapter, reusable React transcript package, visual assets, and browser/API
tests. Remove the `agentchats serve` command and all web-only build, install,
CI, test, error, and documentation paths.

AgentVoice owns its browser transcript implementation and application-specific
history adapters. It may preserve the presentation behavior and package API in
its own source, but AgentChats no longer publishes or serves that UI.

Preserve AgentChats' session index, ingest, archives, search and exact evidence
reads, routing inspection and receipts, MCP server, native resume command, and
OpenTUI picker. Bare `agentchats search` continues to open the picker;
`agentchats search --json` and MCP search keep their producer contracts.

## Consequences

- Installing AgentChats resolves only its Bun lockfile, links the CLI, and
  prepares the session index. It no longer requires npm, Vite, Playwright,
  portless, or a production browser build.
- `agentchats serve` and `https://agentchats.localhost` are retired. AgentStart
  must remove the resident reader service and related dependency checks.
- AgentVoice must stop consuming `@agentchats/transcript` from this repository
  and own the copied implementation before this retirement is integrated.
- AgentSurface's picker launch and the OpenTUI dependency remain unchanged.
