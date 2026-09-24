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
configuration, never through process argv (readable by every local user and
captured by command-line telemetry) or an inherited child-process environment
variable. The configuration is an owner-only file in a per-App-instance
directory that is deleted when the runtime stops or exits and swept at the next
start after a crash; it remains readable by the same OS user and by the
provider's own descendants. The endpoint accepts a bearer only from a
connection owned by that runtime's process tree. Tokens are never returned to
the WebView: runtime events, pending requests and RPC results are redacted
before delivery, and runtime events reach only the main window. Tokens are
revoked when the runtime stops. Tool
calls use typed JSON arguments and semantic names; coordinate
automation, raw key capture, and virtual Bash commands are outside this
contract.

## Trading lifecycle

Every mutation uses a client operation ID and exact request digest. Production
native runtimes require an App-owned sidecar reporting `bootstrap=one_shot_ipc`.
The host retains the exact serialized body. Confirm mode uses the independent
`agent-approval` window for each production mutation. Explicit Auto selection
requests a native session grant on its first production mutation; that window
authorizes the displayed mutation and subsequent risk-checked place/cancel calls
for the same runtime, generation and account. The grant never crosses into the
provider or WebView. Production proposals expire after 15 seconds. Native
snapshot timestamp and price checks reject stale or changed quotes before
dispatch; cancellation rechecks broker status and remaining quantity.
Missing or legacy bootstrap fails closed. An interrupted
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

Production per-order confirmation has a deliberate limitation: the last price
and best bid/ask captured for the proposal must equal the values re-read after
approval, and the whole round trip — including opening the approval window —
must finish within the 15-second proposal lifetime. On an actively ticking
product a human approval often misses that window. The order is then not sent,
the user sees 「報價已變動，請重新確認」 (or its 15-second variant), and the
Agent must re-propose at the new quote. The rule is not relaxed to a tolerance
band, because the user would otherwise authorize a price they never saw. Every
refusal names its cause — user denied, window closed, expired, quote changed,
runtime stopped or authority revoked, or risk check — and states that the
order was not sent.

The approval window renders `cancel_order`, `update_price`, and `update_qty`
as operations on an existing order (刪單／改價／減量) with the product, the
original order, and the remaining unfilled quantity. The native summary
carries an explicit `operation` and `remaining_quantity`; when a legacy summary
omits them the window derives both from the request operation and the order
status. It never renders the original order's side as a new buy or sell. The
outer request operation is authoritative: if the summary declares a different
`operation`, the window shows only the operation label. The window can already
render `update_price` and `update_qty`, but production does not accept them
yet: native proposal validation admits only `place_order` and `cancel_order`
and rejects every other Agent mutation before an approval is shown.

Controlled auto is available in simulation and in production after the user
grants the native scope above. It is never restored from persisted settings.
Account/environment changes, renderer reload and runtime stop revoke authority.
Risk rules still apply and may reject or require confirmation. Raw CLI trading
remains unavailable in production; semantic App Tools are the execution path.

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

## Phase skill parity gate

Every later Agent Harness or Agent Strategy phase must ship its skill surface
with its semantic tools. A phase is not complete until all of the following are
true:

1. The App's built-in Agent prompt routes the new capability and states its
   material limits.
2. The provider-neutral `shioaji-pro` plugin teaches the same workflow through
   one shared `SKILL.md` and references tree installed natively by Codex and
   Claude Code.
3. Tool schemas remain the source of truth for names and arguments; skill text
   adds workflow, safety, interpretation, and progressive-disclosure guidance
   without inventing authority.
4. Contract tests cover tool discoverability, reference packaging, capability
   denial, and the bounded behavior needed to keep large results out of Agent
   context.
5. QA exercises the capability through at least one native provider, and both
   provider manifests are validated before merge.
