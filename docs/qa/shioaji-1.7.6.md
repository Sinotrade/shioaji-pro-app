# Shioaji 1.7.6 sidecar 升級驗收紀錄（2026-09-23）

範圍：PR `chore/shioaji-1.7.6`（Refs #85 #86 #88）。public 基線 `b37f7a0`；private pin 維持
`a254e739ddfbf43619c90ca76b2cb0078a14ac7d`（未修改 private）。決策見
[ADR 0003](../adr/0003-trade-report-identity-and-cache-health.md)。
公開內容不含帳戶、憑證、金鑰、委託識別或完整交易紀錄；fixture 已替換身分、識別、reset／stream token 與時間。

## 環境與證據界線

- macOS arm64；官方 `shioaji-v1.7.6-macOS-aarch64` 與 `v1.7.5` 二進位，**只以模擬模式**在隔離埠
  （21391、21392、21393，dev App 為 21323）啟動，每次先確認 `/api/v1/info` 的 `simulation=true` 與版本。
  使用者正式 App 與 `21322` sidecar 未被觸碰；未送出任何正式委託。
- 下列「模擬實測」為 agent 以 HTTP／SSE 對 1.7.6 模擬 sidecar 的操作；「mock」為 vitest 單元與 renderer 案例；
  兩者都不是正式環境原生驗收。

## 1.7.6 模擬 sidecar 實測

| 項目 | 觀測 | 處置 |
| --- | --- | --- |
| OpenAPI 1.7.5→1.7.6 差異 | 新增 `trade_cache_health`；四種回報新增必填 `event_id`；`TradesRequest.refresh`；`subscribe_trade` 說明改為正式／模擬皆支援；monitor API 無變化 | schema fixture `order-callback-openapi-1.7.6.json` |
| `subscribe_trade` | 模擬環境未訂閱時下單，SSE 只有 heartbeat、health 為 `NotSubscribed`；訂閱後 `NoBaseline`，之後才有回報 | App 改為正式／模擬都訂閱 |
| `event_id` | 形如 `v1:FO:<stream>:<reset>:<seq>`；委託／成交各自 stream 與序號，同帳戶不同 client 的回報共用 stream；首見序號可大於 1（訂閱前的回報不補送） | 依環境去重、BigInt 跳號偵測 |
| 多 client | 同模擬帳戶其他 client 的股票委託與成交也送到本 SSE | 未知委託標示「待關聯回報」，不猜測 |
| #235 | 期貨 UpdatePrice、UpdateQty、Cancel 不先查委託即成功 | 移除暫時 update_status；正式期貨待原生驗收 |
| #234 | New 2 → 減量 1 → 刪單：SSE Cancel 成功；`refresh:false` 與 `refresh:true` 都為 Cancelled、取消 2 | 單一模擬案例一致；上游 issue 仍開啟，前端零剩餘防禦保留 |
| #233 | Common／Share 查詢 `quantity` 1→1000，`yd_quantity` 皆為 1 | 仍重現；昨餘「待確認」延伸至 1.7.6 模擬 |
| Trade cache 形狀 | 已成交與減量列的 `status.order_quantity` 為 0（兩種 refresh 皆然）；`order.quantity` 為原量 | 成交投影改用 `order.quantity` |
| cache health | 訂閱後 `Unknown/NoBaseline`；成交後 Healthy；`refresh:true` 後 Healthy | 只在重連、跳號、手動觸發讀取 |
| Agent harness | `SJ_AGENT_HARNESS_BOOTSTRAP=one_shot_ipc`＋stdin `SJAHIPC1`＋64 hex → `/info` 回報 `bootstrap=one_shot_ipc`、capability v1 | private 不需修改 |

去識別回報 fixture：`src/lib/fixtures/native-simulation-event-id-1.7.6.json`（期貨 New→UpdateQty→Cancel、期貨 New／Cover 成交、
股票 Common 買賣成交、他端委託）。

## dev App（隔離 21323，模擬）

- 原生 dev shell：public 本分支＋private pin `a254e73` overlay、內建 1.7.6 sidecar，`VITE_DEV_SERVER_PORT=21323`、
  Vite `5183`（同源 SSE proxy），identifier 沿用既有 `com.sinotrade.shioaji-pro.dev175`（模擬設定）。sidecar `/info`：
  1.7.6、`simulation=true`、`agent_harness.bootstrap=one_shot_ipc`、enabled。正式 App（21322）未觸碰。
- 原生觀測（sidecar monitor／連線，未取得視窗畫面：本次畫面控制權限未授予）：冷編譯後首次載入在 sidecar 就緒前
  停在閒置，Vite 重新載入後正常連線（原因未查明，與本 PR 變更無直接關聯，列為待觀察）。之後由另一個
  1.7.6 模擬 client 對同帳戶送出期貨 New 2→減量→刪單與 New／Cover 成交：dev sidecar 的 order_event 收到全部 7 筆
  回報；該期間 App 沒有任何 `order/trades`、`position_unit`、`trade_cache_health` 查詢。
- dev sidecar 啟用 harness 時，未帶 capability 的直接 HTTP 下單回 403，未送出。
- 瀏覽器（非原生，同一 Vite／21323 sidecar）：頁首 `App dev · d04a1c95`、模擬環境、LIVE；外部 client 的成交使持倉顯示
  「待對帳：資料暫缺」、委託顯示「待對帳：待關聯回報、資料暫缺」。按委託更新圖示只送出 3 個帳戶的 `order/trades`
  （refresh:true）與 3 次 health，委託變為「即時回報」但持倉原因保留；再按持倉更新才解除。
- 1.7.6 monitor 將 `trade_cache_health` 歸類為 `unknown` endpoint（上游觀察，未影響功能）。

## 自動測試（mock，非原生）

- `report-ledger.test.ts`：完整 ID 去重（環境隔離、模式切換）、空 ID、未支援格式、BigInt、基準、寬限晚到補洞、多段跳號、reset 切換、上限。
- `trading-state.test.ts`：重送同 ID 不重複投影；不同 ID／空 ID 仍以 exchange_seq 去重；成交先於委託只解除資料暫缺；
  寬限內晚到不告警；持續跳號讀一次 health 並以 `refresh:false` 重建委託；Degraded 依分頁標示，手動委託對帳不解除持倉；
  重連在同一 sidecar 以 cache 解除委託的串流中斷，訂閱遺失則重訂閱且不信任 cache；120 秒無定時查詢。
- `shioaji-mutation-preflight.test.ts`：期貨／股票改刪單直接送出且無 trades 查詢；本地歸屬與伺服器切換拒送。
- `trade-exit.test.ts`：全部刪單一律 `refresh:true`，不讀 health／cache。
- 第二輪 review（head `2b8bd09`）修正回歸：訂單分頁更新不吞掉成交跳號、重連 `NoBaseline` 視為重啟、cache 重建
  不刪本地有效委託、無基準時改刪單先權威對帳並重新解析 trade_id、health 退避、`stream.ts` 去重直接測試
  （`stream-order-event.test.ts`）、閃電剩餘量改用共用規則、昨餘提示改為「未確認修正前一律提示」。

## 仍待驗收（不因本 PR 關閉）

- #85：正式成交、Odd／IntradayOdd、部分成交後減量、實際漏報／亂序、快照競爭（Shioaji #232 無 watermark）、
  同商品非零雙帳戶、跨原生視窗與重啟。
- #86：正式期貨改刪單（#235 修正的正式驗證）、部分成交後減量的欄位語意、HTTP settled 與 SSE 的待確認解除（#120 另案）。
- #88：主要是原生多視窗矩陣（mirror ACK 遺失、crash／重啟、關閉後清理）；1.7.6 未改變這些條件，本 PR 只讓小視窗
  的 toast 也受惠於 event_id 去重。
- #75／#113：密集回報用量、App＋SDK 長測、四平台乾淨機器 1.7.6 bootstrap 與 updater 仍待。

## 第三輪：心跳 watchdog 實測（2026-09-23，瀏覽器＋Vite proxy，非原生）

- 環境：本分支 Vite `5194`（`VITE_API_TARGET` 指向隔離 1.7.6 模擬 sidecar `21394`），只以 PID 精確終止／重啟該 sidecar；
  正式 `21322`、dev App `21323`／`5183` 未觸碰。
- 修前行為（coordinator 回報）：只殺 sidecar 時 proxy 下的 EventSource 不會關閉，頁首維持 LIVE、心跳逾時 280 秒以上。
- 修後觀測：07:15:05 終止 sidecar → 頁首維持 LIVE 至 07:16:24 轉 **STALE**，07:16:25 重連失敗為 LOST；委託與持倉顯示
  「待對帳：串流中斷」並說明「逾時沒有心跳，期間可能漏收回報」。07:17:11 重啟 sidecar → 07:17:24 回到 LIVE。
  重連後 App 只呼叫 `trade_cache_health`（2 帳戶，monitor 記為 unknown）與 `subscribe_trade`（2），沒有
  `order/trades` 或 `position_unit`；新實例回報 NotSubscribed，App 重新訂閱且保留「串流中斷」待手動對帳。
- 重連後由另一模擬 client 送出期貨 New／Cover 成交，App 收到回報（持倉新增「資料暫缺」原因，因委託來自他端），
  證明重新訂閱後回報送達。

## 第四輪：重連成本與 watchdog 邊界（2026-09-23，瀏覽器＋Vite proxy，隔離 1.7.6 模擬 sidecar）

- 以 fetch 攔截記錄呼叫來源，只以 PID 精確重啟隔離 sidecar（21394），其他服務未觸碰。
- 修前（`3218421`）一次 STALE 重連：stream/subscribe 114、unsubscribe 51、contracts 130、subscribe_trade 2、
  trade_cache_health 2。
  - 63 筆 subscribe 來自既有的 `resubscribeAll` 重播（本 PR 之前即存在，逐筆但未節流，約 150 ms 送完）。
  - 另 51 組 unsubscribe＋subscribe 全是同一批 key：RECONNECT 的合約刷新造成面板重掛，quote-ownership 在
    release 與非同步 re-retain 之間立即退訂再訂閱。這是 #94 引入的既有行為，本 PR 之前就有；watchdog 會增加重連次數，
    所以會放大影響。
  - contracts 130 筆＝65 檔快取合約 × 2 個 metadata 端點，是 Contract V2 設計的 RECONNECT 全量刷新（SSE 不重播
    contract_event），既有行為，本輪未改。
  - subscribe_trade 在此環境為每帳戶 1 次（2 個已簽署帳戶）。未重現「每帳戶 2 次」；本分支只有重連 health 看到
    NotSubscribed／NoBaseline 時才重新訂閱。
- 修後（本輪）同一情境：stream/subscribe 63、unsubscribe 0、contracts 130、subscribe_trade 2、trade_cache_health 2；
  重播前 5 秒只送 40 筆，其餘 23 筆在下一個 5 秒窗口送出（Shioaji 文件：訂閱 50 次／5 秒）。
