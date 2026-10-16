# 商品搜尋驗收與交接

本次修正從官方 `main` 獨立開發，完成搜尋、消費端與交易入口防護。驗收分為真實商品資料、實際瀏覽器畫面及 mock 故障測試；三者證明的範圍不同。

## 問題與處理範圍

| 問題 | 根因 | 處理 |
| --- | --- | --- |
| 櫃買指數中文找不到，代碼卻可找到 | 靜態指數表缺漏，交易所一律 TSE | 獨立指數搜尋表，每筆保留交易所 |
| 台積電只出現現股 | 未啟用權證，裸名稱不查關聯商品 | 精確名稱／代碼按 underlying 查詢，混合結果配置名額 |
| 同名選擇權只找到一組 | 只取第一個匹配根商品 | 有界多 root 查詢，保留 underlying 過濾 |
| 切換搜尋時誤選上一輪商品 | debounce 期間舊列仍可選 | 輸入當下撤舊列，待決名稱不送出 |
| 來源失敗看起來像空清單 | 全來源連坐或直接吞錯 | 來源隔離，無可用結果時顯示錯誤與重試 |
| 權證進入快速下單被當期貨 | 既有面板非 STK 即採期貨路徑 | App 主視窗與 Popout 共用 WRT 阻擋規則 |

## 環境

- 日期：2026-10-17，Asia/Taipei。
- 工作樹：`C:\Users\How\.codex\worktrees\product-search\Shiaoji pro`。
- 分支：`codex/product-search-related`；base：`be4cbd3073df2625db0d51f767c812a27f79cb8e`。
- Dev：`http://127.0.0.1:5194/`，僅 loopback 綁定。
- REST proxy：`VITE_API_TARGET=http://127.0.0.1:21323`。
- 隔離控制：`VITE_DEV_SERVER_PORT=21323`。
- SSE：`VITE_STREAM_BASE=http://127.0.0.1:5194`，經同源 `/api` proxy 到同一服務。
- 隔離 sidecar：1.7.8，simulation=true，instance `8f729a15f272`，PID 10072。
- 原安裝 App PID 5820、原 sidecar PID 31748／21322，instance `1b5d675788ad`，保留不變；沒有接手、重啟或停止它們。

畫面 build identity 由 Vite 啟動時的 Git HEAD 產生，commit 後須重啟 Vite。`+dirty` 也會計入本機未提交的驗收輸出；不代表正式發版。`pnpm-workspace.yaml` 與 `work/`、`outputs/` 只供本機驗收，不納入 PR。

## 真實商品資料調查

對 21323 執行產品 metadata 唯讀調查，未查詢帳戶或下單。後續瀏覽器啟動會沿用 App 自身的模擬帳務顯示，未操作交易。

- IND Base 共 227 筆，TSE 181、OTC 45、TAIFEX 1；原名稱清單 27 筆。新增名稱搜尋後共 38 筆，仍非完整目錄。
- 逐筆 Info 確認 `IX0043`、`IX0044`、`IX0045`、`IX0048`、`IX0053`、`IX0056`、`IX0058`、`IX0059` 為 OTC，`IX0007/IX0008` 為 TSE，`TAIWANVIX` 為 TAIFEX。
- `underlying_code=2330` 的期貨含 CDF、QFF，近月／次月 alias 保有 target code；台積電選擇權含 CDA、CDO。
- 到期日條件尚會回傳已過最後交易日的權證。以 2026-10-17 查台積電權證，1235 筆中有 8 筆最後交易日為 2026-10-16，因此前端不能只看 expiry_date。
- STK Base 3155 筆，目前名稱借自權證標的清單；2278 筆仍以代碼當名稱。已查到 `0051/0053/0055` 的 Info 有中文名稱，但目前搜尋名稱來源沒有它們。
- 1.7.8 OpenAPI 未提供全部 IND 的批次含名稱目錄，單筆 Info 不適合在每次輸入時逐筆擴散請求。

## 實際瀏覽器驗收

| 操作 | 結果 |
| --- | --- |
| 輸入台積電 | 出現 2330、CDFR1、QFFR1 及權證，現股沒有被擠掉 |
| 輸入櫃買／櫃買指數 | 出現 IX0043 |
| 輸入櫃買半導體並選取 | 圖表切換 IX0053／櫃買半導體類指數，指數下單仍被阻擋 |
| 輸入完整臺指選擇權波動率指數 | 出現 TAIWANVIX |
| 輸入 2330選擇權 | 同時出現 CDA 與 CDO |
| 輸入台積電權證並選取 041320 | 圖表與報價保留完整名稱，不誤當 STK |
| 權證選定後加入閃電下單面板 | 顯示「權證不支援快速下單，請使用下單面板」 |
| 開啟診斷 | SSE LIVE，持續收到約 30 秒一次的新心跳 |

夜盤另透過相同 dev origin 的 SSE proxy 觀測 35 秒（04:37:15 至 04:37:50），收到 3 筆 `tick_fop`、52 筆 `bidask_fop` 及 2 次 heartbeat。台指近月實體合約 `TXFJ6` 成交價依序為 46223、46224、46221。瀏覽器 `TXFR1` 報價亦由 04:36:04 的 46222 更新為 04:38:55 的 46210，診斷顯示成交更新 1.6 筆／秒。此證據是模擬登入環境接收的市場行情，不是下單或成交回報驗證；不以 API 訊息時間推算完整端到端延遲。

沒有透過 UI 增刪伺服器自選清單。既有觀察清單含無效的 `101`，導致清單部分讀取失敗，未擅自移除或猜測轉換成 IX0043。這不等於 IX0043 搜尋或 typed 解析失敗。

## 自動化與獨立驗收

`tsc -b`、Vitest、Vite build、`git diff --check` 均通過。最終 Vitest：3526 通過、0 失敗、2 項既有跳過；跳過項目保留原狀。建置保留既有 BigInt 相容性、chunk 大小及 import 警告，不宣稱零警告。

新增測試涵蓋台／臺、精確及模糊標的、交易所、去重、混合名額、多根商品、完整合約、兩個日期欄位、缺日期標示、共享與有界快取、TTL、跨日／跨 API、來源切換及失敗恢復。

獨立 reviewer 新增 7 項 acceptance 測試。OTC 新增後的重掛載使用 typed IND Info；WRT 新增當下保留完整合約，重載失敗後重試仍保留 WRT 身分，沒有覆寫或重建伺服器清單。這些使用 mock，不能當作真實伺服器寫入的證據。

本機全測最初遇到 3 項既有隔離問題：兩個 Tauri 測試只模擬 native fetch，卻讓全域 fetch 讀到真服務；另一個測試漏清理引擎計時器。只補測試環境隔離，63 項相關測試通過，沒有刪除測試或放寬斷言。

## 尚未驗證與後續方案

1. 完整名稱目錄：優先由 sidecar 提供含 `code/name/security_type/exchange/underlying_code` 的批次搜尋目錄；前端依服務與商品檔版本快取。若無法調整 API，再評估有版本的名稱快照及背景補齊，不在每次輸入時掃全部 Info。完成前保留代碼直查，不宣稱 ETF 中文名稱問題已解決。
2. WRT 冷重載：現行 resolver 的 Base fallback 缺完整名稱、標的及日期。後續需保存可重建的 underlying 身分，或增加可直接取得 WRT Info 的供應路徑，再驗收冷啟動完整 metadata。
3. 原生視窗與乾淨機器：本輪只有瀏覽器 dev 與 mock 驗收，未重建／操作原生 Tauri dev shell、未實開原生 Popout、未測正式登入、未送交易或執行雲端 CI。Remote Desktop Commander 的 How 裝置當時離線。

## 交接操作

開啟 dev 後按 Ctrl+K，依上表輸入查詢。重新啟動請在本工作樹的 PowerShell 設定：

```powershell
$env:VITE_DEV_SERVER_PORT='21323'
$env:VITE_API_TARGET='http://127.0.0.1:21323'
$env:VITE_STREAM_BASE='http://127.0.0.1:5194'
$env:PORT='5194'
pnpm dev -- --strictPort
```

21323 停機時應顯示無法連線，不可改接 21322。工作樹與 dev 保留供使用者檢視；不把金鑰寫入檔案，不提交環境設定，也不推送官方。
