# ADR 0007: 與執行位置無關的回測核心介面

日期:2026-09-30
狀態:已採納(#197;決策背景見 #194)

## 背景

回測、最佳化與策略引擎要在桌面版加一套 App 原生層(Rust)實作,網頁版保留 TypeScript 實作。兩套實作必須產生相同的回測結果與紀錄,因此需要一個不綁定執行位置、可 JSON 序列化的介面,以及任何實作都能比對的共同測試資料。

## 決策

`src/lib/engine/` 定義回測核心的公開契約:

- `schema.ts`:資料形狀(商品集合、K 棒、執行假設、策略意圖、訊號規則、portfolio 結果、成交、拒絕、診斷、research-v1 指標)。原本放在閉源模組的純資料型別移到這裡,閉源模組改為轉出;計算規則仍留在各實作內。
- `core.ts`:`BacktestCore` 介面(`id`、`version`、`run(CoreRequest)`、`selectCandidates(SelectionRequest)`)與請求／回應型別。
- `messages.ts`:錯誤、拒絕原因與診斷的代碼,以及唯一的 zh-TW 翻譯表。
- `conformance.ts`:golden 資料格式與比對規則。

### 核心的範圍

- 核心只接收「策略產物」,不執行使用者程式:
  - `signal-plan`:Signal DSL 產出的四條訊號序列(以該商品自己的 K 棒列為索引)與延伸規則。
  - `intent-stream`:狀態式／目標部位策略在每個決策時間產出的意圖。重播只在核心重現同樣狀態時才精確;之後以內嵌 QuickJS 在核心內直接執行。
    - 記錄不得改變核心的判定:只有「JSON 複本完全等價」的輸出才以 intents 記錄,由核心重新驗證(intent 本身的欄位值為 `undefined` 視同省略;`order` 等巢狀物件仍嚴格)。沒有等價 JSON 形式的輸出(例如 Date 型別的 tag、NaN)先保留,若即時執行的核心拒絕它,串流記錄該錯誤本身(`failure.kind = 'rejected'`,完整的 code／params／time／assetId／cause),重播直接以同一錯誤失敗,JSON 複本永遠不會被接受;若核心接受,才記錄其 JSON 複本。
    - callback 丟出的錯誤:核心錯誤碼(例如 `ctx.asset` 查無商品)記錄 code、params 與 assetId(`failure.kind = 'core'`);回傳形狀錯誤記為 `STRATEGY_RESULT_INVALID`;其他錯誤記錄文字(`'script'`)。重播以相同的 `STRATEGY_CALLBACK_FAILED`、位置與 cause 失敗。
- `mode: 'portfolio'` 是共享資金的逐 bar 引擎;`mode: 'vector'` 是面板多商品掃描仍在使用的單商品向量引擎。
- 最佳化的候選產生、門檻、敏感度與排名是純函式,以 `selectCandidates` 納入同一介面;每個候選的 train／test 仍各自是一次 `run`。

### JSON 規則

- 選用欄位(`name?`)不存在時省略,不寫 `null` 或 `undefined`;可為 null 的欄位(`T | null`)一定存在。
- 序列中的 `null` 代表該位置沒有值:指標暖機、缺 K、停牌。序列比 K 棒短時,缺少的尾端視為 `null`。
- 請求一律帶完整值:`execution.defaults` 為完整設定、`risk` 與 `liquidateAtEnd` 明確給定,不依賴預設值。
- `resultMultiplier` 是報表用的乘數,與 `execution` 無關:單商品 portfolio 的 `result` 交易投影與 vector 模式的 research turnover 使用它。既有 worker 以面板 `CostConfig.multiplier` 計算這兩者,可能與執行乘數不同(例如 config 1000、execution 10),呼叫端傳入該值即可逐位重現;多商品投影仍用各商品的有效執行乘數,成交、損益與 portfolio 數值一律用 execution。
- `profitFactor` 的無限大寫成字串 `'Infinity'`。其他可能非有限的欄位在型別上明確標為 `JsonNumber = number | { "__researchNumber": "Infinity" | "-Infinity" | "NaN" }`(與研究紀錄儲存相同的標記),不得變成 `null`;目前只有 research 指標的 `annualizedReturnPct`(短期間年化溢位為 `Infinity`),其 JSON 形狀是 `ResearchMetricsRecord`,以 `researchMetricsToRecord`／`researchMetricsFromRecord` 轉換。其餘數值欄位一律有限;若實作在其他欄位產生標記,視為與 golden 不一致。

### 錯誤與訊息

- 核心回傳 `{ ok: false, error: { code, params, time, assetId, cause } }`,不回傳中文字串;`formatCoreError` 以翻譯表產生與既有版本逐字相同的訊息。
- 模擬委託拒絕的 `reason.message` 屬於既有研究紀錄格式,仍以中文存入;各實作以同一張翻譯表產生。

### 一致性測試

golden 檔隨閉源實作存放,每筆記錄輸入的來源(手算基準、既有行為測試、TS 對 TS 對拍、或新增推導)與審查狀態。任何實作(TypeScript、Rust,或依規格獨立撰寫的參考實作)都以 `checkGoldenCase` 在 JSON 邊界後比對:數量、時間、索引等離散值完全相等;比率 12 位小數;金額與價格 9 位小數;字串、布林、null、欄位集合與陣列長度完全相等。

## 後果

- 原生實作只依賴公開型別與 golden 資料,不需讀取 TypeScript 計算程式。
- golden 的預期值來自產生時的 TypeScript 實作,不是獨立答案;提供來源欄位讓 QA 標示哪些已獨立驗證。
- 既有 worker 與研究服務仍直接呼叫 TypeScript 引擎,之後的工作再改走 `BacktestCore`。
