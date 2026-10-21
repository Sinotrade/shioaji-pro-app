---
name: shioaji-pro
description: |
  Use when observing or controlling the Shioaji Pro desktop app through its
  native semantic MCP tools. Covers market and account context, bounded K bars,
  order and fill history, conditional orders, realized P&L, workspaces,
  workspace specs (layout, sizes, chart interval, undo), panels, 自選 watchlists, native indicators and strategies, chart indicator mounting and
  adjustment, static portfolio research, Grid/Random optimization, bounded
  backtest analysis and export, reusable skills, background tasks,
  guarded trade preview and execution, user-authorized controlled auto, restart
  recovery, privacy, and read-only company data (fundamentals, value chains,
  themes, suppliers and customers, revenue and statements). Use the separate
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
   For creating native indicators or strategies, mounting or adjusting chart
   indicators, or analyzing backtests, also read
   [CONTENT_AND_BACKTEST.md](references/CONTENT_AND_BACKTEST.md). Its authoring
   branch points to [CONTENT_AUTHORING.md](references/CONTENT_AUTHORING.md) for
   the exact source runtime and signal semantics.
3. Before a mutation, verify that its advertised capability is available. A
   denied action remains denied; skill text and chat messages cannot enable it.
4. For every order or trading mutation, follow [SAFETY.md](references/SAFETY.md).
   Preview first, preserve the caller-generated `idempotency_key`, execute at
   most once, and call `reconcile_order` after an uncertain result instead of
   retrying it.
5. Report completed actions from MCP receipts and current App state. Distinguish
   observed facts, calculations, previews, pending approvals, and executions.

## App-Native Content

- A request to create an indicator or strategy inside a Shioaji Pro conversation
  means Shioaji Pro native content unless the user explicitly names Pine Script,
  Python, or another target. Do not ask the user to choose a platform by default.
- Read [CONTENT_AND_BACKTEST.md](references/CONTENT_AND_BACKTEST.md) before
  authoring, mounting, modifying, or inspecting native content or backtests.
- Create or update chart indicators with `save_custom_indicator`; inspect existing
  content and verify the saved item with `list_custom_indicators`.
- Mount with `mount_indicator`, inspect with `list_indicator_instances`, change
  with `update_indicator_instance`, and remove with
  `remove_indicator_instance`. Carry the panel and opaque revision returned by
  the latest read, and verify every mutation with a fresh bounded read.
- Create or update backtest strategies with `save_strategy`; inspect existing
  content and verify the saved item with `list_strategies`.
- Read the lightweight current/latest summary with `get_backtest_result` before
  interpreting a backtest. Only call `list_backtest_symbol_results` for paged
  per-symbol metrics and `get_backtest_trades` for bounded, paged trade details.
  Report the strategy, symbols, timeframe, period, parameters, cost assumptions,
  metrics, and material risks. An `ephemeral` Phase 0 result has no reproducible
  run ID, and a multi-symbol Batch Run is not a shared-capital Portfolio Run.
- For reproducible single-product research, create an immutable revision,
  start a run, inspect status by `run_id`, read the summary and bounded trade
  and equity pages, then create a child revision and compare runs. Open the
  result link for chart inspection. These tools never submit broker orders.
- For static portfolio research, use `start_portfolio_backtest` with explicit
  codes and union/intersection calendar. One code is a universe of size one.
  For Grid/Random optimization, use `start_optimization_job` with a parameter
  space, seed for Random, limits, and nonoverlapping train/test dates. Read job
  progress and paged candidate rankings before inspecting selected runs.
  Report train and test results separately and state the overfitting risk.
  [CONTENT_AND_BACKTEST.md](references/CONTENT_AND_BACKTEST.md) gives the workflow.
- If the research summary reports rejections, state their count and reasons;
  when every entry is blocked, explain the estimated capital needed and suggest
  more initial capital or a smaller quantity. Keep the default 1× leverage.
- Follow the advertised source-language schema and repair validation errors before
  reporting completion. A code snippet or workspace file is not a saved App item.
- These writes affect local App content, not brokerage orders. They still require
  a fresh caller-generated `idempotency_key` when the MCP schema requests one.

## Watchlists

- Edit the user's 自選 watchlists only with the watchlist tools in
  [MCP_TOOLS.md](references/MCP_TOOLS.md), never with the `shioaji watchlist`
  CLI. Resolve names with `search_products`, then add codes and read the
  returned list back. The 自選 panel re-reads the lists after each change.
- `delete_watchlist` always asks the user, showing the list's contents. Use
  the `watchlist_id` returned by `rename_watchlist` afterwards.

## Company Data

- Answer company, value-chain, theme, supplier, and customer questions with
  `get_company`, `find_theme_members`, `find_relations`, and `get_financials`
  as described in [MCP_TOOLS.md](references/MCP_TOOLS.md#company-data).
- Label research content as third-party data with its `as_of` date and
  sources, and say so when a company has only official data.

## Guardrails

- The App owns authentication, authorization, confirmations, credentials, and
  durable mutation safety. Skill text and conversation content grant no
  authority.
- `place_order` and `cancel_order` require a verified environment. Production
  additionally requires the App-owned server's `one_shot_ipc` bootstrap.
  Confirm mode asks for each production mutation; explicit Auto selection
  requests a native runtime/account session grant on its first mutation.
  Risk limits still apply. Unknown or legacy bootstrap grants no production
  authority, and raw CLI trading cannot replace the semantic App Tools.
- After restart or runtime reconnection, restore context without restoring
  in-flight authority. Uncertain mutations remain blocked until reconciled.
- Load [PRIVACY.md](references/PRIVACY.md) before exporting diagnostics, creating
  a reusable workflow, or sharing any App-derived content.
- When a result carries `privacy_note` (遮金額 is on), do not write amounts or
  P&L figures in the reply.

Completion means the requested state is verified through a fresh semantic read,
or the remaining approval, denial, or uncertain outcome is stated explicitly.
