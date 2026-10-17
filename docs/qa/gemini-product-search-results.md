# 商品搜尋補充驗證進度

2026-10-17 下午完成反例修補與 ETF 名稱補齊。正式程式最終受測 SHA 為 `4449807439a121d057eb101e5ddb150c144f9b66`；先前未修版 `75c9805` 的失敗紀錄保留於下方。狀態是「本機範圍已完成並驗證、Gemini 已實際交卷」，不是原生登入、正式交易或所有未來行情情境均已驗收。

## 最終驗證摘要

- 更正（2026-10-17 效率複核）：本節 3586 是 `4449807` 階段的通過斷言數，不代表當時整套成功。原 `final-vitest.json` 為 `success=false`，因 Vitest 誤收 Node test 檔而有 suite failure。舊報告不覆寫；本輪補正測試入口後，`pnpm test` exit 0，正式測試 3604 項及產生器 6 項通過，2 項既有跳過。詳見 [當前驗收](product-search.md#自動化與獨立驗收)。
- `tsc -b` 與 Vite build 通過。差異空白檢查有 1 個保留原文的格式例外，第 3 份 Gemini 原始答案行尾空白；其餘差異通過，不宣稱零警告。
- 原 9 個獨立反例由 2 過／7 未過變為 9 項全過；沒有改弱斷言。
- 22 個記憶體 mutation 全部由斷言抓到，不是以編譯錯誤冒充。首輪 M05 只改到精確指數的切片，當時沒有改變 fixtures 的可見結果；保留該次 SURVIVED 紀錄，改為明確破壞最終混合結果上限後重跑，斷言確實失敗。此結果只代表所選錯誤，不代表沒有其他缺陷。
- 獨立 agent 對 390 個 ETF 身分、697 個簡稱／別名逐一查核，零漏查、零錯誤 underlying。這是合成 Base 對演算法的驗證；真實 broker 的對應數是 359 檔，不混為一談。
- Gemini 首輪 12 題與 8 個提案已取得；兩項發現經複核不成立，後續明確撤回。ETF 更名來源增量亦已交卷，無新增可確認缺陷，但沒有提出新的有效反例。

## Gemini 原始作答與判定

- 已建立 [12 大題與評分方式](gemini-product-search-exam.md)，及只含需求與白名單正式程式的附行號題包。
- Gemini CLI 0.31.0 在認證階段被服務以 `UNSUPPORTED_CLIENT` 拒絕，未取得模型回應；CLI 原始 stdout 為空。不能記成 Gemini review 完成。
- 使用者登入後，透過官方網頁上傳白名單需求／原始碼／diff。首輪不提供本報告、既有測試或先前驗收結論；複核輪才指出其答案矛盾。
- 實際 UI 模式為「自動」，選單標示「Gemini 3 模型」，無法確認後端實際子模型。3.1 Pro、4 Argon 均要求升級，已取消，沒有購買或改方案。
- [原對話](https://gemini.google.com/app/a05827335510580c)，只限帳號本身可讀，未建立公開分享連結。
- 首輪 [原始答案](gemini-product-search-answer-1.json)；[撤回與修正](gemini-product-search-answer-2.json)；[ETF 增量答案](gemini-product-search-answer-3.json)。沒有代寫或改寫原始答案。

| 題包 | 受測版 | SHA-256 | bytes |
| --- | --- | --- | --- |
| 未取得答案的 CLI 第一版 | 75c9805 | 17b7f115e3d15e330860660bdec22e8f88cf1d1927425bdd9d301f303673743b | 183406 |
| 網頁正式 12 題 | bba3646 | e47f116476ee20693ebd928fbffd3fde82fdd64fc37ee4c1afd38d8b4cb2dbf7 | 348320 |
| ETF 每日名稱增量 | 4449807 | ded87525748abb56b0ab730c2785b82af71188e25adbbaf60d23cf3034b210eb | 116095 |

題包不含金鑰、帳戶／持倉資料、本機環境設定或測試答案。CLI 認證快取由 CLI 自行使用，沒有讀出或放入題包。

| Gemini 發現 | 本機判定 | 證據 |
| --- | --- | --- |
| F01：limit=0 回空表為 P2 | REJECTED；模型第二輪撤回 | 契約允許無效名額回空表，既有 limit 邊界測試通過；Gemini 自己的 TC04 亦預期空表。沒有擅改成例外或預設查詢。 |
| F02：部分刷新失敗後保留 cache 為 P1 | REJECTED；模型第二輪撤回 | 新增同碼 STK/IND 混合測試：STK 503 時保留其最後有效值、IND 正常更新；重試 STK 成功後只更新 STK，code-only 畫面仍為 IND。 |

首輪評閱分數為 53/100，這是主驗收者對證據完整度的判斷，不是模型效能基準或可發布評分。Q01 至 Q12 依序為 6/10、4/6、5/8、4/6、4/8、6/10、3/8、6/10、5/8、3/8、2/8、5/10。扣分主因：缺逐項行號與完整反例、Q07 混用目錄與完整合約快取的證據、Q11 將等待截止混同請求數有界，以及 F01/F02 自相矛盾。TC03 原本容許無關 TXF，TC05/TC08 呼叫 private helper，均未直接採用；後續修正版仍只是提案，不冒稱由 Gemini 執行。

## 修補前的歷史基線

`tsc -b`、Vitest 與 Vite build 通過。Vitest 為 3526 項通過、0 項失敗、2 項既有跳過。此結果只涵蓋原有測試集合，不能替代下列補充驗證。

21323 與 dev 5194 的 `/api/v1/info` 均回傳 1.7.8、simulation=true、instance `8f729a15f272`。當時為週六下午，沒有把服務連通性當成新的即時成交驗證。前次凌晨的夜盤紀錄保留為歷史證據，並非本次新增的盤中實測。

## 修補前的主驗收者反例

這一節全部由主驗收者執行，使用 synthetic fixtures 與 mock，沒有讀取帳戶、下單或變動伺服器資料，不冒稱 Gemini 的發現。

9 項檢查：2 項正向控制通過，7 項規格斷言失敗。兩個中文組字案例屬同一類問題；部分其他反例依賴尚未觀察到的異常資料或代碼碰撞，不能直接稱為 7 個實際使用者事故。

| 類別 | 觀察到的行為 | 判定與建議 |
| --- | --- | --- |
| 中文組字 Enter，兩個入口 | isComposing=true 時，命令面板仍呼叫 onJump；自選清單仍呼叫 onAdd | CONFIRMED 邏輯缺口，P2。keydown 需先處理組字旗標與相容事件；是否實際呼叫網路由現有上層 callback 決定，本測試沒有送出。原本 Enter handler 已存在，不列為本輪新增回歸。 |
| 名稱來源失敗後恢復 | 權證標的名稱請求失敗被轉成空表，成功的 Base 目錄卻永久快取；重試仍顯示 2330，不再查名稱 | CONFIRMED 既有缺陷，P2。區分部分成功與完整成功，保留 Base 可用性但讓缺名稱來源可重試。 |
| 跨服務股票目錄 | API base 從 A 改 B 後，loadStockCatalog 仍回 A 的資料 | CONFIRMED 既有快取缺口，P2。新增關聯商品 cache 的 base 分隔不代表全部 cache 均已分隔；應依服務／商品檔版本失效。 |
| 同碼異型別 cache | primeContract 存 STK 後，ensureContract(code, IND) 直接回 STK，沒有檢查指定型別 | CONFIRMED 條件式缺口。代碼碰撞是 synthetic，尚未證實目前 TW 商品檔有此碰撞；列 P3 防禦性補強，不誇大成已選到錯誤真實商品。 |
| 不結束的股票來源 | 已知靜態櫃買指數仍等待股票 Promise；250 ms 後沒有結果 | CONFIRMED 相依性缺口，P2。250 ms 只是反例觀察點，不是既定效能 SLA；測試證明無關來源尚未結束時靜態結果也不會先回。需設計來源分流或有界等待，不能宣稱已量測永久卡死。 |
| 不可能的日曆日期 | 2027-02-31、2026-13-99 符合正規表示式，被視為已確認日期，沒有待確認標示 | CONFIRMED synthetic 資料品質缺口，P3。尚未觀察到 sidecar 回傳這些值；應驗證日曆有效性或明訂 SDK 資料保證。 |

程式定位為未修版 `75c9805`：`src/components/command-palette.tsx:149`、`src/components/watchlist.tsx:765`、`src/lib/stock-index.ts:26`、`src/lib/contracts-cache.ts:89`、`src/lib/product-search.ts:112` 及 `:156`。最終版皆已有回歸測試；日期測試使用合成壞資料，仍不宣稱曾觀察到 SDK 回傳該資料。

## 重跑方式與證據

```powershell
node work/gemini-exam/run-local-verification.mjs
```

未修版原為 exit 1；最終版預期 exit 0，9 項全過。診斷案例使用 `.cases.tsx`，由專用 runner 指定 include，不會被一般 `vitest run` 自動收集。對應正式回歸已加入 `src/` 的 Vitest 測試，另有 `node --test scripts/refresh-etf-catalog.test.mjs`，不必依賴未提交的 work 目錄才能重現主要驗收。

本機 `work/gemini-exam/` 保留基線、兩個反例案例檔、最終全測 JSON、mutation 摘要與各案 JSON、原未生效 M05、CLI 錯誤、兩份網頁題包及原始答案。正式回歸與安全的模型答案在版本控制中；本機設定、憑證、work、outputs 不納入 PR。未推送或發布。

## 驗證限制與下一步行動

原生 Tauri shell／Popout、實際 Windows 中文輸入法按鍵、完整非 ETF 股票／指數名稱、WRT 冷重載的完整 Info、同源服務重啟身分失效與下一個交易時段的行情，仍未列為已完成。IME 已驗 composition 事件模型，不能代替作業系統實按。等待截止不是 HTTP abort；快速輸入仍可留下底層請求，不宣稱具備網路全域並行上限。

ETF 是版本化名稱快照，不是未來新掛牌自動收錄；詳見 [更新交接](etf-search-catalog.md)。下午 `/info` 與 SSE 心跳只能證明當下隔離服務連通，不把週六快照或心跳稱為即時成交。凌晨夜盤保留為歷史證據。

下一步行動：使用者檢視 dev、PR 草稿與差異。未取得該次授權前，不推送、不建立 GitHub PR、不合併、不發版。
