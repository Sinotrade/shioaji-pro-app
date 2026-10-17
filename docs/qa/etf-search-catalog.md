# ETF 名稱搜尋與更新交接

已完成本機實作與驗收。名稱來源是隨程式交付的版本化快照，不是即時商品全集，也不改變合約型別、下單能力或報價來源。

## 問題、原因與解法

原本 STK Base 不含名稱，搜尋借用權證標的的名稱表；不在該表的 ETF 只剩代碼，名稱搜尋自然找不到。另一個實測缺口是更名：0053 在基金基本表仍為「元大電子」，但同日每日成交資料與 Shioaji Info 已使用「元大科技市值」。

本次以官方基金名單確認 ETF 身分、每日商品資料補顯示名稱，保留基金簡稱與完整名稱為別名。執行期只與 Shioaji STK Base 依 `exchange + code` 取交集；缺合約、交易所不同或不在目前服務的商品，不會因快照存在就被新增。

| 官方來源 | 用途 | 本次紀錄 |
| --- | --- | --- |
| [TWSE 基金基本資料](https://openapi.twse.com.tw/v1/opendata/t187ap47_L) | 上市 ETF 身分、基金簡稱及完整名稱 | 272 筆；出表日 2026-10-16 |
| [TPEx ETF 篩選器](https://info.tpex.org.tw/ETF/zh/filter.html) | 上櫃 ETF 身分與名稱 | 118 筆；回應沒有資料日，不以擷取日冒充 |
| [TWSE 每日商品資料](https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL) | 只替已確認 ETF 補當日名稱，不從此表新增 ETF | 1380 筆商品；資料日 2026-10-16 |

快照擷取於 2026-10-17 14:44（Asia/Taipei），共 390 個不重複身分。當時 Shioaji STK Base 共 3155 筆，其中可對應 ETF 為 359 檔：TSE 241、OTC 118。其餘 31 個官方身分未出現在當時的 broker Base，因此不顯示；沒有據此推斷原因或可交易性。

## 搜尋行為

- 可用代碼、簡稱、官方完整名稱搜尋；上市基金保留官方來源中的舊簡稱。TPEx 該來源僅提供簡稱，不宣稱已補齊每檔上櫃基金的完整法定名稱或所有歷史名稱。
- 名稱支援台／臺、大小寫、全形及相容字元；產生時將 `&amp;`、數字字元參照解碼為純文字，沒有 HTML 注入或危險渲染。
- 顯示「ETF」，實際合約型別仍為 `STK`；00679B 保留 `OTC`。完整基金名含「期貨」時，精確命中優先，不誤拆為期貨類型查詢。
- 精確 ETF 搜尋仍依相同 `underlying_code` 查關聯期貨、權證；不把基金持股當成衍生商品關係。
- 名稱快照不增加執行期外部請求。第一次目錄查詢仍使用現有 Base／權證標的兩個批次來源，不逐檔讀 Info；成功短暫快取，失敗來源可重試。

## 驗收證據

1. 全部 390 個快照身分用合成 broker Base 測試；697 個簡稱／別名逐一呼叫 `searchProducts`，獨立 agent 查核為零漏查、零錯誤 underlying。這證明演算法，不宣稱 390 檔都存在於實際服務。
2. 真實服務 metadata 對照確認目前 359 檔交集；沒有發送訂單或寫入自選清單。
3. 單元測試含缺合約、錯市場、名稱來源失敗、S&P 字元、0053 新舊名、含「期貨」完整名稱及更名來源；產生器測試含空表、重複、壞欄位、壞日期、較舊資料與一般股票混入。
4. 瀏覽器 dev 實際驗證 0051、0053、00679B 等名稱搜尋。畫面證據與完整自動化數量見 [整體驗收](product-search.md) 與 [補充驗證](gemini-product-search-results.md)。

## 更新方式與邊界

在工作樹執行：

```powershell
node scripts/refresh-etf-catalog.mjs
node scripts/refresh-etf-catalog.mjs --write
node --test scripts/refresh-etf-catalog.test.mjs
pnpm exec vitest run src/lib/stock-catalog.test.ts src/lib/product-search.test.ts
pnpm exec tsc -b
```

第一行只擷取、檢查並摘要，不寫檔。第二行產生 `src/lib/data/etf-catalog.json`，須 review 差異後再提交。三個來源必須成功且非空；具有資料日的來源日期倒退，或來源筆數驟減超過 20% 時，保留原快照並停止。TWSE 每日名稱日期不能早於基金表日期。

不是自動排程更新。新掛牌、更名或未被其他名稱來源收錄時，需要重生成快照再隨版本交付；不能承諾未來新 ETF 自動可用。名稱可離線比對，不代表可離線取得 broker 合約、訂閱或即時報價。本輪搜尋截止或最後讀者離開會傳遞 HTTP AbortSignal，但不代表 daemon 已停止內部作業，亦不等於實測行情延遲。ETF 代號與名稱皆分段補入同標的商品，排序不變。

下一步行動：使用者檢視 dev 與 PR 草稿；未授權前不推送、不建立 GitHub PR、不發版。
