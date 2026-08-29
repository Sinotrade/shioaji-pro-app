# Agent Harness contract v1

Shioaji Pro exposes semantic App Tools to provider-native runtimes. The public
contract is versioned independently from React components, Tauri commands, and
provider transports so Codex and Claude use the same authorization vocabulary.

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

## Native transport

The desktop host provides one authenticated loopback MCP endpoint. Every native
runtime receives a distinct short-lived bearer. Tokens are held in native
memory, are never returned to the WebView, and are revoked when the runtime
stops. Tool calls use typed JSON arguments and semantic names; coordinate
automation, raw key capture, and virtual Bash commands are outside this
contract.

## Trading lifecycle

Every mutation uses a client operation ID and exact request digest. A production
operation requires an independent exact-payload confirmation. An interrupted or
timed-out mutation enters `unknown_outcome`; it may only be reconciled by its
operation ID and must never be submitted again automatically.

Controlled auto is available only in simulation and only for the current App
session. Risk rules still apply and may reject or require confirmation.

## Restart policy

| State | Restart behavior |
| --- | --- |
| Conversations and task history | Restore |
| Pending approvals and capability grants | Expire |
| Controlled-auto permission | Downgrade to confirmation |
| Active controlled-auto task | Pause and require a new grant |

Audit records are native, append-only, centrally redacted, and read-only to
skills. They identify provider, runtime, skill digest, tool capability,
approval, client operation ID, and reconciliation result without storing
credentials or raw account secrets.
