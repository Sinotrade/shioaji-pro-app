# ADR 0004 — 刪單以回讀確認，未確認為結果未知

日期：2026-09-23
狀態：本次候選版（PR fix/cancel-confirmation，疊在 #128 之上）；延續 [ADR 0003](0003-trade-report-identity-and-cache-health.md)。

## 背景

#120：Agent `cancel_order` 在 HTTP 成功後就回 `cancelled=true`，但事後回讀，同一筆委託仍是 Submitted、
取消量 0。#116：閃電逐價刪單與全刪只拿到 HTTP 回應，因此一律顯示「送出待確認」，trading-state 也常留下
「改刪待確認」。1.7.6 模擬實測：`/order/cancel_order` 的回應是 Submitted、`cancel_quantity` 0；sidecar Trade
cache（`refresh:false`）大約 0.3–1.4 秒後變成 Cancelled、取消量 1。

PR #121 用回讀確認的方向正確，但把「委託從清單消失」當成取消，還會從本地資料合成一筆 Cancelled，而且每次輪詢
都用 `refresh:true`。本 ADR 只沿用回讀的構想。

## 決策

- `cancelOrder` 在 `observeTradeMutation` 內送出 HTTP 刪單後，呼叫 `verifyCancellation`
  （`src/lib/cancel-verification.ts`）。
- **確認條件**：同帳戶讀到的列，order.id 與帳戶都相同，沒有任何剩餘：狀態為 Cancelled，或在刪單生效前已
  Filled（「已全部成交、無可取消」，屬已知結果，不是結果未知），而且累計 `cancel_quantity`＋成交量 ≥
  max(本地原量, 回讀 `order.quantity`)。成交沒有和刪單競爭時，這等於「取消量涵蓋刪單前剩餘量（原量減開始時
  的成交量）」。`status.order_quantity` 不使用，因為 1.7.6 HTTP 列會回 0。回讀列的已成交量比本地少時，不算證據。
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
- **額度**：讀取依帳戶共用，並以單調遞增的讀取序號判斷先後（不用時鐘），只採用在呼叫端參考點之後才開始的讀取
  （刪單確認：本筆刪單請求回來之後；無基準前置：本筆改刪單開始之後）。每一輪確認，每個帳戶**最多一次**共用的
  `refresh:true`：同一批的刪單都加入進行中或剛完成的那一次。小視窗沒有委託基準時，#128 的前置 `refresh:true`
  也依帳戶共用，所以一批刪單每個帳戶是一次前置加一次確認。委託批次刪單改為並行送出。
- **自動流程不重送**：鋪單跟隨遇到未確認或結果不明的刪單時，停止處理那一筆並提示人工對帳，下一輪不會再刪它。
- **摘要**：全部刪單等批次摘要中，未送出、已送出未確認、失敗或未知都用錯誤色調。
- **識別**：#128 在沒有基準時會重新解析 trade_id。刪單會用新 id 送出與回讀，但確認結果以呼叫端的 id 回報，
  讓本地列與 Agent 的 order_id 對得上；狀態與數量都是券商回讀的值。

## 限制

- Shioaji#234（模擬減量後刪單，HTTP 與 SSE 不一致）上游仍開啟。1.7.6 模擬的減量後刪單回讀是累計取消 2、
  Cancelled，這只是回歸證據，不代表正式環境的行為。
- 若本地還沒收到比回讀更早的成交（回讀的成交量比本地少），不算確認，交給人工對帳。
- 帳戶很多、或短時間內多輪批次，仍會累積 `refresh:true`；每輪每帳戶上限一次前置加一次確認，需要原生實測觀察。
- 正式環境「減量後再刪單」的 `cancel_quantity` 是否累計（1.7.6 模擬為累計）尚未以真實回報核對。
- `refresh:true` 會耗帳務額度（25 次／5 秒）。一般情況靠 cache 就能確認；只有 cache 不可信或逾時才會用到，
  每筆刪單最多一次。
