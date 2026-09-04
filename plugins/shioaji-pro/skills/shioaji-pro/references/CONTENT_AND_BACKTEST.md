# Native Content and Backtests

Read this reference when the user asks to create or inspect a Shioaji Pro
custom indicator, strategy, or backtest result. These operations use semantic
App Tools; they do not grant trading authority.

## Indicators and Strategies

- An unqualified request to create an indicator or strategy in a connected
  Shioaji Pro session means native App content, not Pine Script or a workspace
  file.
- Use `list_custom_indicators` before editing an existing indicator and
  `save_custom_indicator` to create or update it.
- Use `list_strategies` before editing an existing strategy and `save_strategy`
  to create or update it.
- When converting an indicator into a strategy, preserve its parameters and
  signal meaning, then make entry and exit conditions explicit.
- Supply a new caller-generated `idempotency_key` for each save intent. Reuse
  the same key only to reconcile the same uncertain save, never for different
  content.
- A validation failure is actionable feedback. Correct the source and submit
  the same user intent again. Completion requires a successful receipt and a
  fresh list read showing the saved content.

## Backtest Result Reading

Backtest snapshots can be large. Read progressively:

1. Call `get_backtest_result` first. Report its state as `empty`, `running`,
   `failed`, or `completed`; do not infer completion from partial metrics.
2. For `completed`, summarize strategy, symbols, interval, date range,
   parameters, cost assumptions, aggregate metrics, and material risks.
3. Call `list_backtest_symbol_results` only when per-symbol comparison is
   needed. Page with `offset` and `limit`; the default is 20 and the maximum is
   100. This tool omits trade arrays.
4. Call `get_backtest_trades` only for a named symbol or a question that needs
   individual trades. Page from newest toward older trades; the default is 20,
   the maximum is 100, and only the latest 500 trades per symbol are retained.
   A multi-symbol Batch Run requires `symbol`.

Phase 0 snapshots are in-memory, ephemeral, and not reproducible run records.
State that limitation when it affects the answer. A `multi` result is a Batch
Run of independent single-symbol tests, not a Portfolio Run; do not infer
cross-symbol capital allocation, portfolio exposure, or portfolio-level risk.

The current semantic tools read the latest App result. They do not start,
configure, persist, or reproduce a backtest. Ask the user to run it in the App
when no result exists, and report unavailable capabilities plainly.
