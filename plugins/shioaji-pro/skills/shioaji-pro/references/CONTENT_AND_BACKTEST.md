# Native Content and Backtests

Read this reference when the user asks to create or inspect a Shioaji Pro
custom indicator, mount or change a chart indicator, create a strategy, or
inspect a backtest result. These operations use semantic
App Tools; they do not grant trading authority.

## Indicators and Strategies

- An unqualified request to create an indicator or strategy in a connected
  Shioaji Pro session means native App content, not Pine Script or a workspace
  file.
- Use `list_custom_indicators` before editing an existing indicator and
  `save_custom_indicator` to create or update it. Overwriting an existing
  shared definition requires the App's content confirmation because it affects
  every chart using that definition. A concurrent definition change invalidates
  the proposed overwrite; read again and prepare a new proposal.
- Use `list_strategies` before editing an existing strategy and `save_strategy`
  to create or update it.
- When converting an indicator into a strategy, preserve its parameters and
  signal meaning, then make entry and exit conditions explicit.
- Supply a new opaque caller-generated `idempotency_key` for each mutation
  intent. Preserve it with its exact arguments for a transport retry. A changed
  payload, including corrected source or parameters, requires a new key.
- A validation failure is actionable feedback. Correct the source and submit
  the same user intent again. Completion requires a successful receipt and a
  fresh list read showing the saved content.

## Chart Indicator Workflow

1. Locate the intended K-line panel with `list_panels`, then read
   `list_indicator_instances`. Prefer explicit `panel_id`. Omitting it targets
   the most recently focused, mounted K-line chart; with no valid target, use
   the error's available panels to resolve the target. Backtest charts and
   detached popouts are outside this panel control surface.
2. For a new custom indicator, call `save_custom_indicator`, then pass its
   returned `indicator_type` (`custom:<id>`) to `mount_indicator`. A saved
   definition is separate from a mounted instance. Built-in type IDs must come
   from the App's advertised state or existing instances; do not guess them.
3. Use `update_indicator_instance` to merge parameter changes, set `hidden`,
   or move the instance to a zero-based `index`. Carry `panel_id`, `instance_id`
   and the latest `expected_revision` from the read receipt. The revision is an
   opaque string, not a counter. A conflict requires a fresh read and a new
   mutation intent; preserve intervening UI or Agent changes.
4. Use `remove_indicator_instance` for removal. The App resolves and binds the
   target panel and revision before asking for content confirmation. This
   removes the chart instance; the shared custom definition remains available.
5. Make a fresh `list_indicator_instances` call for the receipt's `panel_id`.
   Verify the returned instance ID, type, parameters, visibility and order, or
   its absence after removal. Paginate until the relevant instance is covered;
   an idempotent mutation receipt alone is not a current-state read.

All four tools require `ui.control`. Mutations require `idempotency_key`;
content confirmations grant no trading authority. A host timeout means the
outcome is unknown: read current instances before considering another mutation.
An older or disconnected App may advertise a tool while its indicator host is
unavailable; report the limitation instead of claiming the chart changed.

### Indicator Tool Arguments and Receipts

Inspect the live schema first. All tools accept optional `panel_id` (string).

| Tool | Other arguments | Receipt |
| --- | --- | --- |
| `mount_indicator` | Required `indicator_type` and `idempotency_key`; optional `params` | `panel_id`, `revision`, `instance` |
| `list_indicator_instances` | Optional `offset` (default 0), `limit` (default 20, maximum 100) | `panel_id`, `revision`, `instances`, `page` |
| `update_indicator_instance` | Required `instance_id` and `idempotency_key`; optional `params`, `hidden`, `index`, `expected_revision`; supply at least one change | `panel_id`, `revision`, `instance` |
| `remove_indicator_instance` | Required `instance_id` and `idempotency_key`; optional `expected_revision` | `panel_id`, `revision`, `removed_id` |

`params` is an object of finite numbers keyed by declared parameter names;
values must satisfy that indicator's range and step. `hidden` is boolean.
`offset` and `index` are non-negative integers; `limit` is a positive integer.
An index must fall within the current instance list. Each panel supports at most
100 instances. Instances expose `id`, `type`, `params`, styles, and optional
`hidden`; an absent `hidden` means visible. The page includes `offset`, `limit`,
`returned`, `total`, and `hasMore`. Continue from `offset + returned` while
`hasMore` is true, checking that the revision stays unchanged across pages.

Panel settings persist with the workspace and layout profile. A layout change
or removal can invalidate panel IDs and revisions; refresh the App state.
Successful mounting or matching stored parameters verifies configuration, not
indicator arithmetic or backtest correctness. Numerical claims require fixed
input data and independently checked expected values.

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
