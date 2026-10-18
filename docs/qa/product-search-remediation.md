# 商品搜尋修正與動態名稱驗收

> 本頁為早期 a20 驗收歷史，以下「最終」及「未修」均屬當時狀態。最新 86 檔版本、後續修正、效能裁決及未通過項目以 [商品搜尋擴充驗收](product-search-expanded-acceptance.md) 為準；不把歷史紀錄改寫成現在的測試結果。

本頁記錄 `4203ad5` 後的修正，承接 [原 Claude 審查](claude-product-search-review.md)，不覆寫原始答案或把歷史測試當成新證據。最後 67 份來源、本機全套、窄版名稱優先與快速縮放已重驗；隔離手勢屬前一版證據。AGY Gemini 完成兩輪歷史靜態審查，Opus 已完成五輪聚焦審查，接受最終 a20 為 LOCAL DRAFT/DEV；既有正式發布限制保留。

## 範圍與基準

- 日期：2026-10-17，Asia/Taipei。
- 工作樹：`C:/Users/How/.codex/worktrees/product-search/Shiaoji pro`。
- 分支：`codex/product-search-related`，HEAD `4203ad559b721e48301b30459c27d06864354adf`；本輪尚未提交。
- 官方固定 diff 基準：`be4cbd3073df2625db0d51f767c812a27f79cb8e`，不是本輪重新 fetch 的最新狀態。
- 僅本機；不 push、不建立 GitHub PR、不 merge、不發版、不下單、不寫伺服器自選清單。

## 確認問題的處置

| 原項目 | 原因與正式修正 | 回歸證據 |
| --- | --- | --- |
| F1 舊 partial 可選 | 致命 reject 撤列；兩入口訂閱身分與名稱版本；選取當下再次核對 scope，擋下 React 更新前的舊 handler | `product-search-progressive.test.tsx`、`product-search-freshness.test.ts` |
| F2 同 signal 取消誤發 queued load | reader 保留 signal，真正啟動前剔除已取消讀者；其他有效共享讀者仍繼續 | `search-request.test.ts`，含同步 drain、共享及 timer 清理 |
| F3 非搜尋目錄被搜尋佇列餓死 | 有界共享 STK／IND 目錄改用獨立 queue:none，仍有 deadline／TTL／LRU／取消；搜尋維持四路 FIFO | `product-search-progressive-acceptance.test.ts`、`stock-catalog.test.ts`、`index-catalog.test.ts` |
| QF2 致命分支拒絕未清理 sibling | 搜尋 owns 獨立 controller，finally 釋放本輪 reader；IND 致命失效立即中止本輪，不等其他分支逾時 | `product-search-progressive-acceptance.test.ts`、`product-search-resilience.test.ts` |
| F4a 名稱 pending Enter 清空 | 真正提交 guard 前不清列；擋下提交時保留有效 partial | `product-search-progressive.test.tsx` |
| F4b 跳轉失敗無恢復入口 | 明確重新搜尋，清理舊列、補齊新結果；舊提交不能關閉後來查詢 | `product-search-progressive.test.tsx` |
| F5 版面插列合成 hover | 改 mousemove 並比對座標；靜止游標的合成事件不得覆蓋鍵盤選取 | React 回歸已通過；實際 WebView／瀏覽器行為仍待驗 |
| WatchRow memo 失效 | 三個拖放 callback 穩定化，保留正確依賴、ref 與拖放契約 | 50 列每個搜尋 phase 額外 render 0；指定 quote 更新與選取／排序／拖放回歸 |

原一般審查與聚焦審查對 catch 的建議不同；正式核心普通來源失敗會 resolve 可用 partial，只有致命 reject 才撤列。沒有為迎合錯誤 mock 而保留失效商品。未刪既有測試，也未改報價 store 的新資料通知。

## 清晰的資料責任

1. `product-catalog-version.ts`：只管理 API／台灣日切／TW 商品異動身分 epoch，不反向依賴 stream。`stream.ts` 單向橋接 Base／Info 事件；listener 失敗隔離並留診斷。
2. `etf-catalog-normalizer.mjs`：runtime 與產生器共用純正規化及驗證。`etf-runtime-catalog.ts` owns 來源 IO、權威、刷新、退避及原子替換。
3. `stock-index.ts`：目前有效 Base 與名稱層 join／memo。`stockDisplayMeta` 共用顯示優先序，direct 與目錄一致，不修改原 ContractInfo。
4. `index-catalog.ts`：38 筆名稱／別名與 live IND Base 交集，逐筆保留交易所。不是 227 筆每次逐檔 Info。
5. `product-search.ts`：關聯、排序、去重及分段前綴；不擁有商品名稱資料庫。`search-request.ts`：有界共享來源及每讀者 lifecycle。
6. UI 與三個商品面板：訂閱身分／名稱 epoch，撤銷舊操作能力並重查；名稱改變不重抓未到期的衍生資料，不清空報價。
7. `workspace-grid.ts`：純密度、版面正規化、幾何比對與原精度回存；`use-workspace-grid.ts` 集中 App 與正式 actual-RGL 測試共用的 adapter／完整 handlers bag。不擁有 state、effect 或訂閱，也不與商品搜尋、行情或主題 store 耦合。

### 動態 ETF 名稱

使用三個固定官方批次來源：TWSE 基金表、TWSE 每日名稱表及 TPEx ETF 名單。新商品仍須出現在目前 Shioaji Base 的相同型別／交易所／代碼，官方名單不能自行製造 broker 支援。

顯示名稱依成功驗證的 runtime 官方名稱、有效 broker 名稱、bundled snapshot、代碼依序採用；同一仍存在身分保留已收錄別名。三來源結構、entity、重複、日期、日期倒退、未來日期及超過 20% 縮水均檢查，全輪成功才替換。首次官方權威切換即使內容相同也通知一次；後續相同資料不重複通知。

成功 TTL 5 分鐘、失敗退避 30 秒、台灣跨日下次讀取刷新；觸發式背景共享，不定時輪詢。每來源 5 秒總截止、2 MiB body 上限，公開資料不帶 credentials、不跟 redirect。名稱版本只重建 join，不清除仍有效的 Base／Info／underlyings 或相關期貨／權證快取。來源失敗保留最後好名稱，搜尋不等待外網。

Dev 固定同源代理只綁 loopback，拒絕 query、body、錯方法、外部 Host 及任意 URL；只轉送 Accept，固定三個 HTTPS 上游、3 秒總截止及 2 MiB 上限。不擴張 native allowlist。Production browser CORS 與原生權限仍須分別驗證；dev 代理通過不能當作兩者通過。

## 本輪真實唯讀證據

Dev `http://127.0.0.1:5194/` 的 REST／SSE 指向隔離 `21323`，同一 instance `0d78b855d5fe`、Shioaji `1.7.8`、simulation=true。原正式 App PID 5820、sidecar PID 31748 未停止或接手。

2026-10-17 21:02:39–21:03:14 的同源實站測試，三個 ETF 路由回傳 272、118、1380 筆有效 JSON；35 秒 SSE 取得 2 個新 heartbeat，0 Tick／BidAsk。週六沒有新夜盤行情證據，不以心跳冒稱成交即時。

本機來源：`work/pm-validation/final-live-dev-results.json`，重現 `node work/pm-validation/probe-live-dev.mjs --final`。這是 HTTP／SSE，不是實際 browser 或 native 畫面操作。較早 18:52 檔保留，不覆寫成新資料。

## 效能的基線與界線

較早 `d934eed` → `4203ad5` 的 17 → 13 GET，是取消重複 direct 查詢帶來的同一組減量，不重複算本輪收益。本輪 `4203ad5` → working tree 固定序列是 13 → 14 GET，增加必要的 live IND 身分 gate；三次並行 2330 仍共用 Base＋Info 的 2 GET。

本輪單次唯讀 Node client 量測：

| 查詢 | 首批 | 完整 | sidecar GET |
| --- | --- | --- | --- |
| 台積，client 冷快取 | 18.50 ms | 46.99 ms | 4 |
| 2330，關聯來源暖快取 | 1.71 ms | 4.36 ms | 2 |
| 三次同時 2330 | 不另宣稱首批 | 9.59 ms | 共 2 |
| 00679B | 1.51 ms | 14.10 ms | 4 |
| ETF 名稱，來源暖快取 | 2.38 ms | 2.52 ms | 0 |
| 台指 | 5.72 ms | 5.75 ms | 2 |

IND live gate 原先串行會拖主期貨，正式改為並行並加回歸；上述非精確台指首次 5.72 ms，不用每筆查詢串等 IND。公開名稱刷新另算三個批次外網來源，不混入 sidecar GET 減量。

Baseline 先跑且未重置 daemon／OS，不能把時間差全歸 patch。這不是統計樣本、P95、SLA、瀏覽器 paint、原生 HTTP 或報價端到端延遲。最終證據是 `baseline-4203ad5-live-results.json`、`final-frozen-live-results.json`，位於 `work/pm-validation/`；最後唯讀回歸 1／1 通過，前次量測保留。

## 指定角色與驗收狀態

- GPT-6.1 Sol 工程師：完成目錄／面板／代理實作，與 PM 直接討論界面及反例。
- GPT-6.1 Sol 獨立 QA／架構交接：不代替 Opus 最終 PM。親自執行最後定向 14 檔 410／410，另最新 UI／badge／grid 3 檔 215／215（重疊不相加），核對 67 份來源與主控 4019 全套報告；沒有冒稱自己又跑全套或操作 browser。獨立自建 virtual runner 的 5 類 production 變異均被測試攔下，來源前後 hash 不變；已審範圍無新必修，保留既有 gesture、名稱降級、全域窄窗及原生限制。
- Gemini 3.8：經使用者指定 AGY。CLI `1.4.0` 實際以 `gemini-3.8-flash-high` 完成兩輪，均 SUCCESS／exit 0，工具／hook／權限請求事件 0。工具清單仍 60 項，不宣稱強制隔離。第二輪 B1 快速代碼 Enter 主張由 10 項反例否決；B2 修為 Watchlist pending 未選取不高亮，Down 首筆／Up 末筆。見 [完整複核](gemini-agy-uiux-review.md)。
- Claude Opus 5.5 主要 PM／架構：CLI preflight 與五輪聚焦審查已成功，init／assistant／terminal usage 皆 `claude-opus-5-5`、工具清單空、MCP 0、工具／hook／權限事件 0。`ultracode` 已接受，但實際 effort 未回報。五輪涵蓋 5aba、044cb、6e0f、b858、a20；N1／N2／N3 關閉，最終本機草稿／dev 接受，沒有新的必修，見 [Opus 處置](opus-product-search-acceptance.md)。

21:35:34 凍結最後 67 份任務來源，SHA-256 `a20face6b99d4a8cfb5255571018273f28fba1d12b2fbfda7ccc961cf473c622`。主控完整 Vitest 251 檔、4019 PASS／0 FAIL／2 既有 SKIP，Node 產生器 10／10、`tsc -b` 及 Vite build 通過；既有 BigInt Safari、chunk／import 警告保留。3836／3902／3914／3927／3932／3980／3990／4010／4018 都是較早 checkpoint。兩項 SKIP 均在 `indicator-native-integration.test.ts`，缺原生 bridge 的 auto_safe／ask 權限驗證。來源邊界及結果見 [manifest](product-search-final-manifest.json)，不含本機環境設定、work／outputs。

這次全套曾因 work 中新建的 Node 測試檔被 Vitest 誤掃而 exit 1，雖正式 3932 項沒有 test failure，也未宣稱通過。保留全部工具測試並改為 `.checks.mjs`，明確 Node 執行 12／12，再重跑完整 Vitest 得到 success=true／exit 0；未刪既有測試或放寬 Vitest 設定。

Opus 381088 bytes 第一份題包逾時，不計成功。159792 bytes 聚焦題包 260.501 秒完成，62462 bytes UI delta 177.464 秒完成，113008 bytes closure 226.312 秒完成；各原文、manifest 與精簡事件分別保留。adapter-closure 題包 80323 bytes，SHA-256 `2d5e1517832b2df3ebb4f31c1329ba65bbf9a449174408893da5a1a2667ec13d`，檢視 N1 及窄版共 9 份變更，229.853 秒成功完成。最新 ui-polish 題包 62449 bytes，SHA-256 `353692c455b139d59f6b54ff699d870838134205753407c5db391aa0f789d7ff`，只檢視 N2／N3 的 4 份 UI 變更；各份不互相覆寫。

六類文字標籤集中於純 presentation map、共用 ProductBadge，ETF kind 不改 STK 合約身分。依後續要求改用既有 theme token，底色 12%、邊框 45%、文字 opacity 1；空 detail 不渲染重複 title。12 組配色設定 × 3 狀態 × 6 類，共 216 組合成小字對比最低 6.5475:1。此為數學有限矩陣，不是肉眼辨識六色或完整 WCAG 認證；舊固定鋼藍／冰藍 6.4127:1 只是歷史數據，不再作最新通用主張。

另透過實際 color-well UI 套用非預設自訂六色：背景 `#101926`、面板 `#172B3C`、文字 `#E8E5DF`、強調 `#45BAA9`、紅 `#C46B5F`、綠 `#6AA68E`。可見 hex 與 preset false 均核對，完整重載後保存。股票／ETF／期貨／選擇權／權證／指數實測單行、底色 alpha 0.12、文字 opacity 1，另選取權證的 sampled 最低對比為 6.4168:1。最初 locator fill 只改 DOM value 而未更新設定，該嘗試不算成功；實際 color-well setValue 後才確認生效。

## 快速縮放的版面回寫缺陷與修正

12:36、12:39 UTC 在主頁先後觀察持續 React update-depth，完整重載後仍可重現，沒有當作歷史 HMR 忽略。正常桌面、慢速縮放、獨立 10 面板 RGL 對照沒有重現，不足以否定正例。僅本機 work 診斷入口保留原 index／App，對首次警告加 stack、不讀 state／storage／帳務；12:52:11 UTC 堆疊指向 RGL props-to-layout passive effect 的 setLayout（實際 prebundle 4811）。正式入口未匯入該診斷程式。

Actual RGL／React StrictMode 反例確認：parent passive effect 在 1910→320 尚未 settle 時切回 1910，RGL 在同步新 props 的同一 commit 回報舊 internal layout；App 用最新 density 解碼舊座標，兩份版面互追。雙向 legacy probe 都達上限 20 回寫、46 renders／24 callbacks，寬 72↔36。原測試先 RED；修正後雙向為 6 renders／4 callbacks／0 回寫／1 rejected，沒有額外面板掛載。

修正只接受與當前 normalized props 相符的自主回報，明確 drag／resize stop 才走原精度回存。純 helper 使用 RGL 公開 core、先 clone、依 child key 正規化，不複製第三方演算法。初版 20 項回歸通過，但 Opus N1 指出測試重寫 App wiring 的維護缺口；現改為 production 共用 hook 與完整 handlers bag，新增密度邊界及 App AST 接線驗證，共 28 項。rapid 嚴格要求 0 回寫及至少 1 次拒絕；add／remove／profile／reset 回寫精確為 0→1→2→3→3。工程及獨立 QA 各自執行 5 類 production-module virtual 變異全部 RED，正常版全綠；來源未被 runner 改寫。沒有 key remount、timer、新 state／訂閱、報價清除或 node_modules 修改。

tree 6e0f 曾於 21:01:30 完整重載主頁，8 組快速切換及 12 查詢通過，至 21:08:58 無新 console error。該版隔離公開頁使用實際指標拖曳及縮放、同一 production pure helper：writes 0→1→2，位置 0,0→72,8，寬高 72,8→60,6；StrictMode mounts 20／unmounts 10 不增加，沒有改使用者版面。這是前版的指標證據，不冒充 b858 hook 已做同一真實手勢。

b858 實測改用已開啟的內建瀏覽器，因原 Edge 已不可用且不在清單。21:23:08 開發中 HMR 的 normalizeGridLayout ReferenceError 保留；完整重載後，21:24:03–21:26:46 無新錯誤。又以 320／360 viewport 交替 2330／2330選擇權重放 8 組，實際浮層 281.6／321.6 px，均 8 列、名稱在前、meta 視覺隱藏、無橫向溢出、焦點保留。12 組名稱／代碼、兩系列期貨及 ETF 搜尋排序再驗通過。

使用者最新要求以窄版名稱優先。576 × 760 viewport 下，實際自選浮層寬 255 px，10 列名稱在前、代號在後，類別與 detail 使用 sr-only 方式收起，完整名稱、代碼、分類與日期仍在 DOM 及單一列 title，ArrowDown 選 CDFR1 且 input 保持焦點。寬 476.8 px 命令搜尋維持 code／name／meta。判斷依結果容器的 CSS container query ≤ 360 px，不是 viewport，也不新增每列 observer；其他量測穩定浮層寬 252／267 px 通過，204 px 是縮放過渡快照，不當作穩定尺寸。該版圖保留於本機 outputs/product-search-narrow-255.jpg，暫時 viewport 已還原。

Opus 隨後提出 N2／N3，root 先以真實畫面重現再修。N2 保持 360 px 斷點、名稱採 10em basis、meta shrink 4；命令搜尋實際 361.6 px 時，權證名稱由 71.125 px 增至 123.2875 px，meta 73.1625 px。399.6／476.8 px 的名稱為 128.9625／155.0625 px。這代表空間優先政策改善，不保證所有名稱完整或每列名稱都比 meta 寬。N3 面板圖示及名稱獨立 class，窄版查委託簿，「＋」x=46.8、名稱 x=69.99，圖示回到左側，完整描述仍保留 DOM／列 title。

最新 a20 於 21:36:00 完整重載；N2 三種寬度、N3 面板命令、8 次快速切換及 12 組相同代碼序列再驗通過，至 21:37:38 無新錯誤。自選另驗 361／400／255 px 邊框寬度；CSS query 判斷 content box，361 px 邊框盒的內容仍可低於 360。最終 255 px 十列名稱在前、代號在後、meta 視覺隱藏且無溢出，圖片 outputs/product-search-narrow-verified.jpg。暫時 viewport 已還原；沒有新增每列監聽、狀態、網路、下單或伺服器自選寫入。

另有既有未修限制：拖曳進行中跨 density，再結束手勢，虛擬 actual RGL 在 legacy 與 current 都把寬 72 寫成 144。它不是新迴圈修正引入；完整 gesture 座標世代設計留 follow-up／正式發布 gate，不聲稱所有過期版面回寫都已修。

## 尚未通過與下一步行動

19:08 後恢復 Edge extension，最後實測確認 dev · 4203ad55+dirty、模擬環境與 LIVE，以及 12 組公開名稱／代碼：台積、2330、台指、櫃買、櫃買指數、IX0043、00679B、元大美債20年、0053、元大科技市值、元大電子、2330選擇權。命令搜尋末列捲入、首末循環、input 保持焦點、window.scrollY=0、錯誤重試與 Escape 重開均確認；櫃買跳轉顯示 IX0043 及不可下單提示。自選新增只搜尋，不提交伺服器寫入。

實際發現的自選浮層頂端 -2.305 px 已修正，新增 13 項幾何／cleanup 回歸。最終單行版在原 1910 × 872、workspace.scrollTop=64.5、window.scrollY=0 的情境，clip safeTop=42.336／safeBottom=480.836，浮層 top=144.523／bottom=433.945、高 289.422 px，10 列每列 28.742 px，首末列均完整在 popup client box。1910 × 500 縮高後限高 196 px，末列 scrollTop=93.5，首末列仍完整可見。只捲結果容器；不新增 React state、portal、新套件或修改父 overflow。實作由 useLayoutEffect、resize／祖先 scroll 的同步 callback 與 ResizeObserver 觸發重算，沒有 requestAnimationFrame。resize 的立即同呼叫快照曾捕捉過渡越界，穩定後通過，不把過渡快照隱藏成全程零越界。

使用者當時明確要求一行，覆寫先前雙行／wrap 設計。單行初版的兩入口為 code／name／typed badge／detail 同列；目前僅寬版維持該排列，窄版依上節改 name／code、meta 視覺隱藏。完整 DOM 與列 title 保留，不以 CSS 省略刪資料。初版新增 5 項結構／title 回歸，12 組查詢與自選 10 筆確認同列、無橫向溢出；320 px 末列鍵盤選取 scrollTop=23.5，焦點與 pageScrollY=0 保持。這是前版證據，Gemini 前兩輪未審後續單行及窄版修正。

命令搜尋 320／360 px CSS viewport 無橫向溢出。自選在 320 px 雖垂直定位正確，既有桌面 grid 卻把面板壓成 45 px、input 18 px，整個入口寬度不可用；不列為兩入口窄窗 UX PASS，也不擴張成全域 grid 響應式改造。未驗證實際自選浮層 transform-only 拖動期間連續定位；隔離 RGL 手勢通過不能取代它。歷史 HMR 曾有短暫 ReferenceError，快速縮放也實際有 update-depth；只有明列的最後重載時間窗 error 0，不能說整段歷史零錯誤。暫時 viewport 已還原，兩項隱私偏好保持原值；自訂配色則依使用者最新要求保留預覽，不還原成舊主題。

原生 UI／HTTP allowlist、production CORS、正式登入、彈出視窗、乾淨機器、雲端 CI 與本版本新夜盤行情仍未驗收。中文 fill 不是原生 IME 組字實測；不將 React mock 或 HTTP 證據冒充這些驗收。

名稱來源故障時「2330選擇權」仍只剩現股的 F6，已以 current 與 4203ad5 各 4 項對照確認既有且未修；直接 Info 不會回填名稱。原生、production CORS、新夜盤及 gesture 跨 density gate 都保留，不以本機通過宣稱可發布。

下一步行動：本機 PR 草稿與 patch 交使用者檢視，原始審查答案保留不覆寫。Opus 已接受最終 LOCAL DRAFT/DEV；原生、行情與既有風險仍依文件保留，未授權前不推送。
