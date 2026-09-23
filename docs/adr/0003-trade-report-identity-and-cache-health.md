# ADR 0003 — 1.7.6 回報識別、快取健康與待對帳原因

日期：2026-09-23
狀態：本次候選版（PR chore/shioaji-1.7.6）；延續 [ADR 0002](0002-event-driven-account-views.md)。

## 背景

Shioaji 1.7.6 在主動回報加入 `event_id`、在 sidecar 內以回報先投影 Trade cache 再送 SSE，並新增
`POST /api/v1/order/trades` 的 `refresh:false`（只讀 cache、不呼叫上游）與
`POST /api/v1/order/trade_cache_health`（cache-only 健康檢查）。上游 #235 已修正，期貨改刪單不再需要先
update_status。ADR 0002 當時「cache-only Trade HTTP API 不是本次前提」，本 ADR 記錄 1.7.6 之後的使用邊界。
欄位與行為以 1.7.6 skill 與執行中 1.7.6 sidecar 的 `/openapi.json` 為準，不猜測欄位。

## 決策

- **訂閱**：每個已簽署帳戶都呼叫 `subscribe_trade`，正式與模擬相同。1.7.6 模擬 sidecar 實測未訂閱時
  order_event 只有 heartbeat；1.7.5 模擬對此為 no-op，無需版本判斷。
- **去重**：SSE 分發前以完整、非空 `event_id` 依環境（API base＋已知 simulation 旗標）去重；重複送達不進
  toast、投影、策略或 Agent。空 ID（歷史紀錄或舊版）不參與；不支援的格式只去重、不推論序號並標示
  「回報無法追蹤」。成交另保留 exchange_seq＋委託的舊識別，兩者任一已套用即不重複計入。
- **跳號**：`v1:` ID 從最後兩個冒號拆成 `<stream>:<reset>:<sequence>`，於 (環境, stream, reset) 內以
  BigInt 比較；首見為基準、新 reset 另建基準。跳號只代表可能漏收：1.5 秒寬限內晚到即補洞，不告警；
  仍缺才標示「回報跳號」並觸發一次 health。
- **待對帳原因**：委託／持倉／帳務分頁各自保留原因（資料暫缺、未知成交、串流中斷、快照邊界、回報跳號、
  待關聯回報、投影失敗、回報無法追蹤、回報未訂閱、改刪待確認、查詢失敗、回報過多），並記錄發生時點。
  成功動作只解除自己能解決且在動作開始前發生的原因：
  - 權威對帳（初始、分頁更新圖示；委託 `refresh:true` 即 update_status、持倉快照）解除該分頁原因；
    查詢期間的新回報仍標示快照邊界。任一帳戶失敗則保留所有既有原因。
  - 回報重播（委託或商品資料補到）只解除對應的「資料暫缺」「待關聯回報」。
  - cache-only 重建只解除委託分頁的串流中斷、跳號、待關聯、投影失敗、無法追蹤與資料暫缺；不解除
    改刪待確認（#120 另案），也不解除持倉或帳務原因。
- **health 觸發**：只在 SSE 重連、持續跳號與手動委託對帳後讀取，單一 in-flight、跳號觸發最少間隔 3 秒，
  連續 Healthy 時指數退避（最長 60 秒），無定時輪詢。health 是 sidecar 本機 cache，不耗券商帳務額度，但仍是 HTTP 呼叫。讀取失敗（舊版無此路由）
  不增減原因。
- **cache-only 使用條件**：只用於重連／跳號後重建委託畫面。必須曾在同一 sidecar 做過權威委託查詢、SSE
  為 LIVE、且所有帳戶 health 皆 `Healthy`。重連時先讀 health 再訂閱：`NotSubscribed`、health 讀取失敗，或
  App 已權威對帳過卻出現 `NoBaseline`（update_status 會建立基準，故代表 sidecar 重啟且他端先訂閱），都視為
  不連續：清除基準、重新訂閱、不信任 cache，直到下一次權威查詢。cache 重建只新增或更新列，**不刪除**本地
  委託；本地仍有效但 cache 沒有的委託會保留並標示待對帳，同時清除基準。
- **心跳 watchdog**：sidecar 每 30 秒送 heartbeat。經 proxy 的 EventSource 在 sidecar 死亡後可能不會關閉，
  因此超過 2 個週期加 15 秒沒有 heartbeat 或任何事件時，狀態改為 `stale`（頁首與 Debug 顯示 STALE，非 LIVE），
  關閉連線並沿用既有退避重連。`stale` 與 `down` 一樣觸發委託／持倉／帳務的「串流中斷（可能漏收回報）」原因；
  重連走同一條 health／重啟偵測路徑。watchdog 本身不發任何 HTTP 查詢。
- **watchdog 邊界**：若檢查間隔大於 15 秒（WebView 或分頁從暫停恢復），先給一個心跳週期寬限再判斷 STALE。
  連線開啟後一直沒收到 heartbeat（例如 proxy 緩衝）時，退避不重設、持續加倍（上限 5 分鐘），Debug 顯示
  連續次數與重試間隔；收到 heartbeat 後重設。重連後的行情訂閱重播每 5 秒最多 40 筆，同時只跑一次；
  quote-ownership 的退訂延後 1.5 秒，重新 retain 的 key 不退訂。
- **改單確認**：改價／減量的 HTTP 回應未確認時標示改刪待確認（每筆委託一個來源）；其後同一委託 id 的成功
  UpdatePrice（modified_price 等於要求價）或 UpdateQty（cancel_quantity 等於要求減量）回報只解除該筆；
  回報早於 HTTP 回覆時，以改單開始後已套用的同 id 回報判斷。小視窗送出的要求經同源 BroadcastChannel
  同步到主視窗。
- **全部刪單**：罕見且攸關安全，一律 `refresh:true`（update_status），不讀 cache。
- **改刪單的 trade_id**：trade_id 只存在於觀察到該委託的 sidecar 程序。App 在目前 sidecar 沒有權威基準時
  （例如外部重啟後），改刪單前對該帳戶執行一次 `refresh:true`，依已知 seqno／ordno、方向、商品重新解析
  trade_id；找不到唯一且仍有效的同筆委託即拒送，不重試。
- **#235 暫時處理移除**：有基準時改價、減量、刪單不再先查委託；保留本地唯一委託、已簽署同帳戶、商品市場相符、
  伺服器未切換的檢查，失敗不送出、不重試。
- **Trade 數量**：`order.quantity` 是原量、取消量累計於 `cancel_quantity`；1.7.6 HTTP 的
  `status.order_quantity` 對已成交／減量列可回 0，不作為剩餘量或成交上限依據。

## 不變與限制

- 下單前後的權威檢查、native production 與 Agent 的 read-only 查核、Grid／到價策略與 #102 保護單查詢不改。
- 仍在上游開啟：Shioaji #232（持倉快照無 watermark）、#233（模擬 Share 單位的 yd_quantity，1.7.6 仍重現）、
  #234（模擬減量後刪單 HTTP／SSE 不一致；1.7.6 模擬單一案例已一致，但不宣稱修復，前端零剩餘防禦保留）。
- sidecar 沒有實例識別：重啟偵測靠重連時的 `NotSubscribed`、`NoBaseline` 或 health 讀取失敗。若重啟後
  在 App 讀 health 之前他端已訂閱且兩條串流都已收到新回報（已 Healthy），仍可能誤判為連續；此時 cache
  重建不刪本地委託、缺少本地有效委託即降級，改刪單可能因 trade_id 不存在而失敗並標示改刪待確認，全部刪單
  不受影響（一律權威查詢）。完整解法待上游提供實例或 cache 基準識別。同一原因可有多個來源（App 端與伺服器 health），
  各來源分別解除。
- health 只描述 sidecar cache；App 與 sidecar 之間 SSE 斷線時 sidecar 仍投影，App 端的持倉增量仍可能漏，
  因此持倉只能由持倉快照解除。mock／CI／模擬證據不等於正式原生驗收。
