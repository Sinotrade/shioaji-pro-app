# ADR 0004 — 刪單以回讀確認，未確認為結果未知

日期：2026-09-23
狀態：本次候選版（PR fix/cancel-confirmation，疊在 #128 之上）；延續 [ADR 0003](0003-trade-report-identity-and-cache-health.md)。

## 背景

#120：Agent `cancel_order` 在 HTTP 成功後就回 `cancelled=true`，但事後回讀，同一筆委託仍是 Submitted、
取消量 0。維護者其後確認這個 Submitted＋取消量 0 是測試環境的問題；正確的做法是依 1.7.6 skill，從回報投影的
Trade cache 確認取消，也就是本 ADR 的做法。#116：閃電逐價刪單與全刪只拿到 HTTP 回應，因此一律顯示「送出待確認」，trading-state 也常留下
「改刪待確認」。1.7.6 模擬實測：`/order/cancel_order` 的回應是 Submitted、`cancel_quantity` 0；sidecar Trade
cache（`refresh:false`）大約 0.3–1.4 秒後變成 Cancelled、取消量 1。

PR #121 用回讀確認的方向正確，但把「委託從清單消失」當成取消，還會從本地資料合成一筆 Cancelled，而且每次輪詢
都用 `refresh:true`。本 ADR 只沿用回讀的構想。

## 決策

- `cancelOrder` 在 `observeTradeMutation` 內送出 HTTP 刪單後，呼叫 `verifyCancellation`
  （`src/lib/cancel-verification.ts`）。
- **確認條件**：同帳戶讀到的列，order.id 與帳戶都相同，沒有任何剩餘：累計 `cancel_quantity`＋成交量 ≥
  max(本地原量, 回讀 `order.quantity`)，而且符合其一：
  - 狀態為 Cancelled；
  - 狀態為 Filled（刪單生效前已全部成交，回報「已全部成交、無可取消」，屬已知結果）；
  - `cancel_quantity` > 0 且不是 PendingSubmit。sidecar 重啟後 update_status 會把減量後刪單的委託回成
    Submitted、取消量等於委託量（Shioaji#234 型態）；委託表自 v0.1.48 已把零剩餘列視為非有效委託。此時保留
    券商原始狀態，結果與提示附註「券商狀態仍為 Submitted，取消量已涵蓋全部」。
  成交沒有和刪單競爭時，這等於「取消量涵蓋刪單前剩餘量（原量減開始時的成交量）」。`status.order_quantity`
  不使用（1.7.6 HTTP 列回 0）。回讀列的已成交量比本地少時不算證據。Submitted＋取消量 0、部分取消、
  PendingSubmit 都不算確認。
- **不算確認**：委託不在 cache、同 id 對應多列、別的帳戶、讀取失敗、伺服器或帳戶已切換。不會從本地資料合成
  Cancelled。
- **讀取順序**：先讀 `refresh:false`，約 300ms 一次，最長約 3 秒（sidecar cache，不耗帳務額度）。仍未確認就讀
  一次 `trade_cache_health`（只用來說明原因，本身不能確認取消），再做**恰好一次** `refresh:true`。
  cache 沒有連續基準時（`cancelCacheTrusted()` 為 false；小視窗沿用主視窗的判定；或 #128 的無基準前置流程重新
  解析過 trade_id），跳過 cache 與 health，等到本地收到 Cancel 回報或時窗結束，再直接做那一次 `refresh:true`。
- **未確認**：拋出 `CANCEL_UNCONFIRMED`（`mutationOutcomeUnknown`、`reconcileRequired`），不會自動重送。
  私有 Agent 的 `classifyOrderMutationError` 把它對應成 `unknown_outcome`，由 durable idempotency store 記錄，
  之後只能用 `reconcile_order`。
- **投影**：確認後的列帶 `confirmed` 旗標發布。trading-state 接受它，即使期間已收到其他回報（通常就是 Cancel
  本身）；本地保留原始 order（包括原量），`order_quantity` 為 0 時不覆寫。本地已知的成交或取消量比回讀列多時，
  維持「改刪待確認」。
- **額度**：讀取依帳戶共用，以單調遞增的讀取序號判斷先後（不用時鐘）。
  - **批次**（閃電逐價刪單／全刪、鋪單全撤、全部刪單、委託批次刪單）一律走 `cancelOrders`：先送出全部刪單，
    每筆在自己的請求回來、取得讀取序號後抵達屏障；任何一筆的確認 `refresh:true` 都要等全批抵達後才開始，
    所以同帳戶整批共用**一次**確認讀取，即使 Web Lock 與 sidecar 把送出排成先後。屏障最多等 15 秒，避免
    一筆卡住拖住其他筆。單筆刪單不受影響。
  - **無基準前置**：重新解析 trade_id 只需要「基準遺失之後」開始的權威讀取，所以依帳戶、依基準遺失時點共用
    一次；只有在那次讀取裡找不到的委託，才另外做一次新的讀取。
  - 因此重啟後的一批刪單，每個帳戶最多一次前置加一次確認；cache 可信時為零次。
- **識別**：#128 在沒有基準時會重新解析 trade_id。刪單會用新 id 送出與回讀，但確認結果以呼叫端的 id 回報，
  讓本地列與 Agent 的 order_id 對得上；狀態與數量都是券商回讀的值。

## 限制

- Shioaji#234（模擬減量後刪單，HTTP 與 SSE 不一致）上游仍開啟。1.7.6 模擬的減量後刪單回讀是累計取消 2、
  Cancelled，這只是回歸證據，不代表正式環境的行為。
- 若本地還沒收到比回讀更早的成交（回讀的成交量比本地少），不算確認，交給人工對帳。
- 帳戶很多、或短時間內多輪批次，仍會累積 `refresh:true`（每批每帳戶最多一次前置加一次確認）。
- 正式環境「減量後再刪單」的 `cancel_quantity` 是否累計（1.7.6 模擬為累計）尚未以真實回報核對。
- `refresh:true` 會耗帳務額度（25 次／5 秒）。一般情況靠 cache 就能確認；只有 cache 不可信或逾時才會用到，
  每筆刪單最多一次。
