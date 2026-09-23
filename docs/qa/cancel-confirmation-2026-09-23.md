# 刪單回讀確認驗收紀錄（2026-09-23）

範圍：PR `fix/cancel-confirmation`（Refs #120 #116，private 同名分支另含 #80）。基於 `chore/shioaji-1.7.6`（#128）。
決策見 [ADR 0004](../adr/0004-cancel-confirmation.md)。公開內容不含帳戶、憑證、金鑰或委託識別。

## 證據界線

- 「模擬實測」：agent 以官方 `shioaji-v1.7.6-macOS-aarch64`，**只在模擬模式**的隔離埠 `21326` 上操作。每次操作前都確認
  `/api/v1/info` 回報 1.7.6、`simulation=true`。委託一律是遠離市價的 TXF 限價 ROD，測完全數取消，並核對自己下的單
  沒有殘留。`21322`、`21323`／`5183` 都沒有碰；沒有送出任何正式委託。
- 模擬帳戶上另有其他 client 的在途委託，本次沒有操作。
- 「mock」指 vitest 單元與 renderer 測試。模擬與 mock 都**不是**正式環境的原生驗收。Shioaji#234 上游仍開啟。

## 1.7.6 模擬實測

| 項目 | 觀測 |
| --- | --- |
| HTTP `cancel_order` 回應 | Submitted、`cancel_quantity` 0、`status.order_quantity` 0（Submitted 列也是 0） |
| cache（`refresh:false`）轉為 Cancelled | 刪單後約 0.3–1.4 秒；`cancel_quantity` 1；`order.account` 有值 |
| 真實 `cancelOrder`（node 呼叫實際程式，trading-state／帳戶用 fixture） | 單筆：1 次 cancel、2 次 cache 讀，約 0.4 秒內確認，沒有 `refresh:true` |
| 減量後刪單（#234 路徑） | 原量 2 → 減量 1（cache 取消量 1）→ 刪單：cache 讀 2 次後確認 Cancelled、累計取消 2 |
| 兩筆接連刪單（間隔 30ms） | 兩筆都確認；5 次 HTTP（2 cancel＋3 cache），重疊的讀取有共用 |
| 刪單後 health | `Unknown`（FuturesDeal NoBaseline，沒有成交時屬正常）；因此不能拿 Healthy 當作可用 cache 的前提 |
| 瀏覽器 UI（隔離 Vite 5197 → 21326，非原生） | 手動更新委託後按委託列 CANCEL：網路為 cancel＋2 次 cache 讀；提示「刪單結果：已確認取消 1 筆。」；委託數 0；沒有「待對帳」「改刪待確認」 |

去識別 fixture：`src/lib/fixtures/native-simulation-cancel-readback-1.7.6.json`（HTTP 刪單回應、刪單前後的 cache 列、
減量後刪單序列）。

## 自動測試（mock）

- `cancel-verification.test.ts`：Submitted 且取消量 0 → 未確認（11 次 cache、1 次 health、恰好 1 次 `refresh:true`）；
  部分成交後刪單確認；Degraded 仍只做 1 次 `refresh:true`；讀取失敗、委託不在、別的帳戶都判未確認、不合成
  Cancelled；伺服器切換會中止讀取；cache 不可信時跳過 cache 與 health；同帳戶讀取共用；fixture 回歸。
- `shioaji-mutation-preflight.test.ts`：回讀列限同帳戶且為 `refresh:false`；未確認拋 `CANCEL_UNCONFIRMED`，只送出
  一次 cancel；無基準時是一次 `refresh:true` 前置、重新解析 id、再一次 `refresh:true` 確認。
- `trading-state.test.ts`：已確認的取消，即使期間收到 Cancel 或其他回報，也不標「改刪待確認」；本地成交量較多時
  仍標示；未確認時照舊標示。
- `trade-mutations.test.ts`：摘要分開已確認、已送出未確認、未送出、失敗或未知；只有回讀確認的結果帶
  `confirmed` 旗標。
- private（composite）：`cancel_order` 只在確認列時回 `cancelled:true`；`CANCEL_UNCONFIRMED` 轉成
  `unknown_outcome`，即使訊息帶 4xx 字樣也一樣；durable store 重啟後仍保留、不重送；`reconcile_order` 維持
  `refresh:true`。

## 仍待驗收

- 正式環境：期貨與股票刪單（含閃電逐價刪單、全刪）在正式回報下的確認時間、`order.account` 欄位，以及正式
  cache 的累計取消量語意。需要使用者自行操作；agent 不代送正式委託。
- 原生 App：閃電面板逐價刪單、全刪、小視窗（沿用主視窗的 cache 判定）、Agent `cancel_order` 的核可視窗流程。
- 成交與刪單同時發生會判為未確認（刻意偏保守），正式環境的發生頻率待觀察。
- #116 回報的成本顯示問題不在本 PR 範圍。
