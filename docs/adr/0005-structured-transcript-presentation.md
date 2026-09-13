# 5. Structured transcript presentation

Status: Partially superseded by [ADR 0007](0007-voice-inspection-and-optional-interruption.md)
Date: 2026-09-13

Mike requested readable voice-to-agent handoffs instead of opaque protocol
envelopes. Preserve the record while presenting its request and context clearly.

## Evidence

Codex source at `d6ce3c6a70` defines the canonical payload in
`codex-rs/core/src/context/realtime_delegation.rs`: optional `source`, required
`input`, optional `transcript_delta`, with XML-escaped text. Ordinary handoffs have
no source. `transcript_tail_flush` marks remaining context at the end of a voice
session. `realtime_conversation_tests.rs` verifies escaping and retained context;
`context/realtime_start_instructions.rs`, `realtime_end_instructions.rs` and
`context/world_state/realtime_tests.rs` establish the separate start/end notices.

The agentvoice integration sibling verified the ordinary shape against a local
Codex response-item transcript from 2026-09-12: the requested action occurs in
`input`, and a sole `user:` transcript delta may repeat that same action. No
operator transcript is copied into repository fixtures; tests use synthetic text.

## Decision

Add optional provider-neutral `Message.presentation` with plain-text title,
body and labeled detail sections. The existing `Transcript` and `TranscriptBlock`
render it and retain a collapsed **Original message** containing unchanged source
content. Keep the Human / Agent author label. No AI summarization or HTML parsing
is needed.

The Codex adapter owns strict full-envelope recognition and exposes
`parseCodexMessagePresentation` from the package's `/codex` entry. React never
inspects a provider's protocol tags. Agentvoice can call that same helper while
normalizing its own data, without requiring an HTTP source.

Ordinary delegation presents the input under **Via Voice**, with additional
context collapsed. Identical sole-user context is not repeated. A tail flush is
**Voice session ended**, not a new delegated request; its context and instructions
remain inspectable. Known start/end conversation notices get short descriptions
and retain complete instructions as details.

Recognize only complete known structures. Partial streaming envelopes, unknown
fields/sources, mixed prose, code examples, nested envelopes and custom notices
return no interpretation and retain the normal renderer. Decode XML entities
once, render all interpreted fields as plain text, and always preserve the exact
original. This is presentation metadata only; parser/store/index ingestion and
committed-history discovery are unchanged.
