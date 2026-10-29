# 語音播報 — 技法筆記與使用準則

> 移植自既有的 .NET WPF 交易終端（`System.Speech` 語音引擎）的語音播報模組。
> 本專案是 React + Tauri，語音引擎層重新接，**播報的「腦」則 1:1 移植並改寫成純函式**。
> 原始系統的逐條行為規格已固化為本專案的單元測試：
> [`src/lib/broadcast/broadcast-rule.test.ts`](../../src/lib/broadcast/broadcast-rule.test.ts)、
> [`broadcast-queue.test.ts`](../../src/lib/broadcast/broadcast-queue.test.ts)、
> [`broadcast-name.test.ts`](../../src/lib/broadcast/broadcast-name.test.ts)、
> [`broadcast-events.test.ts`](../../src/lib/broadcast/broadcast-events.test.ts)。

## 核心技法（值得反覆使用的部分）

一句話：**平台相依只留在最底層，判定邏輯做成純函式，四道節流機制各司其職。**

1. **四層分離，平台相依只留一層**

   ```
   事件來源    lib/broadcast/broadcast-hub.ts   三個既有出口（行情／成交／通知）
   判定邏輯    lib/broadcast/                   純函式、平台無關
   語音佇列    lib/broadcast/broadcast-queue.ts  去重／冷卻／過時丟棄／插播
   引擎        lib/tts/                         ← 唯一的平台相依層
   ```

   [`lib/tts/tts-engine.ts`](../../src/lib/tts/tts-engine.ts) 定義 `TtsEngine` 介面，
   [`lib/tts/index.ts`](../../src/lib/tts/index.ts) 是唯一決定用哪個 engine 的地方。
   **上層不 import 任何平台 API。**
   未來要接原生引擎（Linux 的 sherpa-onnx 等）只需新增一個 engine 實作，
   規則層、佇列層與 UI 完全不動。

2. **事件來源用 repo 既有的出口，不要自己造機制**

   | 事件 | 接入點 | 文案來源 |
   |---|---|---|
   | 行情狀態 | `onAnyTick` / `subscribeQuoteStore` | `broadcast-rule.ts`（移植自 WPF 的規則） |
   | 成交／委託 | `onOrderEvent(ev)` | `broadcast-events.ts` 的 `describeOrderVoice()` |
   | 通知／條件單 | `onNotice(n)` ← `notify()` 是全 app 統一出口 | `describeNoticeVoice()` |

   條件單觸發、委託失敗、待確認、收盤平倉提醒**全都走 `notify()`**
   → 新增一種播報事件只要再加一個 hook，規則層／佇列層／引擎層都不用動。

3. **判定邏輯是純函式**：`evaluateBroadcast(state, tick, limits, name, options)`
   回傳新 state，不碰 DOM、不碰平台 API。因此整套播報規則可以在 node 環境用
   vitest 完整覆蓋，不需要真的出聲就能驗證行為。

4. **四道節流機制各管一件事**（缺一不可，少一道就會吵）

   | 機制 | 解決的問題 | 位置 |
   |---|---|---|
   | 同商品同句去重 | 同一句話重複念 | `BroadcastQueue.lastTextBySymbol` |
   | 10 秒過時丟棄 | 排隊時市場早變了，念出來是舊資訊 | `BroadcastQueue` 出列時檢查 |
   | 智慧冷卻 | 沒有狀態詞的一般播報太吵 | `evaluateBroadcast`（**只擋無狀態詞的**） |
   | 急件插播 | 重要事件要立刻念 | `enqueue({ interrupt: true })` |

5. **「有狀態詞就不受冷卻限制」是關鍵取捨**：漲停／創新高這類事件冷卻會被擋下，
   等於把最重要的訊息壓掉。所以冷卻只作用在「沒有狀態詞」的一般播報上。

6. **水位標竿與「上次念出的價格」是兩個不同的狀態**：前者跟著市場走（每次 tick 都推進），
   後者只在真的念出去時才更新。混用這兩個會讓「最高價／最低價」判定失準。

7. **漲跌停用 `chg_type` 判定，不用價格比對**：Shioaji 的 tick 直接帶
   `chg_type`（`1` = 漲停、`5` = 跌停），是權威值；用合約的 `limit_up` 比對
   只是 fallback（合約資料可能是開盤前的快照）。

8. **不可用要明講，不要靜默失敗**：平台沒有語音支援時，engine 回報
   `available: false` 與原因，面板直接顯示。**「語音不可用」比「按了沒反應」有價值得多。**

9. **失敗要能分辨原因，不要只有靜默**：「沒聲音」在使用者端看起來只有一句話，
   但背後可能是六種完全不同的原因（沒開關／事件沒勾／清單是空的／沒有報價／
   沒有狀態詞所以本來就不該念／被冷卻或去重擋下）。面板必須把這些講清楚。
   - `evaluateBroadcast()` 回傳 `reason`（`'first-tick' | 'cooldown'`）
   - **注意：「沒有狀態詞」不是不播報的原因** —— 依 WpfApp6 原始行為，
     無狀態詞時照樣會播（「台積電 1900.0」），只是受冷卻限制。
   - 「已訂閱但收不到報價」要另外明示：訂閱成功（伺服器 `desired=true`）
     不等於有資料可念。沿用 repo 既有的「訂閱失敗會重試並明示」慣例
     （見 `lib/boot.ts` 的 `notify({ kind: 'err', title: '…訂閱失敗' })`）。

10. **診斷層要旁路，不能影響行為**：除錯記錄器只「旁註」原因，不改變判定結果；
    且高頻 tick 的記錄要做節流（狀態永遠最新、通知節流到 250ms），
    否則診斷面板本身就會造成重繪風暴——那是在「用診斷工具製造問題」。

11. **語速是抽象刻度，映射交給各 engine**：`TtsSpeakOptions.rate` 用 **-10 ~ 10**
   （沿用 WPF 的刻度，0 = 正常），各 engine 自行映射成自己的語意
   （Web Speech 是倍率、原生引擎是 rate / length_scale）。
   **共用層不做映射**——那是平台相關的部分。

12. **可用性是兩層的**：`available`（同步）只回答「這個 engine 物件在不在」；
    真的能不能用（例如原生引擎的模型下載了沒）要問非同步的 `probe()`。
    面板在 probe 結果出來前顯示「檢查中…」，不要先樂觀地說「可用」。
    這是整套機制裡最容易省掉、但省掉就會被使用者當成 bug 的一段。

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
- **名稱發音轉換**：去掉名稱裡的 `-`（TTS 會念成英文 dash）；選擇權名稱改寫成
  `標的 履約價 Call/Put`；期貨名稱結尾的月份數字改成 `期`

成交／委託的語音文案在
[`broadcast-events.ts`](../../src/lib/broadcast/broadcast-events.ts)：
`買進 2330 1000 張 成交價 1900`、`取消買進 2330 1000 張`、
`改價買進 2330 1000 張 1950`、`委託失敗 2330 買進，請檢查`。

## 本專案使用準則（風格裁決）

- **語音播報是 app 級能力，不是某個面板的功能。** 事件來源是全域的，
  所以面板是 **singleton 的全域設定中心**——多個面板各有一份設定會互相衝突，
  「哪一份生效」就變成不可預期的規則。
- **事件開關全部預設關**，由使用者逐一開啟。一次全開會被轟炸；
  使用者開啟時是他清楚知道自己在聽什麼。
- **行情要播報哪些商品存在 block 上**（隨版面存檔），
  其餘設定（總開關／事件開關／語速／冷卻／語音）在 localStorage。
- **語音出口是全域單一佇列**：同一商品同時被兩個來源觸發時仍只念一次。
- **成交／委託的事件不帶去重鍵**：兩筆一樣價位的成交是兩件事，都要念
  （SSE 重播的重複由 stream 層的 eventId 去重處理，不靠這裡）。
- **音效與語音分工**：成交／委託／錯誤的提示音效沿用既有 `lib/sounds.ts`
  與 `event-toasts.tsx`；語音播報只負責「用聽的再說一次」。
- **語音失敗要留告警**：`utterance.onerror` 會 `console.warn`，
  不要靜默吞掉——否則只會看到「沒反應」。
- **隱私模式不特別停用語音**：本專案的隱私模式遮的是「帳號與金額」，
  不是股票名稱，所以語音念商品名稱不受影響；要不要播由使用者的開關決定。

## 已套用位置（2026-10-29）

新增「語音播報」面板（`BlockType 'broadcast'`，singleton）：面板庫可搜尋「語音」、
即時預覽、可拖拉版面、隨版面存檔。面板內含三類事件開關、語速／冷卻、
行情商品清單（含現價）、最近播報紀錄、測試語音按鈕。

## 未來擴充

- **原生 TTS 引擎**：Linux 的 WebKitGTK 未實作 Web Speech API，
  要支援 Linux 需在 Tauri Rust 端接原生引擎（Apache-2.0 的 sherpa-onnx
  + CC0 的中文模型）。屆時只需在 `lib/tts/index.ts` 依平台挑選 engine，
  **規則層、佇列層與 UI 完全不動**。
- **更多播報事件**：目前接了三類（行情／成交委託／通知條件單）。
  新增一類只要再加一個 hook。
- **播報範圍語意**：目前行情是「面板指定清單」。若日後要「跟著自選清單自動同步」，
  改動點在 `broadcast-hub.ts` 的 `desiredCodes()`，判定邏輯不受影響。
- **面板不開放 popout**（與 `notices` / `debug` 一致）：語音出口在主視窗的
  webview，popout 出去會變成另一個 webview 的語音。
