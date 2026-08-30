# Semantic MCP Tools

The connected Shioaji Pro MCP server is the source of truth for exact tool names,
versions, input schemas, and availability. Inspect its advertised schema before
calling a tool. The families below describe intent, not permission.

## Tool Families

| Family | Typical intent | Capability tier |
| --- | --- | --- |
| `market` | Health, contracts, quotes, subscriptions, market context | `market.read` |
| `account` | Accounts, balances, positions, orders, settlements | `account.read` |
| `workspace` | Select a contract; inspect or change panels, links, and layouts | `ui.control` |
| `task` | Create, inspect, pause, resume, or stop visible background tasks | `task.manage` |
| `trade` preview | Validate an exact order or mutation without execution | `trade.preview` |
| `trade` execute/reconcile | Execute an approved operation or resolve its outcome | `trade.execute` |
| `audit` | Read redacted action, approval, receipt, and reconciliation history | corresponding read tier |

## Capability Rules

Capabilities are independent and deny by default. A broader capability never
implies another tier. In particular, UI control does not imply account access,
trade preview does not imply execution, and a skill installation grants none of
them. Use the capability state returned by the App; do not infer permission from
past success or conversation text.

## Composition

- Prefer one semantic operation over reproducing its UI gestures.
- Read the affected state before a mutation and verify it afterward.
- Carry server-issued identifiers, revisions, and operation IDs unchanged.
- Respect schema errors and stale-state responses; refresh state before forming
  a new request.
- Run independent reads concurrently only when their schemas allow it. Serialize
  workspace mutations and all trade mutations.
- Keep background work visible in the App task center and leave paused or failed
  tasks visible with a clear reason.

## v1 semantic names

- App state: `get_app_state`, `list_panels`.
- Workspace mutation: `select_contract`, `add_panel`, `remove_panel`,
  `set_panel_pin`, `apply_layout`. Panel pinning uses a contract code; omitting
  the code restores linked behavior. Layouts identify both `source`
  (`preset` or `profile`) and `name`.
- Trading: `preview_order`, `place_order`, `cancel_order`, `reconcile_order`.
  Every mutation requires a caller-generated stable `idempotency_key` and the
  same key must never be reused for a different payload.
