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

## v0.1.47 integration QA — 2026-09-12

Public #77 and private #9 are included in candidate #81/#10 with merge
history preserved. Integration exposed and fixed two native-path regressions:

- The Harness's internal `_native_call_id` reached the strict indicator host;
  private now removes that transport metadata before chart dispatch, without
  relaxing public argument validation or trading call identity.
- Under `ask`, tool permission and content consent reused one approval ID.
  The UI remembered the first decision and displayed the second as approved
  while its waiter remained blocked. Content consent now has a distinct ID.

`src/lib/indicator-native-integration.test.ts` exercises the actual private
bridge, tools, event transport, public host and service under `auto_safe` and
`ask`, including replay, revision updates, focus changes and unique approval
IDs. It runs with the desktop overlay in Linux/Windows composite CI; the
public-only checkout explicitly skips this cross-repo test. The event target
and programmatic approval driver are test substitutes, not native QA.

Native QA also used the existing macOS 26.6.2 arm64 dev App, ChatGPT-bundled
Codex CLI 0.153.4, GPT-5.6-Sol / Medium, public `0f9539e` plus the approval-ID
fix from private `efe6390`. With Agent permission `ask` and trading
`readonly`, Codex created an additional IX0001 chart, mounted SMA(5), read the
instance/revision, changed it to SMA(10), hid it, moved it to index 0 and read
back the result. The chart controls displayed MA(10) and the show action.
The first removal reproduced the approval-ID bug and was stopped; after the
fix, a fresh read and new idempotency key produced separate actionable tool
and content confirmations, and the exact test instance was removed.

The existing sidecar was in production because the maintainer had selected
it; this QA performed local chart operations only, without account queries or
order mutations. It does not certify production trading approval, the full
Codex/Claude/Pi matrix, clean-machine onboarding or other desktop platforms.
Codex did use read-only shell commands to read its installed skill despite the
QA prompt asking for no shell; chart mutations themselves used native App
tools. This is not evidence of shell isolation. Prior numerical fixtures also
do not resolve #35 without its original strategy and dataset.
