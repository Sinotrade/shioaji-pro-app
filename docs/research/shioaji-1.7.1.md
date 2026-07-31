# Shioaji 1.7.1 research for Shioaji Pro App

Research date: 2026-07-31 (Asia/Taipei)

## Executive summary

Shioaji 1.7.1 adds three streaming product families relative to 1.7.0:

1. Realtime one-minute KBar streaming for stocks.
2. Realtime enriched index streaming: calculated index, constituent contribution, and industry contribution.
3. Realtime market-signal streaming: price-limit, rapid-price-move, volume-burst, simulated-matching, and suspension events.

The official 1.7.0 release was centered on Contract V2, automatic contract management, and index quote streaming. The official 1.7.1 release lists exactly the three feature families above, so existing Contract V2 and ordinary `quote_idx` behavior should be treated as the baseline, not as new 1.7.1 work.

Shioaji Pro currently packages the sidecar version from `SHIOAJI_VERSION`, which is still `v1.7.0`. None of the new endpoints should be enabled in a release until that file is moved to `v1.7.1` and the four release assets are verified.

## Common HTTP/SSE lifecycle

All three features use an explicit lifecycle:

1. `POST` the feature-specific subscribe endpoint.
2. Check `success`; do not open the stream as if subscription succeeded when it is false.
3. Open the feature-specific `GET /api/v1/stream/data/...` SSE endpoint.
4. Parse the SSE `event:` name before decoding `data:` JSON. A `heartbeat` is only a keep-alive.
5. On server/SSE recovery, replay the feature-specific subscription. The Pro App's current replay registry only covers generic `/stream/subscribe` bodies, so 1.7.1 subscriptions need their own lifecycle entries.
6. `POST` the same request body to the corresponding unsubscribe endpoint when the consumer is no longer needed.

Every new subscribe/unsubscribe endpoint returns:

```json
{
  "success": true,
  "message": "..."
}
```

This is `CapabilitySubscriptionResponse`; unlike the generic quote subscription response, it has no `subscription` field. Localhost access follows the existing local server rules. A non-local bind requires the server's configured HTTP authentication. Market data is only produced during applicable market sessions; a connected stream that only receives heartbeats outside those sessions is not evidence of failure.

## 1. Realtime KBar

### API contract

Subscribe:

```http
POST /api/v1/stream/subscribe/kbars
Content-Type: application/json

{
  "stocks": [
    {
      "security_type": "STK",
      "exchange": "TSE",
      "code": "2330",
      "target_code": null
    }
  ]
}
```

Unsubscribe uses the identical body:

```http
POST /api/v1/stream/unsubscribe/kbars
```

Consume:

```http
GET /api/v1/stream/data/kbar
Accept: text/event-stream
```

Data events use `event: kbar`. Each event is one completed one-minute stock bar; `time` is the bar's start time.

```json
{
  "code": "2330",
  "date": "2026/07/31",
  "time": "09:01:00.000000",
  "open": 0.0,
  "high": 0.0,
  "low": 0.0,
  "close": 0.0,
  "volume": 0,
  "amount": 0,
  "tick_count": 0
}
```

The numeric values above are placeholders showing the schema, not a captured market quote.

### Prerequisites and constraints

- Shioaji server 1.7.1 or newer.
- Stock contracts only; index, futures, and options are not supported by this feature.
- The body supports multiple stocks in one request.
- `intraday_odd` and `version` are rejected.
- The generic `/api/v1/stream/subscribe` endpoint must not be used for KBar.
- `shioaji data stream` does not expose KBar; HTTP/SSE or Python is required.
- This is not historical `POST /api/v1/data/kbars`. Historical KBar remains the date-range REST query.

### Pro App fit

The chart currently loads historical one-minute bars through REST and builds the live tail from tick events. The safest integration is to keep ticks for the provisional, still-forming candle and use each completed `kbar` event as the authoritative close/reconciliation for stock charts. Higher timeframes can continue to aggregate the canonical one-minute series.

Recommended first UI scope:

- Subscribe only for the actively displayed stock chart, not the whole watchlist.
- Reconcile or replace the matching minute at close, then update higher-timeframe aggregation and indicators once.
- Continue using the existing tick path for futures/options/index charts because 1.7.1 KBar does not support them.

Risks:

- A bar-close event can overlap with the tick-built minute; blindly appending creates duplicates or out-of-order chart updates.
- `date` and `time` are Taiwan wall-clock strings and must use the existing chart timezone conversion.
- KBar volume is in stock lots; do not combine it with intraday odd-lot units.
- A reconnect can miss completed bars because the stream is not a history service. Backfill the gap with REST `kbars`, then resume SSE.
- The new dedicated subscription must be replayed after sidecar restart and daily maintenance; the existing generic subscription registry does not do this automatically.

## 2. Realtime enriched index data

All three capabilities accept an index `StreamContract`. The supported indices are currently only `IX0001` (TAIEX) and `IX0043` (TPEx). Using another contract type or code fails validation.

```json
{
  "security_type": "IND",
  "exchange": "TSE",
  "code": "IX0001",
  "target_code": null
}
```

For `IX0043`, use the exchange returned by Contract V2 rather than hardcoding the `IX0001` example's exchange.

### 2.1 Calculated index

Lifecycle:

```http
POST /api/v1/stream/subscribe/calculated_index
POST /api/v1/stream/unsubscribe/calculated_index
GET  /api/v1/stream/data/calculated_index
```

Request body:

```json
{
  "index": {
    "security_type": "IND",
    "exchange": "TSE",
    "code": "IX0001",
    "target_code": null
  }
}
```

SSE data event: `event: calculated_index`

```json
{
  "code": "IX0001",
  "date": "YYYY/MM/DD",
  "time": "HH:MM:SS.ffffff",
  "open": 0.0,
  "high": 0.0,
  "low": 0.0,
  "close": 0.0,
  "total_amount": 0,
  "price_chg": 0.0,
  "pct_chg": 0.0,
  "simtrade": false
}
```

Cadence can be multiple events per second.

Pro App fit: use as an optional, clearly labelled calculated-index source for the header/index dashboard. Do not silently replace ordinary `quote_idx`: the products have different provenance and fields, and users should be able to distinguish exchange index quote from the calculated value.

Risks: double-rendering two index feeds, incorrectly mixing their timestamps, and showing simulated-matching values as live trades. The basis calculation must use one explicitly selected index source consistently.

### 2.2 Index constituent contribution

Lifecycle:

```http
POST /api/v1/stream/subscribe/index_contribution
POST /api/v1/stream/unsubscribe/index_contribution
GET  /api/v1/stream/data/index_contribution
```

Request body:

```json
{
  "index": {
    "security_type": "IND",
    "exchange": "TSE",
    "code": "IX0001",
    "target_code": null
  },
  "ranking": "top10"
}
```

`ranking` is required and has the closed wire-value set:

- `top10`
- `abs10`
- `positive25`
- `negative25`

SSE data event: `event: index_contribution`

```json
{
  "ranking": "top10",
  "code": "IX0001",
  "date": "YYYY/MM/DD",
  "time": "HH:MM:SS.ffffff",
  "entries": [
    {
      "code": "2330",
      "price": 0.0,
      "reference": 0.0,
      "price_chg": 0.0,
      "pct_chg": 0.0,
      "points": 0.0
    }
  ],
  "simtrade": false
}
```

Cadence is once per second.

Pro App fit: a compact "index drivers" panel with segmented ranking modes, clickable constituents, positive/negative point contribution, and linkage to the existing chart/order workflow.

Risks: switching ranking requires unsubscribe/subscribe state management; entries are rankings, not a complete constituent universe; contribution points should not be presented as stock price changes; and `simtrade` must be reflected or filtered.

### 2.3 Industry contribution

Lifecycle:

```http
POST /api/v1/stream/subscribe/industry_contribution
POST /api/v1/stream/unsubscribe/industry_contribution
GET  /api/v1/stream/data/industry_contribution
```

The request body is the same `{"index": <StreamContract>}` shape as calculated index.

SSE data event: `event: industry_contribution`

```json
{
  "code": "IX0001",
  "date": "YYYY/MM/DD",
  "time": "HH:MM:SS.ffffff",
  "entries": [
    {
      "category": "24",
      "points": 0.0
    }
  ],
  "simtrade": false,
  "index_close": 0.0,
  "index_price_chg": 0.0
}
```

Cadence is once per second. The documented invariant is that the sum of entry `points` equals `index_price_chg`.

Pro App fit: this aligns directly with the existing sector heatmap. Add a contribution-points view beside the current percentage/amount views and map exchange industry category codes through the existing sector metadata.

Risks: not every UI sector grouping is necessarily identical to the exchange category taxonomy; unmapped category codes need a readable fallback. Validate the points-sum invariant with floating-point tolerance and keep `IX0001` and `IX0043` state separate.

### Shared enriched-data constraints

- Shioaji server 1.7.1 or newer.
- Only index contracts `IX0001` and `IX0043` are supported.
- `ranking` is accepted only for index contribution and is required there.
- `intraday_odd` and `version` are rejected.
- HTTP uses dedicated endpoints, not generic `/stream/subscribe`.
- The CLI stream command does not support these types.
- A quiet stream outside market hours normally means no source events, not a failed subscription.

## 3. Realtime market signals

This feature is distinct from the existing historical/ranking endpoint `POST /api/v1/data/scanner`. It scans a selected market scope continuously and pushes any stock that triggers a rule; it does not require one quote subscription per stock.

### API contract

Lifecycle:

```http
POST /api/v1/stream/subscribe/scanner
POST /api/v1/stream/unsubscribe/scanner
GET  /api/v1/stream/data/scanner
```

Preset-rule request:

```json
{
  "scanner": {
    "kind": "preset_rule",
    "id": "trade_price_drop"
  },
  "region": "TW",
  "security_type": "STK",
  "exchange": "TSE"
}
```

State-filter request uses a plain string instead:

```json
{
  "scanner": "simtrade",
  "region": "TW",
  "security_type": "STK",
  "exchange": "TSE"
}
```

TSE and OTC require separate scope subscriptions. Unsubscribe uses the exact corresponding body.

### Rule IDs and semantics

| Family | HTTP wire ID | Meaning |
|---|---|---|
| Limit | `bid_near_limit_up` | Bid approaches limit up |
| Limit | `bid_touch_limit_up` | Bid touches limit up |
| Limit | `limit_up_unlocked` | Limit up unlocks |
| Limit | `ask_near_limit_down` | Ask approaches limit down |
| Limit | `ask_touch_limit_down` | Ask touches limit down |
| Limit | `limit_down_unlocked` | Limit down unlocks |
| Price move | `trade_price_surge` | Trade price rises more than 1% and at least 3 ticks within 1 second |
| Price move | `trade_price_drop` | Trade price falls by the same threshold |
| Price move | `bid_price_surge` | Bid price rises by the same threshold |
| Price move | `ask_price_drop` | Ask price falls by the same threshold |
| Volume | `volume_burst` | One trade exceeds the server's daily value threshold; 5-second per-symbol cooldown |
| State | `simtrade` | Simulated-matching quote |
| State | `suspend` | Suspended-trading quote |

Price-move rules have a one-second per-symbol cooldown. The volume threshold is recalculated by the server each day and is included in each event.

### SSE events

All HTTP data events use `event: scanner`, but there are two principal JSON payload shapes.

Rule signal (`Limit`, `PriceMove`, or `Volume`):

```json
{
  "scanner": "trade_price_drop",
  "region": "TW",
  "security_type": "STK",
  "exchange": "TSE",
  "quote": {
    "code": "8045",
    "date": "YYYY-MM-DD",
    "time": "HH:MM:SS.ffffff",
    "open": "0",
    "close": "0",
    "high": "0",
    "low": "0"
  },
  "extra": {
    "reference_time": "HH:MM:SS.ffffff",
    "reference_price": "0",
    "change_price": "0",
    "change_percent": "0",
    "tick_change": 0,
    "elapsed_ms": 0
  }
}
```

The `extra` fields depend on the family:

- Limit: `previous_best_price`, `trigger_price`, `limit_price`.
- Price move: `reference_time`, `reference_price`, `change_price`, `change_percent`, `tick_change`, `elapsed_ms`.
- Volume burst: `amount`, `volume`, `price`, `threshold`.

State-filter event:

```json
{
  "scanners": ["simtrade"],
  "region": "TW",
  "security_type": "STK",
  "exchange": "TSE",
  "quote": {
    "code": "2492",
    "date": "YYYY-MM-DD",
    "time": "HH:MM:SS.ffffff",
    "simtrade": true
  }
}
```

Note the discriminator difference: rule events contain singular `scanner` plus `extra`; state events contain plural `scanners` and no `extra`. The scanner channel also defines a gap notification after reconnect with `dropped_count`, `first_time`, `last_time`, and `subscriptions`. The bundled 1.7.1 reference documents those fields but does not provide a concrete HTTP JSON example, so the live 1.7.1 OpenAPI/SSE capture should be checked before hardcoding its discriminator.

### Prerequisites and constraints

- Shioaji server 1.7.1 or newer.
- Closed scope: `region=TW`, `security_type=STK`, `exchange=TSE|OTC`; all are required.
- Rule IDs are a closed set. Python factory names are not always the same as HTTP wire IDs.
- This is realtime push, not the ranking-query `ScannerType` API already used by the Pro App.
- Subscribe once per rule and exchange rather than once per symbol.

### Pro App fit

Recommended first UI scope:

- Add an explicit "即時訊號" view alongside the current ranking scanner, not as a replacement for it.
- Start with the six price-limit events and four rapid-move events because they map cleanly to actionable rows and symbol linking.
- Show event time, symbol, rule, trigger value, and the relevant `extra`; clicking a row should link the existing chart.
- Keep a bounded in-memory event log, deduplicate by rule/symbol/time, and surface scanner gap notifications visibly.
- Add TSE/OTC and rule-family controls; subscription state should follow those controls exactly.

Risks:

- Treating `api.scanners` rankings and realtime scanner events as the same model will produce incorrect requests and UI semantics.
- Event bursts can overwhelm React rendering and notifications; batch store updates and cap retained rows.
- TSE and OTC are separate subscriptions, so partial subscription success must be visible.
- Reconnect gaps are explicitly possible. Do not imply the feed is complete when a gap event was received.
- `simtrade` is a market state, not a real trade signal; it should be filtered or clearly marked.
- Signal quotes use the core stock quote wire shape, whose decimal fields may be strings. Normalize at the stream boundary.

## Recommended implementation order

1. Upgrade the packaged sidecar to 1.7.1 and add a runtime capability/version gate. This is mandatory for every feature.
2. Add a reusable dedicated-subscription registry with subscribe, unsubscribe, reconnect, maintenance replay, and `success=false` handling.
3. Keep realtime KBar as documented follow-up work; this release intentionally leaves the existing chart data path unchanged.
4. Add industry contribution to the existing heatmap, then the index-driver panel. These reuse current index/sector linking.
5. Add the realtime signal feed as a separate scanner mode with bounded buffering and gap handling.
6. Consider calculated index as an opt-in index source only after basis/source semantics are made explicit.

## Verification plan for implementation

- Inspect a running 1.7.1 sidecar's `/openapi.json` and save representative SSE fixtures for every event variant.
- Unit-test request bodies, response validation, decimal normalization, event discriminators, and reconnect replay.
- KBar: verify no duplicate minute, correct Taiwan timestamp, REST gap backfill, and stock-only fallback behavior.
- Enriched index: test both `IX0001` and `IX0043`, every contribution ranking, `simtrade`, and unknown industry categories.
- Signals: test each rule family, state-filter payload, TSE/OTC partial failure, burst batching, and scanner gap handling.
- Run production build plus desktop smoke tests on all packaged sidecar platforms before release.

## Source record

First-party sources used:

- [Shioaji v1.7.1 release](https://github.com/Sinotrade/Shioaji/releases/tag/v1.7.1) — official list of the three new feature families.
- [Shioaji v1.7.0 release](https://github.com/Sinotrade/Shioaji/releases/tag/v1.7.0) — comparison baseline.
- [Official stock streaming documentation](https://sinotrade.github.io/zh/tutor/market_data/streaming/stocks/) — realtime KBar behavior and ordinary stream context.
- [Official enriched streaming documentation](https://sinotrade.github.io/zh/tutor/market_data/streaming/enriched/) — calculated index and contribution products.
- [Official market-signal documentation](https://sinotrade.github.io/zh/tutor/market_data/streaming/signals/) — scope, rule IDs, payloads, and callback/event behavior.
- Bundled Shioaji 1.7.1 skill references:
  - `/Users/yvictor/.codex/plugins/cache/sinotrade/shioaji/1.7.1/skills/shioaji/references/STREAMING.md`
  - `/Users/yvictor/.codex/plugins/cache/sinotrade/shioaji/1.7.1/skills/shioaji/references/STREAMING_ENRICHED.md`
  - `/Users/yvictor/.codex/plugins/cache/sinotrade/shioaji/1.7.1/skills/shioaji/references/STREAMING_SIGNALS.md`
  - `/Users/yvictor/.codex/plugins/cache/sinotrade/shioaji/1.7.1/skills/shioaji/references/HTTP_API.md`
- Current repository implementation: `SHIOAJI_VERSION`, `.github/workflows/release.yml`, `src/lib/stream.ts`, `src/lib/shioaji.ts`, `src/components/candle-chart.tsx`, `src/components/scanner-panel.tsx`, `src/components/sector-heatmap.tsx`, and `src/components/market-bar.tsx`.

Post-research verification: the official macOS arm64 `v1.7.1` sidecar was downloaded from the GitHub release and started locally on port 21322. Its `/openapi.json` reported version `1.7.1` and exposed every dedicated endpoint documented above. Smoke subscriptions for realtime KBar, calculated index, index contribution, industry contribution, and scanner signals all returned `{"success":true,"message":"Subscription successful"}`. A live pre-open trial-auction capture on 2026-07-31 then verified continuously updating `IX0001` and `IX0043` calculated-index events, multiple contribution rankings, positive and negative industry points, and `simtrade: true` across the enriched-index payloads; subscription requests for all four ranking values succeeded. The Pro App rendered both markets, the trial-auction badge, constituent points, and the industry heatmap from those live events.
