# Be Like Grok: arthack web design

A local reading surface for Codex conversations. The operator's primary task is to find a session, read what was said, and inspect the work behind a reply without losing the conversation.

## Direction

- One transcript pane. Session navigation is a searchable rail that becomes a dismissible drawer on narrow screens.
- A compact web toolbar keeps Messages / Full and Watch reachable. Identity and conversation metadata sit inside the reading surface.
- User messages are restrained, right-aligned bubbles. Codex replies use the open canvas, with no avatar or repeated enclosing card.
- Full groups consecutive activities between messages. The summary exposes counts and failures. Opening it reveals individually collapsed rows; its summary stays reachable while scrolling through the group. Each file diff opens independently.
- Preserve the reader's place and disclosure state across polling. Watch appends committed items without a refresh animation. Errors remain visible above the transcript and offer recovery.
- No inactive composer, Voice surface, channel routing, simulated audio, or future integration slots.

## Design sources and decisions

Primary research read for this design:

1. Wiki: `design-studio-playbook-for-android-web-and-native-apps`. Use the actual renderer, realistic isolated fixtures, stable state, bounded controls, and separate screenshot evidence from interaction evidence. Synthetic review content belongs in tests, outside the shipping app.
2. Wiki: `vercel-design-guidance-for-native-fleet-apps`. Begin with the task, use a continuous canvas, earn each surface through interaction, retain legible metadata, default to stillness, and test narrow, sparse, dense, failed, and long-content states.
3. Current [Vercel design baseline](https://vercel.com/design.md) and [Web Interface Guidelines](https://vercel.com/design/guidelines). Transfer hierarchy, reflow, focus, semantics, and restraint. The Vercel report branding does not belong here.
4. `~/code/arthack/apps/arthack/app/globals.css`, `landing.module.css`, and the AgentVoice video site's composition; wiki `agentvoice-video-website-maintenance`. Product routes have their own useful compositions within the same house. This reader inherits arthack's current web palette, without reproducing its marketing splash.
5. `/Users/arthack/resources/design-with-ai`: core stance, design taste, typography, arthack north star, and web interface guidelines. Soft white reading text, sparse accent, deliberate spacing, and sans / mono roles are the relevant cues.

Signal Room and fleet TUI shell contracts are **not** this web app's brand system. The operator explicitly chose the web/native sources and a single chat surface. This document supersedes the original provisional TUI-derived brief.

## Foundations

| Role | Value | Use |
| --- | --- | --- |
| Canvas | `#090b0a` | Reading field |
| Field | `#111510` | Navigation, code, dialogs |
| Panel | `#1b2119` | Selection and local message bubbles |
| Text | `#e5e7df` | Reading text |
| Muted | `#969d91` | Readable metadata |
| Accent | `#c5e791` | Selection, focus, live watch |
| Boundary | `#30382f` | Essential separators |
| Failure | `#ee7e89` | Failed activity and recovery |

Geist carries prose and controls; Geist Mono carries code, workspace names, and timestamps. The reading scale is 15px / 1.75, metadata starts at 12px, the conversation title is 24px, and spacing follows an 8px rhythm. The product deliberately uses arthack's dark appearance. No theme picker or decorative motion is needed for the reading task.



## Verification

`npm run check` checks lint, types, and the production build. `npm test` exercises 100-activity runs, per-file Pierre rendering, density persistence, initial and idle scrolling, session search, mobile selection, polling recovery, and long content. The visual test captures production components using test-only synthetic API responses. The pictures establish composition; behavioral assertions establish interaction.

The API retains read-only discovery in `state_5.sqlite` and committed history / follow in `thread_history_1.sqlite`. No database or network write surface is introduced.
