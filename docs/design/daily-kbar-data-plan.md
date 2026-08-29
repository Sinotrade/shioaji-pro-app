# 日 K 官方資料管線規劃（TWSE / TPEX / TAIFEX）

> 2026-08-12 調研定稿。三所端點均經實測（非僅文件），詳細欄位與陷阱見文末附錄。
> 背景：日 K 不該由 1 分 K 聚合（交易日歸屬、官方收盤/結算價、除權息都不對），
> 應以交易所官方日線為源。shioaji server 無日線端點，故需自建資料管線。

## 一、調研結論（load-bearing facts）

### 授權 — 決定架構的關鍵

三所網站條款一致：預設禁爬蟲、禁轉發布，**但已授權「政府資料開放平臺」
(data.gov.tw) 的資料不在此限**。掛上開放平臺的資料集適用
「政府資料開放授權條款 v1」（OGDL-1.0，CC BY 4.0 相容）：**可重製、散布、
公開傳輸、改作、再轉授權、不限目的含商用**，唯需顯名標示來源且不得破壞完整性。

| 開放資料集（可轉發布） | data.gov.tw | 內容 |
|---|---|---|
| TWSE `STOCK_DAY_ALL` 等 openapi | 11549/11548/11672 | 上市全市場**最新交易日**日線 |
| TPEX `tpex_mainboard_quotes` 等 openapi | 11371 | 上櫃全市場**最新交易日**日線 |
| TAIFEX `DailyMarketReportFut/Opt` | 11319/11320 | 期貨/選擇權**最新交易日**全行情 |

**歷史回填端點（legacy web）不在開放清單** → 抓來自用合規（引用需註明出處、
保持完整），**大量轉發布屬灰區**（條款要求事前書面同意）。TAIFEX 例外性最低
（`futDataDown` 與開放資料集內容相同，僅通道不同）。

### 歷史深度與回填成本

| 來源 | 深度 | 粒度 | 回填請求量 |
|---|---|---|---|
| TAIFEX `futDataDown`/`optDataDown` | 期貨 **1998/07**、選擇權 2001/12 | 每商品×每月一請求（Big5 CSV） | TX 一檔 28 年 ≈ 340 req |
| TWSE `MI_INDEX`（全市場單日） | **2004-02-11** | 每交易日一請求 | 全歷史 ≈ 5,500 req |
| TWSE `STOCK_DAY`（單檔逐月） | **2010-01-04** | 每檔×每月 | 一檔 16 年 ≈ 200 req |
| TWSE `MI_5MINS_HIST`（加權指數 OHLC） | **1999-01** | 逐月 | ≈ 330 req |
| TPEX `dailyQuotes`（全市場單日） | **2007-04-23** | 每交易日 | ≈ 4,700 req |
| TPEX `tradingStock`（單檔逐月） | **1994**（僅現存上櫃檔） | 每檔×每月 | — |
| TPEX `indexInfo/inx`（櫃買指數 OHLC） | **1999-09** | 逐月 | ≈ 330 req |
| 除權息：TWSE TWT49U（2003→，舊 schema 不同）＋TWTAUU 減資；TPEX exDailyQ（2011→） | | | |

Rate limit 實測：TWSE ~3 req/5s（超過 IP ban，社群多次證實）；TAIFEX 連發 4 次
即軟擋（3–5s 間隔安全）；TPEX 寬鬆但在 Cloudflare 後面。→ 全量回填是
「以天為單位的一次性慢工」，絕不能放在每個客戶端做。

### TAIFEX 資料紅利

日線檔含 **結算價、未沖銷契約數（OI）**、日夜盤分列（`交易時段`＝一般/盤後，
夜盤官方歸次一交易日；結算價/OI 只在一般列）→ 交易日歸屬、日 K 材料一次到位，
還能做 OI 疊圖。

## 二、架構決策：GitHub Data Release ＋ 每日排程（推薦）

三個候選：

- **A. 每個客戶端直抓交易所**：❌ rate limit 攤在用戶 IP 上（TWSE 3req/5s，一張
  240 天日線圖若逐月抓要數分鐘）、三所格式地雷在客戶端重複實作、交易所被
  N 個用戶打。
- **B. GitHub Data Release（推薦）**：CI 排程每天收盤後抓**開放資料端點**
  （一天總共 ~5 個請求），正規化後更新到 data release assets。用戶從 GitHub
  CDN 下載 — 零 rate limit 風險、離線可用、交易所每天只被打一次、授權乾淨
  （OGDL-1.0＋標示出處）。
- **C. 混合**：B 為主；當天盤中/尚未入庫的最新一根由 server 直抓 openapi 補
  （一天 3 個請求/用戶，無風險）。→ **實際採 B＋C**。

### Data repo 設計

- 新公開 repo（建議 `Sinotrade/tw-daily-kbars`；不放 shioaji-pro-app 內以免
  污染 app 的 release feed 與 latest.json 更新器）。
- **Assets 佈局**（per-market per-year，UTF-8、西元日期、無千分位、schema 版本化）：
  ```
  twse-daily-2026.csv.gz     # 上市個股+ETF 日線（源：STOCK_DAY_ALL 逐日累積）
  tpex-daily-2026.csv.gz     # 上櫃（源：tpex openapi 逐日累積）
  taifex-fut-2026.csv.gz     # 期貨逐合約（含結算價/OI/日夜盤）
  taifex-opt-2026.csv.gz     # 選擇權逐合約
  index-daily-2026.csv.gz    # 加權/櫃買指數 OHLC
  events-2026.csv.gz         # 除權息/減資事件（還原 K 原料）
  continuous-fut-2026.csv.gz # R1/R2 連續月（管線推導，見下）
  manifest.json              # 各檔涵蓋日期區間、sha256、schema 版本
  NOTICE.md                  # 資料來源標示（三所）＋OGDL-1.0 聲明
  ```
  量級：TWSE ~1,400 列/日、TPEX ~1,000（先不含權證）、TAIFEX ~2,200 →
  每年每檔個位數 MB gzip，全歷史總量幾十 MB，離 2GB asset 上限很遠。
- **每日排程**（GitHub Actions cron，週一到週五）：15:40 TW 主跑（TWSE/TPEX
  收盤資料 ~14:00-15:00 齊、TAIFEX 日盤結算後）＋ 18:00 補跑（防遲到）。
  逐日 append、更新 manifest、`gh release upload --clobber` 到固定 tag（如
  `data`）。假日空跑自動跳過（拿到的還是前一交易日就 no-op）。
- **回填策略**（一次性、丟到同 release）：
  - TAIFEX：`futDataDown` 全量回填 1998→（與開放資料集同內容，合規風險最低）。
  - 指數：TWSE/TPEX 逐月端點回填 1999→（量小，~660 req 慢慢抓）。
  - TWSE/TPEX 個股深歷史（2004/2007→）：**轉發布屬灰區 — 需決策**。
    選項 (a) 照抓照發（標示出處＋完整性，承擔殘餘風險）；(b) 只發布開放端點
    從今起的累積，深歷史做成「用戶本機自抓工具」（server 內建，逐月慢抓進
    本地快取，不轉發布）；(c) 先發函詢問兩所取得書面同意。
    **建議 (b) 起步、並行 (c)**，拿到同意再升級成 (a)。

### 連續月合約（管線內推導）

TAIFEX 只有逐合約（且小台代碼是 **MTX**，非 shioaji 的 MXF — 需維護對照表：
TX↔TXF、MTX↔MXF、TMF↔TMF、TE↔EXF、TF↔FXF、個股期逐檔對映）。管線推導
R1/R2：近月＝最小非價差到期月（期貨無到期日欄，用第三個週三規則算換月日；
選擇權檔有 `契約到期日` 可借用驗證）、換月日標記、不做 back-adjust（台灣
慣例）。價差列（到期月份含 `/`）一律濾除。

### Server / App 端

- sidecar 新增 data provider：啟動/背景同步 data release（manifest 比對、下載
  年度檔到 `~/.shioaji-pro/data/`）、暴露 `GET /api/v1/data/daily?code=&from=&to=`
  （含連續月與指數）；當天最新一根盤後由 openapi 直補（C 路徑）。
- App：K 線圖 `1D` timeframe 改走新端點；偵測舊 server（404）fallback 現行
  1 分 K 聚合。日 K 面板可順勢加結算價/OI 顯示（期貨）。
- 還原 K（第二期）：events 檔算調整因子，App 端提供「還原」開關。

## 三、分期

| 期 | 內容 | 依賴 |
|---|---|---|
| 1 | data repo＋管線骨架＋TAIFEX（日線+回填+連續月）＋每日 cron＋NOTICE | 無 |
| 2 | TWSE/TPEX 每日累積＋指數回填＋deep-history 決策（b→c→a） | 1 |
| 3 | sidecar provider＋`/data/daily` 端點＋App 1D 切換（含 fallback） | 1 |
| 4 | 除權息 events＋還原 K＋期貨 OI 疊圖 | 2,3 |

## 附錄：實測陷阱清單（實作時照抄）

- **日期方言**：TWSE openapi 民國 `1150811`；TWSE legacy 民國含空白前綴
  `" 99/01/04"`；TPEX www 請求用西元 `2026/08/11` 但回應列是民國；TPEX
  `tpex_index`/`indexInfo/inx` 又是西元。統一正規化為 ISO。
- **TWSE**：legacy 數字千分位字串；`MI_INDEX` 漲跌欄含 raw HTML
  `<p style=color:red>+</p>`；`STOCK_DAY` 現在 10 欄（多`註記`，`X`=不比價）；
  `MI_INDEX` 新版包在 `tables[]`；TWT49U 要走 `/rwd/` 路徑用
  `startDate/endDate`（舊參數靜默失效）；pre-2011 TWT49U 列 schema 不同且
  混 float；錯誤永遠 HTTP 200 看 `stat`。
- **TPEX**：openapi 欄名 typo 是真的（`LatesAskPrice`、`ExRrights`、`Diviend`）；
  `tradingStock` 量的單位是**張**、`dailyQuotes` 是**股**；舊年份欄數較少
  （2007＝16 欄）→ 必須按 `fields` 解析；**超範圍日期會靜默回最新日資料 —
  必驗回應內 date**；`response=csv` 是 Big5。
- **TAIFEX**：CSV 是 Big5/MS950；期貨與選擇權欄位順序不同（按 header 解析）；
  一次最多查一個月；空 `commodity_id` 回只有 header 的殼；軟擋回 HTML alert
  頁（body 以 `<!` 開頭即重試）；tick zip 只留 30 天（與日 K 無關）。
- 三所 openapi 都**只回最後一個完成交易日**、盤中不更新當日。
