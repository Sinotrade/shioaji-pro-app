# Shioaji Pro — 專業交易終端 Trading Terminal

**[官方網站 / Landing Page](https://sinotrade.github.io/shioaji-pro-app/)** ・
**[下載 Download](https://github.com/Sinotrade/shioaji-pro-app/releases/latest)**

A professional, fully-customizable trading terminal for Taiwan markets
(TWSE / TPEX / TAIFEX), built on the [Shioaji](https://sinotrade.github.io/)
HTTP API + SSE streaming. React 19 + TypeScript + Vite, zero backend code —
it talks directly to your local `shioaji server`.

以 Shioaji HTTP API 打造的專業交易終端：即時行情、K 線、五檔、閃電下單、
圖表點價下單、停損停利觸價單、可拖拉的自訂版面。

**介面 100% 開源** — UI、行情串流、下單鏈路全部都在這個 repo，
clone 下來就能 build 出完整的 Web 版終端。桌面版外殼（Tauri）、
AI Agent 與策略回測為專屬模組，直接到 Releases 下載安裝檔即可使用。

![Shioaji Pro — futures night session](docs/shot-terminal-dark.png)

## Features 功能

- **即時行情** — 單一 SSE 連線串流 tick / 五檔，自選清單成交閃動（只在真實成交時閃，試撮不閃）
- **K 線圖** — lightweight-charts，1m/5m/15m/60m/1D，即時 tick 更新當根 K 棒，
  **歷史無限回溯**（往左拖自動載入更舊 K 棒，最多三年）
  - **點價下單**：點圖表價位直接限價買賣
  - **停損 / 停利**：在圖上掛觸價單（觸價送市價單），虛線顯示、可取消
  - **委託管理**：未成交委託顯示為實線、overlay 有 CANCEL 按鈕、**拖曳委託線即改價**
  - **Hover 同步**：十字線價位即時同步到下單面板
- **閃電下單** — 價格梯點擊即下單（左欄買/右欄賣），含安全開關；
  **⚡全開**：自選前 N 檔自動平鋪多個閃電面板（可選排版）
- **鋪單面板** — 一鍵多檔位掛單：靜態鋪單 ＋ 動態追價模式
- **五檔報價** — 量能條視覺化，點價帶入下單面板
- **成交明細** — 開啟即載入歷史 tick，時間精確到微秒
- **下單面板** — 整股/零股、ROD/IOC/FOK、期貨倉別、沖賣 daytrade_short，
  兩段式確認防誤觸
- **組合單** — 期貨/選擇權組合單（價差、跨式…），T 字報價點擊連動兩腳、
  到價監控自動送單
- **持倉 / 委託 / 帳務** — 即時損益、刪單改量、權益數與保證金、
  資產市值加總＋分布圖、零股混合單位顯示（X張+Y股）
- **排行榜** — 漲幅 / 量 / 額多條件複選 scanner（含放空篩選）、顯示類別、
  點擊即加入追蹤
- **類股熱力圖** — 指數 → 類股熱度總覽 → 點進類股看個股
- **交易安全** — 風控 Kill Switch（單筆上限/日虧上限/一鍵鎖單）、
  Esc×2 全部刪單、括號單（成交後自動掛 OCO 停損停利）、持倉一鍵平倉/反手、
  委託改量、下單預估成本（手續費/稅/契約值）
- **快捷鍵** — B/S 切換買賣、Esc×2 全刪單、⌘K 商品搜尋跳轉（支援中文股名）
- **技術指標** — 21 種內建（MA/EMA/WMA/BOLL/VWAP/SAR/SuperTrend/Donchian/
  Keltner/MACD/RSI/KD/StochRSI/CCI/ATR/OBV/MFI/W%R/DMI/ROC/BIAS），
  TradingView 式選擇器（搜尋/收藏/分類）與設定視窗（色盤/線型/透明度/
  線寬/時框顯示/存為我的預設），副圖獨立窗格、圖上 legend 即時數值、
  上下窗格比例拖曳保存
- **自訂指標** — 面板內用 JavaScript + `ta.*` 函式庫寫自己的指標
  （`plot()`/`hline()` 宣告輸出），Web Worker 沙箱驗證（自動擋無窮迴圈）、
  自動偵測輸出線，寫完與內建指標同等待遇（設定/樣式/收藏全套）
- **大盤狀態列** — 加權指數與台指期基差常駐頂部
- **到價警示** — 圖上點擊設警示線（只通知不下單），音效＋toast
- **分析面板** — 損益分析（權益曲線/勝率/賺賠比）、分價量表＋內外盤比、
  個股籌碼卡（融資券/借券/處置股）、選擇權 T 字報價（TXO）、
  選擇權損益圖（買方/賣方到期損益）
- **行情回放** — 重播當日歷史 tick 練盤感（1x–100x 變速）
- **委託簿熱圖** — 五檔掛單牆的時間序列視覺化
- **自選清單** — 漲跌幅排序、列備註、迷你走勢圖（可開關）、拖曳排序
- **自訂版面** — react-grid-layout 拖拉移動/縮放，面板可任意新增（多開 K 線圖）、
  每個面板可「連動自選」或「鎖定商品」、可彈出成獨立視窗（多螢幕）、
  版面可命名儲存/載入，內建多組預設版面
- **通知中心 / 診斷面板** — 委託回報時間軸、系統事件、App 版本與連線診斷
- **隱私模式** — 一鍵遮蔽帳號與金額（demo / 截圖 / 直播用）
- **音效回報** — 成交/委託/警示分音色（可關閉）
- **斷線自愈** — SSE 重連後自動重新訂閱所有商品；斷線時自動鎖定下單按鍵
- **主題** — 深色 / 純黑 / 淺色 × 紅漲綠跌(台式) / 綠漲紅跌(美式)，字級可調

| Dark | Light |
|------|-------|
| ![dark](docs/shot-terminal-dark.png) | ![light](docs/shot-terminal-light.png) |

## Desktop App 桌面版（推薦）

到 [Releases](https://github.com/Sinotrade/shioaji-pro-app/releases) 下載對應平台安裝檔
（macOS `.dmg`、Windows `.msi`、Linux `.AppImage`/`.deb`/`.rpm`）。桌面版特色：

系統需求：macOS 13.3+（Apple Silicon / Intel）、Windows 10/11 x64、Linux x86_64。

- **AI Agent** — 多供應商（Claude / Codex）agentic 對話、shioaji 技能市集、
  排程任務、操作觀察學習（桌面版專屬）
- **策略回測** — 用 JS 寫進出場策略（與自訂指標同一套 `ta` 函式庫）、
  含手續費/證交稅/期交稅/滑價的回測引擎（訊號收盤成立、次根開盤成交，
  無未來函數）、單商品與自選清單多商品整合績效（合併權益曲線＋可排序
  商品表）、進出場標記直接畫在 K 線上（桌面版專屬）
- **內建 shioaji server**（sidecar）— 不需另外安裝 CLI
- **伺服器管理介面** — header「伺服器」選單：啟動/停止/重啟、健康狀態、
  PID/port、token 效期；API 金鑰在介面填寫（存於本機 App 資料夾）
- **模擬/正式環境切換** — 介面上切換，重啟伺服器生效
- **系統匣（Menu Bar）** — 關閉視窗縮到系統匣常駐；匣選單可叫回視窗、
  開伺服器管理、檢查更新
- **自動更新** — 啟動時靜默檢查，GitHub Releases 簽章驗證後自動更新重啟
- **多視窗 Popout** — 面板 ⧉ 彈出為原生視窗，多螢幕交易
- **單一實例** — 重複開啟自動聚焦既有視窗

> 桌面版外殼（Tauri）、AI Agent 與策略回測為專屬模組，不在本 repo ——
> 本 repo 可 build 出完整的 Web 版終端（CI 持續驗證），桌面版請直接下載安裝檔。

## Getting Started 開始使用（Web 版）

### 1. Prerequisites 前置需求

- 永豐金證券帳戶 + Shioaji API Key/Secret
  （在 [API 管理頁](https://www.sinotrade.com.tw/newweb/PythonAPIKey/) 建立）
- [Node.js](https://nodejs.org/) 20+ 與 [pnpm](https://pnpm.io/)
- Shioaji CLI：

```sh
# 推薦用 uv 安裝
uv tool install shioaji
# 或下載 standalone binary，見 https://sinotrade.github.io/
```

### 2. Configure credentials 設定金鑰

```sh
cp .env.example .env
# 編輯 .env，填入你的 SJ_API_KEY / SJ_SEC_KEY
```

> `.env` 已被 `.gitignore` 排除，**請勿** commit 你的金鑰。

### 3. Start the Shioaji server 啟動行情/交易伺服器

```sh
shioaji server start          # 預設模擬環境（紙上交易）
shioaji server check          # 確認狀態
```

預設跑在 `http://127.0.0.1:8080`，**simulation 模式**——下單不會動用真錢。
切正式環境：`shioaji server start --production`（需先完成 CA 憑證設定，
請務必先在模擬環境完整測試）。

### 4. Run the app 啟動前端

```sh
pnpm install
pnpm dev
```

開啟 [http://localhost:5173](http://localhost:5173) —— dev server 會把
`/api` 代理到 `localhost:8080`。

## Deploy as a Shioaji custom app 部署為內建 App

Shioaji server 可直接代管前端，build 完上傳即可：

```sh
VITE_BASE=/apps/shioaji-pro-app/ pnpm build
cd dist
ARGS=(); for f in *; do ARGS+=(-F "files=@$f"); done
curl -X POST http://localhost:8080/api/v1/apps/shioaji-pro-app "${ARGS[@]}"
```

然後開啟 `http://localhost:8080/apps/shioaji-pro-app/index.html`。
（注意：上傳的 app 存在 server 記憶體，server 重啟後需重新上傳。）

## Safety notes 安全提醒

- 預設為**模擬環境**；頂部會顯示「模擬環境」徽章，正式環境為紅色「正式環境」
- 閃電下單預設**鎖定**，需手動啟用；圖表點價下單為 one-shot 模式
- 停損/停利為**客戶端觸價單**，只在頁面開啟時監控
- 正式環境的每一筆委託都是真實交易，請自行承擔風險

## Stack

- React 19 + TypeScript + Vite 8
- [vanilla-extract](https://vanilla-extract.style/) — zero-runtime themable CSS
- [lightweight-charts](https://tradingview.github.io/lightweight-charts/) v5
- [react-grid-layout](https://github.com/react-grid-layout/react-grid-layout) v2
- Shioaji HTTP API + Server-Sent Events

## License

[GNU AGPL-3.0](LICENSE) — 介面 100% 開源，但這是強 copyleft 授權：

- **可以**自由使用、修改、學習、fork
- **商用條件**：任何基於本專案的修改或衍生作品（包括架成網路服務提供他人
  使用）都**必須以 AGPL-3.0 完整開源**
- 不願開源的商業使用，請聯繫永豐金證券洽談**商業授權**（dual licensing）

External contributions: by submitting a PR you agree to license your
contribution under AGPL-3.0 and grant the maintainers the right to
include it in dual-licensed distributions.
