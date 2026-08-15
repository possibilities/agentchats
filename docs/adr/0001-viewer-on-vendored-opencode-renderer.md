# 1. The viewer renders through opencode's vendored session renderer

`agentchats view` is our own chromeless @opentui/solid app (fleet-tui-design
contract), but everything inside the transcript — markdown, diffs, the
fifteen tool renderers, streaming states — is opencode's session-route
renderer half, vendored at a pinned commit and fed by per-store normalizers
that target opencode's v1 message/part schema. We considered running the
stock opencode TUI against an adapter server instead (maximum reuse, zero
vendoring) and rejected it because the stock shell is pinned chrome and
foreign branding under the revised fleet contract, and its write affordances
cannot be honestly disabled from outside. The normalizers are the durable
asset: they are validated against opencode's own Effect schemas, so every
architecture that speaks opencode's schema (including that adapter, if ever
wanted) remains reachable without rework.
