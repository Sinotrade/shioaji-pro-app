# Debug 用量與 Monitor

Shioaji 1.7.5 的 Debug 首屏回答「流量是否還有餘額、請求集中在哪裡、
現有證據是否足夠」。依安裝版 skill 的 OBSERVABILITY／TROUBLESHOOTING
與實際 `/openapi.json`、唯讀 payload 實作；不靠增加請求觸發限流驗證。

| 區塊 | 資料與判讀 |
| --- | --- |
| 每日流量 | `/auth/usage` 的 bytes、limit_bytes、remaining_bytes；80% 是 App 提醒門檻，耗盡另標示；未知／零上限不算百分比。 |
| 連線 | API 回報 connections；旁列 skill 每人身分證 5 條限制，不能由 SSE／訂閱數推估。每日登入 1,000 次僅列限制，目前累計未知。 |
| 查詢壓力 | backend、origin=all、window=5m，data／portfolio／order 分開請求；顯示完整連續 5／10 秒的完成量與尖峰。 |
| 限制參考 | 行情 50/5s、帳務 25/5s、委託 250/10s。監控分類含 scanner／paper／狀態查詢，完成時間不同於送出時間，不換算券商剩餘次數，不宣稱未限流。 |
| 熱點 | 全類別 endpoint 依錯誤、次數排序；來源分列，P95 只展示各端點微秒轉毫秒，不能相加／平均。in_flight 永遠標示現在。 |
| 完整性 | 檢查 coverage、停錄、dropped、history_incomplete、partial 秒桶及 persistence_error。缺秒不補零，未完全覆蓋短窗顯示未知。 |
| 訂閱 | 使用全域 market_data／trade_accounts／by_type；items 只是分頁，partial／unavailable 有明確提示。 |

Monitor 的 outcome 沒有錯誤詳情，不能以 errors、timeout 或單獨 503
宣稱已限流。只有 API 明確回報暫時 ban 訊息才適用停止重試至少一分鐘的
處理；版本拒絕須分開判斷。歷史行情空值可能與額度有關，即時訂閱不消耗
此流量；SSE 心跳、資料收取與額度是不同的診斷證據。

監控 GET 標記 `X-Shioaji-Activity: dashboard`，10 秒更新本機統計、
30 秒訂閱、60 秒券商用量；每一路循序讀取，10 秒 timeout，隱藏／暫停／
卸載取消自己的讀取。恢復先清除舊狀態再取新值，失敗不展示成功零值。
不自動變更 capture 設定，也不建立 stream session。官方 Dashboard
展開後才掛載，帶同一 backend/all/5m 範圍；僅 owned loopback 可嵌入，
循序重驗 ownership，隱藏／暫停／收合卸載。收集 session 由官方 UI
管理，失敗清理依 15 秒到期收斂，不影響交易行情訂閱。

App／Token 等 runtime 明細與最近委託事件改為折疊，避免淹沒用量診斷。
心跳依 1.7.5 的 30 秒週期顯示，超過兩個週期才提醒；App 成交 Tick 更新不含
試撮／指數 Quote／五檔，可能包含連續月映射，不當作網路收包數；不能拿零更新
判斷所有行情中斷。
真正超限、四平台原生 UI 與乾淨機器仍是獨立 QA 範圍；fixture 與 CI
不能代替券商／原生驗收。
