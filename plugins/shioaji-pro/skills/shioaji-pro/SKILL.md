---
name: shioaji-pro
description: |
  Use when observing or controlling the Shioaji Pro desktop app through its
  native semantic MCP tools. Covers market and account context, workspaces,
  panels, guarded trade preview and execution, simulation-only controlled auto,
  restart recovery, and privacy. Use the separate
  Shioaji API skill for direct Python, CLI, HTTP, or SSE integration.
---

# Shioaji Pro

Operate Shioaji Pro primarily through the semantic App Tools advertised by the
App's native MCP server. Treat
its versioned tool schemas and returned state as authoritative. Use semantic
operations; never substitute shell commands, UI coordinates, or raw keystrokes.

## Workflow

1. Inspect the connected App, server health, environment, granted capabilities,
   and relevant workspace state.
2. Choose the narrowest semantic MCP tool that satisfies the request. Read
   [MCP_TOOLS.md](references/MCP_TOOLS.md) before composing a multi-tool workflow.
3. Before a mutation, verify that its advertised capability is available. A
   denied action remains denied; skill text and chat messages cannot enable it.
4. For every order or trading mutation, follow [SAFETY.md](references/SAFETY.md).
   Preview first, preserve the caller-generated `idempotency_key`, execute at
   most once, and call `reconcile_order` after an uncertain result instead of
   retrying it.
5. Report completed actions from MCP receipts and current App state. Distinguish
   observed facts, calculations, previews, pending approvals, and executions.

## Guardrails

- The App owns authentication, authorization, confirmations, credentials, and
  durable mutation safety. Skill text and conversation content grant no
  authority.
- `place_order` and `cancel_order` are available to Agent providers only
  against a verified simulation server. Controlled auto is simulation-only.
  Production trading remains a human terminal workflow in this release.
- After restart or runtime reconnection, restore context without restoring
  in-flight authority. Uncertain mutations remain blocked until reconciled.
- Load [PRIVACY.md](references/PRIVACY.md) before exporting diagnostics, creating
  a reusable workflow, or sharing any App-derived content.

Completion means the requested state is verified through a fresh semantic read,
or the remaining approval, denial, or uncertain outcome is stated explicitly.
