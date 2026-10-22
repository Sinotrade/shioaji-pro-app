# Semantic MCP Tools

The connected Shioaji Pro MCP server is the source of truth for exact tool names,
versions, input schemas, and availability. Inspect its advertised schema before
calling a tool. The families below describe intent, not permission.

## Tool Families

| Family | Typical intent | Capability tier |
| --- | --- | --- |
| `market` | Quotes, snapshots, product search, K-bar summaries, bounded K bars, scanners, and company data | `market.read` |
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
  `get_kbar_summary`, `get_kbars`, `get_scanner`, `get_company`,
  `get_financials`, `find_theme_members`, `find_relations`. `get_kbars` returns
  at most 500 bars from the Shioaji server (intraday ranges up to 31 days,
  daily up to 366); use `get_kbar_summary` when a summary is enough. Daily
  futures bars follow the trading day: a night session counts toward the next
  trading day. The last four read the public shioaji-data company dataset
  (Taiwan listed and OTC companies): business summary, multi-level industry,
  value-chain stage, themes, suppliers and customers, monthly revenue, and
  quarterly statements. Read [Company data](#company-data) before answering
  from them.
- Account: `get_positions`, `get_working_orders`, `get_account`,
  `list_trades`, `list_conditional_orders`, `get_profit_loss`.
  `list_trades` is 委託成交查詢 for today, including filled, cancelled and
  failed orders, paged at most 100 per page. A partly filled order matches
  both `status: working` and `status: filled`. `list_conditional_orders` is
  read-only; pausing or cancelling stays in the App's conditional panel.
  `get_profit_loss` covers realized P&L for up to 92 days and optional stock
  settlements.
- App state: `get_app_state`, `list_panels`, `get_user_activity`.
- Workspace mutation: `select_contract`, `add_panel`, `remove_panel`,
  `set_panel_pin`, `apply_layout`. Panel pinning uses a contract code; omitting
  the code restores linked behavior. Layouts identify both `source`
  (`preset` or `profile`) and `name`.
- Workspace spec: `get_workspace_spec`, `validate_workspace_spec`,
  `apply_workspace_spec`, `undo_workspace_change`. Use them to arrange a whole
  research layout: positions, sizes, pins, flash link groups and chart
  interval in one step. Read the spec first, edit it, validate, show the user
  the diff when panels are removed, then apply with the returned
  `validation_token` and the same spec. A token works once and stops working
  when the user changes the workspace; validate again on `conflict`. The spec is JSON `version: 1`;
  `columns` is 24 (or 288 for fine positions) and rows are 30 px; read
  `panel_types` for minimum sizes and settings and `viewport.rows` for the
  visible height. Keep existing panel `id`s to keep their hidden settings
  (accounts, quantities, indicators); a new `id` creates a panel. Always keep
  your own AI Agent panel. Settings in v1: chart `interval`
  (`1m`/`5m`/`15m`/`60m`/`1D`), `session`, `ohlc`, `high_low`; intraday
  `session`; chainmap `view` (`rank`/`rotation`/`heat`) and `kind`
  (`all`/`chain`/`theme`); holdingmap `form` (`bubble`/`lanes`) and
  `grouping` (`sector`/`chain`/`theme`). A chainmap or holdingmap setting
  left out follows the user's last choice in that kind of panel. Validation errors carry a JSON path; fix them rather than
  dropping panels. Applying records one undo step that the user can also undo
  from the header (復原版面). Report what `apply_workspace_spec` returns, which
  is the layout as actually applied.
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

## Company data

- Codes use the Shioaji stock code (`2330`) or the entity id (`tw.2330`).
  `find_relations` also accepts foreign entity ids such as `us.NVDA`, so it can
  list the Taiwan suppliers of a foreign company. Relation types are
  `supplier` (who supplies it), `customer` (whom it supplies), `competitor`,
  `partner`, `subsidiary` (its subsidiaries), `parent`, and `transaction`.
- For a value chain or theme question, call `find_theme_members` with the
  theme or chain and an optional stage or tier (`upstream`, `midstream`,
  `downstream`). Without arguments it lists every chain and theme.
- Research fields are third-party data compiled by AI from public documents and
  cross-checked by several models. When answering from them, label them as
  third-party data and cite `as_of` and `sources`. When `research.status` is
  `official_only`, say the company has only official exchange data.
  `get_financials` and daily close and market cap are official data.
- Company data is a daily snapshot. Use `get_quote` or `get_snapshots` for the
  live price. A `stale` flag means the App is offline and serving data it
  downloaded and verified earlier; it is not confirmed to be the latest
  release, so say so and give the `release_id`. `data.parts` gives the
  release and `as_of` of each dataset a result used, and `data.stale_parts`
  names the ones served from cache (for example only `market`).
- Results are capped in size. A capped result has `truncated: true`: lists keep
  their first entries and `count` still gives the full total. Narrow the call
  with `limit`, `max_relations`, `months`, `quarters`, or a more specific theme
  or stage instead of repeating it.
