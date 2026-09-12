# Agent indicator control — Phase 1 partial delivery

This implements the indicator-control portion of #59. The portfolio runtime,
executable two-asset shared-capital slice, immutable strategy revisions and
persistent research runs remain later work. It does not complete #59–#62 or #35.

## State and UI

`IndicatorInstanceService` owns operations on `Block.indicatorState` in the
active workspace. Instances and opaque revisions travel with saved profiles.
Legacy charts seed independent copies of `sj-pro-indicators-v2`. Existing empty
panel configurations stay empty. Deleted definitions are removed from active
panels and when an older profile is restored.

Main workspace K-line panels subscribe to this service. Popouts and preview
charts retain their existing settings path and are not Agent targets. The
indicator picker offers an explicit “存為新圖／回測預設” action: it updates the
shared template used by new charts and the backtest chart, without modifying
existing panels. Saving a named layout continues to be an explicit UI action.

Settings edits preview locally. Cancel discards only the draft. Save compares
the panel revision captured when the editor opened; if the Agent or another
operation changed that panel, the draft is rejected rather than overwriting it.

## Semantic boundary

Private native tools use the `shioaji-pro:indicator-command:request` and
`shioaji-pro:indicator-command:response` events, independent of new public
imports so private `desktop-ci` still compiles against public main. The host
exists only in a native Harness-enabled workspace; an older public host returns
an explicit unavailable error through the private timeout path.

Tools require `ui.control`. They mount, list, update or remove an instance;
none grants broker authority. Removal and shared definition overwrite require
content confirmation, separate from trading approval. Removal resolves panel
and revision before confirmation, so a focus change cannot redirect it.

Explicit panel IDs must identify mounted workspace K-line panels. Without an
ID, the most recently focused K-line is used; missing focus returns available
targets rather than choosing an arbitrary chart. Mutation receipts contain
`panel_id`, `revision`, and `instance` or `removed_id`. Lists contain no source
code and are paged (default 20, maximum 100), with at most 100 instances/panel.
Parameters are checked against the registered definition's range and step.
Native mutation schemas require idempotency keys; replay is payload-checked.

## Correctness and acceptance

- Service/transport tests cover migration, persistence, isolation, stale edits,
  missing targets, definition deletion, parameter validation and replay.
- A registered custom SMA has an independent numeric oracle before and after
  parameter changes; private backtest tests separately assert hand-calculated
  signals, fills, costs, equity and metrics. Passing an operation receipt alone
  is not evidence that an indicator or backtest is mathematically correct.
- Private baseline corrections compute percentage maximum drawdown independently
  of absolute drawdown, and include the final bar held before liquidation in
  exposure. Slippage is already reflected in execution prices, and is not added
  again to the fee/tax cost field.
- Full portfolio accounting, partial reductions, reproducible run manifests and
  the original #35 dataset are outside this delivery. CI fixtures do not claim
  native login, clean-machine QA or live-market validation.
- Paired PRs must record independent review, numerical and UI QA evidence,
  native-provider evidence/limitations, required public CI, Linux/Windows
  composite CI and the private `desktop-ci` status. No merge or release is
  authorized by this implementation.
