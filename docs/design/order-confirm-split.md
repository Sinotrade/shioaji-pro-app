# 手動確認與 Agent 核可

本次 1.7.5 candidate 更新 #51：維護者明確選擇正式環境也提供 Auto。
前提是使用者授權，不從既有模擬或持久設定恢復正式交易權限。

## 人工交易

`RiskSettings.confirmManualOrders` 保持獨立。手動票券、點價、平倉使用
既有可視化確認；系統停損／停利與 bracket 不增加互動視窗。
人工 HTTP body 仍由 native proxy 簽送，不授予 Agent capability。

## Agent 語意交易

- 模擬 confirm／auto 保留既有流程與風控。
- 正式 native runtime 必須驗證 App-owned sidecar generation、enabled
  Harness 與 `bootstrap=one_shot_ipc`，不可降級為 environment secret。
- 正式 `place_order`／`cancel_order` 綁定原生保存的工具呼叫、runtime、
  operation 與參數。合約由 native 查詢，連續月轉實際 target；帳戶由
  sidecar 重新確認。一次 call ID 僅消耗一次，保留原 body bytes 簽送。
- confirm 每筆開獨立 `agent-approval` 視窗，內容由 Rust retained state
  提供；主 WebView 不能呼叫 pending/respond。核可來源由 window label
  與 native-created marker 驗證。
- Auto 首筆顯示原生授權視窗，明確說明會送出該筆與允許後續同一 runtime、
  generation、帳戶的風控通過交易。帳戶、環境、runtime、renderer lifecycle
  改變即失效。風控是可信 App 的 TypeScript policy，並非 native 完整風控引擎。
- 送出前再確認 call、runtime、generation、帳戶／委託與撤權 epoch。
  拒絕、關窗、重新載入與到期在送出前回 `mutationNotStarted`。
- 送出後中斷或無法保存結果屬於 unknown outcome，走既有 durable
  idempotency／reconciliation；不自動重送。

## 視窗

第一級呈現環境、操作、商品、方向、價格、數量、遮罩帳戶、runtime
與剩餘時間。Auto 額外顯示此次授權範圍。exact payload 留在技術詳情。
倒數使用 Rust 回傳的剩餘 TTL；到期停用核准，最終有效性仍由 native 判斷。

`approval.html` 是獨立 Vite entry，不載入主 App bundle。重新載入核可
頁會拒絕待處理請求；不存在沿用舊頁面授權的路徑。

原生 CLI grant/exchange 仍拒絕正式環境。本版不提供 raw shell/CLI 的
正式 Auto，也不讓 provider 取得 broker signing secret 或可重用 token。
