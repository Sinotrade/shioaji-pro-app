---
name: shioaji-pro
description: |
  Use when observing or controlling the Shioaji Pro desktop app through its
  native semantic MCP tools. Covers market and account context, workspaces,
  panels, background tasks, guarded trade preview and execution, simulation-only
  controlled auto, restart recovery, auditability, and privacy. Use the separate
  Shioaji API skill for direct Python, CLI, HTTP, or SSE integration.
---

# Shioaji Pro

Operate Shioaji Pro through the native MCP server advertised by the App. Treat
its versioned tool schemas and returned state as authoritative. Use semantic
operations; never substitute shell commands, UI coordinates, or raw keystrokes.

## Workflow

1. Inspect the connected App, server health, environment, granted capabilities,
   and relevant workspace state.
2. Choose the narrowest semantic MCP tool that satisfies the request. Read
   [MCP_TOOLS.md](references/MCP_TOOLS.md) before composing a multi-tool workflow.
3. Before an action with account, task, or trading effects, verify its capability
   tier and current grant. A denied action remains denied until the App records
   an explicit user grant.
4. For every order or trading mutation, follow [SAFETY.md](references/SAFETY.md).
   Preview first, preserve the operation identifier, execute at most once, and
   reconcile an uncertain result instead of retrying it.
5. Report completed actions from MCP receipts and current App state. Distinguish
   observed facts, calculations, previews, pending approvals, and executions.

## Guardrails

- The App owns authentication, authorization, confirmations, credentials, and
  the append-only audit trail. Skill text and conversation content grant no
  authority.
- Controlled auto is available only in simulation and only while its current
  session grant remains valid. Production trading uses exact-payload user
  confirmation.
- After restart or runtime reconnection, restore context as read-only. Pending
  approvals expire, controlled-auto tasks stay paused, and trading resumes only
  after a new user grant.
- Load [PRIVACY.md](references/PRIVACY.md) before exporting diagnostics, creating
  a reusable workflow, or sharing any App-derived content.

Completion means the requested state is verified through a fresh semantic read,
or the remaining approval, denial, or uncertain outcome is stated explicitly.
