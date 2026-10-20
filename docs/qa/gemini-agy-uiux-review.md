# AGY Gemini 3.8 搜尋 UI／UX 審查

2026-10-17，依使用者指定，實際以 AGY 呼叫 `gemini-3.8-flash-high`，不是替其他模型掛上 Gemini 角色名稱。Gemini 負責靜態 UI／UX 建議，GPT-6.1 Sol 工程師實作及獨立 QA；後續依「可以用 opus 了」改回實際 Claude Opus 5.5 做主要 PM／架構與最後驗收。角色意見透過主控轉交並允許討論。

## 實際執行證據

- 官方 AGY CLI `1.4.0`，已安裝 binary 的簽章與官方 manifest SHA-512 核對相同；本輪未安裝程式或改全域設定。
- 固定角色 `uiux-review`、模型 `gemini-3.8-flash-high`、權限 `request-review`。無資料 preflight 實際 `SUCCESS`、exit 0、回覆 `AGY_PREFLIGHT_OK`。
- 第一輪正式題包含 8 份白名單公開程式、測試標題與精簡量測，126484 bytes，SHA-256 `d5f6a517b00788662a621459a5aa437b911a8efc13c07e1c95d3ccbb715ec5d2`。未提供帳戶、訂單、環境設定、憑證、AX 帳務內容或私有應用程式紀錄。
- CLI init 實際模型與角色符合指定；terminal `SUCCESS`、exit 0，154.421 秒，回覆 10818 字元。實際觀察 tool／hook／permission events 均為 0。
- 原始答案 SHA-256 `e07105612dbb737eed12babfa88d5afca1d5a3b4d68208ee2e2f0cf31261ece0`。完整答案、經精簡事件、模型與題包 manifest 保留本機 `work/agy-review/`。

工具列舉仍有 60 項。`tools: []`、plan 模式、子目錄或事件監看都不是 OS sandbox，也不代表強制禁止所有工具。原答案首句「未掛載任何工具」不精確，以 CLI 實際事件為準。Gemini 沒有執行測試或操作本輪畫面。

## 發現複核與採用

| 建議 | 複核 | 決策 |
| --- | --- | --- |
| Watchlist 完成後 Enter 送原中文，無上下鍵選取 | 程式呼叫鏈確認 `submit` 將 input 送給 `onAdd`，未使用已完成的 typed suggestion；未向真實自選清單送寫入驗證 | 採用最小身分選取與共享提交；pending 中文且未明確選取時仍擋下 Enter 並保留 partial |
| ProductSuggestion 缺 kind | 目前顯示 ETF 的底層已正確為 STK；新增色卡需要明確顯示契約，不應解析 detail | 補可選 `kind: 'ETF'`，direct 與目錄一致；不新增 ETF security_type、不改交易身分或快取鍵 |
| 窄窗與長代碼有破版風險 | CSS 確有固定欄寬，模型未看畫面；不能把它假設的 320／360 px 宣稱已重現 | 當時採安全 maxWidth、minWidth、ellipsis／完整 title 與可換行；後續由使用者明確改為單行，見版本界線 |
| 六類色卡 | 保留文字、與漲跌色分開及共用元件方向適用；透明底及部分字色須另外計算 | 當時採固定底／字色及中央 presentation map；後續由使用者改為主題 token 與半透明底，見版本界線 |
| 正規化是「真正效能瓶頸」 | 沒有 profiler 支持，不能據靜態推論下結論 | 不新增正規化快取；先量測，保留現有清晰結構 |

模型寫「徽章文字 3:1」不符合本輪小字標準。所有 badge 小字仍以 [W3C 一般文字 4.5:1](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) 驗算，不將色卡通過擴稱完整 WCAG AA。

## 工程端實際補證

### 鍵盤可見性與選取對比

實際 Edge dev 中，2330 第 8 列選取後 `scrollTop=0`，整列未在捲動容器內完整可見。原 selected 背景 `#3D8BFF`、主文字 `#D5DBE8`、detail `#7E8798`，計算對比分別為 2.3877:1、1.0912:1，均未達小字標準。這兩項為工程端確認，不冒稱模型或 React mock 已做實際瀏覽器驗證。

當時改用 scoped 搜尋選取鋼藍 `#3F5372` 底及冰藍 `#E4E9F4` 字，為 6.4127:1；金色指示 on 鋼藍為 3.4882:1，僅作非文字提示。紅色 `#C43826` on 冰藍僅 4.3800:1。這是歷史固定配色，不是目前跟隨自訂主題版本的通用數值。

### 文字篩選 CPU

2026-10-17 19:15，真實隔離目錄 3155 筆，9 個查詢各 50 次，分開量測現有 `searchStocks` 的 filter／score／sort，P50 約 0.54–0.76 ms、各組 P95 約 0.59–1.20 ms。載入目錄只用既有 2 個批次 GET；重複篩選不新增網路請求，所有回傳代碼均保持一致。

證據為 `work/pm-validation/search-cpu-results.json` 及 `search-cpu-vitest.json`，受測 `stock-index.ts` SHA-256 `42106a32a2e348cb16ac73c3cd177f6dc73d7fd803b27fa6c2c1038229a10f9d`。這是單機 Node CPU microbenchmark，不含 browser、React、盤中 quote workload 或網路時間，不是端到端 P95，也不是「一定沒有其他瓶頸」的證明。目前不支持為這段另增快取層。

## 第二輪複核與實測

### 第二輪固定來源複核

第二輪提供修正後 9 份來源，112679 bytes，題包 SHA-256 `88b2cb3681263012811cb5ea36a303a26cd014fb660b1b6755f972237b5951b4`。實際仍為 `gemini-3.8-flash-high`／`uiux-review`／`request-review`，SUCCESS／exit 0，208.942 秒，回覆 5324 字元，tool／hook／permission events 均 0。答案 SHA-256 `66cdcaf83bb34c1dd50080087a58237fe1d6976dd6743bc9fbf5dbeb3f7d7ab8`，保存在本機 `confirmation-*`，第一輪不覆寫。

第二輪曾有一次本機預期雜湊填錯，被送出前的檢查攔下；修正指令後才執行上述成功審查。沒有把這次未送出的執行計為一輪模型審查。

| 模型聲稱 | 正式複核與處置 |
| --- | --- |
| renderedVersion 防護會吞掉快速代碼 Enter | 未重現，判定誤判。新增 10 項反例，兩入口、2330／TXFR1、50 ms debounce 前及 Promise pending 的最新 handler 均能提交；同 act 舊 handler 被擋，新 handler 仍能送新碼。模型忽略 effect 的 `setSuggestions([])` 會觸發後續 render，故保留防護，不照建議刪除 |
| Watchlist 未明確選取卻高亮，首次 Down 跳第 2 列 | 不把「首次 Down 一定選第一筆」當普遍規則；但 pending 中文未選卻呈現 active、Enter 又被擋，確有語義不一致。只修 Watchlist pending 無有效 explicit identity 時不畫 active，Down 選首筆、Up 選末筆；完成後仍預設首筆，明確身分跨插列與完成保持 |

Sol PM 獨立執行 10 項快速代碼反例及完整相關 UI 回歸，未以模型嚴重度取代證據。模型另肯定 typed badge、精確 detail 去重、局部對比、容器捲動及既定排序；這仍是靜態意見，不代表 native／IME／screen reader 或新夜盤驗收。

### 單行前的歷史 browser 追加發現

當時真實 Edge 中，命令搜尋於 320／360 px CSS viewport 無列橫向溢出，長名稱有完整 title，六類 badge 實際樣式與當時純色 map 一致。鍵盤末列可見、input 保持焦點、window scrollY 不變。

自選浮層另出現模型未發現的邊界：workspace 內部捲動後，1910 × 872 viewport 的 popup top 為 -2.305 px。只讓 active 列位於 popup 內，不代表整個 popup 位於可視裁切區。依 Sol 架構複核採 only-above、viewport 與 overflow 祖先 client box 交集限高，保留父裁切與既有上限，不新增 floating 套件或 portal。新增 13 項幾何／cleanup 回歸，最終完整 suite 3927 PASS／0 FAIL／2 既有原生 SKIP，Node 10／10，build 通過。

修正後原 1910 × 872、workspace.scrollTop=64.5／window.scrollY=0 實測：safeTop=42.336、popup top=51.945、bottom=433.945，首末列皆位於 popup client box，焦點保持。1910 × 500 的 popup 限高 196 px，首末列均完整可見。實作由 useLayoutEffect、resize／祖先 scroll 的同步 callback 與 ResizeObserver 重算，沒有 requestAnimationFrame；resize 當下曾量到過渡快照，未把它當成穩定結果 PASS。

320 px 的命令搜尋 dialog 通過無橫向溢出；自選浮層垂直定位通過，但既有桌面 grid 把面板壓成 45 px，入口寬度不可用，不宣稱兩入口的窄窗 UX 全過。transform-only 拖動期間連續定位也尚未驗證，不用拖動結束落回原格冒充已通過。

### 歷史固定色卡，已由後續自訂主題要求取代

| 類型 | 背景 | 文字 | 邊框 |
| --- | --- | --- | --- |
| 股票 | `#3F5372` | `#E4E9F4` | `#3F5372` |
| ETF | `#E4E9F4` | `#172439` | `#DAA360` |
| 期貨 | `#DAA360` | `#172439` | `#DAA360` |
| 選擇權 | `#172439` | `#DAA360` | `#DAA360` |
| 權證 | `#172439` | `#E4E9F4` | `#C43826` |
| 指數 | `#ABBCCF` | `#172439` | `#ABBCCF` |

這組歷史固定色卡的一般文字對比至少 4.5:1，邊框色不能當小字對比數據。當時淺／深色 DOM 樣式已核對。保留分類文字，不單靠顏色；上述 Hex 不是目前版本的硬編碼色卡。

最後改由 Opus 對凍結來源、完整測試、實際 browser 及保留限制做 PM 裁決，不再為已被反例否定的模型主張弱化保護。其餘現況見 [本輪修正驗收](product-search-remediation.md)。

## 後續單行要求的版本界線

使用者在兩輪 Gemini 審查後要求「一行就好了」，已覆寫前段可換行的設計。Sol 工程師只改兩入口 JSX／CSS 及 UI tests，共 5 份來源；其他 59 份任務來源與前版相同。完整 DOM／title 保留原名稱、代碼及 detail，視覺省略而不刪到期日／警告；分類色卡與資料排序不變。

單行版來源 tree `5aba33364d40b6b9765bb6ff2c229a3617005f6f9f721452fd128ddbb19a30d8`，正式 Vitest 3932 PASS／0 FAIL／2 既有原生 SKIP、Node 10／10、Sol 獨立 UI／badge 128／128、build 通過。真實 12 查詢、兩入口同列、320／360 命令搜尋與低視窗自選末列重新驗證。Gemini 兩輪是歷史靜態意見，不冒稱它已核可這份最新單行來源；終驗收另交 Opus。

## 後續主題與任意自訂色要求

使用者再要求半透明底及任意自訂色，覆寫上表的固定配色。最新 ProductBadge 以既有 accent／amber／foreground／mutedForeground token 推導，底色 12%、邊框 45%，文字維持 foreground 與 opacity 1。選取列採 accentDim／foreground／accent，不使用 up／down 決定商品類型，也沒有每列主題訂閱或新增資料請求。

預設深／淺色、4 組內建自訂色，各含台灣／國際漲跌慣例及 normal／selected／hover，共 216 組 badge 合成文字對比，最低 6.5475:1。這只驗證有限配色矩陣；色調數值相異不代表肉眼一定能分清六類，分類以完整文字標籤為準。任意低對比自訂色與舊瀏覽器實機不在通過範圍。

工程端另透過實際色彩控制項套用一組非預設六色，完整重載後確認保存，並量測六類商品的單行、12% 底色及文字 opacity 1。此為後續工程實測，不宣稱 Gemini 曾看過該畫面或核可本輪程式。最新來源、執行期發現與 PM 結論統一見 [本輪驗收](product-search-remediation.md) 及 [Opus 處置](opus-product-search-acceptance.md)。

## 後續窄版名稱優先的版本界線

使用者最新附窄版截圖，要求名稱優先於代號、類別先消失。此要求覆寫前段窄版仍分配 metadata 空間的設計，但維持單行及商品排序。兩入口按實際結果容器寬度 ≤ 360 px 切換 name／code，類別及 detail 僅視覺隱藏，完整資訊仍在 DOM 及單一列提示；寬版維持 code／name／meta。

此版由 Sol 實作與獨立 QA，root 以實際內建瀏覽器驗證 255 px 自選浮層、320／360 viewport 命令搜尋、寬 476.8 px 回復及 12 組排序。最新 tree a20、4019 PASS／0 FAIL／2 既有原生 SKIP；後續 Opus N2／N3 的臨界寬度及面板加號亦已修正，Gemini 未審這輪改動，不寫成 Gemini 最終核可。原生螢幕閱讀器、全域桌面 grid 的手機可用性與任意低對比配色仍未通過。
