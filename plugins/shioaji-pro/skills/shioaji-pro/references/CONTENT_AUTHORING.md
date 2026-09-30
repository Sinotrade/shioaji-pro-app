# Native Indicators and Backtest Strategies

Read this reference from the authoring branch of
[CONTENT_AND_BACKTEST.md](CONTENT_AND_BACKTEST.md) when creating or updating
Shioaji Pro native chart indicators or backtest strategies. This file owns the
source runtime, signal, execution, and validation contracts; the connected App's
tool schema remains authoritative for required fields and supported values.

## Target Routing

- In a Shioaji Pro conversation, an unqualified request for an indicator or
  strategy targets Shioaji Pro native content.
- Use Pine Script, Python, or a workspace source file only when the user explicitly
  requests that target.
- A source snippet is not an installed App item. Completion requires a successful
  `save_custom_indicator` or `save_strategy` receipt.

## Shared JavaScript Runtime

Indicator and strategy source is strict JavaScript evaluated in a sandbox. Do not
import packages. The following values are available directly:

| Name | Meaning |
| --- | --- |
| `open`, `high`, `low`, `close`, `volume` | Number series aligned to every bar |
| `time` | Unix-second timestamp series |
| `hl2`, `hlc3`, `ohlc4` | Common composite-price series |
| `bars` | Raw `{ time, open, high, low, close, volume }` container |
| `p` | Numeric parameters declared in the saved item's `params` array |
| `ta` | Supported series functions listed below |

Every `ta.*` function returns a series aligned to its input. Warm-up or invalid
values are `null`; charts leave gaps and strategy signals treat `null` as false.
Plain JavaScript loops and local variables are supported for recursive indicators.
Validation runs in a worker and rejects errors or execution exceeding two seconds.

## Supported `ta.*` Functions

- Smoothing: `sma`, `ema`, `wma`, `rma`.
- Rolling statistics: `stdev`, `highest`, `lowest`, `sum`.
- Momentum and range: `change`, `roc`, `rsi`, `tr`, `atr`.
- Element-wise series or scalar operations: `add`, `sub`, `mul`, `div`, `max`,
  `min`, `avg`, `abs`.
- Series utilities: `offset`, `cum`, `crossover`, `crossunder`, `toSer`.

There is no `ta.macd`, `ta.boll`, `ta.supertrend`, or other hidden indicator API.
Compose those indicators from the supported functions or write a loop. `highest`
and `lowest` include the current bar. Use `ta.offset(series, 1)` when a breakout
must compare against prior bars only.

## Custom Indicator Contract

Call `save_custom_indicator` with:

- `name`, optional `short` and `desc`.
- `category`: `overlay` for the price pane or `pane` for a separate pane.
- `params`: numeric parameter definitions. Source reads them as `p.key`.
- `source`: JavaScript that calls `plot` at least once.
- `id` only when updating an item obtained from `list_custom_indicators`.

Outputs:

```js
plot('Name', series, {
  kind: 'line', // line | dashed | histogram | points
  color: '#3b82f6',
  signed: true,
  width: 2,
})
hline(0)
```

Use `signed: true` for histograms whose positive and negative bars need directional
coloring. `hline` adds a reference level to a separate pane.

Example, EMA spread:

```js
const fast = ta.ema(close, p.fast)
const slow = ta.ema(close, p.slow)
plot('EMA Spread', ta.sub(fast, slow), {
  kind: 'histogram',
  signed: true,
})
hline(0)
```

## Backtest Strategy Contract

Call `save_strategy` with `name`, optional `desc`, numeric `params`, `source`, and
an `id` only for an existing item returned by `list_strategies`.

Strategy source emits aligned signal series through:

- `longEntry(series)` and `longExit(series)`.
- `shortEntry(series)` and `shortExit(series)`.

Signal DSL also accepts `longEntry(symbol, series, options)` and the same
form for the other three collectors. An omitted symbol selects the run's
primary asset. `asset(symbol)` exposes that asset's own `time`, OHLCV, and
`availability` arrays; a named symbol must belong to the resolved universe.
The current multi-symbol panel is a Batch Run of independent single-symbol
runs, so a cross-symbol source needs a portfolio-capable caller.

`options.size` accepts `position.quantity(n)` for an integer number of panel
units (stock lots/張 or futures contracts/口), or `position.weight(fraction)` for an entry's share of
portfolio equity. Exits accept `position.quantity(n)` for a partial reduction
or `position.percent(fraction)` for a fraction of the actual open position.
The execution lot size is separate: quantities and reduction deltas round down
to whole lots, and a nonzero request smaller than one lot fails validation.
An omitted entry size uses the run's configured quantity or one lot.

`pyramiding: n` on an entry permits at most `n` additional same-side entries
of that entry size. The default is zero. A weight-sized pyramid step adds
`weight` of the current equity, so the resulting quantity varies with price and
equity. `tag` is a nonempty string carried to
fills; entry tags own the resulting position PnL in tag attribution, including
untagged or end-of-run exits. `order` defaults to `{ type: 'market' }`, filled
at the next available open. `{ type: 'limit', price: 100 }` may fill at a
better open or at the limit if the next available bar crosses it; it expires
after that bar and an unfilled limit is recorded as a rejection. A limit price
off the exchange tick grid is rounded against the order (buys down, sells up),
and slippage steps tick by tick through the stock/futures tick ladder. Slippage
must still respect the limit. Missing bars defer pending orders without
fabricating prices. A bar that traded entirely at limit-up does not fill buys
(entirely at limit-down: sells); the order waits for the next fillable bar and
the run records a `limit-locked` deferral.

```js
longEntry('2330', breakout, {
  size: position.weight(0.4), pyramiding: 1,
  order: { type: 'limit', price: 100 }, tag: 'breakout',
})
longExit('2330', exitSignal, { size: position.percent(0.5) })
```

Call each collector at most once per asset: a second `longExit(...)` for the
same symbol fails with a duplicate-collector error instead of silently replacing
the first condition. Simultaneous vector signals retain legacy priority and
produce a conflict diagnostic. Direct conflicting intents fail validation. Choose
`authoring_style: stateful` for `onBar`, `currentPosition`, `enterLong`,
`enterShort`, `reducePosition`, and `closePosition`. Choose
`authoring_style: target-portfolio` for `targetWeight` or `targetQuantity`;
weights and quantities are distinct and `targetPosition` is unsupported.
Signal DSL cannot read simulated position state. All assets must be named in
the static universe; `asset(symbol)` reads named bars and availability.
These research calls never grant broker order authority.

A value greater than zero or `true` means the signal is confirmed at that bar's
close. Signals must use only the current and earlier bars: reading `close[i + 1]`,
`close.length`, the last bar, or a whole-history statistic (maximum, average) to
compute earlier signals or options fails the run with a look-ahead error, and so
does a negative `ta.offset` shift. Price series such as `close` are read-only;
copy them (`close.slice()`) before changing values. `Math.random`, `Date.now`, `new Date()` without
an argument, and timers are not available; use bar `time` and parameters so
every run of the same inputs gives the same result. At least one entry is required. A long entry needs `longExit` or a reverse
`shortEntry`; a short entry needs `shortExit` or a reverse `longEntry`.

Example, long-only EMA crossover:

```js
const fast = ta.ema(close, p.fast)
const slow = ta.ema(close, p.slow)
longEntry(ta.crossover(fast, slow))
longExit(ta.crossunder(fast, slow))
```

Example, prior-range breakout without look-ahead:

```js
const priorHigh = ta.offset(ta.highest(high, p.entryLen), 1)
const priorLow = ta.offset(ta.lowest(low, p.exitLen), 1)
longEntry(ta.crossover(close, priorHigh))
longExit(ta.crossunder(close, priorLow))
```

## Backtest Semantics

- A signal confirmed on bar `i` executes at bar `i + 1` open, including configured
  slippage. This built-in delay prevents same-close look-ahead. A fill's time is
  the label of the bar it executed on (bars are labelled at their close), while
  its price is that bar's open: a 60-minute fill labelled 11:00 executed at 10:00.
- A reverse entry closes the current position before opening the opposite side.
  When capital blocks the new side, only the opening leg is rejected; the close
  still executes at the next open (also when the entry's limit is not reached),
  and exits of other symbols in the same batch are never cancelled by it.
- An open position on the final bar is forced closed at that bar's close, except
  when that bar is missing/suspended or limit-locked against the close: the
  position then stays open, is valued at its last close, and the run records an
  end-of-run rejection.
- Futures daily bars follow the exchange trading day: the night session from
  15:00 belongs to the next date that has a day session (after a holiday, the
  day after it); night minutes after the last day session in the data are
  left out until the next day session is available. Night sessions follow the
  TAIFEX after-hours list (15:00 for index futures, TXO and its weeklies, and
  crude oil; 17:25 for TOPIX, FX, gold and listed stock/ETF futures); some
  ETF futures trade until 16:15. Minutes outside the instrument's sessions are dropped; index
  closing values printed at 13:31–13:33 belong to the 13:30 bar. Daily
  price limits are ±10% of the previous close (futures: previous day-session
  close as the settlement stand-in). Sharpe and Sortino annualize with
  the actual number of bars per trading day (for example 5,040 per year for
  60-minute TAIFEX day+night bars).
- Fees, stock tax, futures tax, and slippage are applied by the backtest engine
  according to the panel configuration; they do not belong in strategy source.
- A save receipt may include validation signal counts. Those counts are not a
  performance backtest. Never claim return, drawdown, win rate, or strategy quality
  until the strategy has actually been run with a declared symbol, interval, date
  range, capital, sizing, and cost assumptions.

## Authoring Workflow

1. Default to Shioaji Pro native content and infer conventional parameter defaults
   when the requested calculation is sufficiently clear. Ask only for missing
   information that materially changes the formula or trading semantics.
2. For an update, list existing items first and preserve the selected `id`.
3. Compose source only from this runtime. Generate a fresh stable
   `idempotency_key` for the save mutation.
4. Call the matching save tool. If validation fails, use the returned error to
   correct source and retry the same intended item.
5. List items after saving and verify the expected name and `id` exist.
6. Report where the user can select the item. Distinguish script validation from
   an executed performance backtest.
