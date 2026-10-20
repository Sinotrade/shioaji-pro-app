> 封存：這是 a20 回合的原 PR 詳稿，不代表目前狀態。最新精簡草稿見 [商品搜尋 PR](../pr-drafts/product-search.md)。

# 商品搜尋修正 PR 草稿

補齊櫃買指數搜尋、股票與 ETF 的關聯商品，加入動態 ETF 名稱、商品異動失效處理及主題感知半透明商品標籤，維持既定排序。窄版改為名稱優先、代號其次、類別先隱藏。本次僅本機修改，尚未推送、建立 GitHub PR、合併或發布。快速縮放的版面回寫迴圈及 App／測試共用接線已補齊驗證；最新 67 份凍結來源已獲實際 Opus 接受為 LOCAL DRAFT/DEV；原生環境等既有正式發布 gate 仍保留。

## PR 資訊

- 建議標題：`fix(search): 補齊關聯商品、動態 ETF 名稱與商品異動同步`。
- 官方固定比較基準：`be4cbd3073df2625db0d51f767c812a27f79cb8e`，不宣稱是目前最新 upstream。
- 本機分支：`codex/product-search-related`；已提交實作基準 `4203ad559b721e48301b30459c27d06864354adf`，本輪修正尚未提交。
- 原始問題：[how0531/1017 問題說明](https://github.com/how0531/1017/blob/8b99a29/docs/issue-otc-index-search.md)。
- 目前維持一個整合草稿供審查，不代表技術上不能拆分。若拆分，權證下單防護必須先於或同時合併搜尋開放。

## 問題與原因

1. 原指數名稱清單漏掉櫃買，交易所又全部寫成 TSE；完整代碼則走另一條查合約路徑。
2. 現股名稱與代碼沒有一致列出相關期貨、權證；模糊第一筆還會被誤當成精確標的。
3. STK Base 不含完整名稱，權證標的名稱不足以覆蓋全部 ETF。隨 App 發布的快照無法自行反映新掛牌或更名。
4. 輸入、服務或商品資料變更後的舊結果與共享請求生命週期不完整；同 signal 取消會誤啟動排隊來源，非搜尋目錄也會被搜尋佇列拖到逾時。
5. 分段更新時，三個不穩定拖放 callback 抵銷 WatchRow memo，搜尋更新會額外重繪整份清單。

## 使用者看得到的變化

| 情境 | 行為 |
| --- | --- |
| 櫃買／櫃買指數 | 只在 live IND Base 存在同型別、交易所、代碼時列出 IX0043／OTC |
| 台積、台積電、臺積電、2330 | 現股 → 一般近月 → 小型近月 → 一般次月 → 小型次月 → 權證 |
| 台指／台股 | TXFR1 → MXFR1 → TMFR1 → TXFR2 → MXFR2 → TMFR2 |
| 元大美債20年／00679B | 相同主商品與同標的期貨、權證，保留 OTC 身分 |
| 元大科技市值／元大電子／0053 | 保留已收錄別名，名稱與代碼使用相同顯示政策 |
| 2330 選擇權 | 多個匹配根商品交錯，不只取第一個 CDA／CDO |
| 臺指選擇權波動率指數 | 按完整指數名稱處理，不誤拆成選擇權商品 |
| 權證先回、期貨仍載入 | 權證不提前插進期貨；先出主商品及已驗證的穩定前綴 |
| 中文組字、換字、關閉、選取 | 中止本輪讀者；晚到結果、舊提交不得覆蓋新查詢 |
| 名稱搜尋補齊中按 Enter | 提交被擋下時保留已有 partial，不閃空 |
| 跳轉失敗 | 提供重新搜尋，重新補齊結果 |
| 商品異動或名稱更新 | 已完成的開啟中搜尋也會重查；舊 click handler 不得提交失效列 |
| 商品面板刷新 | 保留仍支援的標的與舊表格；新身分與新合約驗證前，舊列只能看不能選取 |
| 商品分類 | 股票、ETF、期貨、選擇權、權證、指數均保留文字標籤；色卡跟隨既有主題與自訂色，顏色僅輔助，不解析 detail 決定分類，也不改漲跌色 |
| 搜尋容器寬度不超過 360 px | 名稱在前並優先分配寬度，代號在後；類別及補充資訊先視覺隱藏。完整名稱、代號、類型、到期日與警告保留於 DOM 及整列提示；寬版仍為代號、名稱、類別 |
| 自選搜尋 Enter | 完成後提交目前選取商品的完整型別與合約；pending 中文且未明確選取時保留內容，Down 選首筆、Up 選末筆 |
| 自選浮層被裁切而隱藏 | 中文不能提交看不到的列；純碼只有目前同碼候選唯一、且為同一份當前合約物件時保留型別，其餘走原始代碼解析，舊 captured handler 不例外 |
| 鍵盤末列／內部捲動 | 只捲自己的結果容器；自選浮層依 viewport 與裁切祖先交集限高，不蓋到頁首或捲動整頁 |
| 快速切換窄窗與桌面 | 過期版面回報不再用新的欄位密度回存；不重掛整份 grid 或清空圖表。一般拖曳與縮放結束仍能儲存 |

R2 是現有「次月」，不是任意最遠到期月。每個月份內依一般、小型、微型排序；缺規格略過。週別不擠掉六個月合約，已有連續代碼對應的實體月份不重複列出。多檔歧義、非前綴子字串及只有代碼的缺名稱替代值，不任選 underlying。

## 資料來源與更新

不是前端直接查完整資料庫，也不是全靠寫死清單。

| 資料 | 來源與更新 |
| --- | --- |
| 有效股票／ETF 身分 | Shioaji STK Base；成功快取 60 秒，商品異動、服務／台灣日切立即失效 |
| 股票名稱 | Shioaji 權證標的名稱；尚非全部股票中文名稱全集 |
| ETF 名稱 | TWSE 基金表、每日名稱表及 TPEx ETF 名單；三個官方批次來源背景更新 |
| ETF 顯示優先序 | 成功驗證的 runtime 官方名稱 → 當輪 broker 名稱 → bundled snapshot → 代碼 |
| 期貨／選擇權／權證 | Shioaji 對應 API；按 underlying_code 關聯，成功 TTL 60 秒及商品事件失效 |
| 指數名稱 | 38 筆已確認名稱／別名，必須 join live IND Base；未收錄名稱的新指數仍可直接輸入代碼 |

ETF 成功更新保留 5 分鐘，台灣跨日於下次讀取更新；失敗退避 30 秒並保留最後有效名稱。只在目錄讀取時觸發，沒有背景定時輪詢。首次 snapshot → official 權威切換也發出一次名稱版本通知，後續相同內容不重複通知。保留仍存在身分的已收錄舊別名，不復活已移除商品。

官方名單只補名，必須與目前 broker Base 的型別、交易所、代碼取交集，不將官方 ETF 名單直接視為可交易清單。Runtime 與產生器共用純 normalizer，驗證日期、結構、重複、entity、資料倒退與超過 20% 縮水；整輪成功才原子替換。資料只含公開名稱，不存帳戶或價格。

## 程式與效能設計

- 身分 epoch 與 ETF 名稱 epoch 分離。前者失效 Base／Info／roots／關聯合約；後者只重建名稱 join，不重抓有效 Base、underlyings 或衍生商品。
- 目錄組裝以 scope、Base 引用、名稱引用及 ETF 版本記憶化；Info 與聚合快取均不延長原始來源的 60 秒有效期。
- 搜尋來源維持四路邏輯 FIFO；跨面板共享的 STK／IND 目錄不占搜尋 slot，仍有自己的共享、取消與截止。不是把所有 API 或 SSE 放進同一佇列。
- 每位讀者獨立取消；最後讀者退出才中止來源。啟動前移除已取消讀者，避免同步 drain 誤發。每輪搜尋 owns 自己的 reader，致命錯誤立即清理其他分支，不取消其他搜尋的有效共用者。
- 成功 roots／contracts LRU 各 16 項、TTL 60 秒；直接 Info 只共用執行中請求，不保留成功、404、5xx 或逾時。客戶端 AbortSignal 不代表 daemon 內部工作已停止。
- 股票來源截止 1000 ms，其他單一搜尋來源 1200 ms；排隊也計時。多階段整次搜尋不宣稱 1200 ms 完成。非精確指數查詢的 live gate 與期貨並行，不擋首批期貨。
- 公開 ETF 更新不放在搜尋主路徑，每筆 5 秒截止、body 上限 2 MiB。Dev 使用固定同源三路代理；代理固定 HTTPS 上游、拒絕任意 URL、query、錯方法與 body，隔離敏感標頭，3 秒截止及 2 MiB 串流上限。沒有擴張原生權限。
- 三個拖放 callback 使用正確依賴的穩定引用。正式 50 列合成 React 測試每個搜尋 phase 額外列 render 為 0；獨立 quote 訂閱仍能更新指定列與價格。這不是瀏覽器 paint 或行情延遲數據。
- 色卡集中於純 presentation map 與共用 ProductBadge；security_type 決定交易身分，kind 僅補 ETF 顯示。沿用 accent／amber／foreground／mutedForeground，底色 12%、邊框 45%、文字 opacity 1；選取列用 accentDim／foreground／accent。不新增每列主題 hook、JavaScript 調色快取或網路請求。完整名稱 title、到期日及警告保留；空 detail 不渲染重複提示。自選浮層只寫 inline 幾何，不新增 React state、portal 或 floating 套件。
- 預設深／淺色及 4 組內建自訂色，含兩種漲跌慣例與 normal／selected／hover，共 216 組合成文字對比最低 6.5475:1。色調數值相異不代表肉眼可辨六類，分類以文字為準；不宣稱所有任意低對比自訂色或完整 WCAG 通過。實際另套用一組非預設六色並完整重載確認保存，六類商品及選取權證的 sampled 最低對比為 6.4168:1。
- 純 `workspace-grid.ts` 處理密度、正規化與原精度回存，`useWorkspaceGrid` 集中 App 與實際 RGL 測試共用的渲染及完整 handlers bag。沿用公開 bounds／compactor、先 clone、依 child key 正規化；自主回報只接受目前預期幾何，明確拖曳／縮放結束另走回存。AST 測試攔下 App 刪除接線、覆寫 handler 或增加 remount key；5 類 production 變異均由工程及獨立 QA 分別攔下。沒有新增 state、effect、timer、訂閱或套件修改。
- 窄版由兩個搜尋結果容器的 CSS container query 決定，不靠整個 viewport，也不新增每列 observer。單列完整 title 集中資訊，移除子欄重複或空 title；名稱、代碼、類別與日期仍保留原始 DOM，原生螢幕閱讀器尚未驗證。

## 驗證與審查

本輪正式回歸包含原 Claude 反例、資料異動、來源權威切換、名稱／代碼一致、錯交易所、下市不復活、分段前綴、IME、舊提交、拖放、選取及獨立 quote 更新。原始歷史資料保留於 [原驗收](../qa/product-search.md) 與 [Claude 原始審查](../qa/claude-product-search-review.md)，目前結果以 [本輪修正驗收](../qa/product-search-remediation.md) 為準。

- TypeScript `tsc -b` 與 production build 已重跑通過；既有 BigInt Safari target、chunk 與重複 import 警告保留。
- 依使用者要求維持單行，後續再加入窄版名稱優先與類別先隱藏。這兩項後續要求均由 Sol 實作與獨立 QA，Gemini 前兩輪不算最新核可。
- 最後凍結 67 份任務來源，SHA-256 `a20face6b99d4a8cfb5255571018273f28fba1d12b2fbfda7ccc961cf473c622`。完整 Vitest 251 檔、4019 PASS／0 FAIL／2 既有原生 SKIP；Node ETF 產生器 10／10，Sol 獨立定向 14 檔 410／410；最新 UI／badge／grid 3 檔 215／215（覆蓋重疊，不相加）。`tsc -b` 與 Vite build 通過。全套由主控執行，Sol 另核對報告與精確來源，不重複算兩輪全套。來源見 [manifest](../qa/product-search-final-manifest.json)。
- 本輪真實 metadata 唯讀測試維持名稱／代碼結果、兩組期貨排序，三次同時 2330 仍只需 Base＋Info 共 2 GET。
- 固定查詢輪為 14 個 GET，比 4203ad5 的 13 個多 1 個必要 live IND Base gate。公開 ETF 刷新另為三個批次來源，不混入 sidecar GET 減量主張。
- 最後固定來源的單次 client 冷快取序列，台積首批約 18.50 ms、完整約 46.99 ms；daemon／OS 未重置且 baseline 先跑，不把差值歸因於 patch，也不宣稱 P95、SLA 或行情端到端延遲。
- 21:02:39–21:03:14，5194 三個固定代理實站驗證為 272／118／1380 筆；同源 SSE 35 秒收到 2 次新心跳、0 Tick／BidAsk，確認 Shioaji 1.7.8 模擬 instance。週六心跳不是新夜盤成交。
- Gemini 3.8 經 AGY 實際以 `gemini-3.8-flash-high` 完成兩輪，均 SUCCESS／exit 0、實際工具事件 0；原始工具仍列舉 60 項，不宣稱 OS sandbox。第二輪 B1 由 10 項反例否決並保留安全 guard；B2 採納為 pending 選取語義修正，不將兩者合稱全部採用。見 [AGY 審查複核](../qa/gemini-agy-uiux-review.md)。
- 依最新指示，主要 PM／架構與終驗收改回實際 Claude Opus 5.5；GPT-6.1 Sol 保留工程與獨立 QA。Opus preflight 與五輪成功聚焦審查的 init／assistant／terminal usage 均為 `claude-opus-5-5`、空工具、exit 0。首份題包逾時不計成功。五輪涵蓋 tree 5aba、044cb、6e0f、b858、a20。最終 a20 審查 70.644 秒完成，N1／N2／N3 均關閉，接受 LOCAL DRAFT/DEV、沒有新的必修。模型只讀文字，未親自執行測試、核 hash 或看像素；不構成 production／push／merge／release 核准。見 [Opus 處置](../qa/opus-product-search-acceptance.md)。
- 另量測真實 3155 筆目錄，9 查詢各 50 次 `searchStocks` CPU microbenchmark，P50 約 0.54–0.76 ms、各組 P95 約 0.59–1.20 ms。這不是端到端 P95，暫無證據支持另增正規化快取層。
- 快速視窗反例採 actual RGL／React StrictMode：舊 wiring 達診斷上限 20 次回寫、46 renders／24 callbacks；修正後 6 renders／4 callbacks／0 回寫且 rejected 至少 1，面板掛載不增加。App 及測試現共用 production hook，不再在測試重寫 guard。先前 tree 6e0f 的實際隔離拖曳／縮放 writes 為 0→1→2；最新 a20 又重播 8 次快速搜尋／縮放及 12 組查詢，21:36:00–21:37:38 無新 console error。歷史 21:23:08 開發中 HMR 錯誤保留，完整重載後才採證。
- 最新實際內建瀏覽器：255 px 自選浮層的 10 列均為名稱在前、代號在後、類別先隱藏，ArrowDown 及焦點正常；476.8 px 命令搜尋仍顯示代號、名稱、類別，320／360 px viewport 則切換窄版。兩組期貨與 ETF 名稱／代號結果順序不變，暫時 viewport 已還原。

- 臨界寬度不移動 360 px 斷點，名稱採 10em basis、meta shrink 4，先讓出補充資訊空間；實際 361.6 px 命令搜尋中，權證名稱由 71.125 px 增至 123.2875 px。399.6／476.8 px 亦驗證，仍不保證所有文字同時完整可見。面板命令改用獨立 icon／name 樣式，窄版「＋」維持左側；實際「委託簿」命令已驗。

## 安全與未完成驗收

- 權證在主視窗／彈出視窗的閃電下單、鋪單、整零價差入口保持阻擋；不新增權證交易能力。到期日與最後交易日均檢查，缺資料標示待確認。
- 未下單、未寫伺服器自選清單，未停止或接手原正式 App／服務。
- 實際 Edge 已重驗 12 組公開查詢、兩組期貨排序、櫃買圖表跳轉、錯誤重試、Escape 重開、六類色卡及命令搜尋 320／360 px。鍵盤末列捲入且焦點保留。自選浮層在原 1910 × 872 內部捲動與 1910 × 500 縮高後，首末列及浮層均位於裁切 client box；2 項原生 SKIP、原生 UI／HTTP allowlist、正式登入、彈出視窗、乾淨機器與雲端 CI 均未驗收。
- 320 px 的既有桌面 grid 把自選面板壓成 45 px，自選入口窄窗可用性未通過，不宣稱手機版或兩入口的窄窗 UX 全過。只有命令搜尋 dialog 的 320／360 px 無橫向溢出；自選垂直限高通過不代表寬度可用。面板 transform-only 拖動期間的連續定位尚未驗證。
- Production browser 的官方來源仍受 CORS 限制；失敗可退回最後有效名稱。Dev 代理成功不代表原生權限或 production browser 已可自動更新。
- 全部非 ETF 股票／指數中文名稱、新指數名稱自動收錄、完整 ETF 歷史別名與 WRT 冷重載完整 Info，仍有供應端限制。
- 名稱來源失敗時，混合查詢「2330選擇權」仍會只剩現股；直接 Info 不回填目錄名稱。已以 `4203ad5` 與 current 各 4 項對照確認是既有降級，尚未修正。後續僅考慮精確代碼、有截止且共享的名稱補救，不遍抓全部 roots／Info。
- 拖曳進行中同時跨越視窗欄位密度，再結束手勢，仍有既有座標系回存風險；虛擬 actual RGL 對真正 legacy wiring 與 current 均重現寬 72→144。這與已修的快速非手勢縮放迴圈不同，列後續專案及正式發布 gate，不能聲稱所有過期版面回寫都已修掉。
- GitHub 發送需使用者另行授權。現階段不推送、不建立官方 PR、不合併、不發布。

## 下一步行動

本機草稿、最終來源、完整測試與實際窄版已完成並驗證，Opus 接受 LOCAL DRAFT/DEV，patch 已依相同來源整理。原生環境、既有 gesture 限制及正式來源未通過的 gate 保留，不宣稱可正式發布。未授權前不推送。
