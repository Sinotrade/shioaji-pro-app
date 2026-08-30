# 下單確認分離 — 手動 UI 確認 vs Agent 核可

維護者決定（2026-08-30，PR #50 review）：

> Release boundary: the confirmation UI is implemented for the future
> production contract, but Phase 1 native Agent runtimes are simulation-only.
> Production startup fails closed until the sidecar accepts its signing secret
> through one-shot pipe/native IPC instead of a reusable process environment.

1. 手動下單確認與 Agent 下單核准是**兩條獨立路徑**。手動確認可由
   使用者開關；Phase 1 正式環境的 Agent 核准固定逐筆啟用。
2. 使用者看到的確認一律是**可視化委託確認**（方向/商品/價格/數量/帳戶），
   不是 raw payload＋digest 的技術框。
3. Agent 發起、需使用者核可的下單同理 — 第一級友善介面，
   技術細節（exact payload、BLAKE3）收進 detail 展開。

## 現況（本設計要改掉的）

Harness 開啟＋正式環境時，`agent_harness_post` 對**每筆 UI 手動下單**
彈 native NSAlert（title＋raw JSON＋digest）；Agent 交易 grant
（`confirm_production_grant`）也是同款技術框。兩者共用同一條路、
不可分別控制、皆非可視化。

## 設計

### A. 手動下單確認（public，風控設定）

- `RiskSettings.confirmManualOrders: boolean`，預設 `false`（維持現行
  快速流）。設定 → 風控 分頁新增開關。
- 新元件 `order-confirm-dialog`：promise 服務
  `requestOrderConfirm(summary): Promise<boolean>`＋App 掛載的 host。
  內容：方向（買/賣、紅綠）、商品碼＋名稱、價格（限價值或「市價」）、
  數量＋單位、委託條件、帳戶（遮罩）、環境 badge（正式/模擬）。
  Esc＝取消（走 `useEscClose`，不誤武裝 Esc-Esc 刪單）、確認鈕送出。
- 攔截點＝**手動**下單路徑：
  - `placeQuickOrder` 新增 `source: 'manual' | 'auto'`；
    trigger-engine（停損/停利觸發）與 bracket 傳 `'auto'` **絕不彈窗**
    （自動單觸發時使用者可能不在場，彈窗＝錯過行情）。
  - flash-order／candle-chart 點價／bottom-dock 平倉 → `'manual'`。
  - order-ticket／grid-ticket 直呼 `placeStock/FuturesOrder` 前自行
    `requestOrderConfirm`。
- 純 UX 安全帶，**不是**安全邊界（WebView 內的確認擋不了被汙染的
  WebView）— 威脅模型見 C。

### B. `agent_harness_post` 移除逐筆 native 確認（private）

- 刪除 UI mutation 代理路徑上的 `confirm_native_action` 與 4 KiB
  顯示限制（保留 64 KiB 純健全性上限，與對話框無關）。
- 語意修正：UI capability 簽章證明「請求來自本 App 的 WebView」，
  **不再**隱含逐筆人工核可。逐筆確認由 A 的 UX 開關提供。
- `docs/AGENT_HARNESS_THREAT_MODEL.md` 同步改寫該假設；
  被汙染 WebView 經簽章代理下單的暴露面回到與無 harness 時
  （WebView 直發 HTTP）等價 — harness 的職責是管 **Agent** 權限。

### C. Agent 核可視窗（private＋public approval 頁）

- `confirm_production_grant` 的 NSAlert 換成**獨立 Tauri 視窗**
  （label `agent-approval`，always-on-top，載入 `approval.html`）。
  獨立視窗＝主 WebView 無法 script／偽造其內容 — 信任邊界保留。
- 第一級（可視化）：操作種類（下單→方向/商品/數量/價格；非交易
  操作→操作名）、發起 runtime、帳戶（遮罩）、環境 badge、TTL 倒數。
- 「技術細節」展開：runtime_id/pid、operation、raw payload
  pretty JSON、ttl_ms。
- IPC：`agent_approval_pending()`／`agent_approval_respond(id, approved)`
  — **兩者皆驗 `window.label() == "agent-approval"`**，主 WebView 呼叫
  一律拒絕。Rust 端 oneshot 佇列；關窗＝拒絕；TTL 到期＝拒絕。
- **Phase 1 正式環境固定逐筆核可**：舊版即使留下 disabled 設定，App
  啟動也會忽略並恢復 fail-closed；native command 拒絕關閉。模擬環境
  的 controlled-auto 只在當次 session 生效，不跨 App restart 復權。

### 建置

- `approval.html` 為 vite 第二進入點（MPA input），
  `src/approval/` 內自足小頁（不載主 app bundle）。
- Tauri prod 載 dist 內 `approval.html`；dev 載 devUrl 同路徑。

## 不變式

- 自動單（trigger-engine/bracket）不受 A 影響。
- 模擬環境不彈 Agent 核可（現行為）。
- 手動確認關閉時，手動單不彈窗；正式環境 Agent 單仍必須逐筆核可。
- 核可視窗內容來源只能是 Rust state，絕不接受主 WebView 供給的顯示值。
