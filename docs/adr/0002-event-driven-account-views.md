# ADR 0002 — 帳戶畫面以回報與行情更新，查詢只做初始化與人工校正

狀態：本次候選版；保護單追蹤 #102 依使用者決定另案。

## 原因與證據

#75 的舊版行為讓主視窗、小視窗與回報 handler 各自呼叫整份帳務查詢，容易形成尖峰。1.7.5 monitoring 的 backend 是上游呼叫觀測，incoming 是 HTTP 請求觀測；不可相加。一次 snapshot 批次含多商品也不等於多次 HTTP。

本機唯讀 monitoring 樣本確認存在持續的 update_status、positions、snapshots 與 scanner 呼叫。樣本未覆蓋完整要求期間，不能從彙總資料反推精確限流峰值，也未證明每日 bytes 額度接近耗盡。原始數字留在本機，不公開貼入 issue。

#57 的 App＋Python SDK 約 20 分鐘斷線與 token refresh 503 是相關症狀。目前沒有證據可把它判定為同一根因；App public/private 未找到固定 20 分鐘重登入，sidecar token 機制不在這兩個 repo 的實作中。

## 決策

- 主視窗持有共享 positions、trades、餘額及保證金快照。已簽署帳戶逐一初始化；小視窗與 Tray 以同 origin BroadcastChannel 鏡像，不各自啟動主頁或帳務輪詢。
- `/order/trades` 執行 `update_status` 是正常校正行為：首次查詢建立委託清單；右側「更新帳戶資料」圖示才再查。操作有 loading/disabled、共用 single-flight、完成後短暫 cooldown，不排隊補查。
- 收到 order/deal 回報不觸發 HTTP 帳務查詢。一般委託由帳戶＋委託身分匹配；成交以 exchange sequence 去重，支援部分成交及成交先於委託。原始報告缺欄位、合約不符、成交量矛盾時保留資料並標示待確認。
- position_unit 股票以 Share 為單位；成交 Common lot 轉股，Odd/IntradayOdd 保留股數。現股 Cash 與可明確判斷 New/Cover/Auto 的期貨成交作本機增量。信用/Netting、組合成交、無法判斷的 hedged Auto 不猜測部位。
- 現價使用非試撮成交 tick；未實現 P&L 在券商基準上加上價差×數量×乘數×方向，報酬率由持倉現價/成本更新。這是估算，不推算權威現金、手續費、稅、保證金或已實現損益。期貨乘數不足不假定為 1。
- 查詢失敗保留相同帳戶既有資料。餘額/保證金標記其來源帳戶，切帳戶時不把另一帳戶的舊值當成新帳戶資料。
- 查詢期間事件、斷線或 journal overflow 不可被晚快照抹掉。委託快照重播已接收的有效事件，成交序號去重；既有持倉基準在有回報競爭時保留即時投影並標示快照邊界不明。首次快照競爭也須明示不完整。
- 上游目前沒有 position snapshot watermark。以客戶端時鐘界定首次基準仍有延遲/時鐘誤差限制，不能當作無漏報或可交易保證。精確邊界需求追蹤 [Shioaji #232](https://github.com/Sinotrade/Shioaji/issues/232)；cache-only Trade HTTP API 不是本次前提。
- 其他報表用依 scope 共用的 session query，首次與手動查詢；資料範圍變更另取快照，純顯示/篩選變更只在本機重算。
- 行情列表先快照再用 SSE Tick/BidAsk/Quote；一般行情訂閱按消費者保留/釋放，由主視窗統一對 sidecar 操作。合約 metadata lookup 不再永久訂閱。既有保護單所依賴的已啟動 Tick 保留至其移除，保護單執行不在本 ADR 更動範圍。
- 歷史圖表只有 fetchKbars 內有限的 transient retry，4xx 停止；外層不得無限重試錯誤或空歷史。顯示重建共用成功/失敗的 history promise，手動更新或交易時段/日期切換才取得新 revision。

## 保留與限制

Grid follow、使用者啟用的組合到價策略、native production 執行前/核准後的權威檢查、Agent 明確要求的 read-only 查核不改為 UI 快取。健康、info、monitor 診斷輪詢是本機觀測，不當成券商會計查詢刪除。

使用者明確將 #102 保護單另案；既有 pending bracket 的 4 秒查詢仍存在，不可宣稱整個 App 所有帳務背景來源已歸零。多 origin、主視窗崩潰與 WebView 非正常結束無 ACK 的鏡像/訂閱清理仍需 native 驗收；不能把 browser fixture 當原生實測。
