# 商品搜尋驗收與交接

> 本頁保留較早實作、瀏覽器及夜盤證據，程序、instance 與測試數不代表本輪現況。目前修正、動態 ETF 名稱、效能與 PM 驗收以 [本輪修正驗收](product-search-remediation.md) 為準；舊夜盤結果不能替代新版本的即時行情驗證。

本次修正從官方 `main` 獨立開發，完成搜尋、消費端與交易入口防護。驗收分為真實商品資料、實際瀏覽器畫面及 mock 故障測試；三者證明的範圍不同。

2026-10-17 下午補充驗證發現的中文組字 Enter、目錄恢復與快取邊界均已修補；同時完成 ETF 名稱補齊。該輪受測版為 `4449807439a121d057eb101e5ddb150c144f9b66`，後續期貨排序另依下節規則修正與驗收。基線全綠不等於完整驗證通過，完整證據與保留限制見 [補充驗證](gemini-product-search-results.md) 及 [ETF 名稱交接](etf-search-catalog.md)。

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
- 初始 STK Base 3155 筆，名稱僅借自權證標的時有 2278 筆只剩代碼；`0051/0053/0055` 即在缺漏中。下午新增官方 ETF 快照後，可補齊當時 359 檔 ETF 合約交集，非 ETF 股票的其餘名稱缺漏仍未宣稱解決。
- 1.7.8 OpenAPI 未提供全部 IND 的批次含名稱目錄，單筆 Info 不適合在每次輸入時逐筆擴散請求。

## 實際瀏覽器驗收

| 操作 | 結果 |
| --- | --- |
| 輸入台積電 | 出現 2330、CDFR1、QFFR1 及權證，現股沒有被擠掉 |
| 輸入櫃買／櫃買指數 | 出現 IX0043 |
| 輸入櫃買半導體並選取 | 圖表切換 IX0053／櫃買半導體類指數，指數下單仍被阻擋 |
| 輸入完整臺指選擇權波動率指數 | 出現 TAIWANVIX |
| 輸入 2330選擇權 | 同時出現 CDA 與 CDO |
| 輸入元大中型100 | 出現 0051，標示 ETF |
| 輸入元大科技市值／元大電子 | 出現相同 0053，顯示新名稱 |
| 輸入元大美債20年 | 先列 00679B ETF，再列同標的期貨與權證 |
| 輸入台積電權證並選取 041320 | 圖表與報價保留完整名稱，不誤當 STK |
| 權證選定後加入閃電下單面板 | 顯示「權證不支援快速下單，請使用下單面板」 |
| 開啟診斷 | SSE LIVE，持續收到約 30 秒一次的新心跳 |

夜盤另透過相同 dev origin 的 SSE proxy 觀測 35 秒（04:37:15 至 04:37:50），收到 3 筆 `tick_fop`、52 筆 `bidask_fop` 及 2 次 heartbeat。台指近月實體合約 `TXFJ6` 成交價依序為 46223、46224、46221。瀏覽器 `TXFR1` 報價亦由 04:36:04 的 46222 更新為 04:38:55 的 46210，診斷顯示成交更新 1.6 筆／秒。此證據是模擬登入環境接收的市場行情，不是下單或成交回報驗證；不以 API 訊息時間推算完整端到端延遲。

下午 14:47:19 至 14:47:54，再以同源 SSE 觀測 35 秒：收到 2 次 heartbeat、0 筆 Tick、0 筆 BidAsk。當時為週六休市，此次僅確認連通性，未將快照或心跳當作新成交。當時 21323 與 5194 的 `/info` 仍為 instance `8f729a15f272`，原 21322 保持 `1b5d675788ad`，沒有混接。

## 搜尋排列規則

精確靜態指數直接列出。其他查詢先放成功的直接代碼，再放精確現股／ETF。名稱前綴只有唯一一檔時可關聯主商品，例如「台積」；多檔歧義、非前綴子字串或缺名稱時的純代碼替代值，不任選第一檔。一般名稱查詢採「現股／ETF → 同標的連續期貨 → 權證 → 指數／其他匹配 → 額外實體月份」，不再讓權證穿插期貨。明確選擇權或權證查詢保留原類型優先與多 root 交錯；精確股票仍在前。所有結果依型別、交易所、代碼去重，命令面板最多 8 筆，自選新增最多 10 筆。

期貨月份優先，每月按「一般 → 小型 → 微型」排列。例如台指 `TXFR1 → MXFR1 → TMFR1 → TXFR2 → MXFR2 → TMFR2`，台積電則為 `CDFR1 → QFFR1 → CDFR2 → QFFR2`。此處遠月按現有 `R2` 次月處理。同優先級再按 delivery_month 與代碼。小型／微型以官方名稱識別，不以代碼字母猜規格。台指家族共用 `IX0001` 標的，單次批次查詢取得三規格。

真實來源另有共享 `IX0001` 的週別 `MX4R1`，名稱含 W4，但 1.7.8 的 week_of_month 為空。因此同時識別週別欄位與官方 W4 名稱，將週別排在六筆月合約後，避免擠掉 `TMFR2`；直接查週別代碼仍保留完整合約。

多根期貨來源有界合併後統一排序，並保留完整 contract 與 target_code；若連續合約已指向某實體代碼，該實體不重複列出。其他實體月份在權證後，不占用同標的近次月與權證的主要位置；直接輸入完整實體代碼仍可查詢。

權證按 expiry_date、代碼；股票／ETF 依正規化後的精確名稱／代碼、代碼前綴、名稱前綴、代碼長度類型與名稱長度綜合評分。缺日期標示待確認，不把排序當作可交易性保證。

沒有透過 UI 增刪伺服器自選清單。既有觀察清單含無效的 `101`，導致清單部分讀取失敗，未擅自移除或猜測轉換成 IX0043。這不等於 IX0043 搜尋或 typed 解析失敗。

## 自動化與獨立驗收

2026-10-17（Asia/Taipei）分段搜尋與取消完成後，正式 Vitest 3695 個測試通過、0 失敗、2 個既有跳過，整體 `success=true`、`numFailedTestSuites=0`；產生器 Node test 6 項全過。較最佳化前的 3604 項新增 91 項。`pnpm build` 的 `tsc -b` 與 Vite build 通過。建置保留既有 BigInt 相容性、chunk 大小及 import 警告，不宣稱零警告。

本輪更正先前的整體成功判定：舊 `work/gemini-exam/futures-grouped-vitest.json` 及 `final-vitest.json` 雖然沒有失敗斷言，整體 `success=false`，因為 Vitest 誤收使用 `node:test` 的 ETF 產生器測試，回報 `No test suite found`。補正方式是只在 Vitest 排除該檔，並讓 `pnpm test` 使用 `&&` 接續 Node test，兩者任一失敗都不通過；沒有刪測試或放寬斷言。舊報告原樣保留，不能再引用為整套全綠。

`pnpm test` 執行完整兩套；需加 Vitest 篩選或 JSON reporter 參數時，使用 `pnpm exec vitest run ...`，不要把專屬參數附在整體測試入口後面。本輪 JSON 為 `work/search-efficiency/optimized-vitest.json`，不是只看通過斷言數。原 `verified-vitest.json` 保留為最佳化前已修測試入口的 3604 項歷史證據。

完整差異的 `git diff --check` 有 1 項格式例外：`docs/qa/gemini-product-search-answer-3.json:6` 的原始答案行尾空白，保留原文不改。排除此檔後的完整差異與本輪修改通過；不是全差異零警告。

期貨排序回歸涵蓋反向代碼、不同字長的根商品、近次月三規格、缺 delivery_month、單一規格、唯一名稱前綴與歧義、代碼替代值誤判、週別排除、實體去重及權證分組。相關 4 檔共 84 項通過。台指改按標的查詢後，根商品逾時案例改用通用合成商品，保留原斷言，並另補台指新路徑的逾時重試。沒有改報價訂閱或送出訂單，也未把前一輪 Gemini 作答冒稱成對本次改動的審查。

新增測試涵蓋台／臺、精確及模糊標的、交易所、去重、混合名額、多根商品、完整合約、兩個日期欄位、缺日期標示、共享與有界快取、TTL、跨日／跨 API、來源切換及失敗恢復。

獨立 reviewer 新增 7 項 acceptance 測試。OTC 新增後的重掛載使用 typed IND Info；WRT 新增當下保留完整合約，重載失敗後重試仍保留 WRT 身分，沒有覆寫或重建伺服器清單。這些使用 mock，不能當作真實伺服器寫入的證據。

本機全測最初遇到 3 項既有隔離問題：兩個 Tauri 測試只模擬 native fetch，卻讓全域 fetch 讀到真服務；另一個測試漏清理引擎計時器。只補測試環境隔離，63 項相關測試通過，沒有刪除測試或放寬斷言。

## 搜尋效率複核

以 `d934eed1c198542129115c43bd56ebb73906a92b` 為修改前基線。本輪已實作主商品、期貨、權證分段顯示，以及直查 pending 共用、每位讀者獨立取消與搜尋專用四路 FIFO；沒有增加完成 Info 的 TTL 或無條件並行目錄查詢。合併目錄／normalized 欄位的記憶化仍未實作。

| 驗收 | 本輪結果 |
| --- | --- |
| 精確完整指數名稱 | 「櫃買指數」零來源呼叫，保留 `IX0043/IND/OTC` |
| 名稱／代號一致 | 正式回歸與獨立 QA 確認台積／台積電／2330、ETF 名稱／代號使用同 underlying、保留完整型別／交易所／target_code；歧義不任選標的 |
| 分段與排序 | 假時計的目錄 20 ms、期貨再 40 ms、權證再 1000 ms：改前 1020 ms 才有清單；改後 20 ms 主商品、60 ms 期貨、1020 ms 完整結果，權證快回也不超車 |
| 直查共用 | 3 個同時 `2330` 只解析一次，完成後再次搜尋仍重新讀 Info；失敗／404／逾時不保留 |
| 取消隔離 | 取消第一位讀者不讓共享 source 捕捉其失效 signal；最後一人退出才 abort。換字、組字、關閉、選取、卸載及排隊取消都阻止後續分支 |
| 來源早敗 | Base 先失敗時，composite 在 finally 釋放自己的名稱 reader，不殘留至 1000 ms。共享者不連坐 |
| 有界調度 | 跨搜尋 source 共四個未取消的有效 slot；排隊計入來源截止。roots／衍生結果的成功 LRU 各 16 項，pending 不為容量中止有效讀者，依 deadline／取消回收 |
| 選取與 IME | 商品身分使用型別＋交易所＋代碼，面板命令亦固定身分；只保留明確 keyboard／hover 選取。初始面板不能搶走後來的第一個商品 |

獨立 QA 新增 19 項驗收，共享 helper 24 項，分段消費端 31 項。另有真實 Node fetch 對 ephemeral loopback metadata fixture 的 3 項測試：最後 reader 取消使回應在傳送前關閉、一人取消不切斷共享連線、Base 503 必須等名稱 HTTP 已建立才發出，隨後驗證殘留連線在 500 ms 內關閉，不能靠 1000 ms 自然逾時通過。這不是 Tauri 原生傳輸或 daemon 計算中止的證據。

4 個新增記憶體 mutation（退出不清 reader、不共用 direct、共享 source 錯用第一人 signal、把預設 panel 當明確選取）全由斷言抓到；原始碼未被改寫，baseline 45 項通過。包含撤回清理修正後 HTTP 早退測試失敗的對照。證據為 `optimized-mutation-summary.json`。

### 真實 metadata 前後對照

以 Node client 唯讀呼叫隔離 21323，只允許 GET `/api/v1/data/contracts*`；同一 instance `8f729a15f272`、1.7.8、simulation=true。舊 `d934eed` 僅在 Vite 測試記憶體中替換 `product-search.ts`，其他依賴相同，沒有改 dev 或服務。兩輪各重置 client 模組快取，daemon／作業系統快取不重置。

| 固定情境 | 修改前 | 本輪 |
| --- | --- | --- |
| 台積，client 冷快取 | 首次／完整約 47.00 ms，4 GET | 首次 callback 16.63 ms、完整 45.18 ms，4 GET |
| 2330，關聯快取已暖 | 首次／完整 6.07 ms，2 GET | 首次 callback 3.74 ms、完整 6.50 ms，2 GET |
| 3 個同時 2330 | 6 GET、完整 13.83 ms | 2 GET、完整 9.54 ms |
| 00679B | 首次／完整 12.45 ms，4 GET | 首次 callback 1.40 ms、完整 12.54 ms，4 GET |
| ETF 名稱，已暖快取 | 0 GET | 0 GET，與代號結果一致 |
| 台指，已暖目錄 | 1 GET | 1 GET，六個月別／規格順序正確 |
| 整輪 GET 總數 | 17 | 13 |

這是單次本機查詢序列，不含 UI 的 120／150 ms debounce、React 渲染、原生傳輸或行情延遲；不推論 P95 或 SLA。完整返回並非每例都更快，主要改善是提早可選與減少重複。目錄仍重建及正規化；先前 3155 筆合成資料、500 次 `searchStocks` 比對的 P95 為 0.75 ms，暫不優先重寫。

實際 IAB dev 另驗台積與 2330 同一組 8 筆結果、00679B 與元大美債20年同組、台指六序、自選 `2330` 可看到相關產品，未送新增或下單。自動輸入中文一度受原生 IME 攔截，改以選取全欄後貼上並同輪核對欄位值；不把未完成注音當商品查無。畫面為本機 `outputs/product-search-2330-progressive.png`。

15:38:50 至 15:39:25（Asia/Taipei）的同源 SSE 35 秒觀測有 2 次新心跳、0 Tick／BidAsk；確認相同隔離 instance，週六不當新盤中行情驗收。原 App PID 5820 與原 sidecar PID 31748、隔離 PID 10072 仍存在，未重啟交易服務。

本機證據在 `work/search-efficiency/`：`live-baseline-results.json`、`live-probe-results.json`、`optimized-vitest.json`、`optimized-mutation-summary.json` 及 `current-sse.json`。可用 `node work/search-efficiency/run-live-probe.mjs --baseline`、移除旗標跑新版；此診斷只在已授權隔離服務上執行，不納 CI。正式 91 項回歸在 `src/`，不用 work 才能重現。

重新登入後，指定 Claude Opus 5.5 ultracode 已完成一般正確性、程式寫法／效能與 PR 寫法三輪回覆，本機另完成逐項複核。既有 3695 項回歸仍通過，但新診斷有 6 個預期正確行為斷言失敗，涵蓋取消、catalog 佇列隔離、Enter 與服務切換／分支清理，尚未修改正式程式。另以合成 50 列的測試記憶體原型確認，穩定三個 callback 可讓每階段額外列 render 由 50 次降為 0；這不是瀏覽器耗時或真實報價驗收。原始答案、反例與限制見 [審查與複核](claude-product-search-review.md)。

## 尚未驗證與後續方案

1. 完整名稱目錄：本次 ETF 使用已落地的版本化官方名稱快照，並保留代碼直查。其餘股票／指數與未來新掛牌，仍應由 sidecar 提供含名稱的批次目錄，依服務與商品檔版本快取；不在每次輸入時掃全部 Info。不能宣稱 ETF 未來更名會自動同步。
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
