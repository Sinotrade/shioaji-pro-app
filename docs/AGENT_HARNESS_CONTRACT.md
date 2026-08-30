# Agent Harness contract v1

Shioaji Pro exposes semantic App Tools to provider-native runtimes. The public
contract is versioned independently from React components, Tauri commands, and
provider transports so Codex and Claude use the same authorization vocabulary.
The corresponding trust boundaries and residual risks are documented in
[`AGENT_HARNESS_THREAT_MODEL.md`](AGENT_HARNESS_THREAT_MODEL.md).

## Capability tiers

| Capability | Scope |
| --- | --- |
| `market.read` | Contracts, quotes, snapshots, rankings, and market data |
| `account.read` | Positions, working orders, balances, and margin |
| `ui.control` | Semantic workspace, panel, symbol, layout, and local-skill actions |
| `task.manage` | Background task creation, state changes, and run history |
| `trade.preview` | Validate and price an exact order without sending it |
| `trade.execute` | Send, cancel, or modify an order after the required grant |

Tools are denied unless their v1 capability is granted. Runtime filesystem or
shell permission never grants a trading capability.

Every registered tool also declares `effect: read | mutation`. Native MCP
validation rejects unknown effects and requires `idempotency_key` in the input
schema of every mutation, independent of its capability tier.

The machine-readable registry contract lives at
[`schemas/agent-app-tools-v1.schema.json`](../schemas/agent-app-tools-v1.schema.json).
For example, a valid read tool is:

```json
{
  "contractVersion": 1,
  "name": "workspace.list_panels",
  "description": "List the panels in the active workspace",
  "capability": "ui.control",
  "effect": "read",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

The contract test asserts that the schema's version and capability enum remain
identical to the TypeScript constants consumed by the application.

## Native transport

The desktop host provides one authenticated loopback MCP endpoint. Every native
runtime receives a distinct short-lived bearer through its native MCP header
configuration, not an inherited child-process environment variable. Depending
on the provider's native protocol, that configuration can reside in an
owner-only temporary file or process argv and may therefore be observable to a
same-user process. Tokens are never returned to the WebView and are revoked when
the runtime stops. Tool
calls use typed JSON arguments and semantic names; coordinate
automation, raw key capture, and virtual Bash commands are outside this
contract.

## Trading lifecycle

Every mutation uses a client operation ID and exact request digest. Phase 1
native Agent runtimes are simulation-only; startup against a production server
fails before the provider process is spawned. The independent production
exact-payload confirmation contract remains staged but does not grant production
authority until the sidecar supports one-shot secret bootstrap. An interrupted
or timed-out mutation enters `unknown_outcome`; it may only be reconciled by its
operation ID and must never be submitted again automatically.

Until the broker exposes an immutable operation ID that survives an interrupted
response, matching code/side/quantity/price is evidence only. Zero, one, or many
payload matches cannot authorize a retry. `reconcile_order` therefore separates
`mutation_idempotency_key` (the original uncertain trade) from
`idempotency_key` (one reconciliation observation). Replaying one observation
is stable; a later broker-state observation uses a new attempt key and may move
the original mutation to a terminal reconciled state. Payload-shaped matches
remain unresolved and require manual verification.

Controlled auto is available only in simulation and only for the current App
session. Risk rules still apply and may reject or require confirmation.

## Restart policy

| State | Restart behavior |
| --- | --- |
| Conversations and task history | Restore |
| Pending approvals and capability grants | Expire |
| Controlled-auto permission | Downgrade to confirmation |
| Active controlled-auto task | Pause and require a new grant |

Audit records are native, centrally redacted, and read-only to skills. They
identify provider, runtime, action, capability, outcome, and a request digest
without storing credentials or raw account secrets. Keyed entry hashes plus a
MACed head checkpoint detect record edits, complete-tail removal, and whole-log
deletion. Approval/receipt lifecycle fields remain a follow-up before this log
can be treated as a complete compliance journal.
