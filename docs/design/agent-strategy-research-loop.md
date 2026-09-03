# AI Agent 指標與策略研究閉環

> 2026-09-03 定稿。產品決策已確認;portfolio-first 核心決策見
> [ADR 0002](../adr/0002-portfolio-first-strategy-runtime.md)。

## 目標

使用者以自然語言描述指標或策略後,Agent 能在 Shioaji Pro 內完成:

1. 建立不可變修訂並保存原生成品。
2. 把指標掛到指定 K 線面板,讀回及調整 instance。
3. 設定商品、週期、期間、參數、資金、部位、費稅與滑價。
4. 啟動回測、追蹤背景進度並讀取結構化結果。
5. 找出問題、建立新修訂、重跑及比較。
6. 以 deep link 讓使用者直接檢查圖表、交易與回測紀錄。

完整閉環不包含真實自動交易。回測後可進入前向測試,但只產生即時訊號與模擬成交。

## 現況與缺口

目前已有:

- 自訂指標與策略的 JS sandbox、`ta.*`、保存和驗證。
- `longEntry` / `longExit` / `shortEntry` / `shortExit` vector signals。
- 單商品回測、逐檔批次回測、交易明細和權益曲線 UI。
- Agent 建立與列出指標／策略的 semantic tools。

目前缺少:

- Agent 掛載、設定、排序、隱藏及移除 indicator instance 的 interface。
- UI 與 Agent 共用的回測 module;目前執行與結果只存在面板 React state。
- 策略修訂、可重現 run manifest、持久結果及 deep link。
- Agent 啟動／取消回測、讀取摘要／交易／權益及比較 run 的 tools。
- 逐 bar sequential runtime 與真實持倉感知。
- Portfolio intent、order planner、共享資金風控與 per-asset attribution。

現有「多商品」是 Batch Run,不可稱為 Portfolio Run。

## Domain Model

```ts
type StrategyArtifact = {
  id: string
  name: string
  currentRevisionId: string
}

type StrategyRevision = {
  id: string
  artifactId: string
  parentRevisionId?: string
  source: string
  sourceHash: string
  authoringStyle: 'signal' | 'stateful' | 'target-portfolio'
  params: ParamDefinition[]
  dataRequirements: DataRequirement[]
  engineContractVersion: string
  createdAt: number
}

type UniverseSpec =
  | { kind: 'static'; assets: AssetRef[]; primaryAsset: string }
  | { kind: 'dynamic'; selector: UniverseSelector; primaryAsset?: string }

type ResolvedUniverse = {
  assets: AssetRef[]
  primaryAsset: string
  calendar: 'union' | 'intersection'
}

type StrategyIntent =
  | EntryIntent
  | ExitIntent
  | ReduceIntent
  | TargetQuantityIntent
  | TargetWeightIntent

type StrategyRun = {
  id: string
  revisionId: string
  manifest: RunManifest
  status: 'queued' | 'fetching' | 'running' | 'completed' | 'failed' | 'cancelled'
  resultId?: string
}

type AssetDataManifest = {
  asset: AssetRef
  interval: string
  dataSource: string
  dataVersion: string
  availabilityGaps: DataGap[]
}

type RunDataManifest = {
  primaryAsset: string
  calendar: 'union' | 'intersection'
  assets: AssetDataManifest[]
}
```

Dynamic universe 是保留契約,不在第一期實作。`ResolvedUniverse` 與 run manifest 永遠保存實際商品,所以未來動態選股仍可重現。

## Authoring Styles

### Signal DSL

既有語法完整保留。省略 symbol 等於主商品:

```js
longEntry(signal)
longExit(exitSignal)

longEntry('2330', signal, {
  size: position.weight(0.4),
  pyramiding: 1,
  tag: 'breakout',
})
longExit('2330', exitSignal, { size: position.percent(0.5) })
```

### Stateful Trading DSL

持倉感知策略只在 sequential runtime 執行:

```js
onBar((ctx) => {
  const pos = currentPosition('2330')
  if (pos.isFlat && breakout('2330')) enterLong('2330', position.weight(0.4))
  if (pos.isLong && pos.barsHeld >= 20) reducePosition('2330', position.percent(0.5))
  if (pos.isLong && pos.returnPct < -0.08) closePosition('2330')
})
```

Position state 至少包含 `side`、`quantity`、`weight`、`avgPrice`、
`unrealizedPnl`、`returnPct`、`barsHeld`、`isLong`、`isShort`、`isFlat`。

### Target Portfolio DSL

```js
targetWeight('2330', 0.4)
targetWeight('2454', 0.3)
```

`targetWeight` 只接受可交易的 strategy asset,正值為多方、負值為空方;未配置的可用資金自然保留為現金,現金不是 `AssetRef` 或可交易 intent。planner 依 run 的 leverage/gross/net 限制驗證整體目標。`targetQuantity` 表示明確數量。未來若加入 `targetExposure`,其正負值與 gross/net 語意必須先形成獨立契約。禁止 `targetPosition('2330', 0.4)` 這種無法辨識數量或權重的寫法。

## Runtime And Execution

### Data

- 策略以 `asset(symbol)` 取得具名 OHLCV/time 及 availability。
- 主商品保留 `open/high/low/close/volume/time` shortcut。
- Static universe 先實作;dynamic universe 後續加入。
- Union calendar 保留所有時間點;intersection 只在所有必要商品可用時決策。
- 缺失資料為 `null` 且不可成交,禁止 forward-fill 成假 bar。

### Decision Cycle

每個 bar 先成交前一週期訂單、更新 portfolio,再以 close 決策並產生下一個可成交 open 的訂單。這延續現行 no-look-ahead 語意,同時讓 stateful code 讀到真實模擬成交後狀態。

同商品同週期的 signal intent 與 target intent 衝突時驗證失敗。所有商品意圖先形成完整 target portfolio,再由 planner 統一分配現金、lot、槓桿與風險,不得依 source 呼叫順序決定誰先搶到資金。

### Shared Modules

- `IndicatorInstanceService`:掛載、讀取、修改、排序、隱藏、移除及面板定位。
- `StrategyRevisionStore`:artifact、不可變 revision、lineage 與還原。
- `BacktestService`:驗證 request、建立 job/run、呼叫資料與 execution pipeline。
- `BacktestRunStore`:保存 manifest、進度、結果、錯誤與查詢分頁。

這些是 UI、Agent 與背景任務共用的 domain modules。React 面板不再擁有唯一執行狀態;Web Worker 是 BacktestService 的計算 adapter。

## Reproducible Run

Run manifest 固定:

- strategy artifact/revision、source hash 及 engine contract version
- universe spec 與 resolved universe
- primary asset、對齊 calendar 及每個 asset 的 interval、日期、資料來源／版本／availability gaps
- params、capital、sizing、fees、tax、slippage、lot/tick/multiplier
- App、engine 與 result schema version
- started/completed time、status、錯誤與取消原因

結果保存 portfolio metrics、equity、fills/trades、per-asset attribution 及 strategy tag attribution。摘要固定涵蓋報酬、年化、最大回撤、勝率、Profit Factor、expectancy、Sharpe、Sortino、交易數、持有時間、曝險、成本、turnover、多空拆分及 buy-and-hold benchmark。公式與年化基準跟 result schema 一起版本化。

## Agent Tool Interface

工具名稱是設計方向,實作前仍需以 schema review 收斂:

### Indicator instances

- `mount_indicator`
- `list_indicator_instances`
- `update_indicator_instance`
- `remove_indicator_instance`

預設目標是焦點 K 線面板;工具接受明確 `panel_id`,回傳修改後 instance 與 panel receipt。新增、掛載、調參與執行回測可自動;覆蓋既有共用定義與刪除內容需確認。

### Runs and results

- `run_strategy_backtest`
- `run_strategy_backtest_batch`
- `get_backtest_job`
- `cancel_backtest_job`
- `get_backtest_summary`
- `get_backtest_trades`
- `get_backtest_equity`
- `get_backtest_result`
- `compare_backtest_runs`

`run_strategy_backtest` 接受 `UniverseSpec` 並建立共享時間軸、資金與持倉的 Portfolio Run;單商品請求只是 universe 含一個 asset。`run_strategy_backtest_batch` 明確建立多個互相獨立的單商品 Portfolio Run,不得彙整後標示為多商品 Portfolio Run。兩者的 request、receipt、manifest 與 deep link 都必須帶 `executionMode: 'portfolio' | 'batch'`,讓 UI 與 Agent 無法混淆語意。

交易與 equity 使用分頁／降採樣,避免大量結果塞滿模型 context。每次 mutation 具 idempotency key,每個完成回覆帶 run deep link。

高階 `author_and_test_strategy`、`optimize_strategy` 可由 App 內編排原子操作,但不得另有不同回測語意。

## Optimization And Forward Test

Grid/Random search 先實作,每個 job 有組合數、時間、商品與資源上限。候選結果全數保存;使用「最佳」流程時強制 train/test 切分、樣本外指標、參數敏感度、最低交易數與成本後限制。第一版不做 Bayesian optimization。

前向測試使用同一 revision、intent pipeline、planner、risk 與結果 schema,只把 historical data/fill adapter 換成 live data/simulated fill。它可進入盤中雷達並連動 K 線、五檔、分時與下單面板,但預設不建立真實委託。

## Skill Package

主 skill 只負責意圖辨識與 workflow,細節按需讀取:

- `INDICATOR_AUTHORING.md`
- `STRATEGY_AUTHORING.md`
- `BACKTESTING.md`
- `OPTIMIZATION.md`
- `FORWARD_TESTING.md`
- `RESULT_INTERPRETATION.md`
- `APP_TOOLS.md`

Agent 回覆必須列出 artifact/run、商品、週期、資料期間、revision、參數、成本、核心結果、樣本內外差異、風險、下一個實驗及 deep link;不得只說策略表現良好。

## Delivery Phases

### Phase 1: portfolio-safe foundation and indicator control

- 定義 strategy asset、universe、intent、revision、run manifest contracts。
- 引入 sequential execution core 與既有 Signal DSL adapter。
- 完成單商品 compatibility tests,以及可執行的最小雙商品 pair/spread vertical slice:synthetic bars 必須通過時間軸與 availability 對齊、sequential runtime、intent normalization、最小共享資金 planner 與成交模擬,並斷言兩個商品的 fills、positions、portfolio result 及 per-asset attribution;只有多 symbol 型別測試不算完成。
- 抽出 IndicatorInstanceService,讓 Agent 可建立後直接掛載、讀回及調整。
- 不交付多商品 UI,但 code 和 interface 不得以唯一 bars/position 為核心假設。

### Phase 2: backtest research loop

- StrategyRevisionStore、BacktestService、BacktestRunStore。
- Agent 可設定、執行、取消、讀取、定位及比較單商品 run。
- UI 改讀 shared run state,支援 immutable run deep link。
- 明確回答並以 manifest/trades 重現 #35 的執行語意。
- 為 #21 建立 static multi-asset data/runtime foundation;完整橫截面 UI 可後續交付。

### Phase 3: optimization and portfolio delivery

- Batch jobs、Grid/Random、train/test、敏感度與報告匯出。
- Static multi-asset production data loading,擴充 Phase 1 planner 的 lot、槓桿、同時訊號、部分成交與 portfolio risk 規則,並完成 production-grade per-asset attribution。
- 動態 universe 僅在 selector 與 survivorship-bias 規則完成後開放。

### Phase 4: forward testing

- 即時資料 adapter、模擬成交、策略監控與盤中雷達訊號。
- 對比歷史回測與 forward-test 延遲、滑價及結果偏差。
- 使用者明確建立後才可持續背景執行或排程。

正式自動交易另行 threat model、核可、風控與 emergency stop 設計,不屬於上述四期。

## End-to-End Acceptance

使用者以自然語言描述指標和策略,Agent 建立 revision、掛到指定 K 線、設定並執行回測、讀取績效與交易、指出問題、建立新 revision、重跑並比較;所有操作都有 receipt、可在 UI 看見、可由 run id 重現,且不會觸發真實交易。
