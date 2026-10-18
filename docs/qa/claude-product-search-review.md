# Claude 商品搜尋審查與複核

> 歷史審查紀錄：以下反例與「未修正」均描述 `4203ad5` 的受測狀態，原始答案保留不改。使用者之後已授權全數修正及動態 ETF 名稱；目前實作與逐項驗收改見 [本輪修正驗收](product-search-remediation.md)。不要以本頁的舊測試數、程序或下一步判斷目前版本。

2026-10-17 的一般正確性審查、程式寫法／效能聚焦審查及 PR 寫法建議，均已由指定的 Claude Opus 5.5 ultracode 回覆並完成本機複核。已重現取消、佇列隔離與 Enter 互動的缺口，另有服務切換後的舊列與分支清理風險。正式程式尚未修改，PR 維持本機草稿，不代表可合併或發布。

## 執行身分與範圍

- 實作 HEAD：`4203ad559b721e48301b30459c27d06864354adf`。一般審查包含 16 份白名單原始碼／測試、相對 `d934eed` 的最佳化差異與公開 metadata 量測，不是官方基準以來所有變更的完整審查。
- Claude Code：`2.1.302`，明確指定 `--model claude-opus-5-5 --effort ultracode`。唯讀 plan／restricted 模式，工具限 Read／Glob／Grep，停用 hooks、外部 MCP、Chrome 與 session persistence。
- 使用者重新登入後，預檢有實際 `claude-opus-5-5` model usage，exit 0、`is_error=false`，回覆 `PREFLIGHT_OK`。舊 OAuth 失敗證據保存在 `work/claude-review/auth-expired-*`，不是目前的阻擋。
- 三輪皆 exit 0、`is_error=false`，model usage 為 `claude-opus-5-5`。一般審查與 PR 建議的工具呼叫均為 0；聚焦審查只呼叫一次 `Glob({pattern: '**/*'})` 列出隔離審查資料夾，未開啟其他檔案內容。沒有以其他 agent 冒充指定模型，也沒有宣稱 Claude 執行測試。
- 一般題包 420180 bytes，SHA-256：`671c3c1c80dce5e65dd6355102755a1dc4813908a34652ec1468bc98ae00aede`。題包僅含白名單程式與公開商品 metadata，沒有環境設定、憑證、帳戶資料或應用程式紀錄。
- 聚焦題包為 5 份核心程式、最佳化差異與量測，150996 bytes，SHA-256：`705b522f26992cbe2fbc2e7db1e901a6174aa8dfa210648dc660f5b4ac2102ef`；未提供第一輪答案，兩輪獨立作答。
- [一般審查原始答案](claude-product-search-answer.txt)、[程式寫法與效能原始答案](claude-product-search-quality-answer.txt)及 [PR 寫法原始答案](claude-product-search-pr-answer.txt)保留不改。完整原始 JSONL、metadata 與題包 manifest 留在本機 `work/claude-review/`。PR 原稿產生時審查仍在途，目前草稿已按完成結果更正狀態。

## 審查標準

1. 顯示正確：名稱與代號關聯一致，保留型別、交易所、target metadata、歧義及日期規則；月份先、一般／小型／微型後，權證不插隊。
2. 互動安全：明確選取、中文組字、換字、關閉、卸載、舊提交及晚回均不污染新查詢。
3. 程式寫法：責任邊界、重複邏輯、抽象成本、命名、狀態轉移、錯誤處理及 cleanup 歸屬可維護，不因縮短程式而弱化保障。
4. 效能：首批與完整結果時間分開，檢查請求去重、取消、排隊、CPU／配置負擔、快取容量及重複發布；不把 client 中止當成 daemon 已停止作業。
5. 證據：提出具體程式位置、反例、收益與風險，區分確認問題、條件式風險及待量測方案。

## 一般審查發現與本機處置

Claude 原始結論為「沒有確認的 blocker」，但仍提出下列問題；這不等於所有發現已處理或可合併。處置欄是本機複核結果，不直接沿用模型的嚴重度。

| 項目 | 本機結果 | Root Cause | Suggested Fix 與處置 |
| --- | --- | --- | --- |
| F1 服務切換後舊 partial 仍可選 | 兩個 UI 的單元路徑均重現，實際跨服務影響仍屬條件式風險 | 核心 `assertScope` 拒絕舊服務結果，UI 的 catch 卻一律保留先前列 | 區分 scope 失效與普通後段錯誤，失效列清除並在選取時核對 scope；普通後段錯誤仍保留有效 partial。未修正 |
| F2 同 signal 取消仍啟動自己的排隊來源 | 已重現，需處置 | 首個 abort listener 釋放 slot 時同步 drain，其他 reader 的 abort listener 尚未執行，queued load 被呼叫 1 次 | reader 保留 signal，來源啟動前排除已取消讀者；仍有有效共享讀者時必須繼續。不宜直接改成全域延後 drain 而破壞既有同步釋放契約。未修正 |
| F3 非搜尋目錄在 HTTP 發出前逾時 | 已重現，需決定隔離策略 | `stock-index.ts` 的共用 catalog 也使用四路佇列，1000 ms 含排隊；四筆 1200 ms 工作占滿 slot 時，catalog 尚未啟動便失敗 | 明確決定共用 catalog 的排隊與截止政策，避免搜尋流量讓其他商品面板失去目錄；不能只增加 TTL 掩蓋冷載問題。未修正 |
| QF2 致命 scope 拒絕後未清除另一分支 | 已重現，有截止上限，不是無限期洩漏 | `Promise.all` 的一個分支因 scope 改變而 reject，另一分支的本輪 reader 仍掛在未取消的 consumer signal 上 | 每輪搜尋有自己的 lifecycle，完成或致命錯誤時釋放本輪讀者；仍有效的其他共享消費者不能被取消。未修正 |
| F4a 自選名稱 Enter 清掉 partial | 已重現，需處置 | `onKeyDown` 先清單，`submit` 隨後因名稱查詢仍在補齊而 return | 清除動作放在真正提交的 guard 之後；`submit` 本來已有清單處理，不必新增另一套狀態。未修正 |
| F4b partial 跳轉失敗後停止補齊 | 行為已觀察，列為 UX 決策，不直接升為必修缺陷 | 選取會按需求取消搜尋；跳轉失敗只顯示商品錯誤，沒有恢復背景搜尋或提供搜尋重試 | 決定失敗後提供重試或重啟補齊，保留舊提交不得覆蓋新輸入的保護。未變更 |
| F5 版面變動合成 hover | 未驗證，不列已確認缺陷 | 需確認 WebView2／WKWebView 是否因新列移到游標下而觸發 `onMouseEnter` | 原生實測後再決定是否改用實際滑鼠移動事件，不能用 React mock 證明瀏覽器行為 |

位置：F1 為 `command-palette.tsx:94–100`、`watchlist.tsx:366–372`；F2 為 `search-request.ts:122–152,197–204`；F3 為 `stock-index.ts:27–29,58–71`；F4a 為 `watchlist.tsx:807–810` 與 `485`；F4b 為 `command-palette.tsx:155–165`。

F1 的現有呼叫鏈包含 `boot.ts` 與 `server-actions.ts` 的 reload／重新驗證流程，因此不宣稱已實證原生跨服務污染或錯誤下單。F3 不能以 `loadStockIndex` 的函式定義當成熱圖實際呼叫證據；目前找到的非搜尋 catalog 消費端是 `StockFuturesPanel`、`UnderlyingPicker` 與 `WarrantPanel`。

QF2 位置為 `product-search.ts:299–306`：一個來源回覆時發現 scope 改變，整輪已 reject，另一來源的 signal 仍未中止；它仍受自己的 1200 ms 截止約束。這不是 daemon 已停止或實際 HTTP 一定持續送出的證據。

聚焦審查對 F1 建議所有 catch 都清空；一般審查則建議區分錯誤。實際核心對普通來源失敗會 fallback 並 resolve 可用結果，UI 測試直接 mock「推出 partial 後普通 reject」不能當作核心實際契約。應先釐清 reject 的語意，再選擇清空致命錯誤結果或使用明確 scope 標記，不為通過 mock 而保留失效列，也不直接增加一套錯誤狀態。

## 反例與回歸基線

- 本輪重新執行完整 Vitest：3695 項通過、0 項失敗、2 項既有略過，`success=true`；ETF 產生器 Node test 6 項通過；TypeScript `tsc -b` 與 Vite build 通過，既有警告仍在。
- 針對性基線 88 項通過：UI 31、獨立 acceptance 19、分段核心 11、共享 helper 24、loopback HTTP 3。另有 transport forwarding 3 項，因此新增六個正式測試檔共 91 項，不是僅以舊失敗 suite 的總數相減。
- 診斷 runner 只在 Vite 記憶體中對三個測試模組加入反例，沒有修改正式程式或追蹤中的測試。F1 兩個 UI、F2、F3、F4a、QF2 共 6 個預期正確行為斷言失敗，均為 assertion failure；F4b 現況與 50 列重繪觀察共 2 項通過。診斷 runner 自身 exit 0 表示反例結果符合預期，不表示這 6 個斷言揭露的缺口已修好。
- 本機證據：`work/claude-review/full-baseline-vitest.json`、`reviewer-baseline-vitest.json`、`finding-probes-vitest.json`、`finding-probes-summary.json`。重現指令：`node work/claude-review/run-finding-probes.mjs`。
- 本輪沒有重新操作瀏覽器、原生 App、伺服器或行情訂閱，未下單或寫入伺服器自選清單。既有 dev 的畫面與 SSE 驗收仍依原先時間／版本記錄，不冒稱新一輪原生驗收。

## 效能建議的證據界線

已觀察的改善是 callback 提早與重複請求去重：本機單次「台積」首批 47.00 → 16.63 ms；三次同時 `2330` 直查 6 → 2 GET。固定整輪 17 → 13 GET 的四筆減量就是同一個去重案例，不能當作額外四筆收益重複計算。完整結果並非全面變快，也沒有瀏覽器渲染、原生 HTTP、盤中行情或百分位的證據。

原答案把 phase 1 至 final 的約 28.5 ms 歸入權證長尾，這個時間包含並行來源與排程，不能當作權證 HTTP 或排序的獨立耗時；熱路徑約 2.7 ms 的 phase 間隔也不能直接歸因於權證排序。快取處理後前 8 筆、預存正規化欄位與抑制重複發布，均須以分段計時／React profile 補證後決定。增加預熱請求、延遲最後讀者取消或縮短 debounce，都有流量或契約取捨，本輪不直接採用。

### 已驗證的重繪原型

聚焦審查指出 `WatchRow` 的 memo 被三個不穩定 callback（拖曳開始、拖入目標、drop）抵銷。本機以固定 items／props、mock quote 的合成 50 列 React test renderer 驗證：主商品、期貨及 final 的每次更新，都呼叫 50 次列 render。

僅在隔離 Vitest 的模組記憶體中，將這三個 callback 改為正確依賴的 `useCallback` 後，同一個測試的每階段額外列 render 為 0。沒有改磁碟正式程式、追蹤中的測試或 dev，也沒有把剩餘缺口當成已修正。

| 同一合成測試 | 原始實作 | 記憶體原型 |
| --- | --- | --- |
| 主商品 phase 的額外列 render | 50 | 0 |
| 期貨 phase 的額外列 render | 50 | 0 |
| final 的額外列 render | 50 | 0 |

這是 render 次數，不是瀏覽器 paint 耗時或真實行情延遲。正式採用前仍需驗證拖放／排序依賴、選取及 quote store 自主更新，不能為減少重繪阻擋新報價。證據為 `stable-row-prototype-summary.json`、`stable-row-prototype-vitest.json`；指令：`node work/claude-review/run-finding-probes.mjs --stable-row-callbacks`。

## 程式寫法建議的處置

| 建議 | 判斷與下一步 |
| --- | --- |
| 共用分段／最終結果的 head 組裝 | 目前兩者等價，不列既有排序錯誤；下次改排序時可抽小函式，並以每次 update 都是 final 前綴的性質測試保護 |
| 抽共用 `useProductSearch` | 兩入口的 debounce、limit、open 與選取本來有不同需求；重複的取消／錯誤處理確有維護成本，但先修具體生命週期問題，不為此全面重構 |
| 統一 suggestion 身分鍵 | 可減少未來分歧，未發現目前的合法商品鍵衝突，不列必修 |
| 移除外層 deadline | 不直接採用。外層還負責 composite 取消與早敗清理，已有 mutation／HTTP 反例；若改佇列政策，應一起核對內外截止及 lifecycle |
| 匯出 queue snapshot／clear 供測試 | 聚焦題包未提供測試，不能據此判定缺測試；既有 24 項 helper 已檢查 timer 清零及四路行為，不為觀測新增正式 API |
| 相同身分就略過 publish | 只比身分會漏同碼名稱、detail 或完整 metadata 的變動；應先比內容並量測，不犧牲顯示正確性 |
| 暖快取或失敗退避 | 先量測連續輸入與來源失敗，不延長 direct Info 快取，也不默默違反最後讀者立即取消的契約 |

## PR 寫法建議的複核

- Claude 建議一個整合 PR 並附審查順序；這是審查與驗證成本的取捨，不是技術上不能拆。新增的 signal／onUpdate 都是可選參數，不能宣稱拆開一定需要另寫過渡 API。
- 權證下單防護必須先於或同時合併搜尋開放，不能反過來；防護先行的拆分仍是可行方向。指數表修正也具獨立性，但本輪未拆分或重排 commit。
- 不採納刪除「新增 91 項」的理由：六個新增檔案的實際通過數為 31＋19＋11＋24＋3＋3。舊 suite 整體失敗的更正仍保留，不能稱舊基線全綠。
- 三個並行查詢的結果相同有 `work/search-efficiency/live-probe.cases.ts:47` 的斷言，不只靠 JSON 是否重複輸出 codes；PR 可引用該測試，但不把它擴張成所有查詢／傳輸的保證。
- 原始模型答案、QA 歷史與既有檔案均保留，不因模型建議而刪除；目前 PR 草稿的 OAuth 舊狀態已更正。

## 下一步行動

由使用者決定已確認項與重繪原型的實作範圍。本輪只審查、重現與整理草稿；對確認項修正或明確記錄不修理由後，再重跑受影響回歸、完整測試及 build，程式變更後依 DEV.md 更新並操作 dev。不推送、不建立 GitHub PR、不合併或發布。
