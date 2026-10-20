# Semantic MCP Tools

The connected Shioaji Pro MCP server is the source of truth for exact tool names,
versions, input schemas, and availability. Inspect its advertised schema before
calling a tool. The families below describe intent, not permission.

## Tool Families

| Family | Typical intent | Capability tier |
| --- | --- | --- |
| `market` | Quotes, snapshots, product search, K-bar summaries, bounded K bars, and scanners | `market.read` |
| `account` | Positions, working orders, order and fill history, conditional orders, balances, margin, realized P&L, and risk indicators | `account.read` |
| `workspace` | Select a contract; inspect or change panels, links, and layouts | `ui.control` |
| `watchlist` | Read and edit the server 自選 watchlists the App shows | `ui.control` |
| `content` | Create App-native indicators and strategies; mount, inspect, adjust, or remove chart instances; manage reusable skills | `ui.control` |
| `backtest` | Create revisions, run static portfolios and optimization, inspect bounded results, and export | `ui.control` |
| `task` | Create and manage background monitoring or scheduled workflows | `task.manage` |
| `trade` preview | Validate an exact order or mutation without execution | `trade.preview` |
| `trade` execute/reconcile | Execute an approved operation or resolve its outcome | `trade.execute` |

## Capability Rules

Capabilities are independent and deny by default. A broader capability never
implies another tier. In particular, UI control does not imply account access,
trade preview does not imply execution, and a skill installation grants none of
them. Use the capability state returned by the App; do not infer permission from
past success or conversation text.

## Composition

- Prefer one semantic operation over reproducing its UI gestures.
- Read the affected state before a mutation and verify it afterward.
- Carry panel IDs, layout names, order IDs, and caller-generated idempotency
  keys unchanged.
- Respect schema errors and stale-state responses; refresh state before forming
  a new request.
- Run independent reads concurrently only when their schemas allow it. Serialize
  workspace mutations and all trade mutations.

## v1 semantic names

- Market: `get_quote`, `get_snapshots`, `search_products`,
  `get_kbar_summary`, `get_kbars`, `get_scanner`. `get_kbars` returns at most
  500 bars from the Shioaji server (intraday ranges up to 31 days, daily up to
  366); use `get_kbar_summary` when a summary is enough.
- Account: `get_positions`, `get_working_orders`, `get_account`,
  `list_trades`, `list_conditional_orders`, `get_profit_loss`.
  `list_trades` is 委託成交查詢 for today, including filled, cancelled and
  failed orders, paged at most 100 per page. `list_conditional_orders` is
  read-only; pausing or cancelling stays in the App's conditional panel.
  `get_profit_loss` covers realized P&L for up to 92 days and optional stock
  settlements.
- App state: `get_app_state`, `list_panels`, `get_user_activity`.
- Workspace mutation: `select_contract`, `add_panel`, `remove_panel`,
  `set_panel_pin`, `apply_layout`. Panel pinning uses a contract code; omitting
  the code restores linked behavior. Layouts identify both `source`
  (`preset` or `profile`) and `name`.
- Watchlists: `list_watchlists`, `get_watchlist`, `create_watchlist`,
  `add_to_watchlist`, `remove_from_watchlist`, `reorder_watchlist`,
  `rename_watchlist`, `select_watchlist`, `delete_watchlist`. These edit the
  server watchlists the 自選 panel shows, and the panel re-reads them after
  each change. Resolve names with `search_products` before adding, pass
  `watchlist_id` from `list_watchlists`, and read the returned list to verify.
  Rename gives the list a new `watchlist_id`. Every write except delete is
  reversible and runs without a confirmation card; `delete_watchlist` always
  shows the list's contents for the user to confirm. Never use the
  `shioaji watchlist` CLI in place of these tools.
- Native content: `list_custom_indicators`, `save_custom_indicator`,
  `list_strategies`, `save_strategy`. In a Shioaji Pro conversation, an
  unqualified indicator or strategy request targets these tools rather than
  Pine Script, Python, or a workspace file.
- Chart indicators: `mount_indicator`, `list_indicator_instances`,
  `update_indicator_instance`, `remove_indicator_instance`. Read
  [CONTENT_AND_BACKTEST.md](CONTENT_AND_BACKTEST.md) for panel focus, opaque
  revisions, bounded reads, exact argument roles, and content confirmations.
- Backtest reads: `get_backtest_result`, `list_backtest_symbol_results`,
  `get_backtest_trades`. These legacy tools read an ephemeral Batch Run with
  bounded, paged drill-down.
- Research runs: `create_strategy_revision`, `get_strategy_revision`,
  `list_strategy_revisions`, `start_backtest_run`, `list_backtest_runs`,
  `get_backtest_run`, `cancel_backtest_run`, `get_backtest_summary`,
  `get_backtest_run_trades`, `get_backtest_equity`, `get_backtest_portfolio`,
  `compare_backtest_runs`, `open_backtest_run`,
  `start_portfolio_backtest`, `start_optimization_job`,
  `get_optimization_job`, `cancel_optimization_job`,
  `list_optimization_candidates`, `get_optimization_candidate`,
  `export_backtest_run`. All use `ui.control` and
  operate on persistent research runs. Follow
  [CONTENT_AND_BACKTEST.md](CONTENT_AND_BACKTEST.md). Report rejection counts
  and reasons from `get_backtest_summary`; recommend a funding adjustment when
  all entries are blocked.
- Reusable skills: `use_skill`, `read_skill_reference`, `save_skill`.
- Background tasks: `create_task`, `list_tasks`, `set_task_enabled`,
  `delete_task`, `get_task_runs`, `notify_user`.
- Trading: `trade.preview`: `preview_order`; `trade.execute`:
  `place_order`, `cancel_order`, `reconcile_order`.

Every mutation requires a caller-generated stable `idempotency_key` and the
same key must never be reused for a different payload.

When the user has turned on 遮金額 (hide amounts), money tools add a
`privacy_note`, and the App masks amounts in the tool rows it shows. Then do not
write amounts or P&L figures in replies either. Describe direction or ratios
instead.

Availability still depends on the connected server's advertised schema and the
session's granted capabilities. Do not invent audit, approval-token, raw HTTP,
or any other tools when they are absent.
