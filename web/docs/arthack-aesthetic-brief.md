# Agentchats: arthack transcript design

A local reading surface for Codex conversations. The operator's primary task is to find a session, read what was said, and inspect the work behind a reply without losing the conversation.

Revised September 13, 2026 for Mike’s monospaced transcript mandate. This replaces
the earlier sans-serif, right-aligned bubble treatment while retaining the arthack
web palette and reader interactions. The same presentation ships in
`@agentchats/transcript` for agentvoice.

## Direction

- One transcript pane. Session navigation is a searchable rail that becomes a dismissible drawer on narrow screens.
- A compact web toolbar keeps Messages / Full and Watch reachable. Identity and conversation metadata sit inside the reading surface.
- Human input and Agent output share one left reading edge. Human input has a flat, softly filled inset with a single boundary; Agent replies use the open canvas. Human / Agent labels and optional timestamps remain explicit. No avatars or speech-bubble tails.
- Full groups consecutive activities between messages. The summary exposes counts and failures. Opening it reveals individually collapsed rows; its summary stays reachable while scrolling through the group. Each file diff opens independently.
- Preserve the reader's place and disclosure state across polling. Watch appends committed items without a refresh animation. Errors remain visible above the transcript and offer recovery.
- The reader stays read-only. Hosts with send capabilities can compose the existing shared Agent composer below the transcript; it uses the same mono typography and column. Queue, steer, stop, edit, and follow behavior stay host-owned.

## Design sources and decisions

Research read again before the monospaced revision:

1. Wiki: `design-studio-playbook-for-android-web-and-native-apps`. Use the actual renderer, realistic isolated fixtures, stable state, bounded controls, and separate screenshot evidence from interaction evidence. Synthetic review content belongs in tests, outside the shipping app.
2. Wiki: `vercel-design-guidance-for-native-fleet-apps`. Begin with the task, use a continuous canvas, earn each surface through interaction, retain legible metadata, default to stillness, and test narrow, sparse, dense, failed, and long-content states.
3. Current [Vercel design baseline](https://vercel.com/design.md), retrieved September 13. Transfer hierarchy, shared alignment, one owner per gap, and readable density. Its report branding and default sans-serif prose roles do not override this product’s explicit mono brief.
4. `~/code/arthack/apps/arthack/app/globals.css` and `landing.module.css`. Carry forward the charcoal, soft white, lime and Geist Mono house vocabulary; keep marketing grain, wordmark effects and wide tracking out of reading content.
5. `/Users/arthack/resources/design-with-ai`: core stance, design taste, typography and arthack north star. A narrow type scale, restrained weights, clear rhythm and dark monospaced identity apply here. Marketing whitespace ratios do not govern a transcript.
6. Wiki: `fleet-tui-design` and `arthack-tui-design-language-signal-room`. Borrow consistent mono metrics, readable secondary text, quiet state and compact grouping. Their palette, all-caps vocabulary, command palette and chromeless terminal shell do not apply to this web reader.

Signal Room and fleet TUI shell contracts are **not** this web app's brand system. The operator explicitly chose the web/native sources and a single chat surface. This document supersedes the original provisional TUI-derived brief.

## Foundations

| Role | Value | Use |
| --- | --- | --- |
| Canvas | `#090b0a` | Reading field |
| Field | `#111510` | Navigation, code, dialogs |
| Panel | `#1b2119` | Selection, inline code and follow chip |
| Text | `#e5e7df` | Reading text |
| Muted | `#969d91` | Readable metadata |
| Accent | `#c5e791` | Selection, focus, live watch |
| Boundary | `#30382f` | Essential separators |
| Failure | `#ee7e89` | Failed activity and recovery |

Geist Mono carries prose, metadata, controls, code and composer input. The stack is
`"Geist Mono Variable", ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas,
"Liberation Mono", monospace`. The reader already bundles Geist Mono; the shared
package uses the host’s font or this system fallback, without a font download.

| Decision | Value and reason |
| --- | --- |
| Reading | 18px / 28px, regular weight. Mike explicitly asked for a much larger default. The tighter relative leading and message gaps keep this readable scale compact. |
| Hierarchy | 13–14px labels; 16px / 24px code, tool output and queued text; 20–24px conversation title. Medium labels and headings, semibold only for Markdown emphasis. |
| Rhythm | 8px from role to body, 12px between paragraphs, 24px between messages, 20px in narrow lanes (formerly 40px). Space separates turns without boxing every reply. |
| Width | Widen the outer column from 880px to 1120px for code, tables and diffs, but cap prose at 80ch. Widening every line would make the return to the next line harder. |
| Alignment | Title, role, message text and activity share a reading edge. Human input is a flat field; Agent replies remain open. Composer uses the same outer column and 18px input. Its placeholder and accessible name identify the field; only the outer input surface shows focus. |
| Compression | Each lane reduces its gutters from 32px to 20px below 800px and 16px below 400px. Below 640px it tightens message gaps and stacks activity file counts. Text wraps, code scrolls locally, labels and failures remain readable. Coarse pointers keep 44px controls; composer input stays at the full 18px reading size. |
| Surface | Keep arthack charcoal/lime, flat boundaries and 4px control corners. No animated status, phosphor glow, scanlines, fake prompts, line numbers or Signal Room shell. |

Tightening comes from rhythm and alignment, not reducing meaningful metadata below
13px. Inline code now stays at the prose size because both are monospaced. The
shared CSS owns these choices; hosts may override `--transcript-column` and
`--transcript-measure` deliberately. Older host padding/gap overrides should be
removed to adopt the shared density.

## Verification

`bun run web:check` checks lint, types, and both reader/package builds. `bun run web:test` exercises 100-activity runs, per-file Pierre rendering, density persistence, initial and idle scrolling, session search, mobile selection, polling recovery, and long content. The visual test captures production components using test-only synthetic API responses. The pictures establish composition; behavioral assertions establish interaction.

Session discovery reads the agentchats index; Codex eligibility uses `state_5.sqlite`, and committed history / follow uses `thread_history_1.sqlite`. No database or network write surface is introduced.
