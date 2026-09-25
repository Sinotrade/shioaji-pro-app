# 伺服器啟動與環境切換耗時量測（issue #142）

目的：在 macOS 與 Windows 量測「冷啟動」「重啟」「模擬 → 正式」「正式 → 模擬」
四種情境的各階段耗時，找出慢在 App 端、Shioaji Server 端還是網路。本文件只
說明量測方法；結果表格留給維護者實測後填寫。

## App 記錄了什麼

App 端每次啟動／重啟／停止／切換都會記錄一筆 timing run，從按下按鈕（冷啟動
則從 webview 開始載入頁面）一路到伺服器健康、畫面重新載入，再到前端可用
（帳戶已載入、第一次持倉快照完成、行情串流 LIVE）為止，跨頁面重新載入仍會
接續同一筆。只記錄階段名稱、相對時間、port、模式與輪詢次數，不記錄
API Key、Secret、憑證路徑、密碼或伺服器 log。

| 階段 key | 畫面顯示 | 意義 |
| --- | --- | --- |
| `app-js-start` | App 啟動 | 冷啟動：前端程式開始執行（相對 webview 開始載入，見下方說明） |
| `probe` | 檢查現有伺服器 | 探測已在運行的伺服器、決定可否沿用 |
| `wait-warming` | 等待先前啟動中的伺服器 | 上一次 spawn 可能仍在登入，最多等 20 秒；記錄中的程序已不存在（例如 App 重開）時立即結束，下一個 `probe` 附註 `warming dead` |
| `sweep-orphans` | 搜尋遺留的伺服器 | 掃描備用 port 上的孤兒伺服器；先以 bind 測試找出有人監聽的 port，只對這些 port 發 HTTP 探測 |
| `attach` | 連接既有伺服器 | 沿用健康、模式正確的伺服器；附註 `server still starting` 表示接手仍在登入中的伺服器，之後進入 `wait-health` |
| `stop-agents` | 停止 Agent | 使用者操作前先停止 Agent runtime |
| `kill` | 停止伺服器 | 送出停止指令 |
| `wait-exit` | 等待伺服器結束 | 等舊伺服器不再回應，最多 5 秒 |
| `stopped` | 伺服器已停止 | 舊伺服器已不回應（附輪詢次數） |
| `settle` | 等待連接埠釋放 | 舊版重啟時固定等待 1.2 秒；已移除，改在 `reclaim-port` 只在 port 仍被占用時短暫等待（附註 `port freed after N ms`） |
| `reclaim-port` | 清理連接埠 | 回收殭屍 listener、挑選可用 port |
| `spawn` | 啟動伺服器程序 | 啟動 sidecar 程序（附 port、sim/prod） |
| `wait-listener` | 登入與載入合約（約需 10–30 秒） | sidecar 登入＋合約載入後才開始 listen；App 端無法再細分 |
| `listener-up` | 伺服器已回應 | `/api/v1/info` 第一次回應（附輪詢次數） |
| `wait-health` | 等待健康檢查 | 輪詢 `/api/v1/health` |
| `healthy` | 健康檢查通過 | 第一次健康回應（附輪詢次數） |
| `reload` | 重新載入畫面 | App 重新載入頁面 |
| `page-loaded` | 畫面載入中 | 重新載入後的前端 bootstrap 開始 |
| `boot-checked` | 伺服器確認完成 | 重新載入後 boot 的伺服器檢查結束，之後的時間都屬前端就緒 |
| `stream-connect` | 行情串流連線中 | 建立 SSE 連線的時間點；重新載入進已健康的伺服器時會在 `page-loaded` 之前（提前連線） |
| `stream-error` | 行情串流連線失敗，重試中 | 本頁串流第一次開啟前的連線失敗（附第幾次、下次重試間隔）；前 3 次 250 ms 後重試，之後照原本 1 s→2 s… 退避 |
| `stream-open` | 行情串流已開啟 | 本頁串流第一次開啟（SSE `open`，即畫面轉為 LIVE），附開啟前失敗次數 |
| `stream-heartbeat` | 收到第一個串流心跳 | 伺服器連線時立即送出第一個 heartbeat，之後每 30 秒 |
| `stream-restart` | 行情串流重新連線 | 主動關閉並重連（附 `reason=stale／silent／connect-while-open`）；正常啟動不應出現 |
| `trading-start` | 交易資料開始載入 | 重新載入進已健康伺服器時，頁面一載入就啟動交易資料（帳戶、持倉、委託），與儀表板第一次 render 重疊 |
| `account-read` | 帳務查詢完成 | 只記附註：第一次交易資料讀取的每個請求與耗時（`subscribe`、`S1 positions`、`S1 orders`、`S1 balance`、`F1 margin`…，帳戶只以類型＋順序表示）；判斷持倉慢在券商／sidecar 還是頁面 |
| `app-mounted` | 畫面元件已掛載 | 儀表板第一次 commit 完成（所有面板掛載、effect 已執行） |
| `main-thread` | 主執行緒忙碌統計 | 只記附註：從頁面載入（含儀表板第一次 render）到前端就緒，JS 主執行緒被占用的總時間與最長一次卡住（`busy=…ms maxStall=…ms`）；SSE 開啟或第一個事件在主執行緒忙時無法處理，`stream-live` 會一起變晚 |
| `accounts-loaded` | 帳戶已載入 | 帳戶清單第一次載入完成（附帳戶數） |
| `positions-loaded` | 持倉已載入 | 第一次持倉查詢完成；失敗或需對帳也算完成並註明 |
| `stream-live` | 行情串流已連線 | SSE 串流狀態轉為 LIVE |

冷啟動的起點是 webview 的 `performance.timeOrigin`（頁面開始載入），**不含**
從點開 App 到原生程序啟動、建立 webview 的時間；需要這段時請另以碼錶或 OS
工具量測，填在備註。

所有 `stream-*` 附註都以 `page=…` 開頭，標明是哪一個頁面的連線：冷啟動橫跨
「重新載入前」與「重新載入後」兩個頁面，各有自己的連線；`stream-open` 的
`after=…ms` 是該頁從建立連線到開啟的時間。冷啟動的第一個頁面在確定不會被
重新載入前不建立串流（最多等 30 秒）。

三個前端階段到齊時 run 才結束（順序不固定）；60 秒內未到齊則以 `partial`
結束並列出缺少的階段。

結束狀態：`ok`、`attached`（沿用既有伺服器）、`partial`（伺服器已健康但前端
60 秒內未就緒）、`failed`、`abandoned`（被下一個操作取代、上次 App 結束時仍未
完成，或超過 270 秒沒有結束）。過期或上次 session 留下的 run 沒有真正的結束時間，
診斷會顯示 `no end recorded, last mark +X`，總耗時停在最後一個階段、最後一個
階段不列耗時；這類 run 不要填進結果表。

每行格式為 `+相對時間  該階段耗時  階段 (附註)`。`wait-listener` 的耗時即
Shioaji Server 的登入＋合約載入（加上網路）；其餘階段屬 App 端。

## 取得紀錄

- **複製診斷**：伺服器面板的「複製診斷」或完整設定內「複製診斷資訊」，最後會
  附上 `--- startup timing ---` 區塊（進行中的一筆＋最近 6 筆，最新在前；
  App 保留最近 12 筆，重開 App 後仍在）。
- **Debug log**：每個階段以 `console.info` 輸出一行 `[startup-timing] …`，
  在 webview devtools console 篩選即可，不需開啟 Verbose。dev build 可直接開
  devtools；release build 通常沒有 devtools，請改用「複製診斷」，內容相同
  （每筆 run 的所有階段都保存在 App 內，不依賴 console）。
- 伺服器端的登入／合約細節另看 `~/.shioaji/sjpro-server-<port>.log`（Windows
  為 `%USERPROFILE%\.shioaji\`）。App 以 `RUST_LOG=warn` 啟動，log 只有警告
  以上，無法取得伺服器內部階段時間。

## 量測步驟

前置：記錄 App build identity（面板右上）、OS 與版本、網路（有線／Wi-Fi）、
量測時段（盤中／盤後）。每種情境至少量 3 次，全程不下單。

1. **冷啟動**：確認伺服器面板的「App 啟動時自動啟動伺服器」已開啟、伺服器已停止。完全結束
   App（macOS ⌘Q／Windows 關閉並確認工作列無殘留），再開啟 App。畫面就緒
   後按「複製診斷」，取 `[cold-start]` 那一筆。若伺服器在上次結束後仍存活，
   紀錄會是 `attached`；要量真正冷啟動請先在面板停止伺服器再結束 App。
2. **重啟**：伺服器運行中，於面板按重啟（或在完整設定不改環境按「儲存並
   重啟」）。畫面重新載入完成後複製診斷，取 `[restart]`。
3. **模擬 → 正式**：目前為模擬環境，在完整設定改選正式並「儲存並重啟」。
   完成後複製診斷，取 `[sim-to-prod]`。
4. **正式 → 模擬**：反向操作，取 `[prod-to-sim]`。

每次把整個 run 區塊貼進下方的原始紀錄，再把主要階段的耗時填入表格。

## 結果

單位：秒。「伺服器登入＋合約」＝`wait-listener` 耗時；「停止舊伺服器」＝
`kill` 到 `stopped`（含 `wait-exit`）；「健康檢查」＝`wait-health` 耗時；
「前端就緒」＝`page-loaded`（冷啟動沒有 reload 時為 `app-js-start`）到 run
結束，即帳戶、持倉、行情串流都到齊；結果為 `partial` 時在備註寫缺少的階段。

### macOS

| 情境 | 次 | 總耗時 | 停止舊伺服器 | 伺服器登入＋合約 | 健康檢查 | 前端就緒 | 備註 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 冷啟動 | 1 | | | | | | |
| 冷啟動 | 2 | | | | | | |
| 冷啟動 | 3 | | | | | | |
| 重啟 | 1 | | | | | | |
| 重啟 | 2 | | | | | | |
| 重啟 | 3 | | | | | | |
| 模擬 → 正式 | 1 | | | | | | |
| 模擬 → 正式 | 2 | | | | | | |
| 模擬 → 正式 | 3 | | | | | | |
| 正式 → 模擬 | 1 | | | | | | |
| 正式 → 模擬 | 2 | | | | | | |
| 正式 → 模擬 | 3 | | | | | | |

### Windows

| 情境 | 次 | 總耗時 | 停止舊伺服器 | 伺服器登入＋合約 | 健康檢查 | 前端就緒 | 備註 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 冷啟動 | 1 | | | | | | |
| 冷啟動 | 2 | | | | | | |
| 冷啟動 | 3 | | | | | | |
| 重啟 | 1 | | | | | | |
| 重啟 | 2 | | | | | | |
| 重啟 | 3 | | | | | | |
| 模擬 → 正式 | 1 | | | | | | |
| 模擬 → 正式 | 2 | | | | | | |
| 模擬 → 正式 | 3 | | | | | | |
| 正式 → 模擬 | 1 | | | | | | |
| 正式 → 模擬 | 2 | | | | | | |
| 正式 → 模擬 | 3 | | | | | | |

### 原始紀錄

（貼上各次「複製診斷」的 startup timing 區塊，移除其他段落中不需要的內容。）

## 判讀提示

- `wait-listener` 佔大多數：瓶頸在 Shioaji Server 登入／合約載入或網路，
  需在伺服器端另行量測，App 端無法再縮短。
- `wait-warming` 接近 20 秒：前一次 spawn 未存活，重啟被白等；是 App 端
  可改善項目。
- `wait-exit` 接近 5 秒：舊伺服器未及時結束。
- 舊版紀錄的 `settle` 固定 1.2 秒；新版已移除。重新載入後舊版的 `probe` 耗時包含整段前端 bootstrap，新版以 `boot-checked` 分開。
- 冷啟動 `app-js-start` 偏大：webview／前端載入慢，與伺服器無關。
- 前端就緒偏長：先看 `main-thread` 附註。`busy` 接近 `stream-live` 的耗時，代表時間花在畫面 render（主執行緒忙），不是串流連線慢；再比對 `app-mounted` 的時間點。看三個前端階段哪個最晚；`positions-loaded` 最晚通常是帳務
  查詢，`stream-live` 最晚是 SSE 連線。
- 開機時接手「仍在登入中的伺服器」：與全新啟動一樣以快速健康輪詢等待
  （上限 90 秒）；超過後改由開機 watchdog 每 4 秒檢查、不設上限，此時 run
  已記為 `failed`，之後的 reload 不會再計入。
- 量不到的部分：App 無法看到 sidecar 內部的登入、CA 啟用、合約下載等細項
  （全部落在 `wait-listener`），也看不到「畫面各面板第一次畫完」的時間；
  需要時另開 issue 在伺服器端或個別面板量測。
