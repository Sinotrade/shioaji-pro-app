# ADR 0002: portfolio-first 策略執行核心

日期:2026-09-03
狀態:已採納

## 背景

現行回測核心接收單一 `BarsInput`、四條預先計算的進出場訊號陣列及單一持倉狀態。面板所稱的「多商品」會逐檔獨立執行後加總結果,不共享資金、時間軸或持倉,因此是批次執行而不是投資組合執行。

這個模型可以支援簡單單商品回測,但無法誠實提供 `currentPosition`、平均成本、持有根數、未實現損益或依成交結果做下一步決策;也無法表達跨商品排名、配對交易、共同資金配置及投資組合風控。若先把 Agent 控制直接綁在現行面板狀態,未來加入多商品時必須重寫策略語言、引擎、結果與工具契約。

## 決策

策略研究核心從第一版起採 portfolio-first domain model。單商品是商品集合只含一個主商品的特例,不是不同的引擎。

策略作者可選三種一級語法:

1. Signal DSL:`longEntry`、`longExit`、`shortEntry`、`shortExit`;省略商品時指向主商品,完整保留向後相容。語法可指定 quantity/lots/cash/percent/weight/riskPercent、pyramiding、order model、tag 及部分減碼。
2. Stateful trading DSL:`currentPosition(asset)`、`enterLong`、`enterShort`、`reducePosition`、`closePosition`;由逐 bar sequential runtime 提供成交後狀態。
3. Target portfolio DSL:`targetWeight`、`targetQuantity`,未來可加 `targetExposure`;不採用數值語意含糊的 `targetPosition`。

所有語法只產生下列策略意圖:

- `EntryIntent`
- `ExitIntent`
- `ReduceIntent`
- `TargetQuantityIntent`
- `TargetWeightIntent`

統一管線為:

```text
Strategy DSL
  -> Position / Portfolio Intent
  -> Order Planner
  -> Risk Check
  -> Backtest / Simulation / Broker Executor
```

策略程式不得直接呼叫券商下單。訂單規劃器一次解析同一決策週期的整體目標,處理目前部位差額、資金、lot size、同時訊號、反向、部分成交、滑價、風控及 idempotency,結果不得受 source 呼叫順序影響。同商品同週期出現互相衝突的 signal 與 target intent 時,第一版直接驗證失敗,不設定隱含優先序。

逐 bar 執行順序為:

1. 於本 bar 可成交商品的 open 執行前一決策週期已規劃的訂單。
2. 更新成交、現金、部位與投資組合狀態。
3. 以本 bar close 標記市值,讓策略在決策時讀到一致的持倉狀態。
4. 策略產生本週期意圖;統一驗證、規劃及風控後,排入下一個可成交 open。

多商品資料採具名策略資產、統一時間軸及各商品 availability mask。缺 K、停牌或非交易時段不得製造可成交假 bar。商品集合明確選擇 union 或 intersection calendar;執行紀錄保存已解析的實際商品清單。

現行 vector signal runtime 保留為 Signal DSL adapter:它可預先計算訊號,再轉成逐週期意圖;不可在該 runtime 內偽造持倉感知值。Stateful trading DSL 與 target portfolio DSL 使用 sequential runtime。

每次策略執行固定不可變策略修訂、資料身分、商品集合、參數、成本、部位模型及引擎版本。結果同時保存 portfolio 與 per-asset attribution。

## 分期約束

第一期可以只在 UI 完整開放單商品流程,但核心 interface、型別、run manifest 與測試不得假設只有一個商品。第一期必須交付一條可執行的最小 portfolio vertical slice:以 synthetic bars 執行雙商品 pair/spread 策略,實際通過統一時間軸、availability mask、sequential runtime、intent normalization、最小共享資金 planner 及成交模擬,並驗證兩個商品的 fills、positions 與 per-asset attribution。只驗證型別可容納兩個 symbol 不算通過。多商品 UI、正式資料載入、完整 portfolio risk/planner 與動態 universe 可後續交付。

## 後果

- 需要重構現行直接耦合 React state、localStorage 與 Web Worker 的回測流程,短期工作量高於新增幾個 Agent tools。
- 單商品 Signal DSL 可以透過 adapter 保持相容,既有策略不必立即重寫。
- UI、Agent、背景工作與未來 forward test 可共用同一執行核心與結果存放,避免不同入口產生不同回測語意。
- 真實自動交易不因本決策開放;Broker Executor 是未來獨立安全階段,策略程式永遠只產生意圖。
