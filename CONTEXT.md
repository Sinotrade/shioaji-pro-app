# CONTEXT.md — Ubiquitous Language

Shioaji Pro 的詞彙表。只放詞彙定義,不放實作細節。

## 指數成分 (Index Components)

- **建底查詢 (bootstrap query)**: 對 `index_components` 的一次性權威查詢,唯二時機:該指數尚無本地狀態時、日切時。絕不用於定時輪詢、重連恢復或畫面刷新。
- **日切 (day rollover)**: 從串流事件攜帶的交易日欄位偵測到新交易日(資料驅動,不依賴牆上時鐘)。與現貨當日走勢的 session 判定同一哲學。
- **投影 (projection)**: 一條 `(指數, 投影)` 獨立訂閱主題;事件為該投影的整包替換,無增量、無回放。
- **產業全景 (industry panorama)**: 由類股熱力圖面板升級而成的產業地圖面板 — 全景層(treemap)+下鑽層(單一產業詳情)。與市場脈動的分工:市場脈動=誰在動指數(貢獻敘事),產業全景=錢在哪裡、誰強誰弱(地圖)。
- **主力貢獻 (main contributors)**: 單一產業內依 |貢獻點| 排序的前 10 檔成分股(該群組的 AbsDesc10 投影)。
- **餘量 (remainder)**: 群組總值減去已列示成員合計的差額,以「其他」列/磚呈現;一律由已訂閱的群組總值推導,不另外訂閱。

## 交易回報 (Trade Reports)

- **回報識別 (event_id)**: Shioaji 1.7.6 起每筆主動委託／成交回報的不透明字串;同環境完整相同即為同一回報重送。不是委託 ID,也不是成交序號。
- **跳號 (sequence gap)**: 同環境、同 stream、同 reset 的回報序號出現空缺;只代表可能漏收,晚到可補回,不等於確定遺失。
- **權威對帳 (authoritative reconciliation)**: 由券商重建分頁資料的查詢(委託 `refresh:true` 即 update_status、持倉快照);耗帳務額度,只在初始與使用者手動更新時執行。
- **快取重建 (cache resync)**: 以 sidecar 已投影的 Trade cache(`refresh:false`)取代委託畫面;不呼叫券商,只在同一 sidecar 連續且所有帳戶 health 為 Healthy 時使用。
- **待對帳原因 (reconcile reason)**: 分頁需要人工對帳的具體原因(資料暫缺、未知成交、串流中斷、快照邊界、回報跳號、待關聯回報、投影失敗等);動作只解除其確實解決的原因。
- **刪單確認 (cancel confirmation)**: HTTP 刪單後以同帳戶委託回讀判定;只有同 id、同帳戶、Cancelled 且累計取消量涵蓋刪單前剩餘量才算已取消。消失、讀取失敗或逾時都是「已送出未確認」(結果未知),不重送。
