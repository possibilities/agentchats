# 7. Voice inspection and optional interruption

Status: Accepted
Date: 2026-09-13

Partially supersedes [ADR 0004](0004-host-owned-agent-interaction.md) for hosts
without interruption and [ADR 0005](0005-structured-transcript-presentation.md)
for Human Via Voice inspection.

## Decision

Human Via Voice messages keep their displayed request in the transcript and move
voice context and original source into an accessible modal opened by an inspection
icon in the upper-right corner of the Human field. The modal labels all three
variants, retains available context even when it repeats the request, and states
when context is absent. Other structured messages keep their existing disclosure
behavior. Source content and provider recognition boundaries remain unchanged.

An empty busy composer shows passive Working status when its host omits
`onInterrupt`. Hosts supplying the callback retain Stop and its existing lifecycle.
Send, steering, queue editing and mode selection retain their existing semantics.
Composer input and follow-up controls share an inner alignment.

## Rationale and consequences

Mike requested a quieter AgentVoice transcript with source inspection available
up close, and progress in place of a clickable Stop. Shared components own these
presentation capabilities; the host owns transport and whether interruption is
available. AgentVoice can overlay the composer while using the existing transcript
footer slot for measured clearance. The shared reader remains read-only.
