# 語音播報 — 技法筆記與使用準則

> 移植自既有的 .NET WPF 交易終端（`System.Speech` 語音引擎）的語音播報模組。
> 本專案是 React + Tauri，語音引擎層重新接，**播報的「腦」則 1:1 移植並改寫成純函式**。
> 原始系統的逐條行為規格已固化為本專案的單元測試：
> [`src/lib/broadcast/broadcast-rule.test.ts`](../../src/lib/broadcast/broadcast-rule.test.ts)、
> [`broadcast-queue.test.ts`](../../src/lib/broadcast/broadcast-queue.test.ts)、
> [`broadcast-name.test.ts`](../../src/lib/broadcast/broadcast-name.test.ts)。

## 核心技法（值得反覆使用的部分）

一句話：**平台相依只留在最底層，判定邏輯做成純函式，四道節流機制各司其職。**

1. **三層分離，平台相依只留一層**

   ```
   UI          components/broadcast-panel     平台無關
   判定邏輯    lib/broadcast/                 純函式、平台無關
   引擎        lib/tts/                       ← 唯一的平台相依層
   ```

   [`lib/tts/tts-engine.ts`](../../src/lib/tts/tts-engine.ts) 定義 `TtsEngine` 介面，
   [`lib/tts/index.ts`](../../src/lib/tts/index.ts) 是唯一決定用哪個 engine 的地方。
   **上層不 import 任何平台 API。**
   未來要接原生引擎（Windows WinRT / macOS AVSpeechSynthesizer / Linux
   speech-dispatcher）只需新增一個 engine 實作，判定邏輯與 UI 完全不動。

2. **判定邏輯是純函式**：`evaluateBroadcast(state, tick, limits, name, options)`
   回傳新 state，不碰 DOM、不碰平台 API。因此整套播報規則可以在 node 環境用
   vitest 完整覆蓋，不需要真的出聲就能驗證行為。

3. **四道節流機制各管一件事**（缺一不可，少一道就會吵）

   | 機制 | 解決的問題 | 位置 |
   |---|---|---|
   | 同商品同句去重 | 同一句話重複念 | `BroadcastQueue.lastTextBySymbol` |
   | 10 秒過時丟棄 | 排隊時市場早變了，念出來是舊資訊 | `BroadcastQueue` 出列時檢查 |
   | 智慧冷卻 | 沒有狀態詞的一般播報太吵 | `evaluateBroadcast`（**只擋無狀態詞的**） |
   | 急件插播 | 重要事件要立刻念 | `enqueue({ interrupt: true })` |

4. **「有狀態詞就不受冷卻限制」是關鍵取捨**：漲停／創新高這類事件冷卻會被擋下，
   等於把最重要的訊息壓掉。所以冷卻只作用在「沒有狀態詞」的一般播報上。

5. **水位標竿與「上次念出的價格」是兩個不同的狀態**：前者跟著市場走（每次 tick 都推進），
   後者只在真的念出去時才更新。混用這兩個會讓「最高價／最低價」判定失準。

6. **漲跌停用 `chg_type` 判定，不用價格比對**：Shioaji 的 tick 直接帶
   `chg_type`（`1` = 漲停、`5` = 跌停），是權威值；用合約的 `limit_up` 比對
   只是 fallback（合約資料可能是開盤前的快照）。

7. **不可用要明講，不要靜默失敗**：平台沒有語音支援時，engine 回報
   `available: false` 與原因，面板直接把原因顯示出來。使用者看到的是
   「此平台的 webview 未實作 Web Speech API」，而不是「按了沒反應」。

## 播報規則總表

狀態詞互斥，依序判定。文字前面帶一個全形逗號，最終句子是
`台積電 1900.0，創新高`。

| 狀態詞 | 條件 | 文案 |
|---|---|---|
| 漲停 | `chg_type === 1` | `，漲停` |
| 跌停 | `chg_type === 5` | `，跌停` |
| 創新高 | 高點 > 前高點 且 現價 == 高點 | `，創新高` |
| 破新低 | 低點 > 0 且 低點 < 前低點 且 現價 == 低點 | `，破新低` |
| 最高價 | 高點 > 0 且 現價 == 高點 且 上次念出的價格 < 高點 | `，最高價` |
| 最低價 | 低點 > 0 且 現價 == 低點 且 上次念出的價格 > 低點 | `，最低價` |
| （無） | 以上皆不成立 | 受冷卻限制 |

另外兩條規則：

- **第一筆 tick 不播報**（只用來定基準）
- **名稱發音轉換**：去掉名稱裡的 `-`（TTS 會念成英文）；選擇權名稱改寫成
  `標的 履約價 Call/Put`；期貨名稱結尾的月份數字改成 `期`

## 本專案使用準則（風格裁決）

- **播報範圍＝每個「語音播報」面板自訂商品清單**。清單存在 `block.broadcastCodes`，
  隨版面存檔；可開多個面板，各播各的。
  → 使用者自己指定要播報的商品，系統不會主動念出他沒選的商品，
  也就不需要為「私隱模式下的商品名稱」特別處理。
- **語音出口是全域單一佇列**：同一商品被兩個面板同時指定時，仍只念一次。
- **全域設定**（總開關／語速 -10~10／冷卻 0~60 秒／語音）共用，存 localStorage
  （`sj-pro-broadcast`），用 `useSyncExternalStore` 寫法。
- **語速刻度沿用原系統**（-10~10，0 = 正常），映射到 Web Speech 的倍率時
  用 `1 + rate / 10`，並夾在 0.1~3。
- **預設關閉**：語音播報是使用者明確要開的功能，不替他開。
- **「最近播報」紀錄寫在「真的念完」時**——被冷卻或去重擋下、根本沒出聲的句子
  不該出現在紀錄裡，否則使用者會以為有播報。
- **音效與語音分工**：成交／委託／錯誤的提示音效沿用既有 `lib/sounds.ts`
  與 `event-toasts.tsx`；語音播報只負責**行情狀態**。
- **語音失敗要留告警**：`utterance.onerror` 會 `console.warn`，
  不要靜默吞掉——否則只會看到「沒反應」。

## 已套用位置（2026-10-28）

新增「語音播報」面板（`BlockType 'broadcast'`）：面板庫可搜尋「語音」、即時預覽、
可拖拉版面、隨版面存檔。面板內含全域設定、商品清單（含現價）、最近播報紀錄、
測試語音按鈕。

## 未來擴充

- **原生 TTS 引擎**：Linux 的 WebKitGTK 未實作 Web Speech API，
  macOS／Windows 的 WebView 則可用。要支援 Linux 需在 Tauri Rust 端接原生引擎
  （WinRT／AVSpeechSynthesizer／speech-dispatcher），屆時只需在 `lib/tts/index.ts`
  依平台挑選 engine。
- **更多播報事件**：目前只播行情狀態；可依同一套規則擴充到
  成交／委託／帳務事件（事件來源在 `lib/stream.ts` 的 `onOrderEvent` / `onNotice`）。
- **播報範圍語意**：目前是「面板自訂清單」。若日後要「跟著自選清單自動同步」，
  改動點在 `broadcast-hub` 的 `desiredCodes()`，判定邏輯不受影響。
- **面板不開放 popout**（與 `notices` / `debug` 一致）：語音出口在主視窗的
  webview，popout 出去會變成另一個 webview 的語音。
