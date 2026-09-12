# API 用量與面板盤點 — 未發布候選版

基準 public `95bff4a1135f7ab134de898aed3243b6ebb9485d`；private pin `409c0d1901f4bc81b53e6dd405a0f2615bdd5598`。本次 public-only，不修改 private runtime、release tag 或版本檔。

## 盤點與處置

| 面板／來源 | 原行為 | 本次處置／追蹤 |
| --- | --- | --- |
| 持倉 | 主頁 10 秒、Tray 8 秒、小視窗 20 秒＋jitter | #85/#88 共用首次快照、行情估值、可辨識成交增量；手動校正 |
| 一般委託 | 主頁 8 秒、小視窗 12 秒＋jitter；事件後重查 | #86/#88 共用回報投影、手動 broker 校正；失敗保留 |
| 帳務／交割 | balance/margin 與報表 30/60 秒重查，scope effect 可再查 | #87 首次／手動 scope query，帳戶身分與錯誤明示 |
| 頂欄 | 隱藏時也每 10 秒 snapshots | #89 顯示時首次快照＋SSE |
| 選擇權 T 字 | 每 5 秒可見商品 snapshots | #90 初始快照＋Tick/BidAsk、手動更新、scope 隔離 |
| K 線／分時／分時牆 | 底層重試失敗後外層 15–30 秒無限重試；空歷史也循環 | #91/#92/#93 有限重試、成功/失敗 history cache、手動更新；顯示重建不重新查歷史 |
| 一般行情訂閱 | lookup 永久訂閱；移除/換商品不釋放；多 consumer 重複 | #94 主視窗統一保留/釋放，TickTape/分價量明確持有訂閱，保留舊保護單既有 feed |
| 已實現 P&L | 每 60 秒 S/F 30 日歷史，失敗變空 | #95 依已簽署帳戶查詢，首次／手動、失敗保留 |
| 籌碼 | 每 60 秒三請求，非 STK 仍查，失敗顯正常 | #96 股票才查、首次／手動、處置 unknown、部分錯誤明示 |
| 排行榜／Tray movers | 15/30 秒刷新；multi 本機門檻變更再查三榜 | #97 首次／手動，共用原始榜，門檻本機重算 |
| 個股期 | 每 5 秒最多 40 商品一批快照 | #98 首次＋SSE、手動更新、切標的舊回應隔離 |
| 組合商品列表 | 每 5 秒整個家族快照 | #99 首次＋原生組合訂閱、手動更新 |
| 權證列表 | 每 8 秒最多 60 商品一批快照 | #100 首次＋SSE、手動更新、切標的舊回應隔離 |
| 組合委託 | 每 10 秒 /order/combotrades | #101 首次／手動、明示查詢快照；未宣稱此端點必定執行 update_status |
| 五檔／閃電／報價板／組合腳／深度熱圖 | 首筆 BidAsk 前空白或只有價沒有量 | #105 共用現有 HTTP snapshot，以一檔價量墊底；熱圖只記一個快照觀測點，SSE 接手後空側保持空白 |
| Bracket | 有 pending 時每 4 秒查 S/F trades | #102 使用者決定另案，本次保留；不是已解決項目 |
| Grid／combo 到價 | armed 使用者策略、按差異下單 | 保留執行時機及安全檢查；不以省 quota 改變策略 |
| Watchlist sorting／replay | 本機排序/回放 timer | 保留，不產生券商查詢 |
| Debug／Monitor／ServerManager | health/info/metrics/subscriptions/usage | 本機診斷與既有 visibility gate 保留；不同 metrics sources 不相加 |
| TickTape／分價量／指數成分 | 一次歷史＋事件；指數成分已有 ADR0001 | 保留有界查詢，補 quote lifecycle |
| Native／Agent 工具 | 明確工具呼叫、交易前後權威校驗 | 保留，不以顯示投影替代 native authority |

## 證據與驗證範圍

- 右側更新圖示只查目前分頁：持倉不查委託／資金，委託不查持倉／資金，帳務整合資金與帳務明細更新。回歸測試核對各類端點次數、其他分頁錯誤與時間不變、查詢中回報仍投影持倉，以及缺委託 metadata 時兩個受影響分頁皆標記待對帳。

- 現場 monitoring 唯讀樣本與限制詳見 ADR0002；未觀測到接近每日 bytes 額度，未證明 #57 根因。
- 獨立 review 和 QA 已覆蓋 order/position projection、query single-flight、失敗保留、snapshot/event race、舊事件、overflow、斷線，以及行情與history scope。以合成 wire fixtures/mock 驗證，不宣稱實際 broker 回報重播或真實下單。
- 本機 `pnpm build`（含 `tsc -b`）與 `pnpm test` 通過：37 個檔案通過、1 個跳過；285 tests 通過、2 個跳過。既有 build chunk size / ineffective dynamic import 警告仍存在。
- 隔離 browser QA：Chromium、1360×850、localhost:5191，所有 API/SSE 使用 fixture，代理指向未使用的本機 port。61 秒閒置只初始化 positions/trades 各一次；tick 改變現價與損益不查帳；新增 flash popout 不重查帳；手動 503 保留數據並顯示待對帳。650×850 會被既有桌面 grid 水平裁切，未宣稱窄畫面通過。
- 1.7.5 schema fixture 擷取自現場 `/openapi.json`，只保存 callback schema，沒有帳號或委託資料。測試的回報內容為依 schema 製作的合成案例；這不等於 DEV.md 所要求的實際 broker wire 回報驗收，盤中去識別回報重播仍待補。
- 本機疊入 pinned private commit 後，production build 通過、64 個測試檔／548 tests 通過；官方 plugin contract tests 3/3 通過。未啟動 native runtime。
- 公開 CI 與 Linux/Windows 合成檢查結果記錄於 PR 最終 head；尚未成功的檢查不得當作完成。
- 原生登入、乾淨機器、SDK 與 App 長時間共存的 #57 情境及正式盤中 fill/reconnect 邊界尚未驗收。本次不使用真實下單作測試，無 tag／release。

## #105 初始買賣檔顯示

- `fetchSnapshots` 的原始回應由顯示快取觀測，同商品 consumer 共用進行中的 batch／一次性 query。已有 snapshot 不追加查詢；無定時或 reconnect 補查。快取與 single-flight 為同一 WebView 範圍。
- 主頁、固定商品、小視窗、面板預覽採相同 DepthLadder 路徑；閃電使用相同價量投影，補 snapshot close 作價格梯初始位置。報價板補齊掛量，組合腳與組合簿保留零／負價；明示「快照一檔」，不是完整五檔或新 SSE。
- 深度熱圖只加入當時 L1 的一個觀測點，不填歷史；BidAsk 後才累積五檔。Tick 不重複加入相同委託簿。
- 時間比較使用原始 HTTP snapshot，不使用 watchlist 合成 Tick 後的 datetime；明確空側不從舊快照復活。API base／商品／target alias 隔離，舊 server 晚到回應不寫進新 server 快取。
- display fallback 不寫入原始 stream。組合到價監控、一般下單確認與 #102 保護單路徑不變。實際 sidecar OpenAPI 確認 snapshot 的 buy_price/buy_volume、sell_price/sell_volume 與 datetime 型別；測試內容仍為合成行情。
- 獨立 review 已修正 Tick 錯誤淘汰五檔與冷 cache 組合零負價被過濾；QA 已覆蓋 renderer 真實面板 L1／SSE 切換、來源提示與零下單呼叫。原生／CI 最終結果見 PR #103。
